package slack

import (
	"sort"

	corehttp "github.com/vercel-labs/emulate/internal/core/http"
	corestore "github.com/vercel-labs/emulate/internal/core/store"
)

func (s *Service) registerChatRoutes(router *corehttp.Router) {
	router.Post("/api/chat.postMessage", s.handleChatPostMessage)
	router.Post("/api/chat.update", s.handleChatUpdate)
	router.Post("/api/chat.delete", s.handleChatDelete)
	router.Post("/api/chat.meMessage", s.handleChatMeMessage)
}

func (s *Service) registerConversationRoutes(router *corehttp.Router) {
	router.Post("/api/conversations.list", s.handleConversationsList)
	router.Get("/api/conversations.list", s.handleConversationsList)
	router.Post("/api/conversations.info", s.handleConversationsInfo)
	router.Get("/api/conversations.info", s.handleConversationsInfo)
	router.Post("/api/conversations.create", s.handleConversationsCreate)
	router.Post("/api/conversations.history", s.handleConversationsHistory)
	router.Get("/api/conversations.history", s.handleConversationsHistory)
	router.Post("/api/conversations.replies", s.handleConversationsReplies)
	router.Get("/api/conversations.replies", s.handleConversationsReplies)
	router.Post("/api/conversations.join", s.handleConversationsJoin)
	router.Post("/api/conversations.leave", s.handleConversationsLeave)
	router.Post("/api/conversations.members", s.handleConversationsMembers)
	router.Get("/api/conversations.members", s.handleConversationsMembers)
}

func (s *Service) handleChatPostMessage(c *corehttp.Context) {
	user, ok := s.authenticatedUser(c)
	if !ok {
		return
	}
	body := parseSlackBody(c.Request)
	channel := s.findChannel(stringValue(body["channel"]))
	if channel == nil {
		slackError(c, "channel_not_found")
		return
	}
	text := stringValue(body["text"])
	threadTS := stringValue(body["thread_ts"])
	message := s.insertMessage(messageInput{
		ChannelID: stringField(channel, "channel_id"),
		User:      stringField(user, "user_id"),
		Text:      text,
		ThreadTS:  threadTS,
	})
	if threadTS != "" {
		s.incrementThreadReply(stringField(channel, "channel_id"), threadTS, stringField(user, "user_id"))
	}
	slackOK(c, map[string]any{
		"channel": stringField(channel, "channel_id"),
		"ts":      stringField(message, "ts"),
		"message": map[string]any{
			"text":      stringField(message, "text"),
			"user":      stringField(message, "user"),
			"type":      stringField(message, "type"),
			"ts":        stringField(message, "ts"),
			"thread_ts": stringField(message, "thread_ts"),
		},
	})
}

func (s *Service) handleChatUpdate(c *corehttp.Context) {
	if _, ok := s.authenticatedUser(c); !ok {
		return
	}
	body := parseSlackBody(c.Request)
	channel := stringValue(body["channel"])
	ts := stringValue(body["ts"])
	text := stringValue(body["text"])
	message := s.findMessage(channel, ts)
	if message == nil {
		slackError(c, "message_not_found")
		return
	}
	s.store.Messages.Update(intField(message, "id"), corestore.Record{"text": text})
	slackOK(c, map[string]any{"channel": channel, "ts": ts, "text": text})
}

func (s *Service) handleChatDelete(c *corehttp.Context) {
	if _, ok := s.authenticatedUser(c); !ok {
		return
	}
	body := parseSlackBody(c.Request)
	channel := stringValue(body["channel"])
	ts := stringValue(body["ts"])
	message := s.findMessage(channel, ts)
	if message == nil {
		slackError(c, "message_not_found")
		return
	}
	s.store.Messages.Delete(intField(message, "id"))
	slackOK(c, map[string]any{"channel": channel, "ts": ts})
}

func (s *Service) handleChatMeMessage(c *corehttp.Context) {
	user, ok := s.authenticatedUser(c)
	if !ok {
		return
	}
	body := parseSlackBody(c.Request)
	channel := s.findChannel(stringValue(body["channel"]))
	if channel == nil {
		slackError(c, "channel_not_found")
		return
	}
	message := s.insertMessage(messageInput{
		ChannelID: stringField(channel, "channel_id"),
		User:      stringField(user, "user_id"),
		Text:      stringValue(body["text"]),
		Subtype:   "me_message",
	})
	slackOK(c, map[string]any{"channel": stringField(channel, "channel_id"), "ts": stringField(message, "ts")})
}

func (s *Service) handleConversationsList(c *corehttp.Context) {
	if _, ok := s.authenticatedUser(c); !ok {
		return
	}
	body := parseSlackBody(c.Request)
	limit := normalizeLimit(stringValue(body["limit"]), 100, 1000)
	cursor := stringValue(body["cursor"])
	channels := []map[string]any{}
	for _, channel := range s.store.Channels.All() {
		if boolField(channel, "is_archived") {
			continue
		}
		channels = append(channels, formatChannel(channel))
	}
	page, nextCursor := pageByID(channels, "id", cursor, limit)
	slackOK(c, map[string]any{
		"channels":          page,
		"response_metadata": map[string]any{"next_cursor": nextCursor},
	})
}

func (s *Service) handleConversationsInfo(c *corehttp.Context) {
	if _, ok := s.authenticatedUser(c); !ok {
		return
	}
	body := parseSlackBody(c.Request)
	channel := firstRecord(s.store.Channels.FindBy("channel_id", stringValue(body["channel"])))
	if channel == nil {
		slackError(c, "channel_not_found")
		return
	}
	slackOK(c, map[string]any{"channel": formatChannel(channel)})
}

func (s *Service) handleConversationsCreate(c *corehttp.Context) {
	user, ok := s.authenticatedUser(c)
	if !ok {
		return
	}
	body := parseSlackBody(c.Request)
	name := stringValue(body["name"])
	if name == "" {
		slackError(c, "invalid_name_specials")
		return
	}
	if firstRecord(s.store.Channels.FindBy("name", name)) != nil {
		slackError(c, "name_taken")
		return
	}
	teamID := "T000000001"
	if team := firstRecord(s.store.Teams.All()); team != nil {
		teamID = stringField(team, "team_id")
	}
	channel := s.store.Channels.Insert(channelRecord(channelInput{
		ChannelID: generateSlackID("C"),
		TeamID:    teamID,
		Name:      name,
		IsPrivate: boolValue(body["is_private"]),
		Creator:   stringField(user, "user_id"),
		Members:   []string{stringField(user, "user_id")},
		Now:       createdUnix(""),
	}))
	slackOK(c, map[string]any{"channel": formatChannel(channel)})
}

func (s *Service) handleConversationsHistory(c *corehttp.Context) {
	if _, ok := s.authenticatedUser(c); !ok {
		return
	}
	body := parseSlackBody(c.Request)
	channelID := stringValue(body["channel"])
	limit := normalizeLimit(stringValue(body["limit"]), 100, 1000)
	cursor := stringValue(body["cursor"])
	if firstRecord(s.store.Channels.FindBy("channel_id", channelID)) == nil {
		slackError(c, "channel_not_found")
		return
	}
	messages := []map[string]any{}
	for _, message := range s.store.Messages.FindBy("channel_id", channelID) {
		threadTS := stringField(message, "thread_ts")
		if threadTS != "" && threadTS != stringField(message, "ts") {
			continue
		}
		messages = append(messages, formatMessage(message))
	}
	sort.SliceStable(messages, func(i int, j int) bool {
		return stringValue(messages[i]["ts"]) > stringValue(messages[j]["ts"])
	})
	page, nextCursor := pageByID(messages, "ts", cursor, limit)
	slackOK(c, map[string]any{
		"messages":          page,
		"has_more":          nextCursor != "",
		"response_metadata": map[string]any{"next_cursor": nextCursor},
	})
}

func (s *Service) handleConversationsReplies(c *corehttp.Context) {
	if _, ok := s.authenticatedUser(c); !ok {
		return
	}
	body := parseSlackBody(c.Request)
	channelID := stringValue(body["channel"])
	ts := stringValue(body["ts"])
	if channelID == "" || ts == "" {
		slackError(c, "channel_not_found")
		return
	}
	messages := []map[string]any{}
	for _, message := range s.store.Messages.FindBy("channel_id", channelID) {
		if stringField(message, "ts") == ts || stringField(message, "thread_ts") == ts {
			messages = append(messages, formatMessage(message))
		}
	}
	sort.SliceStable(messages, func(i int, j int) bool {
		return stringValue(messages[i]["ts"]) < stringValue(messages[j]["ts"])
	})
	slackOK(c, map[string]any{"messages": messages, "has_more": false})
}

func (s *Service) handleConversationsJoin(c *corehttp.Context) {
	user, ok := s.authenticatedUser(c)
	if !ok {
		return
	}
	body := parseSlackBody(c.Request)
	channel := firstRecord(s.store.Channels.FindBy("channel_id", stringValue(body["channel"])))
	if channel == nil {
		slackError(c, "channel_not_found")
		return
	}
	userID := stringField(user, "user_id")
	members := stringSliceValue(channel["members"])
	if !containsString(members, userID) {
		members = append(members, userID)
		channel, _ = s.store.Channels.Update(intField(channel, "id"), corestore.Record{"members": members, "num_members": len(members)})
	}
	slackOK(c, map[string]any{"channel": formatChannel(channel)})
}

func (s *Service) handleConversationsLeave(c *corehttp.Context) {
	user, ok := s.authenticatedUser(c)
	if !ok {
		return
	}
	body := parseSlackBody(c.Request)
	channel := firstRecord(s.store.Channels.FindBy("channel_id", stringValue(body["channel"])))
	if channel == nil {
		slackError(c, "channel_not_found")
		return
	}
	members := removeString(stringSliceValue(channel["members"]), stringField(user, "user_id"))
	s.store.Channels.Update(intField(channel, "id"), corestore.Record{"members": members, "num_members": len(members)})
	slackOK(c, map[string]any{})
}

func (s *Service) handleConversationsMembers(c *corehttp.Context) {
	if _, ok := s.authenticatedUser(c); !ok {
		return
	}
	body := parseSlackBody(c.Request)
	channel := firstRecord(s.store.Channels.FindBy("channel_id", stringValue(body["channel"])))
	if channel == nil {
		slackError(c, "channel_not_found")
		return
	}
	slackOK(c, map[string]any{
		"members":           stringSliceValue(channel["members"]),
		"response_metadata": map[string]any{"next_cursor": ""},
	})
}

type messageInput struct {
	ChannelID string
	User      string
	Text      string
	Subtype   string
	ThreadTS  string
}

func (s *Service) insertMessage(input messageInput) corestore.Record {
	return s.store.Messages.Insert(corestore.Record{
		"ts":          generateSlackTS(),
		"channel_id":  input.ChannelID,
		"user":        input.User,
		"text":        input.Text,
		"type":        "message",
		"subtype":     nullableString(input.Subtype),
		"thread_ts":   nullableString(input.ThreadTS),
		"reply_count": 0,
		"reply_users": []string{},
		"reactions":   []map[string]any{},
	})
}

func (s *Service) incrementThreadReply(channelID string, threadTS string, userID string) {
	parent := s.findMessage(channelID, threadTS)
	if parent == nil {
		return
	}
	s.store.Messages.UpdateFunc(intField(parent, "id"), func(current corestore.Record) (corestore.Record, bool) {
		if stringField(current, "channel_id") != channelID || stringField(current, "ts") != threadTS {
			return nil, false
		}
		replyUsers := stringSliceValue(current["reply_users"])
		if !containsString(replyUsers, userID) {
			replyUsers = append(replyUsers, userID)
		}
		return corestore.Record{
			"reply_count": intField(current, "reply_count") + 1,
			"reply_users": replyUsers,
		}, true
	})
}

func (s *Service) findMessage(channelID string, ts string) corestore.Record {
	for _, message := range s.store.Messages.FindBy("channel_id", channelID) {
		if stringField(message, "ts") == ts {
			return message
		}
	}
	return nil
}

func formatChannel(channel corestore.Record) map[string]any {
	return map[string]any{
		"id":          stringField(channel, "channel_id"),
		"name":        stringField(channel, "name"),
		"is_channel":  boolField(channel, "is_channel"),
		"is_private":  boolField(channel, "is_private"),
		"is_archived": boolField(channel, "is_archived"),
		"topic":       mapValue(channel["topic"]),
		"purpose":     mapValue(channel["purpose"]),
		"creator":     stringField(channel, "creator"),
		"num_members": intField(channel, "num_members"),
		"created":     createdUnix(stringField(channel, "created_at")),
	}
}

func formatMessage(message corestore.Record) map[string]any {
	out := map[string]any{
		"type": stringField(message, "type"),
		"user": stringField(message, "user"),
		"text": stringField(message, "text"),
		"ts":   stringField(message, "ts"),
	}
	if value := stringField(message, "subtype"); value != "" {
		out["subtype"] = value
	}
	if value := stringField(message, "thread_ts"); value != "" {
		out["thread_ts"] = value
	}
	if count := intField(message, "reply_count"); count > 0 {
		out["reply_count"] = count
		out["reply_users"] = stringSliceValue(message["reply_users"])
	}
	reactions := recordSliceValue(message["reactions"])
	if len(reactions) > 0 {
		out["reactions"] = reactions
	}
	return out
}

func nullableString(value string) any {
	if value == "" {
		return nil
	}
	return value
}
