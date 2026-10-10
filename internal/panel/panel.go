// Package panel 提供实时公交查询面板。
//
// 资源经 go:embed 打进二进制（随服务部署，无外部构建步骤）：
//   - index.html  页面骨架与样式
//   - app.js      全部前端逻辑（独立文件而非内联，为了启用无需 unsafe-inline 的严格 CSP）
//
// 页面不再依赖任何外部脚本（原来是高德底图，改成走向条后整套删了），
// 所以 CSP 回到最紧的一档：无 unsafe-eval、无外部域。
package panel

import (
	_ "embed"
	"net/http"
)

//go:embed index.html
var indexHTML []byte

//go:embed app.js
var appJS []byte

// csp 无需 unsafe-inline：页面无内联脚本、无内联事件处理器。
// style-src 的 'unsafe-inline' 是页面自己那个 <style> 块要的，别顺手也给
// script-src 加上 —— 那才是真正会把 CSP 废掉的一项。
const csp = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
	"connect-src 'self'; img-src 'self' data:; " +
	"form-action 'none'; frame-ancestors 'none'; base-uri 'none'"

func setSecurityHeaders(w http.ResponseWriter) {
	w.Header().Set("Content-Security-Policy", csp)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Frame-Options", "DENY")
	w.Header().Set("Referrer-Policy", "no-referrer")
}

// Routes 把面板挂到 mux 上。数据接口复用 server 已有的 /lines*。
func Routes(mux *http.ServeMux) {
	mux.HandleFunc("GET /{$}", serve(indexHTML, "text/html; charset=utf-8"))
	mux.HandleFunc("GET /app.js", serve(appJS, "text/javascript; charset=utf-8"))
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
