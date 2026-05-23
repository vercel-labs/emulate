package apigatewayv2

import (
	"bytes"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	corestore "github.com/vercel-labs/emulate/internal/core/store"
	"github.com/vercel-labs/emulate/internal/services/aws/gateway"
)

func TestMatchRouteCapturesPathParameters(t *testing.T) {
	handler := newUnitHandler()
	ctx := gateway.AwsRequestContext{AccountID: "123456789012", Region: "us-east-1"}
	handler.Routes.Insert(corestore.Record{
		"account_id": "123456789012",
		"region":     "us-east-1",
		"api_id":     "api-1",
		"route_id":   "route-user",
		"route_key":  "GET /users/{id}",
		"target":     "integrations/int-user",
	})
	handler.Routes.Insert(corestore.Record{
		"account_id": "123456789012",
		"region":     "us-east-1",
		"api_id":     "api-1",
		"route_id":   "route-files",
		"route_key":  "ANY /files/{proxy+}",
		"target":     "integrations/int-files",
	})

	match, ok := handler.matchRoute(ctx, "api-1", http.MethodGet, "/users/abc%20123")
	if !ok {
		t.Fatal("expected templated route to match")
	}
	if got := stringField(match.Record, "route_key"); got != "GET /users/{id}" {
		t.Fatalf("route key = %q", got)
	}
	if got := match.PathParameters["id"]; got != "abc 123" {
		t.Fatalf("id path parameter = %q", got)
	}

	match, ok = handler.matchRoute(ctx, "api-1", http.MethodPost, "/files/a/b.txt")
	if !ok {
		t.Fatal("expected greedy route to match")
	}
	if got := stringField(match.Record, "route_key"); got != "ANY /files/{proxy+}" {
		t.Fatalf("route key = %q", got)
	}
	if got := match.PathParameters["proxy"]; got != "a/b.txt" {
		t.Fatalf("proxy path parameter = %q", got)
	}

	if match, ok = handler.matchRoute(ctx, "api-1", http.MethodPost, "/files"); ok {
		t.Fatalf("greedy route matched zero path segments: %#v", match)
	}
}

func TestLambdaProxyEventCombinesDuplicateQueryValues(t *testing.T) {
	handler := Handler{
		AccountID: "123456789012",
		Region:    "us-east-1",
		Now:       func() time.Time { return time.Unix(0, 0) },
	}
	req := httptest.NewRequest(http.MethodGet, "http://example.test/search?tag=red&tag=blue&single=yes", nil)

	event := handler.lambdaProxyEvent(
		req,
		gateway.AwsRequestContext{AccountID: "123456789012", Region: "us-east-1"},
		corestore.Record{"api_id": "api-1"},
		corestore.Record{"stage_name": "$default"},
		routeMatch{Record: corestore.Record{"route_key": "GET /search"}},
		"/search",
		"req-1",
	)
	query := event["queryStringParameters"].(map[string]string)

	if query["tag"] != "red,blue" {
		t.Fatalf("tag query = %q", query["tag"])
	}
	if query["single"] != "yes" {
		t.Fatalf("single query = %q", query["single"])
	}
}

func TestLambdaProxyEventIncludesPathParameters(t *testing.T) {
	handler := Handler{
		AccountID: "123456789012",
		Region:    "us-east-1",
		Now:       func() time.Time { return time.Unix(0, 0) },
	}
	req := httptest.NewRequest(http.MethodGet, "http://example.test/users/abc", nil)

	event := handler.lambdaProxyEvent(
		req,
		gateway.AwsRequestContext{AccountID: "123456789012", Region: "us-east-1"},
		corestore.Record{"api_id": "api-1"},
		corestore.Record{"stage_name": "$default"},
		routeMatch{
			Record:         corestore.Record{"route_key": "GET /users/{id}"},
			PathParameters: map[string]string{"id": "abc"},
		},
		"/users/abc",
		"req-1",
	)
	params := event["pathParameters"].(map[string]string)

	if params["id"] != "abc" {
		t.Fatalf("id path parameter = %q", params["id"])
	}
}

func TestLambdaProxyEventEncodesBinaryBody(t *testing.T) {
	handler := Handler{
		AccountID: "123456789012",
		Region:    "us-east-1",
		Now:       func() time.Time { return time.Unix(0, 0) },
	}
	body := []byte{0, 1, 2, 3, 255, 'o', 'k'}
	req := httptest.NewRequest(http.MethodPost, "http://example.test/upload", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/octet-stream")

	event := handler.lambdaProxyEvent(
		req,
		gateway.AwsRequestContext{AccountID: "123456789012", Region: "us-east-1", RawBody: body},
		corestore.Record{"api_id": "api-1"},
		corestore.Record{"stage_name": "$default"},
		routeMatch{Record: corestore.Record{"route_key": "POST /upload"}},
		"/upload",
		"req-1",
	)

	if event["isBase64Encoded"] != true {
		t.Fatalf("isBase64Encoded = %#v", event["isBase64Encoded"])
	}
	if got := event["body"]; got != base64.StdEncoding.EncodeToString(body) {
		t.Fatalf("body = %q", got)
	}
}

func TestLambdaProxyEventIncludesCookiesAndStageVariables(t *testing.T) {
	handler := Handler{
		AccountID: "123456789012",
		Region:    "us-east-1",
		Now:       func() time.Time { return time.Unix(0, 0) },
	}
	req := httptest.NewRequest(http.MethodGet, "http://example.test/with-context", nil)
	req.Header.Add("Cookie", "sid=one; prefs=two")
	req.Header.Add("Cookie", "theme=dark")

	event := handler.lambdaProxyEvent(
		req,
		gateway.AwsRequestContext{AccountID: "123456789012", Region: "us-east-1"},
		corestore.Record{"api_id": "api-1"},
		corestore.Record{
			"stage_name":      "$default",
			"stage_variables": corestore.Record{"alias": "live", "debug": "true"},
		},
		routeMatch{Record: corestore.Record{"route_key": "GET /with-context"}},
		"/with-context",
		"req-1",
	)

	cookies := event["cookies"].([]string)
	if len(cookies) != 3 || cookies[0] != "sid=one" || cookies[1] != "prefs=two" || cookies[2] != "theme=dark" {
		t.Fatalf("cookies = %#v", cookies)
	}
	stageVariables := event["stageVariables"].(map[string]string)
	if stageVariables["alias"] != "live" || stageVariables["debug"] != "true" {
		t.Fatalf("stageVariables = %#v", stageVariables)
	}
}

func TestCreateIntegrationRejectsUnsupportedPayloadFormatVersion(t *testing.T) {
	handler := newUnitHandler()
	handler.APIs.Insert(unitAPIRecord())
	ctx := gateway.AwsRequestContext{
		AccountID: "123456789012",
		Region:    "us-east-1",
		Input: map[string]any{
			"IntegrationType":      "AWS_PROXY",
			"IntegrationUri":       "arn:aws:lambda:us-east-1:123456789012:function:test",
			"PayloadFormatVersion": "1.0",
		},
	}

	response := handler.createIntegration(ctx, "api-1", "req-1")

	if response.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, body = %s", response.StatusCode, string(response.Body))
	}
	if !strings.Contains(string(response.Body), "PayloadFormatVersion must be 2.0") {
		t.Fatalf("unexpected body: %s", string(response.Body))
	}
}

func TestCreateRouteAndStageRejectDuplicates(t *testing.T) {
	handler := newUnitHandler()
	handler.APIs.Insert(unitAPIRecord())
	ctx := gateway.AwsRequestContext{AccountID: "123456789012", Region: "us-east-1"}

	ctx.Input = map[string]any{"RouteKey": "GET /users/{id}", "Target": "integrations/int-1"}
	firstRoute := handler.createRoute(ctx, "api-1", "req-1")
	if firstRoute.StatusCode != http.StatusCreated {
		t.Fatalf("create route status = %d, body = %s", firstRoute.StatusCode, string(firstRoute.Body))
	}
	duplicateRoute := handler.createRoute(ctx, "api-1", "req-2")
	if duplicateRoute.StatusCode != http.StatusConflict {
		t.Fatalf("duplicate route status = %d, body = %s", duplicateRoute.StatusCode, string(duplicateRoute.Body))
	}

	ctx.Input = map[string]any{"StageName": "$default"}
	firstStage := handler.createStage(ctx, "api-1", "req-3")
	if firstStage.StatusCode != http.StatusCreated {
		t.Fatalf("create stage status = %d, body = %s", firstStage.StatusCode, string(firstStage.Body))
	}
	duplicateStage := handler.createStage(ctx, "api-1", "req-4")
	if duplicateStage.StatusCode != http.StatusConflict {
		t.Fatalf("duplicate stage status = %d, body = %s", duplicateStage.StatusCode, string(duplicateStage.Body))
	}
}

func newUnitHandler() Handler {
	store := corestore.New()
	return Handler{
		APIs:         store.MustCollection("aws.apigatewayv2_apis", "account_id", "region", "api_id", "name"),
		Integrations: store.MustCollection("aws.apigatewayv2_integrations", "account_id", "region", "api_id", "integration_id"),
		Routes:       store.MustCollection("aws.apigatewayv2_routes", "account_id", "region", "api_id", "route_id", "route_key"),
		Stages:       store.MustCollection("aws.apigatewayv2_stages", "account_id", "region", "api_id", "stage_name"),
		AccountID:    "123456789012",
		Region:       "us-east-1",
		Now:          func() time.Time { return time.Unix(0, 0) },
		IDGenerator:  func(prefix string) string { return prefix + "-1" },
	}
}

func unitAPIRecord() corestore.Record {
	return corestore.Record{
		"account_id": "123456789012",
		"region":     "us-east-1",
		"api_id":     "api-1",
		"name":       "test-api",
	}
}
