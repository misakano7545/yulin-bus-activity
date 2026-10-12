package mygolbs

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/misakano7545/yulin-bus-activity/internal/plate"
	"github.com/misakano7545/yulin-bus-activity/internal/upstream"
)

// testdata/ 里是 2026-10-12 08:30–08:31（CST）从 h5.mygolbs.com 抓的真实响应，
// 未经改动：北流105路两个方向的 103 站表，以及 104 实时（按终点站 / 第 10 站 / 第 1 站问的
// 三次）。断言里的车牌、站序、分钟数都是那几份抓包里读出来的，不是编的。

// newTestClient 起一个替身上游，按 CMD/DIRECTION[/STATIONORDER] 回对应的抓包。
// 顺带断言每个请求都带了 Origin —— 缺了它上游永远回同一个 47 字节网关串，是这套接口最容易踩的坑。
func newTestClient(t *testing.T) *Client {
	t.Helper()
	// 注意：这个假上游不看 LINENAME，任何线路都回同一份北流105路的抓包 —— 够验字段映射，
	// 但别拿它断言某条线的站名。
	files := map[string]string{
		"103/1":    "103_dir1.json",
		"103/2":    "103_dir2.json",
		"104/1/1":  "104_dir1_so1.json",
		"104/1/10": "104_dir1_so10.json",
		"104/1/24": "104_dir1_so24.json",
		"104/2/24": "104_dir2_so24.json",
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Origin"); got != origin {
			t.Errorf("Origin = %q，应为 %q", got, origin)
		}
		_ = r.ParseForm()
		key := r.PostForm.Get("CMD") + "/" + r.PostForm.Get("DIRECTION")
		if r.PostForm.Get("CMD") == "104" {
			key += "/" + r.PostForm.Get("STATIONORDER")
		}
		name, ok := files[key]
		if !ok {
			t.Errorf("没预备这个请求: %s", key)
			http.Error(w, "unexpected", http.StatusBadRequest)
			return
		}
		b, err := os.ReadFile("testdata/" + name)
		if err != nil {
			t.Errorf("读抓包 %s: %v", name, err)
			return
		}
		if _, err := w.Write(b); err != nil {
			t.Errorf("写响应: %v", err)
		}
	}))
	t.Cleanup(srv.Close)

	c := New(nil)
	c.base = srv.URL
	return c
}

func TestRoute(t *testing.T) {
	rt, err := newTestClient(t).Route(context.Background(), "mg40105-1")
	if err != nil {
		t.Fatalf("Route: %v", err)
	}
	if rt.Name != "北流105路" {
		t.Errorf("name = %q", rt.Name)
	}
	if len(rt.Stops) != 24 {
		t.Fatalf("站数 = %d，抓包里是 24", len(rt.Stops))
	}
	for i, s := range rt.Stops {
		if s.Order != i+1 {
			t.Errorf("第 %d 个站 order = %d，站序应是 1 基且连续", i, s.Order)
		}
	}
	if got := rt.Stops[0].Name; got != "北流城南站" {
		t.Errorf("首站 = %q", got)
	}
	if got := rt.Stops[23].Name; got != "玉林北站" {
		t.Errorf("末站 = %q", got)
	}
	if rt.Stops[23].Lat == 0 || rt.Stops[23].Lng == 0 {
		t.Error("末站缺坐标 —— 车辆在两站之间插值要用")
	}
}

// target=0 时按终点站的站序问（掌上公交没有「到终点」这个入参）。
func TestRealtimeToTerminus(t *testing.T) {
	rt, err := newTestClient(t).Realtime(context.Background(), "mg40105-1", 0)
	if err != nil {
		t.Fatalf("Realtime: %v", err)
	}
	if rt.State != 0 || rt.Desc != "" {
		t.Errorf("state = %d desc = %q，runState=0/hasReal=1 应是正常运营", rt.State, rt.Desc)
	}
	if rt.Price != "4元" {
		t.Errorf("票价 = %q，commonts 里写的是「票价：4元」", rt.Price)
	}
	if len(rt.Buses) != 3 {
		t.Fatalf("车数 = %d，抓包里是 3", len(rt.Buses))
	}
	by := map[string]upstream.Bus{}
	for _, b := range rt.Buses {
		by[b.FleetNo] = b
		if b.Confidence != "high" {
			t.Errorf("%s confidence = %q：车牌就是这条数据面的车辆标识，不该标低可信", b.FleetNo, b.Confidence)
		}
		if b.Order < 1 || b.Order > 24 {
			t.Errorf("%s order = %d，越界", b.FleetNo, b.Order)
		}
		if b.UpdatedAt.Unix() != 1791765057 {
			t.Errorf("%s updatedAt = %v，应取该车的 _recTime（抓包 2026-10-12 08:30:57 CST）", b.FleetNo, b.UpdatedAt)
		}
	}

	// statusType "0" = 已到站（官方包注释「到站的直接赋值为最近站」）：钉在站上，且这一站
	// 没有它的到站预测（每站只回最近 2 辆）。
	if b := by["桂KR8698"]; b.Order != 6 || b.State != 1 || b.Pos != 1 || b.ETA != 0 {
		t.Errorf("桂KR8698（停在北流汽车总站）= %+v", b)
	}
	// 在途：index 是 0 基（16 → 第 17 站），ETA = 上游给的 21.0 分钟 × 60。
	if b := by["桂K08258D"]; b.Order != 17 || b.State != 0 || b.ETA != 1260 {
		t.Errorf("桂K08258D = %+v", b)
	} else if b.Pos <= 0.05 || b.Pos >= 0.15 {
		t.Errorf("桂K08258D pos = %.3f，按抓包坐标投影应是 0.10 上下（凉水井→田心市场之间）", b.Pos)
	}
	if b := by["桂KU0806"]; b.Order != 24 || b.ETA != 360 {
		t.Errorf("桂KU0806（开往玉林北站，6 分钟）= %+v", b)
	} else if b.Pos <= 0 || b.Pos >= 1 {
		t.Errorf("桂KU0806 pos = %.3f，超出两站之间", b.Pos)
	}
}

// 点站时按该站问：上游只给最近 2 辆车的预测，其余车辆没有 ETA（透出 0，前端显示「无预测」）。
func TestRealtimeToStation(t *testing.T) {
	c := newTestClient(t)
	rt, err := c.Realtime(context.Background(), "mg40105-1", 10)
	if err != nil {
		t.Fatalf("Realtime: %v", err)
	}
	got := map[string]int{}
	for _, b := range rt.Buses {
		got[b.FleetNo] = b.ETA
	}
	// 抓包里第 10 站只回了一条：桂KR8698 还有 4 站、3 分钟。
	if got["桂KR8698"] != 180 {
		t.Errorf("桂KR8698 ETA = %d，抓包里是 3 分钟 → 180 秒", got["桂KR8698"])
	}
	if got["桂K08258D"] != 0 || got["桂KU0806"] != 0 {
		t.Errorf("另外两辆已过第 10 站，不该有 ETA: %v", got)
	}

	// 始发站：上游回的是「等待发车」那条，没有车牌 —— 对不到任何车上，谁都不该有 ETA。
	rt, err = c.Realtime(context.Background(), "mg40105-1", 1)
	if err != nil {
		t.Fatalf("Realtime(1): %v", err)
	}
	for _, b := range rt.Buses {
		if b.ETA != 0 {
			t.Errorf("%s ETA = %d，「等待发车」那条没有车牌，不该对到车上", b.FleetNo, b.ETA)
		}
	}
}

func TestLines(t *testing.T) {
	c := newTestClient(t)
	ls, err := c.Lines(context.Background())
	if err != nil {
		t.Fatalf("Lines: %v", err)
	}
	if len(ls) != len(catalog) {
		t.Fatalf("线路数 = %d，目录里是 %d 个方向", len(ls), len(catalog))
	}
	// 目录里每条都要在 /lines 里出现 ID 与线路名对得上的一行 —— 加县市线路时不用改这段
	for i, s := range catalog {
		if ls[i].LineID != s.ID || ls[i].Name != s.LineName || ls[i].Src != srcName {
			t.Errorf("第 %d 条 = %+v，目录里是 %+v", i, ls[i], s)
		}
	}
	fst := ls[0]
	if fst.LineID != "mg40105-1" || fst.Name != "北流105路" || fst.Src != "掌上公交" {
		t.Errorf("第 1 条 = %+v", fst)
	}
	if fst.Start != "北流城南站" || fst.End != "玉林北站" {
		t.Errorf("首末站 = %q → %q", fst.Start, fst.End)
	}
	if fst.FirstTime != "07:00" || fst.LastTime != "18:00" || fst.Count != 3 {
		t.Errorf("首末班/车辆数 = %s %s / %d", fst.FirstTime, fst.LastTime, fst.Count)
	}
	// 反向的首末班是另一套（07:30–19:50），不是两个方向合并的
	if ls[1].Start != "玉林北站" || ls[1].FirstTime != "07:30" || ls[1].LastTime != "19:50" {
		t.Errorf("第 2 条 = %+v", ls[1])
	}

	// 第二次读的是缓存，不该再打上游
	c.base = "http://127.0.0.1:1/ApiData.do"
	if _, err := c.Lines(context.Background()); err != nil {
		t.Errorf("一分钟内应走缓存: %v", err)
	}
}

func TestHandles(t *testing.T) {
	if !Handles("mg40105-1") {
		t.Error("掌上公交的 lineId 应被认领")
	}
	if !Handles("mg1011-2") {
		t.Error("陆川1路的 lineId 应被认领")
	}
	if Handles("775200849296") {
		t.Error("车来了的 lineId（纯数字）不该被认领")
	}
	if _, err := New(nil).Route(context.Background(), "775200849296"); err == nil {
		t.Error("不认识的 lineId 该报错")
	}
}

func TestUpstreamFailure(t *testing.T) {
	// 上游失败也是 HTTP 200，status 是字符串 "-1"，原因在 msg 里。
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"status":"-1","msg":"暂无数据信息！"}`))
	}))
	defer srv.Close()
	c := New(nil)
	c.base = srv.URL
	_, err := c.Route(context.Background(), "mg40105-1")
	if err == nil || !strings.Contains(err.Error(), "暂无数据信息") {
		t.Errorf("err = %v，应带上游的 msg", err)
	}
}

func TestGateBlob(t *testing.T) {
	// 缺 Origin 时上游回的就是这串，报错要指得出来（别当成「没车」）。
	const blob = "0vx0czK73ykwCHaLBTiKh0iCXQINzRvSZw4+b/H8FgE52U="
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(blob))
	}))
	defer srv.Close()
	c := New(nil)
	c.base = srv.URL
	_, err := c.Route(context.Background(), "mg40105-1")
	if err == nil || !strings.Contains(err.Error(), "Origin") {
		t.Errorf("err = %v，应提示多半是 Origin 头的问题", err)
	}
}

func TestLineState(t *testing.T) {
	// 官方 H5 包 showRealTimeInfo：runState=1 该线路已停运，hasReal=0 未开通实时查询。
	if s, d := lineState(1, 1); s != -2 || d == "" {
		t.Errorf("runState=1 → %d %q，应是停运", s, d)
	}
	if s, d := lineState(0, 0); s != 1 || d == "" {
		t.Errorf("hasReal=0 → %d %q，面板已知值里没有「未开通实时查询」，得靠 desc 透出", s, d)
	}
	if s, d := lineState(0, 1); s != 0 || d != "" {
		t.Errorf("正常运营 → %d %q", s, d)
	}
}

func TestPriceOf(t *testing.T) {
	for _, tc := range []struct{ in, want string }{
		{"票价：4元  北流汽车总站的首班车6：30，末班车18：40", "4元"},
		{"票价:2元", "2元"},
		{"", ""},
		{"上车请投币2元", ""}, // 这句里没有「票价：」，不该瞎摘
	} {
		if got := priceOf(tc.in); got != tc.want {
			t.Errorf("priceOf(%q) = %q，应为 %q", tc.in, got, tc.want)
		}
	}
}

// 站表缓存：/lines/{id} 与 /realtime 都要站表，而前端每 10 秒刷一次 —— 103 不能跟着重问。
func TestRouteDataCached(t *testing.T) {
	c := newTestClient(t)
	for _, target := range []int{1, 10, 24} {
		if _, err := c.Realtime(context.Background(), "mg40105-1", target); err != nil {
			t.Fatalf("Realtime(%d): %v", target, err)
		}
	}
	c.mu.Lock()
	n, at := len(c.routes), c.routes["mg40105-1"].at
	c.mu.Unlock()
	if n != 1 {
		t.Errorf("站表缓存 %d 条，三次实时请求该共用同一条", n)
	}
	if time.Since(at) > time.Minute {
		t.Errorf("站表缓存是 %v 前写的，应当是刚取的那份", time.Since(at))
	}
}

// 给了映射表就归一：FleetNo 取自编号，RawID 留上游的车牌 —— 出问题还能对回上游。
// 表里没有的车牌（北流105路那几辆）原样透出，见 TestRealtimeToTerminus 那几条断言。
func TestRealtimeUsesPlateMap(t *testing.T) {
	tab, err := plate.Load("testdata/plate_map.json")
	if err != nil {
		t.Fatalf("读测试映射表: %v", err)
	}
	c := newTestClient(t)
	c.plates = tab
	rt, err := c.Realtime(context.Background(), "mg40105-1", 0)
	if err != nil {
		t.Fatalf("Realtime: %v", err)
	}
	by := map[string]upstream.Bus{}
	for _, b := range rt.Buses {
		by[b.FleetNo] = b
	}
	b, ok := by["399"]
	if !ok {
		t.Fatalf("桂KR8698 应归一成 399，实际编号: %v", keys(by))
	}
	if b.RawID != "桂KR8698" {
		t.Errorf("rawId = %q，应留上游的车牌", b.RawID)
	}
	if b.ETA != 0 || b.Order != 6 {
		t.Errorf("归一不该动别的字段: %+v", b)
	}
}

func keys(m map[string]upstream.Bus) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
