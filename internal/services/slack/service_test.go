package slack

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"

	corehttp "github.com/vercel-labs/emulate/internal/core/http"
	corestore "github.com/vercel-labs/emulate/internal/core/store"
)

func TestSlackAuthTeamAndUsers(t *testing.T) {
	_, handler := newSlackTestService()

	res := slackRequest(handler, http.MethodPost, "/api/auth.test", "", false)
	var unauth map[string]any
	mustDecodeSlackJSON(t, res.Body.Bytes(), &unauth)
	if unauth["ok"] != false || unauth["error"] != "not_authed" {
		t.Fatalf("unexpected unauth body: %#v", unauth)
	}

	res = slackRequest(handler, http.MethodPost, "/api/auth.test", "", true)
	var auth struct {
		OK     bool   `json:"ok"`
		Team   string `json:"team"`
		UserID string `json:"user_id"`
	}
	mustDecodeSlackJSON(t, res.Body.Bytes(), &auth)
	if !auth.OK || auth.Team != "Emulate" || auth.UserID != "U000000001" {
		t.Fatalf("unexpected auth body: %#v", auth)
	}

	res = slackRequest(handler, http.MethodPost, "/api/users.lookupByEmail", `{"email":"admin@emulate.dev"}`, true)
	var lookup struct {
		OK   bool `json:"ok"`
		User struct {
			ID      string `json:"id"`
			Profile struct {
				Email string `json:"email"`
			} `json:"profile"`
		} `json:"user"`
	}
	mustDecodeSlackJSON(t, res.Body.Bytes(), &lookup)
	if !lookup.OK || lookup.User.ID != "U000000001" || lookup.User.Profile.Email != "admin@emulate.dev" {
		t.Fatalf("unexpected lookup body: %#v", lookup)
	}

	res = slackRequest(handler, http.MethodPost, "/api/bots.info", `{"bot":"B000000001"}`, true)
	var botInfo struct {
		OK  bool `json:"ok"`
		Bot struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"bot"`
	}
	mustDecodeSlackJSON(t, res.Body.Bytes(), &botInfo)
	if !botInfo.OK || botInfo.Bot.ID != "B000000001" || botInfo.Bot.Name == "" {
		t.Fatalf("unexpected bot info body: %#v", botInfo)
	}
}

func TestSlackChatConversationsAndReactions(t *testing.T) {
	_, handler := newSlackTestService()

	post := slackRequest(handler, http.MethodPost, "/api/chat.postMessage", `{"channel":"general","text":"hello world"}`, true)
	var posted struct {
		OK      bool   `json:"ok"`
		Channel string `json:"channel"`
		TS      string `json:"ts"`
		Message struct {
			Text string `json:"text"`
		} `json:"message"`
	}
	mustDecodeSlackJSON(t, post.Body.Bytes(), &posted)
	if !posted.OK || posted.Channel != "C000000001" || posted.TS == "" || posted.Message.Text != "hello world" {
		t.Fatalf("unexpected post body: %#v", posted)
	}

	reply := slackRequest(handler, http.MethodPost, "/api/chat.postMessage", `{"channel":"C000000001","text":"reply","thread_ts":"`+posted.TS+`"}`, true)
	var replyBody struct {
		OK      bool `json:"ok"`
		Message struct {
			ThreadTS string `json:"thread_ts"`
		} `json:"message"`
	}
	mustDecodeSlackJSON(t, reply.Body.Bytes(), &replyBody)
	if !replyBody.OK || replyBody.Message.ThreadTS != posted.TS {
		t.Fatalf("unexpected reply body: %#v", replyBody)
	}

	history := slackRequest(handler, http.MethodPost, "/api/conversations.history", `{"channel":"C000000001"}`, true)
	var historyBody struct {
		OK       bool `json:"ok"`
		Messages []struct {
			TS         string   `json:"ts"`
			ReplyCount int      `json:"reply_count"`
			ReplyUsers []string `json:"reply_users"`
		} `json:"messages"`
	}
	mustDecodeSlackJSON(t, history.Body.Bytes(), &historyBody)
	if !historyBody.OK || len(historyBody.Messages) != 1 || historyBody.Messages[0].ReplyCount != 1 {
		t.Fatalf("unexpected history body: %#v", historyBody)
	}

	replies := slackRequest(handler, http.MethodPost, "/api/conversations.replies", `{"channel":"C000000001","ts":"`+posted.TS+`"}`, true)
	var repliesBody struct {
		OK       bool          `json:"ok"`
		Messages []interface{} `json:"messages"`
	}
	mustDecodeSlackJSON(t, replies.Body.Bytes(), &repliesBody)
	if !repliesBody.OK || len(repliesBody.Messages) != 2 {
		t.Fatalf("unexpected replies body: %#v", repliesBody)
	}

	addReaction := slackRequest(handler, http.MethodPost, "/api/reactions.add", `{"channel":"C000000001","timestamp":"`+posted.TS+`","name":"thumbsup"}`, true)
	var addBody map[string]any
	mustDecodeSlackJSON(t, addReaction.Body.Bytes(), &addBody)
	if addBody["ok"] != true {
		t.Fatalf("unexpected reaction add body: %#v", addBody)
	}
	getReaction := slackRequest(handler, http.MethodPost, "/api/reactions.get", `{"channel":"C000000001","timestamp":"`+posted.TS+`"}`, true)
	if !strings.Contains(getReaction.Body.String(), `"name":"thumbsup"`) {
		t.Fatalf("reaction missing: %s", getReaction.Body.String())
	}
}

func TestSlackThreadReplyCountHandlesConcurrentReplies(t *testing.T) {
	service, handler := newSlackTestService()

	post := slackRequest(handler, http.MethodPost, "/api/chat.postMessage", `{"channel":"general","text":"parent"}`, true)
	var posted struct {
		OK bool   `json:"ok"`
		TS string `json:"ts"`
	}
	mustDecodeSlackJSON(t, post.Body.Bytes(), &posted)
	if !posted.OK || posted.TS == "" {
		t.Fatalf("unexpected post body: %#v", posted)
	}

	const replies = 50
	errCh := make(chan string, replies)
	var wg sync.WaitGroup
	for index := 0; index < replies; index++ {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			res := slackRequest(handler, http.MethodPost, "/api/chat.postMessage", fmt.Sprintf(`{"channel":"C000000001","text":"reply %d","thread_ts":"%s"}`, index, posted.TS), true)
			if !strings.Contains(res.Body.String(), `"ok":true`) {
				errCh <- fmt.Sprintf("reply %d failed: %s", index, res.Body.String())
			}
		}(index)
	}
	wg.Wait()
	close(errCh)
	for err := range errCh {
		t.Error(err)
	}
	if t.Failed() {
		return
	}

	parent := service.findMessage("C000000001", posted.TS)
	if parent == nil || intField(parent, "reply_count") != replies {
		t.Fatalf("unexpected parent after replies: %#v", parent)
	}
	replyUsers := stringSliceValue(parent["reply_users"])
	if len(replyUsers) != 1 || replyUsers[0] != "U000000001" {
		t.Fatalf("unexpected reply users: %#v", replyUsers)
	}
}

func TestSlackReactionsHandleConcurrentDistinctUsers(t *testing.T) {
	service, handler := newSlackTestService()

	const reactors = 40
	tokens := make([]string, 0, reactors)
	for index := 0; index < reactors; index++ {
		userID := fmt.Sprintf("UCONC%06d", index)
		token := fmt.Sprintf("xoxb-concurrent-%d", index)
		tokens = append(tokens, token)
		service.store.Users.Insert(userRecord(userInput{
			UserID:   userID,
			TeamID:   "T000000001",
			Name:     fmt.Sprintf("reactor%d", index),
			RealName: fmt.Sprintf("Reactor %d", index),
			Email:    fmt.Sprintf("reactor%d@example.com", index),
		}))
		service.store.Tokens.Insert(corestore.Record{
			"token":  token,
			"login":  userID,
			"scopes": []string{"reactions:write"},
		})
	}

	post := slackRequest(handler, http.MethodPost, "/api/chat.postMessage", `{"channel":"general","text":"react here"}`, true)
	var posted struct {
		OK bool   `json:"ok"`
		TS string `json:"ts"`
	}
	mustDecodeSlackJSON(t, post.Body.Bytes(), &posted)
	if !posted.OK || posted.TS == "" {
		t.Fatalf("unexpected post body: %#v", posted)
	}

	errCh := make(chan string, reactors)
	var wg sync.WaitGroup
	for index, token := range tokens {
		wg.Add(1)
		go func(index int, token string) {
			defer wg.Done()
			res := slackRequestWithToken(handler, http.MethodPost, "/api/reactions.add", fmt.Sprintf(`{"channel":"C000000001","timestamp":"%s","name":"eyes"}`, posted.TS), token)
			if !strings.Contains(res.Body.String(), `"ok":true`) {
				errCh <- fmt.Sprintf("reaction %d failed: %s", index, res.Body.String())
			}
		}(index, token)
	}
	wg.Wait()
	close(errCh)
	for err := range errCh {
		t.Error(err)
	}
	if t.Failed() {
		return
	}

	message := service.findMessage("C000000001", posted.TS)
	if message == nil {
		t.Fatal("posted message missing")
	}
	reactions := recordSliceValue(message["reactions"])
	if len(reactions) != 1 || stringValue(reactions[0]["name"]) != "eyes" || intField(reactions[0], "count") != reactors {
		t.Fatalf("unexpected reactions: %#v", reactions)
	}
	users := stringSliceValue(reactions[0]["users"])
	if len(users) != reactors {
		t.Fatalf("unexpected reaction users: %#v", users)
	}
}

func TestSlackConversationsCreateJoinLeaveAndDelete(t *testing.T) {
	_, handler := newSlackTestService()

	create := slackRequest(handler, http.MethodPost, "/api/conversations.create", `{"name":"eng"}`, true)
	var created struct {
		OK      bool `json:"ok"`
		Channel struct {
			ID         string `json:"id"`
			Name       string `json:"name"`
			NumMembers int    `json:"num_members"`
		} `json:"channel"`
	}
	mustDecodeSlackJSON(t, create.Body.Bytes(), &created)
	if !created.OK || created.Channel.Name != "eng" || created.Channel.ID == "" || created.Channel.NumMembers != 1 {
		t.Fatalf("unexpected create body: %#v", created)
	}

	duplicate := slackRequest(handler, http.MethodPost, "/api/conversations.create", `{"name":"eng"}`, true)
	if !strings.Contains(duplicate.Body.String(), `"error":"name_taken"`) {
		t.Fatalf("unexpected duplicate body: %s", duplicate.Body.String())
	}

	leave := slackRequest(handler, http.MethodPost, "/api/conversations.leave", `{"channel":"`+created.Channel.ID+`"}`, true)
	if !strings.Contains(leave.Body.String(), `"ok":true`) {
		t.Fatalf("unexpected leave body: %s", leave.Body.String())
	}
	join := slackRequest(handler, http.MethodPost, "/api/conversations.join", `{"channel":"`+created.Channel.ID+`"}`, true)
	if !strings.Contains(join.Body.String(), `"num_members":1`) {
		t.Fatalf("unexpected join body: %s", join.Body.String())
	}

	message := slackRequest(handler, http.MethodPost, "/api/chat.postMessage", `{"channel":"`+created.Channel.ID+`","text":"delete me"}`, true)
	var posted struct {
		TS string `json:"ts"`
	}
	mustDecodeSlackJSON(t, message.Body.Bytes(), &posted)
	deleted := slackRequest(handler, http.MethodPost, "/api/chat.delete", `{"channel":"`+created.Channel.ID+`","ts":"`+posted.TS+`"}`, true)
	if !strings.Contains(deleted.Body.String(), `"ok":true`) {
		t.Fatalf("unexpected delete body: %s", deleted.Body.String())
	}
}

func TestSlackOAuthFlow(t *testing.T) {
	service, handler := newSlackTestService()
	service.store.OAuthApps.Insert(corestore.Record{
		"client_id":     "12345.67890",
		"client_secret": "test-secret",
		"name":          "Test App",
		"redirect_uris": []string{"http://localhost:3000/callback"},
	})

	auth := slackRequest(handler, http.MethodGet, "/oauth/v2/authorize?client_id=12345.67890&redirect_uri=http://localhost:3000/callback&scope=chat:write&state=xyz", "", false)
	if auth.Code != http.StatusOK || !strings.Contains(auth.Body.String(), "Sign in to Slack") || !strings.Contains(auth.Body.String(), "Test App") {
		t.Fatalf("unexpected auth page status = %d body = %s", auth.Code, auth.Body.String())
	}

	form := url.Values{
		"user_id":      {"U000000001"},
		"redirect_uri": {"http://localhost:3000/callback"},
		"scope":        {"chat:write"},
		"state":        {"xyz"},
		"client_id":    {"12345.67890"},
	}
	callback := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "http://localhost:4018/oauth/v2/authorize/callback", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	handler.ServeHTTP(callback, req)
	if callback.Code != http.StatusFound {
		t.Fatalf("callback status = %d body = %s", callback.Code, callback.Body.String())
	}
	location, err := url.Parse(callback.Header().Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	code := location.Query().Get("code")
	if code == "" || location.Query().Get("state") != "xyz" {
		t.Fatalf("unexpected callback location: %s", callback.Header().Get("Location"))
	}

	wrongRedirect := slackRequest(handler, http.MethodPost, "/api/oauth.v2.access", url.Values{
		"code":          {code},
		"client_id":     {"12345.67890"},
		"client_secret": {"test-secret"},
		"redirect_uri":  {"http://localhost:3000/wrong"},
	}.Encode(), false)
	var wrongRedirectBody map[string]any
	mustDecodeSlackJSON(t, wrongRedirect.Body.Bytes(), &wrongRedirectBody)
	if wrongRedirectBody["ok"] != false || wrongRedirectBody["error"] != "invalid_code" {
		t.Fatalf("unexpected wrong redirect body: %#v", wrongRedirectBody)
	}

	token := slackRequest(handler, http.MethodPost, "/api/oauth.v2.access", url.Values{
		"code":          {code},
		"client_id":     {"12345.67890"},
		"client_secret": {"test-secret"},
		"redirect_uri":  {"http://localhost:3000/callback"},
	}.Encode(), false)
	var tokenBody struct {
		OK          bool   `json:"ok"`
		AccessToken string `json:"access_token"`
		Team        struct {
			Name string `json:"name"`
		} `json:"team"`
		AuthedUser struct {
			ID string `json:"id"`
		} `json:"authed_user"`
	}
	mustDecodeSlackJSON(t, token.Body.Bytes(), &tokenBody)
	if !tokenBody.OK || !strings.HasPrefix(tokenBody.AccessToken, "xoxb-") || tokenBody.Team.Name != "Emulate" || tokenBody.AuthedUser.ID != "U000000001" {
		t.Fatalf("unexpected token body: %#v", tokenBody)
	}
}

func TestSlackIncomingWebhookAndInspector(t *testing.T) {
	service, handler := newSlackTestService()
	webhook := firstRecord(service.store.IncomingWebhooks.All())
	res := slackRequest(handler, http.MethodPost, stringField(webhook, "url"), `{"text":"Deploy succeeded!"}`, false)
	if res.Code != http.StatusOK || res.Body.String() != "ok" {
		t.Fatalf("webhook status = %d body = %s", res.Code, res.Body.String())
	}
	messages := service.store.Messages.FindBy("channel_id", "C000000001")
	if len(messages) != 1 || stringField(messages[0], "text") != "Deploy succeeded!" || stringField(messages[0], "subtype") != "bot_message" {
		t.Fatalf("unexpected stored webhook messages: %#v", messages)
	}

	page := slackRequest(handler, http.MethodGet, "/?channel=C000000001", "", false)
	if page.Code != http.StatusOK || !strings.Contains(page.Body.String(), "Message Inspector") || !strings.Contains(page.Body.String(), "Deploy succeeded!") {
		t.Fatalf("unexpected inspector page status = %d body = %s", page.Code, page.Body.String())
	}
}

func TestSlackIncomingWebhookRejectsInvalidPathSecrets(t *testing.T) {
	service, handler := newSlackTestService()

	for _, path := range []string{
		"/services/T000000001/B000000001/not-real",
		"/services/T000000001/B999999999/X000000001",
		"/services/T999999999/B000000001/X000000001",
	} {
		res := slackRequest(handler, http.MethodPost, path, `{"text":"should not post","channel":"general"}`, false)
		if res.Code != http.StatusNotFound || res.Body.String() != "no_service" {
			t.Fatalf("%s status = %d body = %s", path, res.Code, res.Body.String())
		}
	}

	if service.store.Messages.Count() != 0 {
		t.Fatalf("invalid webhook paths stored messages: %#v", service.store.Messages.All())
	}
}

func TestSlackSeedFromConfig(t *testing.T) {
	store := corestore.New()
	service := New(Options{
		Store:   store,
		BaseURL: "http://localhost:4018",
		Seed: &SeedConfig{
			Team: &TeamSeed{Name: "Acme Corp", Domain: "acme"},
			Users: []UserSeed{
				{Name: "alice", RealName: "Alice Smith", Email: "alice@acme.com", IsAdmin: true},
				{Name: "bob", Email: "bob@acme.com"},
			},
			Channels:         []ChannelSeed{{Name: "engineering", Topic: "Code talk"}, {Name: "secret", IsPrivate: true}},
			Bots:             []BotSeed{{Name: "deploy-bot"}},
			OAuthApps:        []OAuthAppSeed{{ClientID: "client", ClientSecret: "secret", Name: "Slack App", RedirectURIs: []string{"http://localhost/callback"}}},
			IncomingWebhooks: []IncomingWebhookSeed{{Channel: "engineering", Label: "Deploys"}},
			SigningSecret:    "test-signing-secret",
		},
	})
	team := firstRecord(service.store.Teams.All())
	if stringField(team, "name") != "Acme Corp" || stringField(team, "domain") != "acme" {
		t.Fatalf("unexpected team: %#v", team)
	}
	if service.store.Users.Count() != 3 || service.store.Channels.Count() != 4 || service.store.Bots.Count() != 2 || service.store.OAuthApps.Count() != 1 {
		t.Fatalf("unexpected seeded counts: users=%d channels=%d bots=%d oauth=%d", service.store.Users.Count(), service.store.Channels.Count(), service.store.Bots.Count(), service.store.OAuthApps.Count())
	}
	secret := firstRecord(service.store.Channels.FindBy("name", "secret"))
	if secret == nil || !boolField(secret, "is_private") {
		t.Fatalf("secret channel missing or not private: %#v", secret)
	}
	signingSecret, ok := store.GetData("slack.signing_secret")
	if !ok || signingSecret != "test-signing-secret" {
		t.Fatalf("unexpected signing secret: %#v ok=%v", signingSecret, ok)
	}
}

func newSlackTestService() (*Service, http.Handler) {
	service := New(Options{Store: corestore.New(), BaseURL: "http://localhost:4018"})
	router := corehttp.NewRouter()
	service.RegisterRoutes(router)
	return service, router
}

func slackRequest(handler http.Handler, method string, path string, body string, auth bool) *httptest.ResponseRecorder {
	token := ""
	if auth {
		token = "xoxb-test-token"
	}
	return slackRequestWithToken(handler, method, path, body, token)
}

func slackRequestWithToken(handler http.Handler, method string, path string, body string, token string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, "http://localhost:4018"+path, strings.NewReader(body))
	if body != "" {
		if strings.Contains(body, "=") && !strings.HasPrefix(strings.TrimSpace(body), "{") {
			req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		} else {
			req.Header.Set("Content-Type", "application/json")
		}
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)
	return res
}

func mustDecodeSlackJSON(t *testing.T, raw []byte, target any) {
	t.Helper()
	if err := json.Unmarshal(raw, target); err != nil {
		t.Fatalf("decode JSON: %v\n%s", err, string(raw))
	}
}
