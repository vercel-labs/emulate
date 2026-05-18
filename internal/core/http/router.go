package corehttp

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	pathpkg "path"
	"regexp"
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
	regex   *regexp.Regexp
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

	if req.Method == http.MethodHead {
		for _, route := range routes {
			if route.method != http.MethodGet {
				continue
			}
			params, ok := route.match(http.MethodGet, req.URL.Path)
			if !ok {
				continue
			}
			ctx := &Context{Writer: w, Request: req, Params: params, requestID: requestID}
			chain(route.handler, middleware)(ctx)
			return
		}
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
	if r.method != "*" && r.method != method {
		return nil, false
	}
	requestPath = normalizePath(requestPath)
	if r.mountPrefix != "" {
		return map[string]string{}, hasPathPrefix(r.mountPrefix, requestPath)
	}
	parts := splitPath(requestPath)
	params := map[string]string{}
	if !matchSegments(r.segments, parts, 0, 0, params) {
		return nil, false
	}
	return params, true
}

func matchSegments(segments []segment, parts []string, segmentIndex int, partIndex int, params map[string]string) bool {
	if segmentIndex == len(segments) {
		return partIndex == len(parts)
	}

	segment := segments[segmentIndex]
	if segment.literal == "*" {
		return true
	}

	if segment.param != "" && segment.regex != nil {
		for end := len(parts); end >= partIndex; end-- {
			value := strings.Join(parts[partIndex:end], "/")
			if !setMatchedParam(segment, value, params) {
				continue
			}
			if matchSegments(segments, parts, segmentIndex+1, end, params) {
				return true
			}
			delete(params, segment.param)
		}
		return false
	}

	if partIndex >= len(parts) {
		return false
	}
	part := parts[partIndex]
	if segment.param != "" {
		if !setMatchedParam(segment, part, params) {
			return false
		}
		if matchSegments(segments, parts, segmentIndex+1, partIndex+1, params) {
			return true
		}
		delete(params, segment.param)
		return false
	}
	if segment.literal != part {
		return false
	}
	return matchSegments(segments, parts, segmentIndex+1, partIndex+1, params)
}

func setMatchedParam(segment segment, value string, params map[string]string) bool {
	decoded, ok := segment.matchParam(value)
	if !ok {
		return false
	}
	params[segment.param] = decoded
	return true
}

func (s segment) matchParam(value string) (string, bool) {
	if s.regex != nil && !s.regex.MatchString(value) {
		return "", false
	}
	decoded, err := url.PathUnescape(value)
	if err != nil {
		decoded = value
	}
	return decoded, true
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
			segments = append(segments, parseParamSegment(part))
		case strings.HasPrefix(part, "{") && strings.HasSuffix(part, "}") && len(part) > 2:
			segments = append(segments, segment{param: part[1 : len(part)-1]})
		default:
			segments = append(segments, segment{literal: part})
		}
	}
	return segments
}

func parseParamSegment(part string) segment {
	name := part[1:]
	brace := strings.Index(name, "{")
	if brace <= 0 || !strings.HasSuffix(name, "}") {
		return segment{param: name}
	}
	expr := name[brace+1 : len(name)-1]
	return segment{
		param: name[:brace],
		regex: regexp.MustCompile("^" + expr + "$"),
	}
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
