package runtime

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
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

func TestNewHandlerMountsAWSInConservativeModeByDefault(t *testing.T) {
	handler := NewHandler(ServerOptions{})
	req := httptest.NewRequest(http.MethodPost, "/sqs/", strings.NewReader("Action=CreateQueue&QueueName=jobs"))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Authorization", "AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE/20260519/us-east-1/sqs/aws4_request, SignedHeaders=host;x-amz-date, Signature=abcdef")
	req.Header.Set("X-Amz-Date", "20260519T000000Z")

	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)

	if res.Code != http.StatusNotImplemented {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	if !strings.Contains(res.Body.String(), "sqs.CreateQueue") {
		t.Fatalf("unexpected body: %s", res.Body.String())
	}
}

func TestNewHandlerMountsAWSWhenEnabled(t *testing.T) {
	handler := NewHandler(ServerOptions{Services: []string{"aws"}})
	req := httptest.NewRequest(http.MethodPost, "/sqs/", strings.NewReader("Action=CreateQueue&QueueName=jobs"))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Authorization", "AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE/20260519/us-east-1/sqs/aws4_request, SignedHeaders=host;x-amz-date, Signature=abcdef")
	req.Header.Set("X-Amz-Date", "20260519T000000Z")

	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)

	if res.Code != http.StatusNotImplemented {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	if !strings.Contains(res.Body.String(), "sqs.CreateQueue") {
		t.Fatalf("unexpected body: %s", res.Body.String())
	}
}

func TestNewHandlerAWSOnlyUsesS3PathFallback(t *testing.T) {
	handler := NewHandler(ServerOptions{Services: []string{"aws"}})

	res := httptest.NewRecorder()
	handler.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/emulate-default", nil))

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	if !strings.Contains(res.Body.String(), "<ListBucketResult>") {
		t.Fatalf("unexpected body: %s", res.Body.String())
	}
}

func TestNewHandlerMultiServiceKeepsLegacyS3Path(t *testing.T) {
	handler := NewHandler(ServerOptions{Services: []string{"aws", "github"}})

	res := httptest.NewRecorder()
	handler.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/s3/emulate-default", nil))

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	if !strings.Contains(res.Body.String(), "<ListBucketResult>") {
		t.Fatalf("unexpected body: %s", res.Body.String())
	}
}

func TestNewHandlerMultiServiceDoesNotTreatNestedKnownServicePathAsS3(t *testing.T) {
	handler := NewHandler(ServerOptions{Services: []string{"aws", "github"}})

	res := httptest.NewRecorder()
	handler.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/sqs/foo", nil))

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
	if strings.Contains(res.Body.String(), "s3.GetObject") {
		t.Fatalf("unexpected S3 fallback response: %s", res.Body.String())
	}
}

func TestNewHandlerAWSDoesNotShadowHeadHealth(t *testing.T) {
	handler := NewHandler(ServerOptions{Services: []string{"aws"}})

	res := httptest.NewRecorder()
	handler.ServeHTTP(res, httptest.NewRequest(http.MethodHead, HealthPath, nil))

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
}

func TestNewHandlerDoesNotMountAWSWhenDisabled(t *testing.T) {
	handler := NewHandler(ServerOptions{Services: []string{"github"}})
	req := httptest.NewRequest(http.MethodPost, "/sqs/", strings.NewReader("Action=CreateQueue&QueueName=jobs"))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Authorization", "AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE/20260519/us-east-1/sqs/aws4_request, SignedHeaders=host;x-amz-date, Signature=abcdef")
	req.Header.Set("X-Amz-Date", "20260519T000000Z")

	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)

	if res.Code != http.StatusNotFound {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
}
