package runtime

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestNewHandlerServesHealthEndpoint(t *testing.T) {
	handler := NewHandler(ServerOptions{
		Version:  "test",
		BaseURL:  "http://localhost:4010",
		Services: []string{"github", "aws"},
	})

	res := httptest.NewRecorder()
	handler.ServeHTTP(res, httptest.NewRequest(http.MethodGet, HealthPath, nil))

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	var body struct {
		OK       bool     `json:"ok"`
		Runtime  string   `json:"runtime"`
		Version  string   `json:"version"`
		BaseURL  string   `json:"base_url"`
		Services []string `json:"services"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if !body.OK || body.Runtime != "go" || body.Version != "test" || body.BaseURL != "http://localhost:4010" {
		t.Fatalf("unexpected health body: %#v", body)
	}
	if len(body.Services) != 2 || body.Services[0] != "github" || body.Services[1] != "aws" {
		t.Fatalf("unexpected services: %#v", body.Services)
	}
}

func TestNewHandlerReturnsJSONNotFound(t *testing.T) {
	handler := NewHandler(ServerOptions{})

	res := httptest.NewRecorder()
	handler.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/missing", nil))

	if res.Code != http.StatusNotFound {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	var body map[string]string
	if err := json.Unmarshal(res.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["message"] != "Not Found" {
		t.Fatalf("unexpected body: %#v", body)
	}
}
