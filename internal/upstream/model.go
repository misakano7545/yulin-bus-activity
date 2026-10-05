package upstream

import "time"

// Line 是 cityLineList 里的一条记录 —— 一条线的一个方向。
type Line struct {
	LineID    string `json:"lineId"`
	Name      string `json:"name"`
	Start     string `json:"start"`
	End       string `json:"end"`
	FirstTime string `json:"firstTime"`
	LastTime  string `json:"lastTime"`
}

// Stop 是线路上的一个站。
type Stop struct {
	ID    string  `json:"id"`
	Name  string  `json:"name"`
	Order int     `json:"order"`
	Lat   float64 `json:"lat"`
	Lng   float64 `json:"lng"`
}

// Route 是一条线的静态信息：站点序列 + 走向折线。
//
// ponytail: lineRoute 的 line 对象只有 lineId+name，票价/状态/描述都在详情接口里，
// 所以这里不放那几个字段（放了恒为空，比没有更糟）。
type Route struct {
	LineID string       `json:"lineId"`
	Name   string       `json:"name"`
	Stops  []Stop       `json:"stops"`
	Track  [][2]float64 `json:"track"` // [lng, lat]
}

// Bus 是归一化后的实时车辆。
type Bus struct {
	FleetNo    string    `json:"fleetNo"`    // 自编号
	RawID      string    `json:"rawId"`      // 上游 licence 原值（自编号或车牌）
	Confidence string    `json:"confidence"` // high=自编号可信；low=未知车牌，原样透出
	LineID     string    `json:"lineId"`
	Lat        float64   `json:"lat"`
	Lng        float64   `json:"lng"`
	Order      int       `json:"order"`       // 当前站序
	Target     int       `json:"targetOrder"` // 目标站序
	ETA        int       `json:"eta"`         // 到目标站秒数
	ArriveAt   string    `json:"arriveAt"`    // 到目标站时刻 HH:MM
	UpdatedAt  time.Time `json:"updatedAt"`
}

// Realtime 是一条线的实时快照。
type Realtime struct {
	LineID string `json:"lineId"`
	Price  string `json:"price"`
	State  int    `json:"state"` // 0 正常 / -1 等待发车 / -2 临时停运 / -3 末班已过
	Desc   string `json:"desc"`
	Buses  []Bus  `json:"buses"`
}
