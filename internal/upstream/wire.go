package upstream

// 上游报文结构。只在本包内用，不导出 —— 对外一律走 model.go 的归一化类型。

type wireLine struct {
	LineID    string `json:"lineId"`
	LineName  string `json:"lineName"`
	StartStop string `json:"startStopName"`
	EndStop   string `json:"endStopName"`
	FirstTime string `json:"firstTime"`
	LastTime  string `json:"lastTime"`
}

type wireStop struct {
	SID    string  `json:"sId"`
	SN     string  `json:"sn"`
	Order  int     `json:"order"`
	Lat    float64 `json:"lat"`    // bd 基准
	Lng    float64 `json:"lng"`    // bd 基准
	WgsLat float64 `json:"wgsLat"` // 与车辆 lat/lng 同基准
	WgsLng float64 `json:"wgsLng"`
}

type wirePoint struct {
	Lng float64 `json:"lng"`
	Lat float64 `json:"lat"`
	// StopOrder 标记「这个折线点就是第 N 站」；非站点为 0。
	// 上游只在站边界点带它，靠它把折线切成站间段。
	StopOrder int `json:"stopOrder"`
}

type wireMeta struct {
	LineID  string `json:"lineId"`
	Name    string `json:"name"`
	Price   string `json:"price"`
	State   int    `json:"state"`
	Desc    string `json:"desc"`
	StartSn string `json:"startSn"`
	EndSn   string `json:"endSn"`
}

type wireRoute struct {
	Route    []wirePoint `json:"route"`
	Stations []wireStop  `json:"stations"`
	Line     wireMeta    `json:"line"`
}

type wireBus struct {
	Licence string  `json:"licence"`
	BusID   string  `json:"busId"`
	State   int     `json:"state"` // 0 在途，1 已到站（H5 的 BUS_STATE）
	Lat     float64 `json:"lat"`
	Lng     float64 `json:"lng"`
	Order   int     `json:"order"`
	Travels []struct {
		Order      int    `json:"order"`
		TravelTime int    `json:"travelTime"`
		RecommTip  string `json:"recommTip"`
	} `json:"travels"`
}

type wireDetail struct {
	Line     wireMeta   `json:"line"`
	Stations []wireStop `json:"stations"`
	Buses    []wireBus  `json:"buses"`
	Target   int        `json:"targetOrder"`
}
