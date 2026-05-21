package slack

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"

	corehttp "github.com/vercel-labs/emulate/internal/core/http"
	corestore "github.com/vercel-labs/emulate/internal/core/store"
	"github.com/vercel-labs/emulate/internal/core/ui"
)

func (s *Service) registerWebhookRoutes(router *corehttp.Router) {
	router.Post("/services/:teamId/:botId/:token", s.handleIncomingWebhook)
}

func (s *Service) registerInspectorRoutes(router *corehttp.Router) {
	router.Get("/slack", s.handleInspector)
	if s.rootInspector {
		router.Get("/", s.handleInspector)
	}
}

func (s *Service) handleIncomingWebhook(c *corehttp.Context) {
	body, ok := parseWebhookBody(c)
	if !ok {
		c.Text(http.StatusBadRequest, "invalid_payload")
		return
	}
	text := stringValue(body["text"])
	if text == "" && body["blocks"] == nil && body["attachments"] == nil {
		c.Text(http.StatusBadRequest, "no_text")
		return
	}
	channelName := stringValue(body["channel"])
	threadTS := stringValue(body["thread_ts"])
	webhook := firstRecord(s.store.IncomingWebhooks.FindBy("token", c.Param("token")))
	if webhook == nil || stringField(webhook, "team_id") != c.Param("teamId") || stringField(webhook, "bot_id") != c.Param("botId") {
		c.Text(http.StatusNotFound, "no_service")
		return
	}
	var channel corestore.Record
	if channelName != "" {
		channel = s.findChannel(channelName)
	}
	if channel == nil {
		channel = s.findChannel(stringField(webhook, "default_channel"))
	}
	if channel == nil {
		channel = s.findChannel("general")
	}
	if channel == nil {
		c.Text(http.StatusNotFound, "channel_not_found")
		return
	}
	if text == "" {
		text = "(rich message)"
	}
	s.insertMessage(messageInput{
		ChannelID: stringField(channel, "channel_id"),
		User:      c.Param("botId"),
		Text:      text,
		Subtype:   "bot_message",
		ThreadTS:  threadTS,
	})
	c.Text(http.StatusOK, "ok")
}

func parseWebhookBody(c *corehttp.Context) (map[string]any, bool) {
	raw, _ := io.ReadAll(c.Request.Body)
	body := map[string]any{}
	if strings.Contains(c.Header("Content-Type"), "application/json") {
		if err := json.Unmarshal(raw, &body); err != nil {
			return nil, false
		}
		return body, true
	}
	values, err := url.ParseQuery(string(raw))
	if err != nil {
		return nil, false
	}
	body = valuesToMap(values)
	if payload := stringValue(body["payload"]); payload != "" {
		var parsed map[string]any
		if err := json.Unmarshal([]byte(payload), &parsed); err != nil {
			return nil, false
		}
		return parsed, true
	}
	return body, true
}

func (s *Service) handleInspector(c *corehttp.Context) {
	channels := []corestore.Record{}
	for _, channel := range s.store.Channels.All() {
		if !boolField(channel, "is_archived") {
			channels = append(channels, channel)
		}
	}
	if len(channels) == 0 {
		c.HTML(http.StatusOK, ui.RenderSettingsPage("Slack Inspector", `<p class="empty">No channels</p>`, `<p class="empty">No channels in the emulator store.</p>`, ui.PageOptions{Service: serviceLabel}))
		return
	}
	active := channels[0]
	if requested := c.Query("channel"); requested != "" {
		for _, channel := range channels {
			if stringField(channel, "channel_id") == requested {
				active = channel
				break
			}
		}
	}
	var sidebar strings.Builder
	inspectorPath := c.Request.URL.Path
	if inspectorPath == "" {
		inspectorPath = "/"
	}
	for _, channel := range channels {
		className := ""
		if stringField(channel, "channel_id") == stringField(active, "channel_id") {
			className = ` class="active"`
		}
		prefix := "# "
		if boolField(channel, "is_private") {
			prefix = "private "
		}
		sidebar.WriteString(`<a href="`)
		sidebar.WriteString(ui.EscapeAttr(inspectorPath))
		sidebar.WriteString(`?channel=`)
		sidebar.WriteString(url.QueryEscape(stringField(channel, "channel_id")))
		sidebar.WriteString(`"`)
		sidebar.WriteString(className)
		sidebar.WriteString(`>`)
		sidebar.WriteString(ui.EscapeHTML(prefix + stringField(channel, "name")))
		sidebar.WriteString(`</a>`)
	}
	userNames := map[string]string{}
	for _, user := range s.store.Users.All() {
		userNames[stringField(user, "user_id")] = stringField(user, "name")
		userNames[stringField(user, "name")] = stringField(user, "name")
	}
	for _, bot := range s.store.Bots.All() {
		userNames[stringField(bot, "bot_id")] = stringField(bot, "name")
	}
	messages := s.store.Messages.FindBy("channel_id", stringField(active, "channel_id"))
	sort.SliceStable(messages, func(i int, j int) bool {
		return stringField(messages[i], "ts") > stringField(messages[j], "ts")
	})
	var messageHTML strings.Builder
	if len(messages) == 0 {
		messageHTML.WriteString(`<p class="empty">No messages yet. Post one with chat.postMessage or an incoming webhook.</p>`)
	} else {
		limit := len(messages)
		if limit > 50 {
			limit = 50
		}
		for _, message := range messages[:limit] {
			messageHTML.WriteString(renderInspectorMessage(message, userNames))
		}
	}
	topic := stringValue(mapValue(active["topic"])["value"])
	if topic == "" {
		topic = "No topic set"
	}
	stats := fmt.Sprintf("%d users, %d channels, %d messages", s.store.Users.Count(), len(channels), s.store.Messages.Count())
	body := `<div class="s-card">
  <div class="s-card-header">
    <div class="s-icon">#</div>
    <div>
      <div class="s-title">` + ui.EscapeHTML(stringField(active, "name")) + `</div>
      <div class="s-subtitle">` + ui.EscapeHTML(topic) + ` - ` + strconv.Itoa(intField(active, "num_members")) + ` members</div>
    </div>
  </div>
  <div class="section-heading">Messages <span class="user-meta">` + ui.EscapeHTML(stats) + `</span></div>
  ` + messageHTML.String() + `
</div>`
	teamName := "Slack"
	if team := firstRecord(s.store.Teams.All()); team != nil {
		teamName = stringField(team, "name")
	}
	c.HTML(http.StatusOK, ui.RenderSettingsPage(teamName+" - Message Inspector", sidebar.String(), body, ui.PageOptions{Service: serviceLabel}))
}

func renderInspectorMessage(message map[string]any, userNames map[string]string) string {
	displayName := userNames[stringField(message, "user")]
	if displayName == "" {
		displayName = stringField(message, "user")
	}
	letter := "?"
	if displayName != "" {
		letter = strings.ToUpper(displayName[:1])
	}
	if stringField(message, "subtype") == "bot_message" {
		letter = "B"
	}
	botBadge := ""
	if stringField(message, "subtype") == "bot_message" {
		botBadge = ` <span class="badge badge-granted">bot</span>`
	}
	threadBadge := ""
	if count := intField(message, "reply_count"); count > 0 {
		label := "replies"
		if count == 1 {
			label = "reply"
		}
		threadBadge = ` <span class="badge badge-requested">` + strconv.Itoa(count) + ` ` + label + `</span>`
	}
	return `<div class="org-row">
  <span class="org-icon">` + ui.EscapeHTML(letter) + `</span>
  <span class="org-name">` + ui.EscapeHTML(displayName) + botBadge + `</span>
  <span class="user-meta">` + ui.EscapeHTML(stringField(message, "ts")) + `</span>
</div>
<div class="info-text">` + ui.EscapeHTML(stringField(message, "text")) + threadBadge + renderInspectorReactions(recordSliceValue(message["reactions"])) + `</div>`
}

func renderInspectorReactions(reactions []map[string]any) string {
	if len(reactions) == 0 {
		return ""
	}
	var out strings.Builder
	out.WriteString(`<div>`)
	for _, reaction := range reactions {
		out.WriteString(`<span class="badge badge-granted">:`)
		out.WriteString(ui.EscapeHTML(stringValue(reaction["name"])))
		out.WriteString(`: `)
		out.WriteString(strconv.Itoa(intField(reaction, "count")))
		out.WriteString(`</span>`)
	}
	out.WriteString(`</div>`)
	return out.String()
}
