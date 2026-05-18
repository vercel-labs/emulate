package corehttp

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	pathpkg "path"
	"strings"
	"sync"
	"sync/atomic"
)

type HandlerFunc func(*Context)

type Middleware func(HandlerFunc) HandlerFunc

type Context struct {
	Writer    http.ResponseWriter
	Request   *http.Request
	Params    map[string]string
	requestID string
}

func (c *Context) Param(name string) string {
	return c.Params[name]
}

func (c *Context) Query(name string) string {
	return c.Request.URL.Query().Get(name)
}

func (c *Context) Header(name string) string {
	return c.Request.Header.Get(name)
}

func (c *Context) RequestID() string {
	return c.requestID
}

func (c *Context) JSON(status int, value any) {
	setDefaultHeader(c.Writer.Header(), "Content-Type", "application/json; charset=utf-8")
	c.Writer.WriteHeader(status)
	if err := json.NewEncoder(c.Writer).Encode(value); err != nil {
		panic(err)
	}
}

func (c *Context) Text(status int, value string) {
	setDefaultHeader(c.Writer.Header(), "Content-Type", "text/plain; charset=utf-8")
	c.Writer.WriteHeader(status)
	_, _ = c.Writer.Write([]byte(value))
}

func (c *Context) HTML(status int, value string) {
	setDefaultHeader(c.Writer.Header(), "Content-Type", "text/html; charset=utf-8")
	c.Writer.WriteHeader(status)
	_, _ = c.Writer.Write([]byte(value))
}

func (c *Context) Binary(status int, contentType string, value []byte) {
	if contentType != "" {
		setDefaultHeader(c.Writer.Header(), "Content-Type", contentType)
	}
	c.Writer.WriteHeader(status)
	_, _ = c.Writer.Write(value)
}

func (c *Context) Redirect(status int, target string) {
	http.Redirect(c.Writer, c.Request, target, status)
}

type Router struct {
	mu          sync.RWMutex
	routes      []route
	middleware  []Middleware
	notFound    HandlerFunc
	requestNext atomic.Uint64
}

type route struct {
	method      string
	pattern     string
	segments    []segment
	mountPrefix string
	handler     HandlerFunc
}

type segment struct {
	literal string
	param   string
}

func NewRouter() *Router {
	return &Router{
		notFound: func(c *Context) {
			c.JSON(http.StatusNotFound, map[string]any{"message": "Not Found"})
		},
	}
}

func (r *Router) Use(middleware ...Middleware) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.middleware = append(r.middleware, middleware...)
}

func (r *Router) Handle(method string, pattern string, handler HandlerFunc) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.routes = append(r.routes, route{
		method:   strings.ToUpper(method),
		pattern:  normalizePath(pattern),
		segments: parseSegments(pattern),
		handler:  handler,
	})
}

func (r *Router) Get(pattern string, handler HandlerFunc) {
	r.Handle(http.MethodGet, pattern, handler)
}

func (r *Router) Post(pattern string, handler HandlerFunc) {
	r.Handle(http.MethodPost, pattern, handler)
}

func (r *Router) Put(pattern string, handler HandlerFunc) {
	r.Handle(http.MethodPut, pattern, handler)
}

func (r *Router) Patch(pattern string, handler HandlerFunc) {
	r.Handle(http.MethodPatch, pattern, handler)
}

func (r *Router) Delete(pattern string, handler HandlerFunc) {
	r.Handle(http.MethodDelete, pattern, handler)
}

func (r *Router) Any(pattern string, handler HandlerFunc) {
	r.Handle("*", pattern, handler)
}

func (r *Router) Mount(prefix string, handler http.Handler) {
	cleanPrefix := normalizePath(prefix)
	mountHandler := func(c *Context) {
		request := c.Request.Clone(c.Request.Context())
		copiedURL := *request.URL
		copiedURL.Path = stripPrefix(cleanPrefix, c.Request.URL.Path)
		if c.Request.URL.RawPath != "" {
			copiedURL.RawPath = stripPrefix(cleanPrefix, c.Request.URL.RawPath)
		}
		request.URL = &copiedURL
		handler.ServeHTTP(c.Writer, request)
	}

	r.mu.Lock()
	defer r.mu.Unlock()
	r.routes = append(r.routes, route{
		method:      "*",
		pattern:     cleanPrefix,
		mountPrefix: cleanPrefix,
		handler:     mountHandler,
	})
}

func (r *Router) NotFound(handler HandlerFunc) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.notFound = handler
}

func (r *Router) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	requestID := r.requestID(req)
	w.Header().Set("X-Request-Id", requestID)
	defer func() {
		if recovered := recover(); recovered != nil {
			http.Error(w, "Internal Server Error", http.StatusInternalServerError)
		}
	}()

	r.mu.RLock()
	routes := append([]route(nil), r.routes...)
	middleware := append([]Middleware(nil), r.middleware...)
	notFound := r.notFound
	r.mu.RUnlock()

	for _, route := range routes {
		params, ok := route.match(req.Method, req.URL.Path)
		if !ok {
			continue
		}
		ctx := &Context{Writer: w, Request: req, Params: params, requestID: requestID}
		chain(route.handler, middleware)(ctx)
		return
	}

	ctx := &Context{Writer: w, Request: req, Params: map[string]string{}, requestID: requestID}
	chain(notFound, middleware)(ctx)
}

func (r *Router) requestID(req *http.Request) string {
	if requestID := req.Header.Get("X-Request-Id"); requestID != "" {
		return requestID
	}
	return fmt.Sprintf("req_%d", r.requestNext.Add(1))
}

func (r route) match(method string, requestPath string) (map[string]string, bool) {
	if r.method != "*" && r.method != method && !(method == http.MethodHead && r.method == http.MethodGet) {
		return nil, false
	}
	requestPath = normalizePath(requestPath)
	if r.mountPrefix != "" {
		return map[string]string{}, hasPathPrefix(r.mountPrefix, requestPath)
	}
	parts := splitPath(requestPath)
	hasWildcard := len(r.segments) > 0 && r.segments[len(r.segments)-1].literal == "*"
	if (!hasWildcard && len(parts) != len(r.segments)) || (hasWildcard && len(parts) < len(r.segments)-1) {
		return nil, false
	}
	params := map[string]string{}
	for i, part := range parts {
		segment := r.segments[i]
		if segment.literal == "*" {
			return params, true
		}
		if segment.param != "" {
			decoded, err := url.PathUnescape(part)
			if err != nil {
				decoded = part
			}
			params[segment.param] = decoded
			continue
		}
		if segment.literal != part {
			return nil, false
		}
	}
	return params, true
}

func chain(handler HandlerFunc, middleware []Middleware) HandlerFunc {
	for i := len(middleware) - 1; i >= 0; i-- {
		handler = middleware[i](handler)
	}
	return handler
}

func parseSegments(pattern string) []segment {
	parts := splitPath(normalizePath(pattern))
	segments := make([]segment, 0, len(parts))
	for _, part := range parts {
		switch {
		case part == "*":
			segments = append(segments, segment{literal: "*"})
		case strings.HasPrefix(part, ":") && len(part) > 1:
			segments = append(segments, segment{param: part[1:]})
		case strings.HasPrefix(part, "{") && strings.HasSuffix(part, "}") && len(part) > 2:
			segments = append(segments, segment{param: part[1 : len(part)-1]})
		default:
			segments = append(segments, segment{literal: part})
		}
	}
	return segments
}

func splitPath(value string) []string {
	trimmed := strings.Trim(value, "/")
	if trimmed == "" {
		return nil
	}
	return strings.Split(trimmed, "/")
}

func normalizePath(value string) string {
	if value == "" {
		return "/"
	}
	if !strings.HasPrefix(value, "/") {
		value = "/" + value
	}
	return pathpkg.Clean(value)
}

func stripPrefix(prefix string, requestPath string) string {
	if prefix == "/" {
		return requestPath
	}
	stripped := strings.TrimPrefix(requestPath, prefix)
	if stripped == "" {
		return "/"
	}
	if !strings.HasPrefix(stripped, "/") {
		return "/" + stripped
	}
	return stripped
}

func hasPathPrefix(prefix string, requestPath string) bool {
	if prefix == "/" {
		return true
	}
	return requestPath == prefix || strings.HasPrefix(requestPath, prefix+"/")
}

func setDefaultHeader(header http.Header, key string, value string) {
	if header.Get(key) == "" {
		header.Set(key, value)
	}
}
