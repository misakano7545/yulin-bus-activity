// Package upstream 是车来了（Chelaile）H5 数据面的客户端。
//
// 两个参数缺一个就静默返假数据，不是报错：
//   - s=h5  每个 /api 调用都要带，少了返回空 body
//   - src   实时接口要带，少了全城 state=-1「等待发车」、buses 恒空
package upstream

import (
	"context"
	"crypto/aes"
	"crypto/md5"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/misakano7545/yulin-bus-activity/internal/plate"
)

const (
	apiBase   = "https://web.chelaile.net.cn/api/"
	aesKey    = "422556651C7F7B2B5C266EED06068230"
	signSalt  = "qwihrnbtmj"
	cityID    = "440" // 玉林
	srcTag    = "wechat_yulingongjiao"
	clientVer = "9.1.2"
	userAgent = "Mozilla/5.0 (Linux; Android 13) Mobile MicroMessenger/8.0"

	ttlRealtime = 5 * time.Second
	ttlStatic   = time.Hour
)

type Client struct {
	http   *http.Client
	plates *plate.Table
	cache  *cache
}

func New(plates *plate.Table) *Client {
	return &Client{
		http:   &http.Client{Timeout: 15 * time.Second},
		plates: plates,
		cache:  newCache(),
	}
}

// baseParams：s=h5 每个请求都必须带；src 决定实时接口有没有数据。
func baseParams() url.Values {
	return url.Values{
		"s": {"h5"}, "v": {clientVer}, "vc": {"1"}, "sign": {"1"},
		"userId": {""}, "h5Id": {""}, "cityId": {cityID}, "src": {srcTag},
	}
}

// get 请求上游并剥掉 **YGKJ…YGKJ## 包装，返回 jsonr.data。
func (c *Client) get(ctx context.Context, handler string, p url.Values) (json.RawMessage, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", apiBase+handler+"?"+p.Encode(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Referer", "https://web.chelaile.net.cn/customer_ch5/")

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("上游 HTTP %d: %.120s", resp.StatusCode, body)
	}

	const pre, suf = "**YGKJ", "YGKJ##"
	text := string(body)
	i := strings.Index(text, pre)
	j := strings.LastIndex(text, suf)
	if i < 0 || j < i {
		return nil, fmt.Errorf("响应不是 YGKJ 包装（多半缺 s 参数）: %.120s", text)
	}
	var env struct {
		Jsonr struct {
			Status string          `json:"status"`
			Errmsg string          `json:"errmsg"`
			Data   json.RawMessage `json:"data"`
		} `json:"jsonr"`
	}
	if err := json.Unmarshal(body[i+len(pre):j], &env); err != nil {
		return nil, fmt.Errorf("解析 jsonr 失败: %w", err)
	}
	if env.Jsonr.Status != "00" {
		return nil, fmt.Errorf("业务失败 status=%s errmsg=%s", env.Jsonr.Status, env.Jsonr.Errmsg)
	}
	return env.Jsonr.Data, nil
}

// Lines 返回全部线路（每条线两个方向各一条记录）。
func (c *Client) Lines(ctx context.Context) ([]Line, error) {
	if v, ok := c.cache.get("lines"); ok {
		return v.([]Line), nil
	}
	data, err := c.get(ctx, "bus/cityLineList", baseParams())
	if err != nil {
		return nil, err
	}
	var wrap struct {
		AllLines struct {
			All []wireLine `json:"all"`
		} `json:"allLines"`
	}
	if err := json.Unmarshal(data, &wrap); err != nil {
		return nil, err
	}
	lines := make([]Line, 0, len(wrap.AllLines.All))
	for _, l := range wrap.AllLines.All {
		lines = append(lines, Line{
			LineID: l.LineID, Name: l.LineName,
			Start: l.StartStop, End: l.EndStop,
			FirstTime: l.FirstTime, LastTime: l.LastTime,
		})
	}
	c.cache.put("lines", lines, ttlStatic)
	return lines, nil
}

// Route 返回站点序列与走向折线（明文接口）。
func (c *Client) Route(ctx context.Context, lineID string) (*Route, error) {
	key := "route:" + lineID
	if v, ok := c.cache.get(key); ok {
		return v.(*Route), nil
	}
	p := baseParams()
	p.Set("lineId", lineID)
	data, err := c.get(ctx, "bus/line!lineRoute.action", p)
	if err != nil {
		return nil, err
	}
	var up wireRoute
	if err := json.Unmarshal(data, &up); err != nil {
		return nil, err
	}
	rt := &Route{
		LineID: up.Line.LineID, Name: up.Line.Name,
		Stops: make([]Stop, 0, len(up.Stations)),
		Track: make([][2]float64, 0, len(up.Route)),
	}
	for _, s := range up.Stations {
		rt.Stops = append(rt.Stops, Stop{ID: s.SID, Name: s.SN, Order: s.Order, Lat: s.Lat, Lng: s.Lng})
	}
	for _, pt := range up.Route {
		rt.Track = append(rt.Track, [2]float64{pt.Lng, pt.Lat})
	}
	c.cache.put(key, rt, ttlStatic)
	return rt, nil
}

// Realtime 返回实时车辆（加密接口：cryptoSign 入参 + AES-256-ECB 出参）。
//
// targetOrder > 0 时，每辆车的 ETA 是「到该站序」的秒数（到站情况）；
// 为 0 时是「到终点站」的秒数。
func (c *Client) Realtime(ctx context.Context, lineID string, targetOrder int) (*Realtime, error) {
	key := fmt.Sprintf("rt:%s:%d", lineID, targetOrder)
	if v, ok := c.cache.get(key); ok {
		return v.(*Realtime), nil
	}
	payload := map[string]any{"lineId": lineID}
	if targetOrder > 0 {
		payload["targetOrder"] = targetOrder
	}
	sig, err := cryptoSign(payload)
	if err != nil {
		return nil, err
	}
	p := baseParams()
	p.Set("lineId", lineID)
	p.Set("cryptoSign", sig)
	if targetOrder > 0 {
		p.Set("targetOrder", strconv.Itoa(targetOrder))
	}

	data, err := c.get(ctx, "bus/line!encryptedLineDetail.action", p)
	if err != nil {
		return nil, err
	}
	var wrap struct {
		EncryptResult string `json:"encryptResult"`
	}
	if err := json.Unmarshal(data, &wrap); err != nil {
		return nil, err
	}
	plain, err := decryptECB(wrap.EncryptResult)
	if err != nil {
		return nil, err
	}
	var up wireDetail
	if err := json.Unmarshal(plain, &up); err != nil {
		return nil, err
	}

	now := time.Now()
	rt := &Realtime{LineID: up.Line.LineID, Price: up.Line.Price, State: up.Line.State, Desc: up.Line.Desc, Buses: []Bus{}}

	// 站序索引：算车辆在两站之间的位置用（车 lat/lng 与站 wgsLat/wgsLng 同基准）
	byOrder := make(map[int]wireStop, len(up.Stations))
	for _, s := range up.Stations {
		byOrder[s.Order] = s
	}

	for _, b := range up.Buses {
		no, confident := c.plates.FleetNo(b.Licence)

		// 上游 order 是「正在接近的站」，车其实在 order-1 与 order 之间；
		// 取不到前站或坐标时退回 1，即画在 order 站圆点上。
		pos := 1.0
		if prev, ok := byOrder[b.Order-1]; ok {
			if p, ok := segPos(b.Lat, b.Lng, prev, byOrder[b.Order]); ok {
				pos = p
			}
		}

		bus := Bus{
			FleetNo: no, RawID: b.Licence, LineID: lineID, Confidence: "high",
			Lat: b.Lat, Lng: b.Lng, Order: b.Order, Target: up.Target, UpdatedAt: now,
			Pos: pos,
		}
		if !confident {
			bus.Confidence = "low"
		}
		if len(b.Travels) > 0 {
			bus.Target = b.Travels[0].Order
			bus.ETA = b.Travels[0].TravelTime
			bus.ArriveAt = b.Travels[0].RecommTip
		}
		rt.Buses = append(rt.Buses, bus)
	}
	c.cache.put(key, rt, ttlRealtime)
	return rt, nil
}

// segPos 返回车在 a→b 这一段上的投影比例，夹在 [0,1]；坐标缺失时 ok=false。
// 车与站同在 WGS 基准（站的 bd 坐标与车差一个偏移，不能用）。
func segPos(lat, lng float64, a, b wireStop) (float64, bool) {
	if lat == 0 || lng == 0 || a.WgsLat == 0 || b.WgsLat == 0 {
		return 0, false
	}
	// ponytail: 一站之内的尺度把经纬度当平面；经度按 cos(纬度) 缩放即可
	k := math.Cos(lat * math.Pi / 180)
	ax, ay := a.WgsLng*k, a.WgsLat
	bx, by := b.WgsLng*k, b.WgsLat
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

// cryptoSign 是 H5 的签名：JSON 去掉最外层 {}，':'->'=' ','->'&'，追加固定盐，取 MD5。
func cryptoSign(data map[string]any) (string, error) {
	b, err := json.Marshal(data)
	if err != nil {
		return "", err
	}
	s := strings.TrimSuffix(strings.TrimPrefix(string(b), "{"), "}")
	s = strings.ReplaceAll(s, ":", "=")
	s = strings.ReplaceAll(s, ",", "&")
	sum := md5.Sum([]byte(s + signSalt))
	return hex.EncodeToString(sum[:]), nil
}

// decryptECB 解 base64(AES-256-ECB + PKCS7)。
func decryptECB(encryptResult string) ([]byte, error) {
	ct, err := base64.StdEncoding.DecodeString(encryptResult)
	if err != nil {
		return nil, fmt.Errorf("base64 解码失败: %w", err)
	}
	if len(ct) == 0 || len(ct)%aes.BlockSize != 0 {
		return nil, fmt.Errorf("密文长度非法: %d", len(ct))
	}
	block, err := aes.NewCipher([]byte(aesKey))
	if err != nil {
		return nil, err
	}
	out := make([]byte, len(ct))
	for i := 0; i < len(ct); i += aes.BlockSize {
		block.Decrypt(out[i:], ct[i:])
	}
	n := int(out[len(out)-1])
	if n == 0 || n > aes.BlockSize || n > len(out) {
		return nil, fmt.Errorf("PKCS7 填充非法: %d", n)
	}
	return out[:len(out)-n], nil
}

// ─── 缓存 ───

// ponytail: 一把锁 + 全量 map。键只有几十个（线路数级），不淘汰也不会涨。
type cache struct {
	mu sync.Mutex
	m  map[string]entry
}

type entry struct {
	v   any
	exp time.Time
}

func newCache() *cache { return &cache{m: map[string]entry{}} }

func (c *cache) get(k string) (any, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.m[k]
	if !ok || time.Now().After(e.exp) {
		return nil, false
	}
	return e.v, true
}

func (c *cache) put(k string, v any, ttl time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.m[k] = entry{v: v, exp: time.Now().Add(ttl)}
}
