// Package panel 提供实时公交查询面板。
//
// 资源经 go:embed 打进二进制（随服务部署，无外部构建步骤）：
//   - index.html  页面骨架与样式
//   - app.js      全部前端逻辑（独立文件而非内联，为了启用无需 unsafe-inline 的严格 CSP）
//
// 底图用高德 JS API。key 不进 embed（否则会随 app.js/index.html 进 git），
// 由服务端从环境变量读入后经 /amap.js 下发。
package panel

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"net/http"
)

//go:embed index.html
var indexHTML []byte

//go:embed app.js
var appJS []byte

// csp 无需 unsafe-inline：页面无内联脚本、无内联事件处理器。
//
// 高德 JS API 2.0 是唯一的例外，且是硬需求：它的模块加载器用 eval 解析插件
//（实测 script-src 只放域名不放 'unsafe-eval' 时，map 建得出来但一张瓦片都不画，
// 控制台报 EvalError）。所以 script-src 必须带 'unsafe-eval'。
// 域名放 *.amap.com 而不是只放 webapi.amap.com：渲染插件、主题、埋点分别来自
// jsapi-service.amap.com / jsapi.amap.com / restapi.amap.com；瓦片来自 *.autonavi.com。
// 'unsafe-inline' 不需要，别顺手加 —— 那才是真正会把 CSP 废掉的一项。
const csp = "default-src 'none'; script-src 'self' https://*.amap.com 'unsafe-eval'; " +
	"style-src 'self' 'unsafe-inline' https://*.amap.com; " +
	"connect-src 'self' https://*.amap.com https://*.autonavi.com; " +
	"img-src 'self' data: blob: https://*.amap.com https://*.autonavi.com; " +
	"font-src 'self' https://*.amap.com; worker-src 'self' blob:; " +
	"form-action 'none'; frame-ancestors 'none'; base-uri 'none'"

func setSecurityHeaders(w http.ResponseWriter) {
	w.Header().Set("Content-Security-Policy", csp)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Frame-Options", "DENY")
	w.Header().Set("Referrer-Policy", "no-referrer")
}

// Routes 把面板挂到 mux 上。数据接口复用 server 已有的 /lines*。
func Routes(mux *http.ServeMux, amapKey, amapSecurity string) {
	mux.HandleFunc("GET /{$}", serve(indexHTML, "text/html; charset=utf-8"))
	mux.HandleFunc("GET /app.js", serve(appJS, "text/javascript; charset=utf-8"))
	mux.HandleFunc("GET /amap.js", amapConfig(amapKey, amapSecurity))
}

// amapConfig 把高德 key 下发给前端。JSON 编码值而不是拼字符串，免得配置里
// 混进引号就变成注入点。
func amapConfig(key, security string) http.HandlerFunc {
	body, err := json.Marshal(struct {
		Key      string `json:"key"`
		Security string `json:"security,omitempty"`
	}{Key: key, Security: security})
	if err != nil { // 两个 string 字段不可能编不出来，兜底成空配置
		body = []byte(`{}`)
	}
	return func(w http.ResponseWriter, r *http.Request) {
		setSecurityHeaders(w)
		w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = fmt.Fprintf(w, "window.YBA_AMAP=%s;\n", body)
	}
}

func serve(body []byte, ct string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		setSecurityHeaders(w)
		w.Header().Set("Content-Type", ct)
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(body)
	}
}
