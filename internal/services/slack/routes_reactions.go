package slack

import (
	corehttp "github.com/vercel-labs/emulate/internal/core/http"
	corestore "github.com/vercel-labs/emulate/internal/core/store"
)

func (s *Service) registerReactionRoutes(router *corehttp.Router) {
	router.Post("/api/reactions.add", s.handleReactionsAdd)
	router.Post("/api/reactions.remove", s.handleReactionsRemove)
	router.Post("/api/reactions.get", s.handleReactionsGet)
	router.Get("/api/reactions.get", s.handleReactionsGet)
}

func (s *Service) handleReactionsAdd(c *corehttp.Context) {
	user, ok := s.authenticatedUser(c)
	if !ok {
		return
	}
	body := parseSlackBody(c.Request)
	name := stringValue(body["name"])
	if name == "" {
		slackError(c, "invalid_name")
		return
	}
	message := s.findMessage(stringValue(body["channel"]), stringValue(body["timestamp"]))
	if message == nil {
		slackError(c, "message_not_found")
		return
	}
	userID := stringField(user, "user_id")
	reactions := recordSliceValue(message["reactions"])
	for index, reaction := range reactions {
		if stringValue(reaction["name"]) != name {
			continue
		}
		users := stringSliceValue(reaction["users"])
		if containsString(users, userID) {
			slackError(c, "already_reacted")
			return
		}
		users = append(users, userID)
		reactions[index]["users"] = users
		reactions[index]["count"] = len(users)
		s.store.Messages.Update(intField(message, "id"), corestore.Record{"reactions": reactions})
		slackOK(c, map[string]any{})
		return
	}
	reactions = append(reactions, map[string]any{"name": name, "users": []string{userID}, "count": 1})
	s.store.Messages.Update(intField(message, "id"), corestore.Record{"reactions": reactions})
	slackOK(c, map[string]any{})
}

func (s *Service) handleReactionsRemove(c *corehttp.Context) {
	user, ok := s.authenticatedUser(c)
	if !ok {
		return
	}
	body := parseSlackBody(c.Request)
	name := stringValue(body["name"])
	if name == "" {
		slackError(c, "invalid_name")
		return
	}
	message := s.findMessage(stringValue(body["channel"]), stringValue(body["timestamp"]))
	if message == nil {
		slackError(c, "message_not_found")
		return
	}
	userID := stringField(user, "user_id")
	reactions := recordSliceValue(message["reactions"])
	next := []map[string]any{}
	removed := false
	for _, reaction := range reactions {
		if stringValue(reaction["name"]) != name {
			next = append(next, reaction)
			continue
		}
		users := stringSliceValue(reaction["users"])
		if !containsString(users, userID) {
			next = append(next, reaction)
			continue
		}
		removed = true
		users = removeString(users, userID)
		if len(users) > 0 {
			reaction["users"] = users
			reaction["count"] = len(users)
			next = append(next, reaction)
		}
	}
	if !removed {
		slackError(c, "no_reaction")
		return
	}
	s.store.Messages.Update(intField(message, "id"), corestore.Record{"reactions": next})
	slackOK(c, map[string]any{})
}

func (s *Service) handleReactionsGet(c *corehttp.Context) {
	if _, ok := s.authenticatedUser(c); !ok {
		return
	}
	body := parseSlackBody(c.Request)
	message := s.findMessage(stringValue(body["channel"]), stringValue(body["timestamp"]))
	if message == nil {
		slackError(c, "message_not_found")
		return
	}
	slackOK(c, map[string]any{
		"type": "message",
		"message": map[string]any{
			"type":      stringField(message, "type"),
			"text":      stringField(message, "text"),
			"ts":        stringField(message, "ts"),
			"reactions": recordSliceValue(message["reactions"]),
		},
	})
}
