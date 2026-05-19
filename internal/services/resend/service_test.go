package resend

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	corehttp "github.com/vercel-labs/emulate/internal/core/http"
	corestore "github.com/vercel-labs/emulate/internal/core/store"
)

func newTestHandler() http.Handler {
	router := corehttp.NewRouter()
	Register(router, Options{})
	router.NotFound(func(c *corehttp.Context) {
		c.JSON(http.StatusNotFound, map[string]any{"message": "Not Found"})
	})
	return router
}

func requestJSON(t *testing.T, handler http.Handler, method string, path string, body string) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer re_test_token")
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)
	var parsed map[string]any
	if strings.Contains(res.Header().Get("Content-Type"), "application/json") && res.Body.Len() > 0 {
		if err := json.Unmarshal(res.Body.Bytes(), &parsed); err != nil {
			t.Fatalf("failed to parse response JSON: %v\nbody: %s", err, res.Body.String())
		}
	}
	return res, parsed
}

func TestEmailsLifecycle(t *testing.T) {
	handler := newTestHandler()

	res, body := requestJSON(t, handler, http.MethodPost, "/emails", `{"from":"a@example.com","to":"b@example.com","subject":"Hello","html":"<h1>Hello</h1>"}`)
	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	id, _ := body["id"].(string)
	if id == "" {
		t.Fatalf("missing id in %#v", body)
	}

	res, body = requestJSON(t, handler, http.MethodGet, "/emails/"+id, "")
	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	if body["subject"] != "Hello" || body["status"] != "delivered" {
		t.Fatalf("unexpected email: %#v", body)
	}

	res, body = requestJSON(t, handler, http.MethodGet, "/emails", "")
	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	data, _ := body["data"].([]any)
	if body["object"] != "list" || len(data) != 1 {
		t.Fatalf("unexpected list: %#v", body)
	}
}

func TestEmailValidationAndCancel(t *testing.T) {
	handler := newTestHandler()

	res, body := requestJSON(t, handler, http.MethodPost, "/emails", `{"from":"a@example.com"}`)
	if res.Code != http.StatusUnprocessableEntity || body["name"] != "validation_error" {
		t.Fatalf("unexpected validation response: status=%d body=%#v", res.Code, body)
	}

	res, body = requestJSON(t, handler, http.MethodPost, "/emails", `{"from":"a@example.com","to":"b@example.com","subject":"Later","scheduled_at":"2099-01-01T00:00:00Z"}`)
	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	id := body["id"].(string)

	res, body = requestJSON(t, handler, http.MethodPost, "/emails/"+id+"/cancel", `{}`)
	if res.Code != http.StatusOK || body["canceled"] != true {
		t.Fatalf("unexpected cancel response: status=%d body=%#v", res.Code, body)
	}

	res, body = requestJSON(t, handler, http.MethodGet, "/emails/"+id, "")
	if res.Code != http.StatusOK || body["status"] != "canceled" {
		t.Fatalf("unexpected canceled email: status=%d body=%#v", res.Code, body)
	}
}

func TestBatchEmailsValidateBeforeInsert(t *testing.T) {
	handler := newTestHandler()

	res, body := requestJSON(t, handler, http.MethodPost, "/emails/batch", `[{"from":"a@example.com","to":"b@example.com","subject":"One"},{"from":"a@example.com"}]`)
	if res.Code != http.StatusUnprocessableEntity || body["name"] != "validation_error" {
		t.Fatalf("unexpected batch validation response: status=%d body=%#v", res.Code, body)
	}

	res, body = requestJSON(t, handler, http.MethodGet, "/emails", "")
	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	if data := body["data"].([]any); len(data) != 0 {
		t.Fatalf("batch inserted records after validation failure: %#v", body)
	}

	res, body = requestJSON(t, handler, http.MethodPost, "/emails/batch", `[{"from":"a@example.com","to":"b@example.com","subject":"One"},{"from":"a@example.com","to":"c@example.com","subject":"Two"}]`)
	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	if data := body["data"].([]any); len(data) != 2 {
		t.Fatalf("unexpected batch response: %#v", body)
	}
}

func TestDomainsLifecycle(t *testing.T) {
	handler := newTestHandler()

	res, body := requestJSON(t, handler, http.MethodPost, "/domains", `{"name":"example.com"}`)
	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	id := body["id"].(string)
	if body["status"] != "pending" {
		t.Fatalf("unexpected domain: %#v", body)
	}

	res, body = requestJSON(t, handler, http.MethodPost, "/domains/"+id+"/verify", `{}`)
	if res.Code != http.StatusOK || body["status"] != "verified" {
		t.Fatalf("unexpected verify response: status=%d body=%#v", res.Code, body)
	}

	res, body = requestJSON(t, handler, http.MethodGet, "/domains", "")
	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	if data := body["data"].([]any); len(data) != 1 {
		t.Fatalf("unexpected domain list: %#v", body)
	}

	res, body = requestJSON(t, handler, http.MethodDelete, "/domains/"+id, "")
	if res.Code != http.StatusOK || body["deleted"] != true {
		t.Fatalf("unexpected delete response: status=%d body=%#v", res.Code, body)
	}
}

func TestAPIKeysDoNotExposeTokenInList(t *testing.T) {
	handler := newTestHandler()

	res, body := requestJSON(t, handler, http.MethodPost, "/api-keys", `{"name":"Production"}`)
	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	id := body["id"].(string)
	token := body["token"].(string)
	if !strings.HasPrefix(token, "re_") {
		t.Fatalf("unexpected token: %s", token)
	}

	res, body = requestJSON(t, handler, http.MethodGet, "/api-keys", "")
	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	key := body["data"].([]any)[0].(map[string]any)
	if _, ok := key["token"]; ok {
		t.Fatalf("list exposed token: %#v", key)
	}

	res, body = requestJSON(t, handler, http.MethodDelete, "/api-keys/"+id, "")
	if res.Code != http.StatusOK || body["deleted"] != true {
		t.Fatalf("unexpected delete response: status=%d body=%#v", res.Code, body)
	}
}

func TestAudiencesAndContactsLifecycle(t *testing.T) {
	handler := newTestHandler()

	res, body := requestJSON(t, handler, http.MethodPost, "/audiences", `{"name":"Newsletter"}`)
	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	audienceID := body["id"].(string)

	res, body = requestJSON(t, handler, http.MethodPost, "/audiences/"+audienceID+"/contacts", `{"email":"user@example.com","first_name":"Test"}`)
	if res.Code != http.StatusOK || body["email"] != "user@example.com" {
		t.Fatalf("unexpected contact response: status=%d body=%#v", res.Code, body)
	}
	contactID := body["id"].(string)

	res, body = requestJSON(t, handler, http.MethodGet, "/audiences/"+audienceID+"/contacts", "")
	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	if data := body["data"].([]any); len(data) != 1 {
		t.Fatalf("unexpected contacts list: %#v", body)
	}

	res, body = requestJSON(t, handler, http.MethodDelete, "/audiences/"+audienceID+"/contacts/"+contactID, "")
	if res.Code != http.StatusOK || body["deleted"] != true {
		t.Fatalf("unexpected contact delete response: status=%d body=%#v", res.Code, body)
	}
}

func TestInboxPages(t *testing.T) {
	handler := newTestHandler()

	req := httptest.NewRequest(http.MethodGet, "/inbox", nil)
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), "0 emails sent") {
		t.Fatalf("unexpected empty inbox: status=%d body=%s", res.Code, res.Body.String())
	}

	sendRes, body := requestJSON(t, handler, http.MethodPost, "/emails", `{"from":"sender@example.com","to":"recipient@example.com","subject":"Detail Test","html":"<h1>Hello</h1>"}`)
	if sendRes.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", sendRes.Code, sendRes.Body.String())
	}
	id := body["id"].(string)

	res = httptest.NewRecorder()
	handler.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/inbox", nil))
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), "Detail Test") || !strings.Contains(res.Body.String(), "1 email sent") {
		t.Fatalf("unexpected inbox: status=%d body=%s", res.Code, res.Body.String())
	}

	res = httptest.NewRecorder()
	handler.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/inbox/"+id, nil))
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), "Detail Test") || !strings.Contains(res.Body.String(), "email-preview-frame") {
		t.Fatalf("unexpected inbox detail: status=%d body=%s", res.Code, res.Body.String())
	}
}

func TestFormEncodedEmailBody(t *testing.T) {
	handler := newTestHandler()
	body := bytes.NewBufferString("from=a%40example.com&to=b%40example.com&subject=Hello")
	req := httptest.NewRequest(http.MethodPost, "/emails", body)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
}

func TestSeedFromConfig(t *testing.T) {
	runtimeStore := corestore.New()
	SeedFromConfig(runtimeStore, SeedConfig{
		Domains:  []DomainSeed{{Name: "example.com"}},
		Contacts: []ContactSeed{{Email: "user@example.com", FirstName: "Test", LastName: "User"}},
	})

	rs := NewStore(runtimeStore)
	domains := rs.Domains.All()
	if len(domains) != 1 || stringField(domains[0], "status") != "verified" {
		t.Fatalf("unexpected seeded domains: %#v", domains)
	}
	contacts := rs.Contacts.All()
	if len(contacts) != 1 || stringField(contacts[0], "email") != "user@example.com" {
		t.Fatalf("unexpected seeded contacts: %#v", contacts)
	}
	audiences := rs.Audiences.All()
	if len(audiences) != 1 || stringField(audiences[0], "name") != "Default" {
		t.Fatalf("unexpected seeded audiences: %#v", audiences)
	}
}
