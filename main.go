package main

import (
	"encoding/json"
	"flag"
	"log"
	"net/http"
)

var client *Client

func main() {
	addr := flag.String("addr", ":8080", "监听地址")
	platePath := flag.String("plate-map", "plate_map.json", "车牌→自编号映射表")
	flag.Parse()

	loadPlateMap(*platePath)
	client = NewClient()

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]bool{"ok": true})
	})
	mux.HandleFunc("GET /lines", handleLines)
	mux.HandleFunc("GET /lines/{lineId}", handleRoute)
	mux.HandleFunc("GET /lines/{lineId}/realtime", handleRealtime)

	log.Printf("监听 %s", *addr)
	log.Fatal(http.ListenAndServe(*addr, mux))
}

func handleLines(w http.ResponseWriter, r *http.Request) {
	lines, err := client.Lines(r.Context())
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, lines)
}

func handleRoute(w http.ResponseWriter, r *http.Request) {
	rt, err := client.Route(r.Context(), r.PathValue("lineId"))
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, rt)
}

func handleRealtime(w http.ResponseWriter, r *http.Request) {
	rt, err := client.Realtime(r.Context(), r.PathValue("lineId"))
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, rt)
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	if err := enc.Encode(v); err != nil {
		log.Printf("写响应失败: %v", err)
	}
}

// writeErr 上游异常一律 502 + 明确原因 —— 绝不返回空数组假装「没车」。
func writeErr(w http.ResponseWriter, err error) {
	log.Printf("上游错误: %v", err)
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusBadGateway)
	json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
}
