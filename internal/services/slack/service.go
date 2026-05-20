package slack

import (
	"strings"
	"time"

	corehttp "github.com/vercel-labs/emulate/internal/core/http"
	corestore "github.com/vercel-labs/emulate/internal/core/store"
)

const serviceLabel = "Slack"

type Options struct {
	Store   *corestore.Store
	BaseURL string
	Seed    *SeedConfig
}

type SeedConfig struct {
	Port             int                   `json:"port,omitempty"`
	Team             *TeamSeed             `json:"team"`
	Users            []UserSeed            `json:"users"`
	Channels         []ChannelSeed         `json:"channels"`
	Bots             []BotSeed             `json:"bots"`
	OAuthApps        []OAuthAppSeed        `json:"oauth_apps"`
	IncomingWebhooks []IncomingWebhookSeed `json:"incoming_webhooks"`
	SigningSecret    string                `json:"signing_secret"`
}

type TeamSeed struct {
	Name   string `json:"name"`
	Domain string `json:"domain"`
}

type UserSeed struct {
	Name     string `json:"name"`
	RealName string `json:"real_name"`
	Email    string `json:"email"`
	IsAdmin  bool   `json:"is_admin"`
}

type ChannelSeed struct {
	Name      string `json:"name"`
	Topic     string `json:"topic"`
	Purpose   string `json:"purpose"`
	IsPrivate bool   `json:"is_private"`
}

type BotSeed struct {
	Name string `json:"name"`
}

type OAuthAppSeed struct {
	ClientID     string   `json:"client_id"`
	ClientSecret string   `json:"client_secret"`
	Name         string   `json:"name"`
	RedirectURIs []string `json:"redirect_uris"`
}

type IncomingWebhookSeed struct {
	Channel string `json:"channel"`
	Label   string `json:"label"`
}

type Service struct {
	store        Store
	runtimeStore *corestore.Store
	baseURL      string
}

func Register(router *corehttp.Router, options Options) {
	service := New(options)
	service.RegisterRoutes(router)
}

func New(options Options) *Service {
	runtimeStore := options.Store
	if runtimeStore == nil {
		runtimeStore = corestore.New()
	}
	baseURL := strings.TrimRight(options.BaseURL, "/")
	if baseURL == "" {
		baseURL = "http://localhost:4000"
	}
	service := &Service{
		store:        NewStore(runtimeStore),
		runtimeStore: runtimeStore,
		baseURL:      baseURL,
	}
	service.SeedDefaults()
	if options.Seed != nil {
		service.SeedFromConfig(*options.Seed)
	}
	return service
}

func SeedFromConfig(runtimeStore *corestore.Store, baseURL string, config SeedConfig) {
	New(Options{Store: runtimeStore, BaseURL: baseURL, Seed: &config})
}

func (s *Service) RegisterRoutes(router *corehttp.Router) {
	s.registerAuthRoutes(router)
	s.registerChatRoutes(router)
	s.registerConversationRoutes(router)
	s.registerUserRoutes(router)
	s.registerReactionRoutes(router)
	s.registerTeamRoutes(router)
	s.registerOAuthRoutes(router)
	s.registerWebhookRoutes(router)
	s.registerInspectorRoutes(router)
}

func (s *Service) SeedDefaults() {
	if firstRecord(s.store.Teams.FindBy("team_id", "T000000001")) != nil {
		return
	}
	teamID := "T000000001"
	userID := "U000000001"
	s.store.Teams.Insert(corestore.Record{
		"team_id": teamID,
		"name":    "Emulate",
		"domain":  "emulate",
	})
	s.store.Users.Insert(userRecord(userInput{
		UserID:   userID,
		TeamID:   teamID,
		Name:     "admin",
		RealName: "Admin User",
		Email:    "admin@emulate.dev",
		IsAdmin:  true,
	}))
	now := time.Now().Unix()
	s.store.Channels.Insert(channelRecord(channelInput{
		ChannelID: "C000000001",
		TeamID:    teamID,
		Name:      "general",
		Topic:     "General discussion",
		Purpose:   "A place for general discussion",
		Creator:   userID,
		Members:   []string{userID},
		Now:       now,
	}))
	s.store.Channels.Insert(channelRecord(channelInput{
		ChannelID: "C000000002",
		TeamID:    teamID,
		Name:      "random",
		Topic:     "Random stuff",
		Purpose:   "A place for non-work-related chatter",
		Creator:   userID,
		Members:   []string{userID},
		Now:       now,
	}))
	s.store.Tokens.Insert(corestore.Record{
		"token":  "xoxb-test-token",
		"login":  userID,
		"scopes": []string{"chat:write", "channels:read", "users:read", "reactions:write"},
	})
	s.store.IncomingWebhooks.Insert(corestore.Record{
		"token":           "X000000001",
		"team_id":         teamID,
		"bot_id":          "B000000001",
		"default_channel": "general",
		"label":           "Default Webhook",
		"url":             "/services/T000000001/B000000001/X000000001",
	})
}

func (s *Service) SeedFromConfig(config SeedConfig) {
	if config.Team != nil {
		if team := firstRecord(s.store.Teams.All()); team != nil {
			patch := corestore.Record{}
			if config.Team.Name != "" {
				patch["name"] = config.Team.Name
			}
			if config.Team.Domain != "" {
				patch["domain"] = config.Team.Domain
			}
			if len(patch) > 0 {
				s.store.Teams.Update(intField(team, "id"), patch)
			}
		}
	}

	team := firstRecord(s.store.Teams.All())
	teamID := "T000000001"
	if team != nil {
		teamID = stringField(team, "team_id")
	}
	for _, user := range config.Users {
		name := strings.TrimSpace(user.Name)
		if name == "" || firstRecord(s.store.Users.FindBy("name", name)) != nil {
			continue
		}
		email := user.Email
		if email == "" {
			email = name + "@emulate.dev"
		}
		realName := user.RealName
		if realName == "" {
			realName = name
		}
		s.store.Users.Insert(userRecord(userInput{
			UserID:   generateSlackID("U"),
			TeamID:   teamID,
			Name:     name,
			RealName: realName,
			Email:    email,
			IsAdmin:  user.IsAdmin,
		}))
	}

	for _, channel := range config.Channels {
		name := strings.TrimSpace(channel.Name)
		if name == "" || firstRecord(s.store.Channels.FindBy("name", name)) != nil {
			continue
		}
		users := s.store.Users.All()
		members := make([]string, 0, len(users))
		for _, user := range users {
			members = append(members, stringField(user, "user_id"))
		}
		creator := "U000000001"
		if len(members) > 0 {
			creator = members[0]
		}
		s.store.Channels.Insert(channelRecord(channelInput{
			ChannelID: generateSlackID("C"),
			TeamID:    teamID,
			Name:      name,
			Topic:     channel.Topic,
			Purpose:   channel.Purpose,
			IsPrivate: channel.IsPrivate,
			Creator:   creator,
			Members:   members,
			Now:       time.Now().Unix(),
		}))
	}

	for _, bot := range config.Bots {
		name := strings.TrimSpace(bot.Name)
		if name == "" || s.findBotByName(name) != nil {
			continue
		}
		s.store.Bots.Insert(corestore.Record{
			"bot_id":  generateSlackID("B"),
			"name":    name,
			"deleted": false,
			"icons":   map[string]any{"image_48": ""},
		})
	}

	for _, app := range config.OAuthApps {
		if app.ClientID == "" || firstRecord(s.store.OAuthApps.FindBy("client_id", app.ClientID)) != nil {
			continue
		}
		s.store.OAuthApps.Insert(corestore.Record{
			"client_id":     app.ClientID,
			"client_secret": app.ClientSecret,
			"name":          app.Name,
			"redirect_uris": app.RedirectURIs,
		})
	}

	botID := "B000000001"
	if bot := firstRecord(s.store.Bots.All()); bot != nil {
		botID = stringField(bot, "bot_id")
	}
	for _, webhook := range config.IncomingWebhooks {
		channel := strings.TrimSpace(webhook.Channel)
		if channel == "" {
			continue
		}
		token := generateSlackID("X")
		label := webhook.Label
		if label == "" {
			label = channel
		}
		s.store.IncomingWebhooks.Insert(corestore.Record{
			"token":           token,
			"team_id":         teamID,
			"bot_id":          botID,
			"default_channel": channel,
			"label":           label,
			"url":             "/services/" + teamID + "/" + botID + "/" + token,
		})
	}
	if config.SigningSecret != "" {
		s.runtimeStore.SetData("slack.signing_secret", config.SigningSecret)
	}
}

type userInput struct {
	UserID   string
	TeamID   string
	Name     string
	RealName string
	Email    string
	IsAdmin  bool
	IsBot    bool
}

func userRecord(input userInput) corestore.Record {
	return corestore.Record{
		"user_id":   input.UserID,
		"team_id":   input.TeamID,
		"name":      input.Name,
		"real_name": input.RealName,
		"email":     input.Email,
		"is_admin":  input.IsAdmin,
		"is_bot":    input.IsBot,
		"deleted":   false,
		"profile": map[string]any{
			"display_name": input.Name,
			"real_name":    input.RealName,
			"email":        input.Email,
			"image_48":     "",
			"image_192":    "",
		},
	}
}

type channelInput struct {
	ChannelID string
	TeamID    string
	Name      string
	Topic     string
	Purpose   string
	IsPrivate bool
	Creator   string
	Members   []string
	Now       int64
}

func channelRecord(input channelInput) corestore.Record {
	return corestore.Record{
		"channel_id":  input.ChannelID,
		"team_id":     input.TeamID,
		"name":        input.Name,
		"is_channel":  !input.IsPrivate,
		"is_private":  input.IsPrivate,
		"is_archived": false,
		"topic":       map[string]any{"value": input.Topic, "creator": input.Creator, "last_set": input.Now},
		"purpose":     map[string]any{"value": input.Purpose, "creator": input.Creator, "last_set": input.Now},
		"members":     append([]string(nil), input.Members...),
		"creator":     input.Creator,
		"num_members": len(input.Members),
	}
}

func (s *Service) findUser(value string) corestore.Record {
	if value == "" {
		return nil
	}
	if user := firstRecord(s.store.Users.FindBy("user_id", value)); user != nil {
		return user
	}
	return firstRecord(s.store.Users.FindBy("name", value))
}

func (s *Service) findChannel(value string) corestore.Record {
	if value == "" {
		return nil
	}
	if channel := firstRecord(s.store.Channels.FindBy("channel_id", value)); channel != nil {
		return channel
	}
	return firstRecord(s.store.Channels.FindBy("name", strings.TrimPrefix(value, "#")))
}

func (s *Service) findBotByName(name string) corestore.Record {
	for _, bot := range s.store.Bots.All() {
		if stringField(bot, "name") == name {
			return bot
		}
	}
	return nil
}
