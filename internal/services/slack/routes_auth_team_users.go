package slack

import (
	"strconv"

	corehttp "github.com/vercel-labs/emulate/internal/core/http"
)

func (s *Service) registerAuthRoutes(router *corehttp.Router) {
	router.Post("/api/auth.test", s.handleAuthTest)
	router.Get("/api/auth.test", s.handleAuthTest)
}

func (s *Service) registerTeamRoutes(router *corehttp.Router) {
	router.Post("/api/team.info", s.handleTeamInfo)
	router.Get("/api/team.info", s.handleTeamInfo)
	router.Post("/api/bots.info", s.handleBotInfo)
	router.Get("/api/bots.info", s.handleBotInfo)
}

func (s *Service) registerUserRoutes(router *corehttp.Router) {
	router.Post("/api/users.list", s.handleUsersList)
	router.Get("/api/users.list", s.handleUsersList)
	router.Post("/api/users.info", s.handleUsersInfo)
	router.Get("/api/users.info", s.handleUsersInfo)
	router.Post("/api/users.lookupByEmail", s.handleUsersLookupByEmail)
	router.Get("/api/users.lookupByEmail", s.handleUsersLookupByEmail)
}

func (s *Service) handleAuthTest(c *corehttp.Context) {
	user, ok := s.authenticatedUser(c)
	if !ok {
		return
	}
	team := firstRecord(s.store.Teams.All())
	domain := "emulate"
	teamName := "Emulate"
	teamID := "T000000001"
	if team != nil {
		domain = stringField(team, "domain")
		teamName = stringField(team, "name")
		teamID = stringField(team, "team_id")
	}
	body := map[string]any{
		"url":     "https://" + domain + ".slack.com/",
		"team":    teamName,
		"user":    stringField(user, "name"),
		"team_id": teamID,
		"user_id": stringField(user, "user_id"),
	}
	if boolField(user, "is_bot") {
		body["bot_id"] = stringField(user, "user_id")
	}
	slackOK(c, body)
}

func (s *Service) handleTeamInfo(c *corehttp.Context) {
	if _, ok := s.authenticatedUser(c); !ok {
		return
	}
	team := firstRecord(s.store.Teams.All())
	if team == nil {
		slackError(c, "team_not_found")
		return
	}
	slackOK(c, map[string]any{
		"team": map[string]any{
			"id":     stringField(team, "team_id"),
			"name":   stringField(team, "name"),
			"domain": stringField(team, "domain"),
		},
	})
}

func (s *Service) handleBotInfo(c *corehttp.Context) {
	if _, ok := s.authenticatedUser(c); !ok {
		return
	}
	body := parseSlackBody(c.Request)
	bot := firstRecord(s.store.Bots.FindBy("bot_id", stringValue(body["bot"])))
	if bot == nil {
		slackError(c, "bot_not_found")
		return
	}
	slackOK(c, map[string]any{
		"bot": map[string]any{
			"id":      stringField(bot, "bot_id"),
			"name":    stringField(bot, "name"),
			"deleted": boolField(bot, "deleted"),
			"icons":   mapValue(bot["icons"]),
		},
	})
}

func (s *Service) handleUsersList(c *corehttp.Context) {
	if _, ok := s.authenticatedUser(c); !ok {
		return
	}
	body := parseSlackBody(c.Request)
	limit := normalizeLimit(stringValue(body["limit"]), 100, 1000)
	cursor := stringValue(body["cursor"])
	users := []map[string]any{}
	for _, user := range s.store.Users.All() {
		if boolField(user, "deleted") {
			continue
		}
		users = append(users, formatUser(user))
	}
	page, nextCursor := pageByID(users, "id", cursor, limit)
	slackOK(c, map[string]any{
		"members":           page,
		"response_metadata": map[string]any{"next_cursor": nextCursor},
	})
}

func (s *Service) handleUsersInfo(c *corehttp.Context) {
	if _, ok := s.authenticatedUser(c); !ok {
		return
	}
	body := parseSlackBody(c.Request)
	user := firstRecord(s.store.Users.FindBy("user_id", stringValue(body["user"])))
	if user == nil {
		slackError(c, "user_not_found")
		return
	}
	slackOK(c, map[string]any{"user": formatUser(user)})
}

func (s *Service) handleUsersLookupByEmail(c *corehttp.Context) {
	if _, ok := s.authenticatedUser(c); !ok {
		return
	}
	body := parseSlackBody(c.Request)
	email := stringValue(body["email"])
	if email == "" {
		slackError(c, "users_not_found")
		return
	}
	user := firstRecord(s.store.Users.FindBy("email", email))
	if user == nil {
		slackError(c, "users_not_found")
		return
	}
	slackOK(c, map[string]any{"user": formatUser(user)})
}

func formatUser(user map[string]any) map[string]any {
	return map[string]any{
		"id":        stringField(user, "user_id"),
		"team_id":   stringField(user, "team_id"),
		"name":      stringField(user, "name"),
		"real_name": stringField(user, "real_name"),
		"is_admin":  boolField(user, "is_admin"),
		"is_bot":    boolField(user, "is_bot"),
		"deleted":   boolField(user, "deleted"),
		"profile":   mapValue(user["profile"]),
	}
}

func normalizeLimit(value string, fallback int, max int) int {
	limit, err := strconv.Atoi(value)
	if err != nil || limit <= 0 {
		limit = fallback
	}
	if limit > max {
		return max
	}
	return limit
}

func pageByID(items []map[string]any, idField string, cursor string, limit int) ([]map[string]any, string) {
	start := 0
	if cursor != "" {
		for index, item := range items {
			if stringValue(item[idField]) == cursor {
				start = index
				break
			}
		}
	}
	if start >= len(items) {
		return []map[string]any{}, ""
	}
	end := start + limit
	if end > len(items) {
		end = len(items)
	}
	next := ""
	if end < len(items) {
		next = stringValue(items[end][idField])
	}
	return items[start:end], next
}
