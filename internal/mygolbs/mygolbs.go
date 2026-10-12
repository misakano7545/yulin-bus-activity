// Package mygolbs 是掌上公交（mygolbs）H5 数据面的客户端。
//
// 只用来补车来了没覆盖的线路（北流105路、陆川1路，以及市区那三条城际/樟木线），
// 车来了有的照旧走 internal/upstream。
// 两边的字段语义不一样，映射全写在本包里，别把掌上公交的字段名漏到面板里：
//   - 车辆标识：busNumber 就是车牌（车来了那边 licence 多是自编号），所以拿 plate_map 归一成
//     自编号；表里没有的（比如北流105路那几辆，益业公交的车）原样透出车牌
//   - 到站估计：只按站给（STATIONORDER），且每站最多回最近 2 辆车的预测 —— 其余车辆没有
//     ETA，透出 0，前端显示「无预测」而不是猜「即将到站」
//   - 运营状态：runState=1 该线路已停运、hasReal=0 未开通实时查询（见官方 H5 包
//     showRealTimeInfo 里那两段判断）
//
// Origin: https://h5.mygolbs.com 是这个接口的硬门槛 —— 缺了所有命令都返回同一个
// 47 字节网关串（HTTP 200、不是 JSON），加了才通。
package mygolbs

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/misakano7545/yulin-bus-activity/internal/plate"
	"github.com/misakano7545/yulin-bus-activity/internal/upstream"
)

const (
	apiBase   = "https://h5.mygolbs.com/ApiData.do"
	origin    = "https://h5.mygolbs.com"
	userAgent = "Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"

	// srcName 是面板底部那行「数据更新 … · X」用的名字。
	srcName = "掌上公交"

	// 站表/首末站这些静态信息变得慢；/lines 上那段带车辆数，按分钟刷。
	ttlStatic  = time.Hour
	ttlCatalog = time.Minute
)

// spec 是一条要发布的掌上公交线路方向。面板里的 lineId = "mg" + routeId + "-" + 方向
// （车来了的 lineId 是纯数字串，两边不会撞）。加线路时在这里加两行，每个方向一行。
type spec struct {
	ID       string
	CityCode string
	CityName string
	LineName string // 上游查线路用的名字（LINENAME），不能动
	Dir      int
	// Short 是面板上显示的名字：上游那条「玉林至北流城际公交线路」在列表那一格放不下，
	// 换简称；空表示直接用 LineName。
	Short string
}

// label 面板显示名。
func (s spec) label() string {
	if s.Short != "" {
		return s.Short
	}
	return s.LineName
}

var catalog = []spec{
	{"mg40105-1", "450981", "北流市", "北流105路", 1, ""},
	{"mg40105-2", "450981", "北流市", "北流105路", 2, ""},
	// 陆川没有自己的城市码（450922 → -2），车队挂在玉林市 450900 下面，所以城市码写 450900
	{"mg1011-1", "450900", "玉林市", "陆川1路", 1, ""},
	{"mg1011-2", "450900", "玉林市", "陆川1路", 2, ""},
	// 这三条车来了没有，上游名字太长，面板那一格用简称（用户定的）。
	// 玉樟（routeId 151）在线但没有车传 GPS，列表里会一直显示 0 辆 —— 这不是解析问题。
	{"mg131-1", "450900", "玉林市", "玉林至北流城际公交线路", 1, "玉北1"},
	{"mg131-2", "450900", "玉林市", "玉林至北流城际公交线路", 2, "玉北1"},
	{"mg141-1", "450900", "玉林市", "玉林旅游客运站至北流成南站公交线路", 1, "玉北2"},
	{"mg141-2", "450900", "玉林市", "玉林旅游客运站至北流成南站公交线路", 2, "玉北2"},
	{"mg151-1", "450900", "玉林市", "玉林总站-福绵新滔工业园", 1, "玉樟"},
	{"mg151-2", "450900", "玉林市", "玉林总站-福绵新滔工业园", 2, "玉樟"},
}

func specOf(lineID string) (spec, bool) {
	for _, s := range catalog {
		if s.ID == lineID {
			return s, true
		}
	}
	return spec{}, false
}

// Handles 判断一个 lineId 是不是本数据面的。
func Handles(lineID string) bool {
	_, ok := specOf(lineID)
	return ok
}

type Client struct {
	http   *http.Client
	base   string       // 测试里指到 httptest
	plates *plate.Table // 车牌 → 自编号；为 nil 时不归一

	mu      sync.Mutex
	routes  map[string]entry // 103 的原始响应，按线路方向缓存
	lines   []upstream.Line  // /lines 那一段（含车辆数）
	linesAt time.Time
}

type entry struct {
	wire wireRoute
	at   time.Time
}

func New(plates *plate.Table) *Client {
	log.Printf("掌上公交线路: %d 个方向", len(catalog))
	return &Client{
		http:   &http.Client{Timeout: 10 * time.Second},
		base:   apiBase,
		plates: plates,
	}
}

// Route 返回站序（CMD=103）。
func (c *Client) Route(ctx context.Context, lineID string) (*upstream.Route, error) {
	s, ok := specOf(lineID)
	if !ok {
		return nil, fmt.Errorf("不是掌上公交线路: %q", lineID)
	}
	w, err := c.routeData(ctx, s)
	if err != nil {
		return nil, err
	}
	rt := &upstream.Route{LineID: lineID, Name: s.label()}
	for _, st := range w.Data {
		rt.Stops = append(rt.Stops, upstream.Stop{
			ID: strconv.Itoa(st.Order), Name: st.Name, Order: st.Order, Lat: st.Lat, Lng: st.Lon,
		})
	}
	return rt, nil
}

// Lines 返回目录里的线路，字段对齐车来了那边（首末站/首末班/票价/车辆数/运营状态），
// 面板不需要区分数据面。带车辆数的那段按 ttlCatalog 缓存。
func (c *Client) Lines(ctx context.Context) ([]upstream.Line, error) {
	c.mu.Lock()
	last, at := c.lines, c.linesAt
	c.mu.Unlock()
	if last != nil && time.Since(at) < ttlCatalog {
		return last, nil
	}

	out, err := c.buildLines(ctx)
	if err != nil {
		// 一次抖动不该让线路从列表里消失 —— 前端只在开页时拉 /lines，丢了要刷页面才回来。
		if last != nil {
			log.Printf("掌上公交目录刷新失败，沿用上一次: %v", err)
			return last, nil
		}
		return nil, err
	}
	c.mu.Lock()
	c.lines, c.linesAt = out, time.Now()
	c.mu.Unlock()
	return out, nil
}

// buildLines 逐条方向拼目录。首末站/首末班来自 103，车辆数与运营状态来自 104。
func (c *Client) buildLines(ctx context.Context) ([]upstream.Line, error) {
	out := make([]upstream.Line, 0, len(catalog))
	for _, s := range catalog {
		w, err := c.routeData(ctx, s)
		if err != nil {
			return nil, err
		}
		rt, err := c.Realtime(ctx, s.ID, 0)
		if err != nil {
			return nil, err
		}
		out = append(out, upstream.Line{
			LineID: s.ID, Name: s.label(),
			Start: w.Data[0].Name, End: w.Data[len(w.Data)-1].Name,
			FirstTime: w.first(), LastTime: w.last(),
			State: rt.State, Desc: rt.Desc, Count: len(rt.Buses), Src: srcName,
		})
	}
	return out, nil
}

// Realtime 返回实时车辆（CMD=104）。
//
// target > 0 时 ETA 算到第 target 站；为 0 时算到终点站 —— 掌上公交没有「到终点」这个
// 入参，只有 STATIONORDER，所以按终点站的站序问。
func (c *Client) Realtime(ctx context.Context, lineID string, target int) (*upstream.Realtime, error) {
	s, ok := specOf(lineID)
	if !ok {
		return nil, fmt.Errorf("不是掌上公交线路: %q", lineID)
	}
	w, err := c.routeData(ctx, s)
	if err != nil {
		return nil, err
	}
	if target <= 0 {
		target = len(w.Data)
	}

	body, err := c.call(ctx, url.Values{
		"CMD": {"104"}, "CITYNAME": {s.CityName}, "CITYCODE": {s.CityCode},
		"LINENAME": {s.LineName}, "DIRECTION": {strconv.Itoa(s.Dir)},
		"STATIONORDER": {strconv.Itoa(target)},
	})
	if err != nil {
		return nil, err
	}
	var up wireRealtime
	if err := json.Unmarshal(body, &up); err != nil {
		return nil, fmt.Errorf("解析实时响应失败: %w", err)
	}

	state, desc := lineState(up.RunState, up.HasReal)
	rt := &upstream.Realtime{
		LineID: lineID, Price: priceOf(w.Commonts), State: state, Desc: desc,
		Buses: []upstream.Bus{},
	}

	// 每站只回最近 2 辆车，按车牌对到车上（等待发车那种没有 busNumber，跳过）。
	eta := map[string]float64{}
	for _, e := range up.OnStation {
		if e.BusNumber != "" {
			eta[e.BusNumber] = e.Time
		}
	}

	for _, b := range up.List {
		// 表里没有的车牌（北流105路那几辆）原样透出 —— 车牌本身仍是稳定标识，不算低可信。
		fleetNo := b.BusNumber
		if n, ok := c.plates.Lookup(b.BusNumber); ok {
			fleetNo = n
		}
		bus := upstream.Bus{
			FleetNo: fleetNo, RawID: b.BusNumber, Confidence: "high", LineID: lineID,
			Lat: b.Lat, Lng: b.Lng, Order: b.Index + 1, Target: target, Pos: 1,
			UpdatedAt: time.UnixMilli(b.RecTime),
		}
		// statusType "0" 是到站（官方包：到站的直接赋值为最近站），钉在站上；在途的按投影
		// 插到「上一站 → 正在接近的那站」之间。
		if b.StatusType == "0" {
			bus.State = 1
		} else if bus.Order >= 2 && bus.Order <= len(w.Data) {
			a, z := w.Data[bus.Order-2], w.Data[bus.Order-1]
			if p, ok := segPos(b.Lat, b.Lng, a.Lat, a.Lon, z.Lat, z.Lon); ok {
				bus.Pos = p
			}
		}
		if m, ok := eta[b.BusNumber]; ok {
			// busToStationTime 是分钟（上游文案会再向上取整一分钟）；小于 1 分钟时给 0，
			// 按 60 秒透出 —— 前端那片就显示「即将到站」，跟上游文案一致。
			switch {
			case m >= 1:
				bus.ETA = int(m * 60)
			case m > 0:
				bus.ETA = 60
			}
		}
		rt.Buses = append(rt.Buses, bus)
	}
	return rt, nil
}

// routeData 取 CMD=103 的原始响应（带缓存）。Route 与 Lines 都用它 —— 首末站、首末班、
// 票价、站坐标都在这一份里。
func (c *Client) routeData(ctx context.Context, s spec) (wireRoute, error) {
	c.mu.Lock()
	e, hit := c.routes[s.ID]
	c.mu.Unlock()
	if hit && time.Since(e.at) < ttlStatic {
		return e.wire, nil
	}

	body, err := c.call(ctx, url.Values{
		"CMD": {"103"}, "CITYNAME": {s.CityName}, "CITYCODE": {s.CityCode},
		"LINENAME": {s.LineName}, "DIRECTION": {strconv.Itoa(s.Dir)},
	})
	if err != nil {
		return wireRoute{}, err
	}
	var w wireRoute
	if err := json.Unmarshal(body, &w); err != nil {
		return wireRoute{}, fmt.Errorf("解析站表失败: %w", err)
	}
	if len(w.Data) == 0 {
		return wireRoute{}, fmt.Errorf("%s 方向 %d 没取到站表", s.LineName, s.Dir)
	}
	c.mu.Lock()
	if c.routes == nil {
		c.routes = map[string]entry{}
	}
	c.routes[s.ID] = entry{wire: w, at: time.Now()}
	c.mu.Unlock()
	return w, nil
}

// call 发一条命令。status 不是 1（成功）就按上游的 msg 报错 —— 上游失败也是 HTTP 200。
func (c *Client) call(ctx context.Context, p url.Values) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, "POST", c.base, strings.NewReader(p.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Referer", origin+"/")
	req.Header.Set("Origin", origin)

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("上游 HTTP %d: %.120s", resp.StatusCode, body)
	}
	var env struct {
		Status json.RawMessage `json:"status"`
		Msg    string          `json:"msg"`
	}
	if err := json.Unmarshal(body, &env); err != nil {
		return nil, fmt.Errorf("响应不是 JSON（多半缺 Origin 头）: %.120s", body)
	}
	if !statusOK(env.Status) {
		return nil, fmt.Errorf("上游失败 status=%s msg=%s", strings.Trim(string(env.Status), `"`), env.Msg)
	}
	return body, nil
}

// 上游成功时 status 是数字 1，失败时是字符串 "-1"/"-2"。
func statusOK(raw json.RawMessage) bool {
	return strings.Trim(string(raw), `"`) == "1"
}

// lineState 把 runState/hasReal 翻成面板认的 state。1 不在面板已知的 0/-1/-2/-3 里，
// 前端 stateOf 的兜底会把 desc 原样显示出来 —— 这正是「未开通实时查询」要的效果
// （硬塞成 -1「等待发车」是错的）。
func lineState(runState, hasReal int) (int, string) {
	switch {
	case runState == 1:
		return -2, "该线路已停运"
	case hasReal == 0:
		return 1, "该线路未开通实时数据查询"
	}
	return 0, ""
}

// 票价只藏在 commonts 那句话里（"票价：4元  北流汽车总站的首班车6：30…"）。
var priceRe = regexp.MustCompile(`票价[:：]\s*([^\s，,]+)`)

func priceOf(commonts string) string {
	if m := priceRe.FindStringSubmatch(commonts); m != nil {
		return m[1]
	}
	return ""
}

// segPos 返回车在「上一站 → 正在接近的那站」这一段上的投影比例，夹在 [0,1]；坐标缺失时 ok=false。
// 与 internal/upstream 里那份是同一套算法，那边入参是车来了的 wireStop，没法直接复用。
// ponytail: 一站之内的尺度把经纬度当平面，经度按 cos(纬度) 缩放即可。
func segPos(lat, lng, aLat, aLng, bLat, bLng float64) (float64, bool) {
	if lat == 0 || lng == 0 || aLat == 0 || bLat == 0 {
		return 0, false
	}
	k := math.Cos(lat * math.Pi / 180)
	ax, ay := aLng*k, aLat
	bx, by := bLng*k, bLat
	dx, dy := bx-ax, by-ay
	dd := dx*dx + dy*dy
	if dd == 0 {
		return 0, false
	}
	t := ((lng*k-ax)*dx + (lat-ay)*dy) / dd
	switch {
	case t < 0:
		return 0, true
	case t > 1:
		return 1, true
	}
	return t, true
}

// ─── 上游响应 ───

// CMD=103：站序 + 首末班 + 票价文案。
type wireRoute struct {
	RouteName string        `json:"routeName"`
	Data      []wireStation `json:"data"`
	Commonts  string        `json:"commonts"`
	FirstLast []wireSpan    `json:"firstLast"`
}

type wireStation struct {
	Name  string  `json:"stationName"`
	Lon   float64 `json:"station_lon"`
	Lat   float64 `json:"station_lat"`
	Order int     `json:"stationOrder"`
}

// 首末班按「北流汽车总站发车 6：30…」这种口径给，一条方向一条。
type wireSpan struct {
	First string `json:"first"`
	Last  string `json:"last"`
}

func (w wireRoute) first() string {
	if len(w.FirstLast) > 0 {
		return w.FirstLast[0].First
	}
	return ""
}

func (w wireRoute) last() string {
	if len(w.FirstLast) > 0 {
		return w.FirstLast[0].Last
	}
	return ""
}

// CMD=104：车辆在 list，逐站到站预测在 routeOnStationRTimeInfoList。
type wireRealtime struct {
	List      []wireBus `json:"list"`
	OnStation []wireETA `json:"routeOnStationRTimeInfoList"`
	RunState  int       `json:"runState"`
	HasReal   int       `json:"hasReal"`
}

type wireBus struct {
	Index      int     `json:"index"` // 0 基的站序：车正在接近的那站
	StatusType string  `json:"statusType"`
	BusNumber  string  `json:"busNumber"` // 车牌
	Lat        float64 `json:"bus_lat"`
	Lng        float64 `json:"bus_lng"`
	RecTime    int64   `json:"_recTime"` // 毫秒
}

type wireETA struct {
	BusNumber string  `json:"busNumber"`
	Count     int     `json:"busToStationCount"`
	Time      float64 `json:"busToStationTime"` // 分钟
}
