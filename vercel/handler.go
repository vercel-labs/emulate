package vercel

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"

	coreassets "github.com/vercel-labs/emulate/internal/core/assets"
	corestore "github.com/vercel-labs/emulate/internal/core/store"
	emuruntime "github.com/vercel-labs/emulate/internal/runtime"
)

const DefaultRoutePrefix = "/emulate"

var defaultServices = []string{"aws", "github", "resend", "vercel"}

var mutatingMethods = map[string]struct{}{
	http.MethodPost:   {},
	http.MethodPut:    {},
	http.MethodPatch:  {},
	http.MethodDelete: {},
}

var (
	htmlRootAttrRE = regexp.MustCompile(`(action|href)="(/[^"]*?)"`)
	htmlRootURLRE  = regexp.MustCompile(`url\('(/[^']*?)'\)`)
	linkURLRE      = regexp.MustCompile(`<([^>]*)>`)
	defaultHandler = NewHandler(Options{})
)

type Persistence interface {
	Load(ctx context.Context, service string) ([]byte, error)
	Save(ctx context.Context, service string, snapshot []byte) error
}

type Options struct {
	Version     string
	RoutePrefix string
	Services    []string
	Persistence Persistence
}

type Runtime struct {
	version     string
	routePrefix string
	services    []string
	serviceSet  map[string]struct{}
	persistence Persistence

	mu      sync.Mutex
	servers map[string]*emuruntime.Server
}

type persistentSnapshot struct {
	Store  *corestore.StoreSnapshot      `json:"store,omitempty"`
	Assets *coreassets.FullStoreSnapshot `json:"assets,omitempty"`
}

func SupportedServices() []string {
	return append([]string(nil), defaultServices...)
}

func NewHandler(options Options) http.Handler {
	version := options.Version
	if version == "" {
		version = "dev"
	}
	services := normalizeServices(options.Services)
	serviceSet := make(map[string]struct{}, len(services))
	for _, service := range services {
		serviceSet[service] = struct{}{}
	}
	return &Runtime{
		version:     version,
		routePrefix: normalizeMountPath(firstNonEmpty(options.RoutePrefix, DefaultRoutePrefix)),
		services:    services,
		serviceSet:  serviceSet,
		persistence: options.Persistence,
		servers:     map[string]*emuruntime.Server{},
	}
}

func Handler(w http.ResponseWriter, r *http.Request) {
	defaultHandler.ServeHTTP(w, r)
}

func (rt *Runtime) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	publicPath, query := rt.publicPathAndQuery(r)
	if rt.isHealthPath(publicPath) {
		rt.writeHealth(w)
		return
	}

	service, restPath, ok := rt.parseServicePath(publicPath)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"message": "Not Found"})
		return
	}
	if _, ok := rt.serviceSet[service]; !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"message": fmt.Sprintf("Unknown service: %s", service)})
		return
	}

	publicPrefix := appendPath(rt.routePrefix, service)
	baseURL := originFromRequest(r) + publicPrefix
	server, err := rt.serverFor(r.Context(), service, baseURL)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"message": err.Error()})
		return
	}

	forwarded := cloneForwardedRequest(r, restPath, query, publicPath, publicPrefix, service)
	recorder := newResponseRecorder()
	server.Handler.ServeHTTP(recorder, forwarded)

	if rt.persistence != nil && isMutating(r.Method) && recorder.statusOrDefault() < http.StatusInternalServerError {
		snapshot, err := marshalPersistentSnapshot(server.Store, server.AssetStore)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"message": err.Error()})
			return
		}
		if err := rt.persistence.Save(r.Context(), service, snapshot); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"message": err.Error()})
			return
		}
	}

	writeRewrittenResponse(w, r, recorder, publicPrefix)
}

func (rt *Runtime) publicPathAndQuery(r *http.Request) (string, url.Values) {
	query := r.URL.Query()
	rewritePath := query.Get("path")
	if rewritePath != "" && !hasPathPrefix(r.URL.Path, rt.routePrefix) {
		query.Del("path")
		return appendPath(rt.routePrefix, rewritePath), query
	}
	return r.URL.Path, query
}

func (rt *Runtime) isHealthPath(publicPath string) bool {
	return publicPath == rt.routePrefix ||
		publicPath == rt.routePrefix+"/" ||
		publicPath == rt.routePrefix+emuruntime.HealthPath ||
		publicPath == rt.routePrefix+"/health"
}

func (rt *Runtime) writeHealth(w http.ResponseWriter) {
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":           true,
		"adapter":      "vercel",
		"runtime":      "go",
		"version":      rt.version,
		"route_prefix": rt.routePrefix,
		"services":     rt.services,
		"state": map[string]any{
			"default":     "warm-memory",
			"persistence": rt.persistence != nil,
		},
	})
}

func (rt *Runtime) parseServicePath(publicPath string) (string, string, bool) {
	if !hasPathPrefix(publicPath, rt.routePrefix) {
		return "", "", false
	}
	rest := strings.TrimPrefix(publicPath, rt.routePrefix)
	rest = strings.TrimPrefix(rest, "/")
	if rest == "" {
		return "", "", false
	}
	service, remainingPath, hasRemainingPath := strings.Cut(rest, "/")
	if service == "" {
		return "", "", false
	}
	if !hasRemainingPath {
		return service, "/", true
	}
	return service, "/" + remainingPath, true
}

func (rt *Runtime) serverFor(ctx context.Context, service string, baseURL string) (*emuruntime.Server, error) {
	key := service + "\x00" + baseURL
	rt.mu.Lock()
	defer rt.mu.Unlock()
	if server, ok := rt.servers[key]; ok {
		return server, nil
	}

	runtimeStore := corestore.New()
	assetStore := coreassets.New()
	if rt.persistence != nil {
		raw, err := rt.persistence.Load(ctx, service)
		if err != nil {
			return nil, err
		}
		if len(bytes.TrimSpace(raw)) > 0 {
			if err := restorePersistentSnapshot(raw, runtimeStore, assetStore); err != nil {
				return nil, err
			}
		}
	}

	server := emuruntime.NewServer(emuruntime.ServerOptions{
		Version:    rt.version,
		BaseURL:    baseURL,
		Services:   []string{service},
		Store:      runtimeStore,
		AssetStore: assetStore,
	})
	rt.servers[key] = server
	return server, nil
}

func marshalPersistentSnapshot(runtimeStore *corestore.Store, assetStore *coreassets.Store) ([]byte, error) {
	storeSnapshot := runtimeStore.Snapshot()
	assetSnapshot := assetStore.FullSnapshot()
	return json.MarshalIndent(persistentSnapshot{
		Store:  &storeSnapshot,
		Assets: &assetSnapshot,
	}, "", "  ")
}

func restorePersistentSnapshot(raw []byte, runtimeStore *corestore.Store, assetStore *coreassets.Store) error {
	var snapshot persistentSnapshot
	if err := json.Unmarshal(raw, &snapshot); err != nil {
		return err
	}
	if snapshot.Store == nil {
		return runtimeStore.RestoreJSON(raw)
	}
	if err := runtimeStore.Restore(*snapshot.Store); err != nil {
		return err
	}
	if snapshot.Assets != nil {
		if err := assetStore.RestoreFullSnapshot(*snapshot.Assets); err != nil {
			return err
		}
	}
	return nil
}

func cloneForwardedRequest(r *http.Request, restPath string, query url.Values, publicPath string, publicPrefix string, service string) *http.Request {
	forwarded := r.Clone(r.Context())
	forwarded.Header = r.Header.Clone()
	forwarded.URL = cloneURL(r.URL)
	forwarded.URL.Path = restPath
	forwarded.URL.RawPath = ""
	forwarded.URL.RawQuery = query.Encode()
	forwarded.RequestURI = ""
	setForwardHeaders(forwarded, r, publicPath, publicPrefix, service)
	return forwarded
}

func cloneURL(input *url.URL) *url.URL {
	copied := *input
	return &copied
}

func setForwardHeaders(forwarded *http.Request, original *http.Request, publicPath string, publicPrefix string, service string) {
	forwarded.Header.Set("X-Forwarded-Host", firstNonEmpty(firstForwardedValue(original.Header.Get("X-Forwarded-Host")), original.Host, original.URL.Host))
	forwarded.Header.Set("X-Forwarded-Proto", requestProto(original))
	forwarded.Header.Set("X-Forwarded-Prefix", publicPrefix)
	forwarded.Header.Set("X-Emulate-Proxy", "vercel")
	forwarded.Header.Set("X-Emulate-Original-Path", publicPath)
	forwarded.Header.Set("X-Emulate-Service", service)
	if port := forwardedPort(original); port != "" {
		forwarded.Header.Set("X-Forwarded-Port", port)
	}
}

func requestProto(r *http.Request) string {
	if proto := firstForwardedValue(r.Header.Get("X-Forwarded-Proto")); proto != "" {
		return proto
	}
	if r.URL.Scheme != "" {
		return r.URL.Scheme
	}
	if r.TLS != nil {
		return "https"
	}
	return "http"
}

func forwardedPort(r *http.Request) string {
	if port := firstForwardedValue(r.Header.Get("X-Forwarded-Port")); port != "" {
		return port
	}
	host := firstNonEmpty(firstForwardedValue(r.Header.Get("X-Forwarded-Host")), r.Host, r.URL.Host)
	if index := strings.LastIndex(host, ":"); index >= 0 {
		return host[index+1:]
	}
	return ""
}

func originFromRequest(r *http.Request) string {
	host := firstNonEmpty(firstForwardedValue(r.Header.Get("X-Forwarded-Host")), r.Host, r.URL.Host)
	return requestProto(r) + "://" + host
}

func writeRewrittenResponse(w http.ResponseWriter, r *http.Request, recorder *responseRecorder, publicPrefix string) {
	headers := cloneHeader(recorder.Header())
	if location := headers.Get("Location"); strings.HasPrefix(location, "/") {
		headers.Set("Location", rewriteRootPath(publicPrefix, location))
	}
	if links, ok := headers["Link"]; ok {
		rewritten := make([]string, len(links))
		for i, link := range links {
			rewritten[i] = rewriteLinkHeader(link, publicPrefix)
		}
		headers["Link"] = rewritten
	}

	body := recorder.body.Bytes()
	contentType := headers.Get("Content-Type")
	if strings.Contains(contentType, "text/html") {
		body = []byte(rewriteHTML(string(body), publicPrefix))
		headers.Del("Content-Length")
		headers.Del("Content-Encoding")
	}

	for name, values := range headers {
		for _, value := range values {
			w.Header().Add(name, value)
		}
	}
	w.WriteHeader(recorder.statusOrDefault())
	if r.Method != http.MethodHead && len(body) > 0 {
		_, _ = w.Write(body)
	}
}

func rewriteHTML(html string, publicPrefix string) string {
	html = htmlRootAttrRE.ReplaceAllStringFunc(html, func(match string) string {
		parts := htmlRootAttrRE.FindStringSubmatch(match)
		if len(parts) != 3 {
			return match
		}
		return parts[1] + `="` + rewriteRootPath(publicPrefix, parts[2]) + `"`
	})
	html = htmlRootURLRE.ReplaceAllStringFunc(html, func(match string) string {
		parts := htmlRootURLRE.FindStringSubmatch(match)
		if len(parts) != 2 {
			return match
		}
		return `url('` + rewriteRootPath(publicPrefix, parts[1]) + `')`
	})
	return html
}

func rewriteLinkHeader(link string, publicPrefix string) string {
	return linkURLRE.ReplaceAllStringFunc(link, func(match string) string {
		parts := linkURLRE.FindStringSubmatch(match)
		if len(parts) != 2 {
			return match
		}
		return "<" + rewriteServiceLinkTarget(parts[1], publicPrefix) + ">"
	})
}

func rewriteServiceLinkTarget(target string, publicPrefix string) string {
	if strings.HasPrefix(target, "/") {
		return rewriteRootPath(publicPrefix, target)
	}
	parsed, err := url.Parse(target)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return target
	}
	parsed.Path = rewriteRootPath(publicPrefix, parsed.Path)
	parsed.RawPath = ""
	return parsed.String()
}

func rewriteRootPath(publicPrefix string, target string) string {
	prefix := normalizeMountPath(publicPrefix)
	if prefix != "" && hasPathPrefix(target, prefix) {
		return target
	}
	if target == "" || target == "/" {
		if prefix == "" {
			return "/"
		}
		return prefix
	}
	if strings.HasPrefix(target, "?") || strings.HasPrefix(target, "#") {
		return prefix + target
	}
	if prefix == "" {
		return target
	}
	return prefix + "/" + strings.TrimLeft(target, "/")
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	body, err := json.Marshal(value)
	if err != nil {
		http.Error(w, "Internal Server Error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

func normalizeServices(services []string) []string {
	if len(services) == 0 {
		return append([]string(nil), defaultServices...)
	}
	seen := map[string]struct{}{}
	normalized := []string{}
	for _, service := range services {
		name := strings.ToLower(strings.TrimSpace(service))
		if name == "" {
			continue
		}
		if name == "all" {
			return append([]string(nil), defaultServices...)
		}
		if _, ok := seen[name]; ok {
			continue
		}
		seen[name] = struct{}{}
		normalized = append(normalized, name)
	}
	if len(normalized) == 0 {
		return append([]string(nil), defaultServices...)
	}
	return normalized
}

func normalizeMountPath(input string) string {
	trimmed := strings.Trim(input, "/")
	if trimmed == "" {
		return ""
	}
	return "/" + trimmed
}

func appendPath(prefix string, segment string) string {
	mountPath := normalizeMountPath(prefix)
	cleanedSegment := strings.TrimLeft(segment, "/")
	if cleanedSegment == "" {
		if mountPath == "" {
			return "/"
		}
		return mountPath
	}
	if mountPath == "" {
		return "/" + cleanedSegment
	}
	return mountPath + "/" + cleanedSegment
}

func hasPathPrefix(input string, prefix string) bool {
	normalizedPrefix := normalizeMountPath(prefix)
	if normalizedPrefix == "" {
		return true
	}
	return input == normalizedPrefix || strings.HasPrefix(input, normalizedPrefix+"/")
}

func firstForwardedValue(input string) string {
	if input == "" {
		return ""
	}
	return strings.TrimSpace(strings.Split(input, ",")[0])
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func isMutating(method string) bool {
	_, ok := mutatingMethods[method]
	return ok
}

func cloneHeader(input http.Header) http.Header {
	output := http.Header{}
	for name, values := range input {
		output[name] = append([]string(nil), values...)
	}
	return output
}

type responseRecorder struct {
	header http.Header
	body   bytes.Buffer
	status int
}

func newResponseRecorder() *responseRecorder {
	return &responseRecorder{header: http.Header{}}
}

func (r *responseRecorder) Header() http.Header {
	return r.header
}

func (r *responseRecorder) WriteHeader(status int) {
	if r.status != 0 {
		return
	}
	r.status = status
}

func (r *responseRecorder) Write(body []byte) (int, error) {
	if r.status == 0 {
		r.status = http.StatusOK
	}
	return r.body.Write(body)
}

func (r *responseRecorder) statusOrDefault() int {
	if r.status == 0 {
		return http.StatusOK
	}
	return r.status
}
