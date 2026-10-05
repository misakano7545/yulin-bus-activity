// main.go yulin-bus-activity 入口：加载车牌映射、装配 upstream 与 HTTP 服务。
package main

import (
	"flag"
	"log"
	"net/http"

	"github.com/misakano7545/yulin-bus-activity/internal/plate"
	"github.com/misakano7545/yulin-bus-activity/internal/server"
	"github.com/misakano7545/yulin-bus-activity/internal/upstream"
)

func main() {
	addr := flag.String("addr", ":8080", "监听地址")
	platePath := flag.String("plate-map", "plate_map.json", "车牌→自编号映射表")
	flag.Parse()

	plates, err := plate.Load(*platePath)
	if err != nil {
		// 表缺失不致命：非纯数字的 licence 会原样透出 + 记日志，跑一轮就能收齐待补项。
		log.Printf("车牌映射表未加载 (%v)", err)
	}
	log.Printf("车牌映射表: %d 条", plates.Len())

	log.Printf("监听 %s", *addr)
	log.Fatal(http.ListenAndServe(*addr, server.NewHandler(server.Config{
		Upstream: upstream.New(plates),
	})))
}
