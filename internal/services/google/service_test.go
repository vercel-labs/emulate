package google

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"

	corehttp "github.com/vercel-labs/emulate/internal/core/http"
	corestore "github.com/vercel-labs/emulate/internal/core/store"
)

func newGoogleTestHandler() http.Handler {
	router := corehttp.NewRouter()
	Register(router, Options{
		Store:   corestore.New(),
		BaseURL: "http://localhost:4016",
		Seed: &SeedConfig{
			Users: []UserSeed{
				{Email: "testuser@example.com", Name: "Test User"},
				{Email: "consumer@gmail.com", Name: "Consumer User"},
			},
			OAuthClients: []OAuthClientSeed{
				{
					ClientID:     "emu_google_client_id",
					ClientSecret: "emu_google_client_secret",
					Name:         "Inbox Zero",
					RedirectURIs: []string{"http://localhost:3000/api/auth/callback/google"},
				},
			},
			Labels: []LabelSeed{
				{ID: "Label_ops", UserEmail: "testuser@example.com", Name: "Ops/Review", ColorBackground: "#DDEEFF", ColorText: "#111111"},
			},
			Messages: []MessageSeed{
				{
					ID:        "msg_support_1",
					ThreadID:  "thread_support",
					UserEmail: "testuser@example.com",
					From:      "Support <support@example.com>",
					To:        "testuser@example.com",
					Subject:   "Your support ticket has been updated",
					BodyText:  "We have an update on your ticket.",
					LabelIDs:  []string{"INBOX", "UNREAD", "Label_ops"},
					Date:      "2025-01-04T10:00:00.000Z",
				},
				{
					ID:        "msg_invoice",
					ThreadID:  "thread_billing",
					UserEmail: "testuser@example.com",
					From:      "Billing <billing@example.com>",
					To:        "testuser@example.com",
					Subject:   "Invoice ready for review",
					BodyText:  "Your January invoice is ready to review.",
					LabelIDs:  []string{"INBOX", "CATEGORY_UPDATES"},
					Date:      "2025-01-03T10:00:00.000Z",
				},
				{
					ID:        "msg_draft",
					ThreadID:  "thread_draft",
					UserEmail: "testuser@example.com",
					From:      "testuser@example.com",
					To:        "partner@example.com",
					Subject:   "Draft follow-up",
					BodyText:  "Draft body.",
					LabelIDs:  []string{"DRAFT"},
					Date:      "2025-01-01T10:00:00.000Z",
				},
			},
			Calendars: []CalendarSeed{
				{ID: "primary", UserEmail: "testuser@example.com", Summary: "testuser@example.com", Primary: true, TimeZone: "UTC"},
				{ID: "cal_team", UserEmail: "testuser@example.com", Summary: "Team Calendar", TimeZone: "UTC"},
			},
			CalendarEvents: []CalendarEventSeed{
				{
					ID:            "evt_kickoff",
					UserEmail:     "testuser@example.com",
					CalendarID:    "primary",
					Summary:       "Project Kickoff",
					StartDateTime: "2025-01-10T09:00:00.000Z",
					EndDateTime:   "2025-01-10T09:30:00.000Z",
					HangoutLink:   "https://meet.google.com/project-kickoff",
				},
			},
			DriveItems: []DriveItemSeed{
				{ID: "drv_docs", UserEmail: "testuser@example.com", Name: "Docs", MIMEType: googleDriveFolderMIME, ParentIDs: []string{"root"}},
				{ID: "drv_handbook", UserEmail: "testuser@example.com", Name: "Handbook.pdf", MIMEType: "application/pdf", ParentIDs: []string{"drv_docs"}, Data: "pdf-handbook-data"},
			},
		},
	})
	return router
}

func TestGoogleOAuthAuthorizationCodeAndRefresh(t *testing.T) {
	handler := newGoogleTestHandler()
	form := url.Values{
		"email":        {"testuser@example.com"},
		"redirect_uri": {"http://localhost:3000/api/auth/callback/google"},
		"scope":        {"openid email profile https://www.googleapis.com/auth/calendar.readonly"},
		"client_id":    {"emu_google_client_id"},
	}
	res := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "http://localhost:4016/o/oauth2/v2/auth/callback", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	handler.ServeHTTP(res, req)
	if res.Code != http.StatusFound {
		t.Fatalf("authorize callback status = %d, body = %s", res.Code, res.Body.String())
	}
	location, err := url.Parse(res.Header().Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	code := location.Query().Get("code")
	if code == "" {
		t.Fatalf("missing code in redirect: %s", res.Header().Get("Location"))
	}

	tokenForm := url.Values{
		"code":          {code},
		"grant_type":    {"authorization_code"},
		"redirect_uri":  {"http://localhost:3000/api/auth/callback/google"},
		"client_id":     {"emu_google_client_id"},
		"client_secret": {"emu_google_client_secret"},
	}
	res = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "http://localhost:4016/oauth2/token", strings.NewReader(tokenForm.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	handler.ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("token status = %d, body = %s", res.Code, res.Body.String())
	}
	var tokenBody struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		IDToken      string `json:"id_token"`
		Scope        string `json:"scope"`
	}
	mustDecodeGoogleJSON(t, res.Body.Bytes(), &tokenBody)
	if !strings.HasPrefix(tokenBody.AccessToken, "google_") || !strings.HasPrefix(tokenBody.RefreshToken, "google_refresh_") || tokenBody.IDToken == "" {
		t.Fatalf("unexpected token body: %#v", tokenBody)
	}
	assertGoogleIDTokenUsesPublishedJWKS(t, handler, tokenBody.IDToken)

	refreshForm := url.Values{
		"grant_type":    {"refresh_token"},
		"refresh_token": {tokenBody.RefreshToken},
		"client_id":     {"emu_google_client_id"},
		"client_secret": {"emu_google_client_secret"},
	}
	res = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "http://localhost:4016/oauth2/token", strings.NewReader(refreshForm.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	handler.ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("refresh status = %d, body = %s", res.Code, res.Body.String())
	}
	var refreshBody struct {
		AccessToken string `json:"access_token"`
		Scope       string `json:"scope"`
	}
	mustDecodeGoogleJSON(t, res.Body.Bytes(), &refreshBody)
	if refreshBody.AccessToken == "" || refreshBody.AccessToken == tokenBody.AccessToken || refreshBody.Scope != tokenBody.Scope {
		t.Fatalf("unexpected refresh body: %#v", refreshBody)
	}
}

func TestGoogleGmailCalendarAndDriveSeededRoutes(t *testing.T) {
	handler := newGoogleTestHandler()
	res := googleRequest(handler, http.MethodGet, "/oauth2/v2/userinfo", "", true)
	if res.Code != http.StatusOK {
		t.Fatalf("userinfo status = %d, body = %s", res.Code, res.Body.String())
	}
	if !strings.Contains(res.Body.String(), `"email":"testuser@example.com"`) || !strings.Contains(res.Body.String(), `"hd":"example.com"`) {
		t.Fatalf("unexpected userinfo: %s", res.Body.String())
	}

	res = googleRequest(handler, http.MethodGet, "/gmail/v1/users/me/messages?maxResults=2&q=-label:DRAFT+in:inbox", "", true)
	if res.Code != http.StatusOK {
		t.Fatalf("messages status = %d, body = %s", res.Code, res.Body.String())
	}
	var messages struct {
		Messages []struct {
			ID       string `json:"id"`
			ThreadID string `json:"threadId"`
		} `json:"messages"`
		ResultSizeEstimate int `json:"resultSizeEstimate"`
	}
	mustDecodeGoogleJSON(t, res.Body.Bytes(), &messages)
	if messages.ResultSizeEstimate != 2 || messages.Messages[0].ID != "msg_support_1" || messages.Messages[1].ID != "msg_invoice" {
		t.Fatalf("unexpected messages: %#v", messages)
	}

	res = googleRequest(handler, http.MethodPost, "/gmail/v1/users/me/messages/msg_invoice/modify", `{"addLabelIds":["Label_ops"],"removeLabelIds":["INBOX"]}`, true)
	if res.Code != http.StatusOK {
		t.Fatalf("modify status = %d, body = %s", res.Code, res.Body.String())
	}
	if !strings.Contains(res.Body.String(), `"Label_ops"`) || strings.Contains(res.Body.String(), `"INBOX"`) {
		t.Fatalf("unexpected modified message: %s", res.Body.String())
	}

	res = googleRequest(handler, http.MethodPost, "/gmail/v1/users/me/drafts", `{"message":{"to":"partner@example.com","subject":"Draft review","text":"First draft body"}}`, true)
	if res.Code != http.StatusOK {
		t.Fatalf("create draft status = %d, body = %s", res.Code, res.Body.String())
	}
	var draft struct {
		ID      string `json:"id"`
		Message struct {
			ID       string   `json:"id"`
			LabelIDs []string `json:"labelIds"`
		} `json:"message"`
	}
	mustDecodeGoogleJSON(t, res.Body.Bytes(), &draft)
	if draft.ID == "" || !containsString(draft.Message.LabelIDs, "DRAFT") {
		t.Fatalf("unexpected draft: %#v", draft)
	}
	res = googleRequest(handler, http.MethodPost, "/gmail/v1/users/me/drafts/send", `{"id":"`+draft.ID+`"}`, true)
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), `"SENT"`) || strings.Contains(res.Body.String(), `"DRAFT"`) {
		t.Fatalf("send draft status = %d, body = %s", res.Code, res.Body.String())
	}

	res = googleRequest(handler, http.MethodGet, "/calendar/v3/users/me/calendarList", "", true)
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), `"id":"primary"`) || !strings.Contains(res.Body.String(), `"id":"cal_team"`) {
		t.Fatalf("calendar list status = %d, body = %s", res.Code, res.Body.String())
	}

	res = googleRequest(handler, http.MethodGet, "/calendar/v3/calendars/primary/events?q=kickoff", "", true)
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), `"id":"evt_kickoff"`) {
		t.Fatalf("event list status = %d, body = %s", res.Code, res.Body.String())
	}

	res = googleRequest(handler, http.MethodGet, "/drive/v3/files?q=%27root%27+in+parents+and+mimeType+%3D+%27application%2Fvnd.google-apps.folder%27+and+trashed+%3D+false", "", true)
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), `"id":"drv_docs"`) {
		t.Fatalf("drive list status = %d, body = %s", res.Code, res.Body.String())
	}

	res = googleRequest(handler, http.MethodGet, "/drive/v3/files/drv_handbook?alt=media", "", true)
	if res.Code != http.StatusOK {
		t.Fatalf("drive media status = %d, body = %s", res.Code, res.Body.String())
	}
	body, _ := io.ReadAll(res.Result().Body)
	if string(body) != "pdf-handbook-data" {
		t.Fatalf("unexpected drive media body: %q", string(body))
	}
}

func TestGoogleRejectsUnknownMutationLabels(t *testing.T) {
	handler := newGoogleTestHandler()
	cases := []struct {
		name string
		path string
		body string
	}{
		{
			name: "message modify",
			path: "/gmail/v1/users/me/messages/msg_invoice/modify",
			body: `{"addLabelIds":["Label_missing"]}`,
		},
		{
			name: "batch modify",
			path: "/gmail/v1/users/me/messages/batchModify",
			body: `{"ids":["msg_invoice"],"addLabelIds":["Label_missing"]}`,
		},
		{
			name: "thread modify",
			path: "/gmail/v1/users/me/threads/thread_billing/modify",
			body: `{"removeLabelIds":["Label_missing"]}`,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			res := googleRequest(handler, http.MethodPost, tc.path, tc.body, true)
			if res.Code != http.StatusBadRequest || !strings.Contains(res.Body.String(), "Invalid label IDs: Label_missing") {
				t.Fatalf("mutation status = %d, body = %s", res.Code, res.Body.String())
			}
		})
	}

	res := googleRequest(handler, http.MethodGet, "/gmail/v1/users/me/messages/msg_invoice", "", true)
	if res.Code != http.StatusOK {
		t.Fatalf("get message status = %d, body = %s", res.Code, res.Body.String())
	}
	var message struct {
		LabelIDs []string `json:"labelIds"`
	}
	mustDecodeGoogleJSON(t, res.Body.Bytes(), &message)
	if containsString(message.LabelIDs, "Label_missing") {
		t.Fatalf("missing label was applied: %#v", message.LabelIDs)
	}
}

func TestGoogleHistoryIDsAreDecimalAndMonotonic(t *testing.T) {
	var previous int64
	for i := 0; i < 1000; i++ {
		id := generateHistoryID()
		parsed, err := strconv.ParseInt(id, 10, 64)
		if err != nil {
			t.Fatalf("history ID %q is not decimal: %v", id, err)
		}
		if parsed <= previous {
			t.Fatalf("history ID did not increase: previous=%d current=%d", previous, parsed)
		}
		previous = parsed
	}
}

func TestGoogleHistoryListUsesNumericStartHistoryID(t *testing.T) {
	runtimeStore := corestore.New()
	service := New(Options{
		Store:   runtimeStore,
		BaseURL: "http://localhost:4016",
		Seed: &SeedConfig{
			Users: []UserSeed{{Email: "testuser@example.com", Name: "Test User"}},
		},
	})
	service.store.History.Insert(corestore.Record{
		"gmail_id":         "2",
		"user_email":       "testuser@example.com",
		"change_type":      "messageAdded",
		"message_gmail_id": "msg_two",
		"thread_id":        "thread_two",
	})
	service.store.History.Insert(corestore.Record{
		"gmail_id":         "10",
		"user_email":       "testuser@example.com",
		"change_type":      "messageAdded",
		"message_gmail_id": "msg_ten",
		"thread_id":        "thread_ten",
	})
	router := corehttp.NewRouter()
	service.RegisterRoutes(router)

	res := googleRequest(router, http.MethodGet, "/gmail/v1/users/me/history?startHistoryId=2&historyTypes=messageAdded", "", true)
	if res.Code != http.StatusOK {
		t.Fatalf("history status = %d, body = %s", res.Code, res.Body.String())
	}
	var body struct {
		History []struct {
			ID string `json:"id"`
		} `json:"history"`
	}
	mustDecodeGoogleJSON(t, res.Body.Bytes(), &body)
	if len(body.History) != 1 || body.History[0].ID != "10" {
		t.Fatalf("unexpected history response: %#v", body)
	}
}

func TestGoogleSeedUpdatesPrimaryCalendar(t *testing.T) {
	router := corehttp.NewRouter()
	Register(router, Options{
		Store:   corestore.New(),
		BaseURL: "http://localhost:4016",
		Seed: &SeedConfig{
			Calendars: []CalendarSeed{
				{
					ID:        "primary",
					UserEmail: defaultGoogleEmail,
					Summary:   "Seeded Primary Calendar",
					TimeZone:  "America/Chicago",
					Primary:   true,
				},
			},
		},
	})

	res := googleRequest(router, http.MethodGet, "/calendar/v3/users/me/calendarList", "", true)
	if res.Code != http.StatusOK {
		t.Fatalf("calendar list status = %d, body = %s", res.Code, res.Body.String())
	}
	var body struct {
		Items []struct {
			ID       string `json:"id"`
			Summary  string `json:"summary"`
			TimeZone string `json:"timeZone"`
			Primary  bool   `json:"primary"`
		} `json:"items"`
	}
	mustDecodeGoogleJSON(t, res.Body.Bytes(), &body)
	for _, calendar := range body.Items {
		if calendar.Primary {
			if calendar.ID != "primary" || calendar.Summary != "Seeded Primary Calendar" || calendar.TimeZone != "America/Chicago" {
				t.Fatalf("primary calendar did not use seed values: %#v", calendar)
			}
			return
		}
	}
	t.Fatalf("missing primary calendar: %#v", body.Items)
}

func TestGoogleSystemLabelsRejectMutation(t *testing.T) {
	handler := newGoogleTestHandler()

	res := googleRequest(handler, http.MethodPatch, "/gmail/v1/users/me/labels/INBOX", `{"name":"Changed"}`, true)
	if res.Code != http.StatusBadRequest || !strings.Contains(res.Body.String(), "System labels cannot be modified") {
		t.Fatalf("patch system label status = %d, body = %s", res.Code, res.Body.String())
	}

	res = googleRequest(handler, http.MethodDelete, "/gmail/v1/users/me/labels/INBOX", "", true)
	if res.Code != http.StatusBadRequest || !strings.Contains(res.Body.String(), "System labels cannot be deleted") {
		t.Fatalf("delete system label status = %d, body = %s", res.Code, res.Body.String())
	}
}

func TestGoogleDriveParentQueryIgnoresEarlierQuotedTerms(t *testing.T) {
	handler := newGoogleTestHandler()
	query := url.QueryEscape("name = 'Handbook.pdf' and 'drv_docs' in parents and trashed = false")
	res := googleRequest(handler, http.MethodGet, "/drive/v3/files?q="+query, "", true)
	if res.Code != http.StatusOK {
		t.Fatalf("drive list status = %d, body = %s", res.Code, res.Body.String())
	}
	var body struct {
		Files []struct {
			ID string `json:"id"`
		} `json:"files"`
	}
	mustDecodeGoogleJSON(t, res.Body.Bytes(), &body)
	for _, file := range body.Files {
		if file.ID == "drv_handbook" {
			return
		}
	}
	t.Fatalf("missing handbook from drive query: %#v", body.Files)
}

func googleRequest(handler http.Handler, method string, path string, body string, auth bool) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, "http://localhost:4016"+path, strings.NewReader(body))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if auth {
		req.Header.Set("Authorization", "Bearer test-token")
	}
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)
	return res
}

func mustDecodeGoogleJSON(t *testing.T, raw []byte, target any) {
	t.Helper()
	if err := json.Unmarshal(raw, target); err != nil {
		t.Fatalf("decode JSON: %v\n%s", err, string(raw))
	}
}

func assertGoogleIDTokenUsesPublishedJWKS(t *testing.T, handler http.Handler, idToken string) {
	t.Helper()
	parts := strings.Split(idToken, ".")
	if len(parts) != 3 {
		t.Fatalf("id_token is not a JWT: %q", idToken)
	}
	headerRaw, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		t.Fatalf("decode JWT header: %v", err)
	}
	var header struct {
		Alg string `json:"alg"`
		Kid string `json:"kid"`
	}
	mustDecodeGoogleJSON(t, headerRaw, &header)
	if header.Alg != "RS256" || header.Kid != googleKeyID {
		t.Fatalf("unexpected JWT header: %#v", header)
	}

	res := googleRequest(handler, http.MethodGet, "/oauth2/v3/certs", "", false)
	if res.Code != http.StatusOK {
		t.Fatalf("certs status = %d, body = %s", res.Code, res.Body.String())
	}
	var jwks struct {
		Keys []struct {
			Kty string `json:"kty"`
			Kid string `json:"kid"`
			Alg string `json:"alg"`
			N   string `json:"n"`
			E   string `json:"e"`
		} `json:"keys"`
	}
	mustDecodeGoogleJSON(t, res.Body.Bytes(), &jwks)
	if len(jwks.Keys) != 1 || jwks.Keys[0].Kty != "RSA" || jwks.Keys[0].Kid != header.Kid || jwks.Keys[0].Alg != "RS256" || jwks.Keys[0].N == "" || jwks.Keys[0].E == "" {
		t.Fatalf("unexpected JWKS: %#v", jwks)
	}
}
