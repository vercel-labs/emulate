package runtime

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
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

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	if !strings.Contains(res.Body.String(), "<CreateQueueResponse>") || !strings.Contains(res.Body.String(), "jobs") {
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

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	if !strings.Contains(res.Body.String(), "<CreateQueueResponse>") || !strings.Contains(res.Body.String(), "jobs") {
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

func TestNewHandlerMountsResendWhenEnabled(t *testing.T) {
	handler := NewHandler(ServerOptions{Services: []string{"resend"}})

	res := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/emails", strings.NewReader(`{"from":"a@example.com","to":"b@example.com","subject":"Hello"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer re_test_token")
	handler.ServeHTTP(res, req)

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	if !strings.Contains(res.Body.String(), `"id"`) {
		t.Fatalf("unexpected body: %s", res.Body.String())
	}
}

func TestNewHandlerDoesNotMountResendWhenDisabled(t *testing.T) {
	handler := NewHandler(ServerOptions{Services: []string{"github"}})

	res := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/emails", strings.NewReader(`{"from":"a@example.com","to":"b@example.com","subject":"Hello"}`))
	req.Header.Set("Content-Type", "application/json")
	handler.ServeHTTP(res, req)

	if res.Code != http.StatusNotFound {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
}

func TestNewHandlerMountsMongoAtlasWhenEnabled(t *testing.T) {
	handler := NewHandler(ServerOptions{Services: []string{"mongoatlas"}})

	res := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/app/data-api/v1/action/insertOne", strings.NewReader(`{"dataSource":"Cluster0","database":"test","collection":"items","document":{"name":"Widget"}}`))
	req.Header.Set("Content-Type", "application/json")
	handler.ServeHTTP(res, req)

	if res.Code != http.StatusCreated {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	if !strings.Contains(res.Body.String(), `"insertedId"`) {
		t.Fatalf("unexpected body: %s", res.Body.String())
	}
}

func TestNewHandlerDoesNotMountMongoAtlasWhenDisabled(t *testing.T) {
	handler := NewHandler(ServerOptions{Services: []string{"resend"}})

	res := httptest.NewRecorder()
	handler.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/api/atlas/v2/groups", nil))

	if res.Code != http.StatusNotFound {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
}

func TestNewHandlerMountsSlackWhenEnabled(t *testing.T) {
	handler := NewHandler(ServerOptions{Services: []string{"slack"}})

	res := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/auth.test", nil)
	req.Header.Set("Authorization", "Bearer xoxb-test-token")
	handler.ServeHTTP(res, req)

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	if !strings.Contains(res.Body.String(), `"team":"Emulate"`) || !strings.Contains(res.Body.String(), `"user_id":"U000000001"`) {
		t.Fatalf("unexpected body: %s", res.Body.String())
	}
}

func TestNewHandlerDoesNotMountSlackWhenDisabled(t *testing.T) {
	handler := NewHandler(ServerOptions{Services: []string{"resend"}})

	res := httptest.NewRecorder()
	handler.ServeHTTP(res, httptest.NewRequest(http.MethodPost, "/api/auth.test", nil))

	if res.Code != http.StatusNotFound {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
}

func TestNewHandlerMountsStripeWhenEnabled(t *testing.T) {
	handler := NewHandler(ServerOptions{Services: []string{"stripe"}, BaseURL: "http://localhost:4020"})

	res := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/customers", strings.NewReader(`{"email":"native@stripe.test"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer sk_test_emulated")
	handler.ServeHTTP(res, req)

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	if !strings.Contains(res.Body.String(), `"object":"customer"`) || !strings.Contains(res.Body.String(), `"email":"native@stripe.test"`) {
		t.Fatalf("unexpected body: %s", res.Body.String())
	}
}

func TestNewHandlerDoesNotMountStripeWhenDisabled(t *testing.T) {
	handler := NewHandler(ServerOptions{Services: []string{"resend"}})

	res := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/customers", strings.NewReader(`{"email":"native@stripe.test"}`))
	req.Header.Set("Content-Type", "application/json")
	handler.ServeHTTP(res, req)

	if res.Code != http.StatusNotFound {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
}

func TestNewHandlerSlackDoesNotShadowAWSRootListBuckets(t *testing.T) {
	handler := NewHandler(ServerOptions{Services: []string{"aws", "slack"}})
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Authorization", "AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE/20260519/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-date, Signature=abcdef")
	req.Header.Set("X-Amz-Date", "20260519T000000Z")

	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	if got := res.Header().Get("Content-Type"); got != "application/xml" {
		t.Fatalf("content type = %q, body = %s", got, res.Body.String())
	}
	body := res.Body.String()
	if !strings.Contains(body, "<ListAllMyBucketsResult>") || strings.Contains(body, "Slack Inspector") {
		t.Fatalf("unexpected body: %s", body)
	}
}

func TestNewHandlerMultiServiceSlackServesInspectorAtSlackPath(t *testing.T) {
	handler := NewHandler(ServerOptions{Services: []string{"aws", "slack"}})

	res := httptest.NewRecorder()
	handler.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/slack", nil))

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	body := res.Body.String()
	if !strings.Contains(body, "Message Inspector") || !strings.Contains(body, `href="/slack?channel=`) {
		t.Fatalf("unexpected body: %s", body)
	}
}

func TestNewHandlerSlackOnlyServesRootInspector(t *testing.T) {
	handler := NewHandler(ServerOptions{Services: []string{"slack"}})

	res := httptest.NewRecorder()
	handler.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/", nil))

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	if !strings.Contains(res.Body.String(), "Message Inspector") {
		t.Fatalf("unexpected body: %s", res.Body.String())
	}
}

func TestNewHandlerMountsAppleWhenEnabled(t *testing.T) {
	handler := NewHandler(ServerOptions{Services: []string{"apple"}, BaseURL: "http://localhost:4014"})

	res := httptest.NewRecorder()
	handler.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/.well-known/openid-configuration", nil))

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	if !strings.Contains(res.Body.String(), `"issuer":"http://localhost:4014"`) || !strings.Contains(res.Body.String(), `"jwks_uri":"http://localhost:4014/auth/keys"`) {
		t.Fatalf("unexpected body: %s", res.Body.String())
	}
}

func TestNewHandlerDoesNotMountAppleWhenDisabled(t *testing.T) {
	handler := NewHandler(ServerOptions{Services: []string{"resend"}})

	res := httptest.NewRecorder()
	handler.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/auth/keys", nil))

	if res.Code != http.StatusNotFound {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
}

func TestNewHandlerMountsMicrosoftWhenEnabled(t *testing.T) {
	handler := NewHandler(ServerOptions{Services: []string{"microsoft"}, BaseURL: "http://localhost:4015"})

	res := httptest.NewRecorder()
	handler.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/.well-known/openid-configuration", nil))

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	if !strings.Contains(res.Body.String(), `"issuer":"http://localhost:4015/9188040d-6c67-4c5b-b112-36a304b66dad/v2.0"`) ||
		!strings.Contains(res.Body.String(), `"jwks_uri":"http://localhost:4015/discovery/v2.0/keys"`) {
		t.Fatalf("unexpected body: %s", res.Body.String())
	}
}

func TestNewHandlerMountsOktaWhenEnabled(t *testing.T) {
	handler := NewHandler(ServerOptions{Services: []string{"okta"}, BaseURL: "http://localhost:4016"})

	res := httptest.NewRecorder()
	handler.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/oauth2/default/.well-known/openid-configuration", nil))

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	if !strings.Contains(res.Body.String(), `"issuer":"http://localhost:4016/oauth2/default"`) ||
		!strings.Contains(res.Body.String(), `"jwks_uri":"http://localhost:4016/oauth2/default/v1/keys"`) {
		t.Fatalf("unexpected body: %s", res.Body.String())
	}
}

func TestNewHandlerMountsClerkWhenEnabled(t *testing.T) {
	handler := NewHandler(ServerOptions{Services: []string{"clerk"}, BaseURL: "http://localhost:4017"})

	res := httptest.NewRecorder()
	handler.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/.well-known/openid-configuration", nil))

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	if !strings.Contains(res.Body.String(), `"issuer":"http://localhost:4017"`) ||
		!strings.Contains(res.Body.String(), `"jwks_uri":"http://localhost:4017/v1/jwks"`) {
		t.Fatalf("unexpected body: %s", res.Body.String())
	}
}

func TestNewHandlerMultiServiceOIDCDiscoveryUsesServicePrefixes(t *testing.T) {
	handler := NewHandler(ServerOptions{
		Services: []string{"apple", "google", "microsoft", "okta", "clerk"},
		BaseURL:  "http://localhost:4010",
	})

	res := httptest.NewRecorder()
	handler.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/.well-known/openid-configuration", nil))
	if res.Code != http.StatusBadRequest {
		t.Fatalf("root discovery status = %d, body = %s", res.Code, res.Body.String())
	}
	if !strings.Contains(res.Body.String(), "service specific discovery path") {
		t.Fatalf("unexpected root discovery body: %s", res.Body.String())
	}

	for _, tc := range []struct {
		path string
		want string
	}{
		{path: "/google/.well-known/openid-configuration", want: `"issuer":"http://localhost:4010/google"`},
		{path: "/apple/.well-known/openid-configuration", want: `"issuer":"http://localhost:4010/apple"`},
		{path: "/microsoft/.well-known/openid-configuration", want: `"issuer":"http://localhost:4010/microsoft/9188040d-6c67-4c5b-b112-36a304b66dad/v2.0"`},
		{path: "/okta/oauth2/default/.well-known/openid-configuration", want: `"issuer":"http://localhost:4010/okta/oauth2/default"`},
		{path: "/clerk/.well-known/openid-configuration", want: `"issuer":"http://localhost:4010/clerk"`},
	} {
		t.Run(tc.path, func(t *testing.T) {
			res := httptest.NewRecorder()
			handler.ServeHTTP(res, httptest.NewRequest(http.MethodGet, tc.path, nil))
			if res.Code != http.StatusOK {
				t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
			}
			if !strings.Contains(res.Body.String(), tc.want) {
				t.Fatalf("missing %s in %s", tc.want, res.Body.String())
			}
		})
	}
}

func TestNewHandlerPrefixesClerkOIDCWhenVercelIsEnabled(t *testing.T) {
	handler := NewHandler(ServerOptions{
		Services: []string{"vercel", "clerk"},
		BaseURL:  "http://localhost:4010",
	})

	rootDiscovery := httptest.NewRecorder()
	handler.ServeHTTP(rootDiscovery, httptest.NewRequest(http.MethodGet, "/.well-known/openid-configuration", nil))
	if rootDiscovery.Code != http.StatusBadRequest {
		t.Fatalf("root discovery status = %d, body = %s", rootDiscovery.Code, rootDiscovery.Body.String())
	}
	if !strings.Contains(rootDiscovery.Body.String(), "/clerk/.well-known/openid-configuration") {
		t.Fatalf("unexpected root discovery body: %s", rootDiscovery.Body.String())
	}

	discovery := httptest.NewRecorder()
	handler.ServeHTTP(discovery, httptest.NewRequest(http.MethodGet, "/clerk/.well-known/openid-configuration", nil))
	if discovery.Code != http.StatusOK {
		t.Fatalf("prefixed discovery status = %d, body = %s", discovery.Code, discovery.Body.String())
	}
	if !strings.Contains(discovery.Body.String(), `"issuer":"http://localhost:4010/clerk"`) ||
		!strings.Contains(discovery.Body.String(), `"authorization_endpoint":"http://localhost:4010/clerk/oauth/authorize"`) {
		t.Fatalf("unexpected prefixed discovery body: %s", discovery.Body.String())
	}

	authorizePath := "/clerk/oauth/authorize?client_id=clerk_emulate_client&response_type=code&redirect_uri=" + url.QueryEscape("http://localhost:3000/api/auth/callback/clerk")
	authorize := httptest.NewRecorder()
	handler.ServeHTTP(authorize, httptest.NewRequest(http.MethodGet, authorizePath, nil))
	if authorize.Code != http.StatusOK {
		t.Fatalf("authorize status = %d, body = %s", authorize.Code, authorize.Body.String())
	}
	if !strings.Contains(authorize.Body.String(), `action="/clerk/oauth/authorize/callback"`) {
		t.Fatalf("authorize form did not use prefixed callback: %s", authorize.Body.String())
	}
}

func TestNewHandlerDoesNotMountOktaWhenDisabled(t *testing.T) {
	handler := NewHandler(ServerOptions{Services: []string{"resend"}})

	res := httptest.NewRecorder()
	handler.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/oauth2/default/v1/keys", nil))

	if res.Code != http.StatusNotFound {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
}

func TestNewHandlerDoesNotMountClerkWhenDisabled(t *testing.T) {
	handler := NewHandler(ServerOptions{Services: []string{"resend"}})

	res := httptest.NewRecorder()
	handler.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/v1/jwks", nil))

	if res.Code != http.StatusNotFound {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
}

func TestNewHandlerDoesNotMountMicrosoftWhenDisabled(t *testing.T) {
	handler := NewHandler(ServerOptions{Services: []string{"resend"}})

	res := httptest.NewRecorder()
	handler.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/discovery/v2.0/keys", nil))

	if res.Code != http.StatusNotFound {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
}

func TestNewHandlerMountsVercelWhenEnabled(t *testing.T) {
	handler := NewHandler(ServerOptions{Services: []string{"vercel"}, BaseURL: "http://localhost:4010"})

	res := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v2/user", nil)
	req.Header.Set("Authorization", "Bearer test_token_admin")
	handler.ServeHTTP(res, req)

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	if !strings.Contains(res.Body.String(), `"username":"admin"`) {
		t.Fatalf("unexpected body: %s", res.Body.String())
	}
}

func TestNewHandlerDoesNotMountVercelWhenDisabled(t *testing.T) {
	handler := NewHandler(ServerOptions{Services: []string{"resend"}})

	res := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v2/user", nil)
	req.Header.Set("Authorization", "Bearer test_token_admin")
	handler.ServeHTTP(res, req)

	if res.Code != http.StatusNotFound {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
}

func TestNewHandlerMountsGitHubWhenEnabled(t *testing.T) {
	handler := NewHandler(ServerOptions{Services: []string{"github"}, BaseURL: "http://localhost:4010"})

	res := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/user", nil)
	req.Header.Set("Authorization", "Bearer test_token_admin")
	handler.ServeHTTP(res, req)

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	if !strings.Contains(res.Body.String(), `"login":"admin"`) {
		t.Fatalf("unexpected body: %s", res.Body.String())
	}
}

func TestNewHandlerDoesNotMountGitHubWhenDisabled(t *testing.T) {
	handler := NewHandler(ServerOptions{Services: []string{"resend"}})

	res := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/user", nil)
	req.Header.Set("Authorization", "Bearer test_token_admin")
	handler.ServeHTTP(res, req)

	if res.Code != http.StatusNotFound {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
}
