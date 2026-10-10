// Package server 暴露玉林公交实时查询的 HTTP 接口。
package server

import (
	"encoding/json"
	"log"
	"net/http"
	"strconv"

	"github.com/misakano7545/yulin-bus-activity/internal/panel"
	"github.com/misakano7545/yulin-bus-activity/internal/upstream"
)

// Config 是 handler 的依赖。
type Config struct {
	Upstream *upstream.Client
}

type handler struct {
	up *upstream.Client
}

// NewHandler 组装路由。
func NewHandler(cfg Config) http.Handler {
	h := &handler{up: cfg.Upstream}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", h.healthz)
	panel.Routes(mux)
	mux.HandleFunc("GET /lines", h.lines)
	mux.HandleFunc("GET /lines/{lineId}", h.route)
	mux.HandleFunc("GET /lines/{lineId}/realtime", h.realtime)
	return mux
}

func (h *handler) healthz(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, map[string]bool{"ok": true})
}

func (h *handler) lines(w http.ResponseWriter, r *http.Request) {
	v, err := h.up.Lines(r.Context())
	if err != nil {
		writeErr(w, err)
		return
	}
	// 静态目录里没有运营状态，把后台刷出来的贴上去（先进制造城专线这类名字没带停运的
	// 线路，列表才标得出来）。先拷一份 —— 缓存里那份是共享的，不能在 handler 里改。
	if st := h.up.LineStates(); len(st) > 0 {
		v = append([]upstream.Line(nil), v...)
		for i := range v {
			if s, ok := st[v[i].LineID]; ok {
				v[i].State, v[i].Desc, v[i].Count = s.State, s.Desc, s.Count
			}
		}
	}
	writeJSON(w, v)
}

func (h *handler) route(w http.ResponseWriter, r *http.Request) {
	v, err := h.up.Route(r.Context(), r.PathValue("lineId"))
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, v)
}

func (h *handler) realtime(w http.ResponseWriter, r *http.Request) {
	target := 0
	if s := r.URL.Query().Get("targetOrder"); s != "" {
		n, err := strconv.Atoi(s)
		if err != nil || n < 0 {
			http.Error(w, "targetOrder 必须是非负整数", http.StatusBadRequest)
			return
		}
		target = n
	}
	v, err := h.up.Realtime(r.Context(), r.PathValue("lineId"), target)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, v)
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
