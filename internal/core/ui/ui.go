package ui

import (
	"embed"
	"io/fs"
	"net/http"
	"path"
	"sort"
	"strings"

	corehttp "github.com/vercel-labs/emulate/internal/core/http"
)

//go:embed assets/*
var assets embed.FS

type PageOptions struct {
	Service string
	Prefix  string
}

type InspectorTab struct {
	ID     string
	Label  string
	Href   string
	Active bool
}

type UserButtonOptions struct {
	Letter       string
	Login        string
	Name         string
	Email        string
	FormAction   string
	HiddenFields map[string]string
}

func EscapeHTML(value string) string {
	replacer := strings.NewReplacer(
		"&", "&amp;",
		"<", "&lt;",
		">", "&gt;",
		`"`, "&quot;",
	)
	return replacer.Replace(value)
}

func EscapeAttr(value string) string {
	return strings.ReplaceAll(EscapeHTML(value), "'", "&#39;")
}

func RenderCardPage(title string, subtitle string, body string, opts PageOptions) string {
	return head(title, opts) + `<body>
` + emuBar(opts) + `
<div class="content">
  <div class="content-inner">
    <div class="card-title">` + EscapeHTML(title) + `</div>
    <div class="card-subtitle">` + subtitle + `</div>
    ` + body + `
  </div>
</div>
` + poweredBy + `
</body></html>`
}

func RenderErrorPage(title string, message string, opts PageOptions) string {
	return head(title, opts) + `<body>
` + emuBar(opts) + `
<div class="content">
  <div class="content-inner error-card">
    <div class="error-title">` + EscapeHTML(title) + `</div>
    <div class="error-msg">` + EscapeHTML(message) + `</div>
  </div>
</div>
` + poweredBy + `
</body></html>`
}

func RenderSettingsPage(title string, sidebarHTML string, bodyHTML string, opts PageOptions) string {
	return head(title, opts) + `<body>
` + emuBar(opts) + `
<div class="settings-layout">
  <nav class="settings-sidebar">` + sidebarHTML + `</nav>
  <main class="settings-main">` + bodyHTML + `</main>
</div>
` + poweredBy + `
</body></html>`
}

func RenderInspectorPage(title string, tabs []InspectorTab, activeTab string, body string, opts PageOptions) string {
	var links strings.Builder
	for _, tab := range tabs {
		className := ""
		if tab.Active || tab.ID == activeTab {
			className = ` class="active"`
		}
		links.WriteString(`<a href="`)
		links.WriteString(EscapeAttr(tab.Href))
		links.WriteString(`"`)
		links.WriteString(className)
		links.WriteString(`>`)
		links.WriteString(EscapeHTML(tab.Label))
		links.WriteString(`</a>`)
	}

	return head(title, opts) + `<body>
` + emuBar(opts) + `
<div class="inspector-layout">
  <nav class="inspector-tabs">` + links.String() + `</nav>
  ` + body + `
</div>
` + poweredBy + `
</body></html>`
}

func RenderFormPostPage(action string, fields map[string]string, opts PageOptions) string {
	keys := make([]string, 0, len(fields))
	for key := range fields {
		keys = append(keys, key)
	}
	sort.Strings(keys)

	var hidden strings.Builder
	for _, key := range keys {
		hidden.WriteString(`<input type="hidden" name="`)
		hidden.WriteString(EscapeAttr(key))
		hidden.WriteString(`" value="`)
		hidden.WriteString(EscapeAttr(fields[key]))
		hidden.WriteString(`"/>`)
		hidden.WriteByte('\n')
	}

	return head("Redirecting", opts) + `<body onload="document.forms[0].submit()">
` + emuBar(opts) + `
<div class="content">
  <div class="content-inner center">
    <div class="card-subtitle">Redirecting...</div>
    <form method="POST" action="` + EscapeAttr(action) + `">
` + hidden.String() + `    <noscript><button type="submit" class="user-btn continue-btn"><span class="user-login">Continue</span></button></noscript>
    </form>
  </div>
</div>
` + poweredBy + `
</body></html>`
}

func RenderUserButton(opts UserButtonOptions) string {
	keys := make([]string, 0, len(opts.HiddenFields))
	for key := range opts.HiddenFields {
		keys = append(keys, key)
	}
	sort.Strings(keys)

	var hidden strings.Builder
	for _, key := range keys {
		hidden.WriteString(`<input type="hidden" name="`)
		hidden.WriteString(EscapeAttr(key))
		hidden.WriteString(`" value="`)
		hidden.WriteString(EscapeAttr(opts.HiddenFields[key]))
		hidden.WriteString(`"/>`)
	}

	nameLine := ""
	if opts.Name != "" {
		nameLine = `<div class="user-meta">` + EscapeHTML(opts.Name) + `</div>`
	}
	emailLine := ""
	if opts.Email != "" {
		emailLine = `<div class="user-email">` + EscapeHTML(opts.Email) + `</div>`
	}

	return `<form class="user-form" method="post" action="` + EscapeAttr(opts.FormAction) + `">
` + hidden.String() + `
<button type="submit" class="user-btn">
  <span class="avatar">` + EscapeHTML(opts.Letter) + `</span>
  <span class="user-text">
    <span class="user-login">` + EscapeHTML(opts.Login) + `</span>
    ` + nameLine + emailLine + `
  </span>
</button>
</form>`
}

func RegisterAssetRoutes(router *corehttp.Router) {
	router.Get("/_emulate/fonts/:name", func(c *corehttp.Context) {
		name := path.Base(c.Param("name"))
		serveAsset(c, "assets/"+name)
	})
	router.Get("/_emulate/favicon.ico", func(c *corehttp.Context) {
		serveAsset(c, "assets/favicon.ico")
	})
}

func AssetFS() fs.FS {
	sub, err := fs.Sub(assets, "assets")
	if err != nil {
		panic(err)
	}
	return sub
}

func serveAsset(c *corehttp.Context, filename string) {
	raw, err := assets.ReadFile(filename)
	if err != nil {
		c.JSON(http.StatusNotFound, map[string]any{"message": "Not Found"})
		return
	}
	contentType := mimeType(filename)
	c.Binary(http.StatusOK, contentType, raw)
}

func head(title string, opts PageOptions) string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<link rel="icon" href="` + EscapeAttr(assetPath(opts, "/_emulate/favicon.ico")) + `"/>
<title>` + EscapeHTML(title) + ` | emulate</title>
<style>` + css(opts) + `</style>
</head>`
}

func emuBar(opts PageOptions) string {
	title := "Emulator"
	if opts.Service != "" {
		title = opts.Service + " Emulator"
	}
	return `<div class="emu-bar">
  <span class="emu-bar-title">` + EscapeHTML(title) + `</span>
  <nav class="emu-bar-links">
    <a href="https://github.com/vercel-labs/emulate/issues" target="_blank" rel="noopener"><span class="full">Report Issue</span><span class="short">Report</span></a>
    <a href="https://github.com/vercel-labs/emulate" target="_blank" rel="noopener"><span class="full">Source Code</span><span class="short">Source</span></a>
    <a href="https://emulate.dev" target="_blank" rel="noopener"><span class="full">Learn More</span><span class="short">Learn</span></a>
  </nav>
</div>`
}

func css(opts PageOptions) string {
	fontPath := assetPath(opts, "/_emulate/fonts/geist-sans.woff2")
	pixelPath := assetPath(opts, "/_emulate/fonts/GeistPixel-Square.woff2")
	return `
@font-face{font-family:'Geist';font-style:normal;font-weight:100 900;font-display:swap;src:url('` + EscapeAttr(fontPath) + `') format('woff2');}
@font-face{font-family:'Geist Pixel';font-style:normal;font-weight:400;font-display:swap;src:url('` + EscapeAttr(pixelPath) + `') format('woff2');}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Geist',-apple-system,BlinkMacSystemFont,sans-serif;background:#000;color:#33ff00;min-height:100vh;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;}
.emu-bar{border-bottom:1px solid #0a3300;padding:10px 20px;display:flex;align-items:center;gap:10px;font-size:.8125rem;color:#1a8c00;}
.emu-bar-title{font-weight:600;color:#33ff00;font-family:'Geist Pixel',monospace;}
.emu-bar-links{margin-left:auto;display:flex;gap:16px;}
.emu-bar-links a{color:#1a8c00;font-size:.75rem;text-decoration:none;transition:color .15s;}
.emu-bar-links a:hover{color:#33ff00;}
.emu-bar-links a .full{display:inline;}.emu-bar-links a .short{display:none;}
@media(max-width:600px){.emu-bar-links a .full{display:none;}.emu-bar-links a .short{display:inline;}}
.content{display:flex;align-items:center;justify-content:center;min-height:calc(100vh - 42px);padding:24px 16px;}
.content-inner{width:100%;max-width:420px;}
.center{text-align:center;}
.card-title{font-family:'Geist Pixel',monospace;font-size:1.125rem;font-weight:600;margin-bottom:4px;color:#33ff00;}
.card-subtitle{color:#1a8c00;font-size:.8125rem;margin-bottom:18px;line-height:1.45;}
.powered-by{position:fixed;bottom:0;left:0;right:0;text-align:center;padding:12px;font-size:.6875rem;color:#0a3300;font-family:'Geist Pixel',monospace;}
.powered-by a{color:#1a8c00;text-decoration:none;transition:color .15s;}
.powered-by a:hover{color:#33ff00;}
.error-title{font-family:'Geist Pixel',monospace;color:#ff4444;font-size:1.125rem;font-weight:600;margin-bottom:8px;}
.error-msg{color:#1a8c00;font-size:.875rem;line-height:1.5;}
.error-card{text-align:center;}
.user-form{margin-bottom:8px;}.user-form:last-of-type{margin-bottom:0;}
.user-btn{width:100%;display:flex;align-items:center;gap:12px;padding:10px 12px;border:1px solid #0a3300;border-radius:8px;background:#000;color:inherit;cursor:pointer;text-align:left;font:inherit;transition:border-color .15s;}
.user-btn:hover{border-color:#33ff00;}
.continue-btn{margin-top:12px;justify-content:center;}
.avatar{width:36px;height:36px;border-radius:50%;background:#0a3300;color:#33ff00;font-weight:600;font-size:.875rem;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-family:'Geist Pixel',monospace;}
.user-text{min-width:0;}.user-login{font-weight:600;font-size:.875rem;display:block;color:#33ff00;}
.user-meta{color:#1a8c00;font-size:.75rem;margin-top:1px;}
.user-email{font-size:.6875rem;color:#116600;word-break:break-all;margin-top:1px;}
.settings-layout{max-width:920px;margin:0 auto;padding:28px 20px;display:flex;gap:28px;}
.settings-sidebar{width:200px;flex-shrink:0;}
.settings-sidebar a{display:block;padding:6px 10px;border-radius:6px;color:#1a8c00;text-decoration:none;font-size:.8125rem;transition:color .15s;}
.settings-sidebar a:hover,.settings-sidebar a.active{color:#33ff00;}
.settings-main{flex:1;min-width:0;}
.s-card{padding:18px 0;margin-bottom:14px;border-bottom:1px solid #0a3300;}
.s-card:last-child{border-bottom:none;}
.section-heading{font-size:.9375rem;font-weight:600;margin-bottom:10px;color:#33ff00;display:flex;align-items:center;justify-content:space-between;}
.badge{font-size:.6875rem;padding:1px 7px;border-radius:999px;font-weight:500;background:#0a3300;color:#33ff00;}
.empty{color:#1a8c00;text-align:center;padding:28px 0;font-size:.875rem;}
.inspector-layout{max-width:960px;margin:0 auto;padding:28px 20px;}
.inspector-tabs{display:flex;gap:4px;margin-bottom:20px;}
.inspector-tabs a{padding:7px 16px;border-radius:6px;text-decoration:none;font-size:.8125rem;color:#1a8c00;border:1px solid transparent;transition:color .15s,border-color .15s;}
.inspector-tabs a:hover{color:#33ff00;}
.inspector-tabs a.active{color:#33ff00;font-weight:600;border-color:#0a3300;background:#0a3300;}
.inspector-section{margin-bottom:24px;}
.inspector-section h2{font-family:'Geist Pixel',monospace;font-size:1rem;font-weight:600;color:#33ff00;margin-bottom:10px;}
.inspector-section h3{font-family:'Geist Pixel',monospace;font-size:.875rem;font-weight:600;color:#1a8c00;margin:16px 0 8px;}
.inspector-table{width:100%;border-collapse:collapse;margin-bottom:12px;}
.inspector-table th,.inspector-table td{text-align:left;padding:8px 12px;border-bottom:1px solid #0a3300;font-size:.8125rem;}
.inspector-table th{color:#1a8c00;font-weight:600;font-size:.75rem;text-transform:uppercase;letter-spacing:.04em;}
.inspector-table td{color:#33ff00;}
.inspector-table a{color:#33ff00;text-decoration:none;}
.inspector-table a:hover{text-decoration:underline;}
.inspector-table tbody tr{transition:background .1s;}
.inspector-table tbody tr:hover{background:#0a3300;}
.inspector-empty{color:#1a8c00;text-align:center;padding:20px 0;font-size:.8125rem;}
.email-preview-frame{width:100%;min-height:300px;border:1px solid #0a3300;border-radius:8px;background:#fff;}
.email-preview-text{white-space:pre-wrap;word-break:break-word;color:#33ff00;font:inherit;}
`
}

const poweredBy = `<div class="powered-by">Powered by <a href="https://emulate.dev" target="_blank" rel="noopener">emulate</a></div>`

func assetPath(opts PageOptions, target string) string {
	prefix := strings.TrimRight(opts.Prefix, "/")
	if prefix == "" {
		return target
	}
	if !strings.HasPrefix(prefix, "/") {
		prefix = "/" + prefix
	}
	return prefix + target
}

func mimeType(filename string) string {
	switch strings.ToLower(path.Ext(filename)) {
	case ".woff2":
		return "font/woff2"
	case ".ico":
		return "image/x-icon"
	default:
		return "application/octet-stream"
	}
}
