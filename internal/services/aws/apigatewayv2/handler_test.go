package apigatewayv2

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	corestore "github.com/vercel-labs/emulate/internal/core/store"
	"github.com/vercel-labs/emulate/internal/services/aws/gateway"
)

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
		corestore.Record{"route_key": "GET /search"},
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
