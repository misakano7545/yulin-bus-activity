// main.go yulin-bus-activity 入口：加载车牌映射、装配 upstream 与 HTTP 服务。
package main

import (
	"flag"
	"log"
	"net/http"
	"os"

	"github.com/misakano7545/yulin-bus-activity/internal/plate"
	"github.com/misakano7545/yulin-bus-activity/internal/server"
	"github.com/misakano7545/yulin-bus-activity/internal/upstream"
)

func main() {
	addr := flag.String("addr", ":8080", "监听地址")
	platePath := flag.String("plate-map", "plate_map.json", "车牌→自编号映射表")
	// 高德 key 走环境变量（默认值），命令行只是覆盖手段 —— 免得 key 出现在 ps 里。
	amapKey := flag.String("amap-key", os.Getenv("YBA_AMAP_KEY"), "高德 JS API key（面板底图用）")
	amapSec := flag.String("amap-security", os.Getenv("YBA_AMAP_SECURITY"), "高德 securityJsCode（2021-12 后创建的 key 才需要）")
	flag.Parse()

	plates, err := plate.Load(*platePath)
	if err != nil {
		// 表缺失不致命：非纯数字的 licence 会原样透出 + 记日志，跑一轮就能收齐待补项。
		log.Printf("车牌映射表未加载 (%v)", err)
	}
	log.Printf("车牌映射表: %d 条", plates.Len())
	amapState := "未配置（YBA_AMAP_KEY）—— 面板底图会提示未配置"
	if *amapKey != "" {
		amapState = "已配置"
		if *amapSec != "" {
			amapState += "（含安全密钥）"
		}
	}
	log.Printf("高德 key: %s", amapState)

	log.Printf("监听 %s", *addr)
	log.Fatal(http.ListenAndServe(*addr, server.NewHandler(server.Config{
		Upstream:     upstream.New(plates),
		AmapKey:      *amapKey,
		AmapSecurity: *amapSec,
	})))
}
