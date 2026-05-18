package corehttp

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRouterMatchesParamsAndRunsMiddleware(t *testing.T) {
	router := NewRouter()
	router.Use(func(next HandlerFunc) HandlerFunc {
		return func(c *Context) {
			c.Writer.Header().Set("X-Middleware", "ran")
			next(c)
		}
	})
	router.Get("/users/:id", func(c *Context) {
		c.JSON(http.StatusCreated, map[string]any{
			"id":         c.Param("id"),
			"query":      c.Query("q"),
			"agent":      c.Header("X-Agent"),
			"request_id": c.RequestID(),
		})
	})

	req := httptest.NewRequest(http.MethodGet, "/users/alice?q=ok", nil)
	req.Header.Set("X-Agent", "test")
	req.Header.Set("X-Request-Id", "req-test")
	res := httptest.NewRecorder()

	router.ServeHTTP(res, req)

	if res.Code != http.StatusCreated {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	if res.Header().Get("X-Middleware") != "ran" {
		t.Fatalf("middleware header missing: %v", res.Header())
	}
	if res.Header().Get("X-Request-Id") != "req-test" {
		t.Fatalf("request id header mismatch: %v", res.Header())
	}

	var body map[string]string
	if err := json.Unmarshal(res.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["id"] != "alice" || body["query"] != "ok" || body["agent"] != "test" || body["request_id"] != "req-test" {
		t.Fatalf("unexpected body: %#v", body)
	}
}

func TestRouterMatchesRegexTailParam(t *testing.T) {
	router := NewRouter()
	router.Get("/repos/:owner/:repo/git/ref/:ref{.+}", func(c *Context) {
		c.JSON(http.StatusOK, map[string]string{
			"owner": c.Param("owner"),
			"repo":  c.Param("repo"),
			"ref":   c.Param("ref"),
		})
	})

	res := httptest.NewRecorder()
	router.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/repos/acme/widgets/git/ref/heads/main", nil))

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	var body map[string]string
	if err := json.Unmarshal(res.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["owner"] != "acme" || body["repo"] != "widgets" || body["ref"] != "heads/main" {
		t.Fatalf("unexpected body: %#v", body)
	}
}

func TestRouterMatchesRegexParamBeforeLiteralSuffix(t *testing.T) {
	router := NewRouter()
	router.Get("/repos/:owner/:repo/branches/:branch{.+}/protection", func(c *Context) {
		c.JSON(http.StatusOK, map[string]string{
			"branch": c.Param("branch"),
		})
	})

	res := httptest.NewRecorder()
	router.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/repos/acme/widgets/branches/feature/auth/protection", nil))

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	var body map[string]string
	if err := json.Unmarshal(res.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["branch"] != "feature/auth" {
		t.Fatalf("unexpected body: %#v", body)
	}
}

func TestRouterPrefersExplicitHeadOverGetFallback(t *testing.T) {
	router := NewRouter()
	router.Get("/object", func(c *Context) {
		c.Writer.Header().Set("X-Handler", "get")
		c.Text(http.StatusOK, "get")
	})
	router.Handle(http.MethodHead, "/object", func(c *Context) {
		c.Writer.Header().Set("X-Handler", "head")
		c.Binary(http.StatusOK, "", nil)
	})

	res := httptest.NewRecorder()
	router.ServeHTTP(res, httptest.NewRequest(http.MethodHead, "/object", nil))

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	if res.Header().Get("X-Handler") != "head" {
		t.Fatalf("handler = %q", res.Header().Get("X-Handler"))
	}
}

func TestRouterFallsBackHeadToGet(t *testing.T) {
	router := NewRouter()
	router.Get("/object", func(c *Context) {
		c.Writer.Header().Set("X-Handler", "get")
		c.Text(http.StatusOK, "get")
	})

	res := httptest.NewRecorder()
	router.ServeHTTP(res, httptest.NewRequest(http.MethodHead, "/object", nil))

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	if res.Header().Get("X-Handler") != "get" {
		t.Fatalf("handler = %q", res.Header().Get("X-Handler"))
	}
}

func TestRouterResponseHelpers(t *testing.T) {
	router := NewRouter()
	router.Get("/text", func(c *Context) { c.Text(http.StatusAccepted, "hello") })
	router.Get("/html", func(c *Context) { c.HTML(http.StatusOK, "<strong>hello</strong>") })
	router.Get("/binary", func(c *Context) { c.Binary(http.StatusOK, "application/octet-stream", []byte{1, 2, 3}) })
	router.Get("/redirect", func(c *Context) { c.Redirect(http.StatusFound, "/target") })

	tests := []struct {
		path        string
		status      int
		contentType string
		body        string
		location    string
	}{
		{path: "/text", status: http.StatusAccepted, contentType: "text/plain; charset=utf-8", body: "hello"},
		{path: "/html", status: http.StatusOK, contentType: "text/html; charset=utf-8", body: "<strong>hello</strong>"},
		{path: "/binary", status: http.StatusOK, contentType: "application/octet-stream", body: "\x01\x02\x03"},
		{path: "/redirect", status: http.StatusFound, contentType: "text/html; charset=utf-8", location: "/target"},
	}

	for _, test := range tests {
		req := httptest.NewRequest(http.MethodGet, test.path, nil)
		res := httptest.NewRecorder()
		router.ServeHTTP(res, req)

		if res.Code != test.status {
			t.Fatalf("%s status = %d, body = %s", test.path, res.Code, res.Body.String())
		}
		if test.contentType != "" && res.Header().Get("Content-Type") != test.contentType {
			t.Fatalf("%s content type = %q", test.path, res.Header().Get("Content-Type"))
		}
		if test.location != "" && res.Header().Get("Location") != test.location {
			t.Fatalf("%s location = %q", test.path, res.Header().Get("Location"))
		}
		if test.body != "" && res.Body.String() != test.body {
			t.Fatalf("%s body = %q", test.path, res.Body.String())
		}
	}
}

func TestRouterMountStripsPrefix(t *testing.T) {
	router := NewRouter()
	router.Mount("/api", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(r.URL.Path))
	}))

	res := httptest.NewRecorder()
	router.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/api/v1/health", nil))

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	if res.Body.String() != "/v1/health" {
		t.Fatalf("mounted path = %q", res.Body.String())
	}
}

func TestRouterNotFoundAndPanicRecovery(t *testing.T) {
	router := NewRouter()
	router.Get("/panic", func(c *Context) {
		panic("boom")
	})

	missing := httptest.NewRecorder()
	router.ServeHTTP(missing, httptest.NewRequest(http.MethodGet, "/missing", nil))
	if missing.Code != http.StatusNotFound {
		t.Fatalf("missing status = %d", missing.Code)
	}

	panicked := httptest.NewRecorder()
	router.ServeHTTP(panicked, httptest.NewRequest(http.MethodGet, "/panic", nil))
	if panicked.Code != http.StatusInternalServerError {
		t.Fatalf("panic status = %d", panicked.Code)
	}
}
