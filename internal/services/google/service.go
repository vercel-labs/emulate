package google

import (
	"strings"
	"time"

	corehttp "github.com/vercel-labs/emulate/internal/core/http"
	corestore "github.com/vercel-labs/emulate/internal/core/store"
)

const (
	serviceLabel          = "Google"
	defaultGoogleEmail    = "testuser@gmail.com"
	googleDriveFolderMIME = "application/vnd.google-apps.folder"
)

type Options struct {
	Store   *corestore.Store
	BaseURL string
	Seed    *SeedConfig
}

type SeedConfig struct {
	Port           int                 `json:"port,omitempty"`
	Users          []UserSeed          `json:"users"`
	OAuthClients   []OAuthClientSeed   `json:"oauth_clients"`
	Labels         []LabelSeed         `json:"labels"`
	Messages       []MessageSeed       `json:"messages"`
	Calendars      []CalendarSeed      `json:"calendars"`
	CalendarEvents []CalendarEventSeed `json:"calendar_events"`
	DriveItems     []DriveItemSeed     `json:"drive_items"`
}

type UserSeed struct {
	Email         string  `json:"email"`
	Name          string  `json:"name"`
	GivenName     string  `json:"given_name"`
	FamilyName    string  `json:"family_name"`
	Picture       string  `json:"picture"`
	Locale        string  `json:"locale"`
	EmailVerified *bool   `json:"email_verified"`
	HD            *string `json:"hd"`
}

type OAuthClientSeed struct {
	ClientID     string   `json:"client_id"`
	ClientSecret string   `json:"client_secret"`
	Name         string   `json:"name"`
	RedirectURIs []string `json:"redirect_uris"`
}

type LabelSeed struct {
	ID                    string `json:"id"`
	UserEmail             string `json:"user_email"`
	Name                  string `json:"name"`
	Type                  string `json:"type"`
	MessageListVisibility string `json:"message_list_visibility"`
	LabelListVisibility   string `json:"label_list_visibility"`
	ColorBackground       string `json:"color_background"`
	ColorText             string `json:"color_text"`
}

type MessageSeed struct {
	ID           string   `json:"id"`
	ThreadID     string   `json:"thread_id"`
	UserEmail    string   `json:"user_email"`
	Raw          string   `json:"raw"`
	From         string   `json:"from"`
	To           string   `json:"to"`
	CC           string   `json:"cc"`
	BCC          string   `json:"bcc"`
	ReplyTo      string   `json:"reply_to"`
	Subject      string   `json:"subject"`
	Snippet      string   `json:"snippet"`
	BodyText     string   `json:"body_text"`
	BodyHTML     string   `json:"body_html"`
	LabelIDs     []string `json:"label_ids"`
	Date         string   `json:"date"`
	InternalDate string   `json:"internal_date"`
	MessageID    string   `json:"message_id"`
	References   string   `json:"references"`
	InReplyTo    string   `json:"in_reply_to"`
}

type CalendarSeed struct {
	ID          string `json:"id"`
	UserEmail   string `json:"user_email"`
	Summary     string `json:"summary"`
	Description string `json:"description"`
	TimeZone    string `json:"time_zone"`
	Primary     bool   `json:"primary"`
	Selected    *bool  `json:"selected"`
	AccessRole  string `json:"access_role"`
}

type CalendarEventSeed struct {
	ID                    string                      `json:"id"`
	UserEmail             string                      `json:"user_email"`
	CalendarID            string                      `json:"calendar_id"`
	Status                string                      `json:"status"`
	Summary               string                      `json:"summary"`
	Description           string                      `json:"description"`
	Location              string                      `json:"location"`
	StartDateTime         string                      `json:"start_date_time"`
	StartDate             string                      `json:"start_date"`
	EndDateTime           string                      `json:"end_date_time"`
	EndDate               string                      `json:"end_date"`
	Attendees             []CalendarEventAttendeeSeed `json:"attendees"`
	ConferenceEntryPoints []ConferenceEntryPointSeed  `json:"conference_entry_points"`
	HangoutLink           string                      `json:"hangout_link"`
}

type CalendarEventAttendeeSeed struct {
	Email       string `json:"email"`
	DisplayName string `json:"display_name"`
}

type ConferenceEntryPointSeed struct {
	EntryPointType string `json:"entry_point_type"`
	URI            string `json:"uri"`
	Label          string `json:"label"`
}

type DriveItemSeed struct {
	ID        string   `json:"id"`
	UserEmail string   `json:"user_email"`
	Name      string   `json:"name"`
	MIMEType  string   `json:"mime_type"`
	ParentIDs []string `json:"parent_ids"`
	Data      string   `json:"data"`
}

type Service struct {
	store   Store
	baseURL string
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
		store:   NewStore(runtimeStore),
		baseURL: baseURL,
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
	s.registerOAuthRoutes(router)
	s.registerGmailRoutes(router)
	s.registerCalendarRoutes(router)
	s.registerDriveRoutes(router)
}

func (s *Service) SeedDefaults() {
	if firstRecord(s.store.Users.FindBy("email", defaultGoogleEmail)) == nil {
		s.store.Users.Insert(userRecord(UserSeed{
			Email:   defaultGoogleEmail,
			Name:    "Test User",
			Picture: "",
		}))
	}
	ensureSystemLabels(s.store, defaultGoogleEmail)
	ensureDefaultSendAs(s.store, defaultGoogleEmail)
	ensureDefaultCalendars(s.store, defaultGoogleEmail)
	s.createCalendarRecord(calendarInput{
		GoogleID:    "cal_team",
		UserEmail:   defaultGoogleEmail,
		Summary:     "Team Calendar",
		Description: "Shared team events",
		TimeZone:    "UTC",
		Selected:    true,
		AccessRole:  "owner",
	})
	s.createCalendarEventRecord(calendarEventInput{
		GoogleID:         "evt_standup",
		UserEmail:        defaultGoogleEmail,
		CalendarGoogleID: "primary",
		Summary:          "Daily Standup",
		Description:      "Team sync",
		StartDateTime:    time.Now().Add(time.Hour).UTC().Format(time.RFC3339Nano),
		EndDateTime:      time.Now().Add(90 * time.Minute).UTC().Format(time.RFC3339Nano),
		Attendees: []map[string]any{
			{"email": defaultGoogleEmail, "display_name": "Test User", "response_status": nil, "organizer": false, "self": true},
			{"email": "teammate@example.com", "display_name": "Teammate", "response_status": nil, "organizer": false, "self": false},
		},
		ConferenceEntryPoints: []map[string]any{
			{"entry_point_type": "video", "uri": "https://meet.google.com/emulate-standup", "label": "Google Meet"},
		},
		HangoutLink: "https://meet.google.com/emulate-standup",
	})
	s.createDriveItemRecord(driveItemInput{
		GoogleID:        "drv_contracts",
		UserEmail:       defaultGoogleEmail,
		Name:            "Contracts",
		MIMEType:        googleDriveFolderMIME,
		ParentGoogleIDs: []string{"root"},
	})
	s.createDriveItemRecord(driveItemInput{
		GoogleID:        "drv_pdf_guide",
		UserEmail:       defaultGoogleEmail,
		Name:            "Welcome Guide.pdf",
		MIMEType:        "application/pdf",
		ParentGoogleIDs: []string{"drv_contracts"},
		Data:            base64URLString([]byte("sample-pdf-data")),
		Size:            intPtr(len("sample-pdf-data")),
	})
	s.createStoredMessage(messageInput{
		GmailID:   "msg_welcome",
		ThreadID:  "thr_welcome",
		UserEmail: defaultGoogleEmail,
		From:      "Welcome Team <welcome@example.com>",
		To:        defaultGoogleEmail,
		Subject:   "Welcome to your local Gmail emulator",
		Snippet:   "Your OAuth flow is set up and Gmail message, thread, and label APIs are ready.",
		BodyText:  "Your OAuth flow is set up and Gmail message, thread, and label APIs are ready.\n\nUse this inbox to test Gmail automations locally.",
		LabelIDs:  []string{"INBOX", "UNREAD", "CATEGORY_UPDATES"},
		Date:      time.Now().Add(-time.Hour).UTC().Format(time.RFC3339Nano),
	})
	s.createStoredMessage(messageInput{
		GmailID:   "msg_build",
		ThreadID:  "thr_build",
		UserEmail: defaultGoogleEmail,
		From:      "Build Bot <builds@example.com>",
		To:        defaultGoogleEmail,
		Subject:   "Nightly build finished successfully",
		Snippet:   "The latest build completed successfully in 6 minutes.",
		BodyText:  "The latest build completed successfully in 6 minutes.\n\nArtifact upload finished and smoke checks passed.",
		LabelIDs:  []string{"INBOX", "CATEGORY_UPDATES"},
		Date:      time.Now().Add(-2 * time.Hour).UTC().Format(time.RFC3339Nano),
	})
}

func (s *Service) SeedFromConfig(config SeedConfig) {
	for _, seed := range config.Users {
		email := strings.TrimSpace(seed.Email)
		if email == "" {
			continue
		}
		if firstRecord(s.store.Users.FindBy("email", email)) == nil {
			s.store.Users.Insert(userRecord(seed))
		}
		ensureSystemLabels(s.store, email)
		ensureDefaultSendAs(s.store, email)
		ensureDefaultCalendars(s.store, email)
	}

	for _, seed := range config.OAuthClients {
		clientID := strings.TrimSpace(seed.ClientID)
		if clientID == "" || firstRecord(s.store.OAuthClients.FindBy("client_id", clientID)) != nil {
			continue
		}
		name := seed.Name
		if name == "" {
			name = "Code App (Google)"
		}
		s.store.OAuthClients.Insert(corestore.Record{
			"client_id":     clientID,
			"client_secret": seed.ClientSecret,
			"name":          name,
			"redirect_uris": seed.RedirectURIs,
		})
	}

	fallbackEmail := defaultGoogleEmail
	if len(config.Users) > 0 && strings.TrimSpace(config.Users[0].Email) != "" {
		fallbackEmail = strings.TrimSpace(config.Users[0].Email)
	} else if first := firstRecord(s.store.Users.All()); first != nil {
		fallbackEmail = stringField(first, "email")
	}
	ensureSystemLabels(s.store, fallbackEmail)
	ensureDefaultSendAs(s.store, fallbackEmail)
	ensureDefaultCalendars(s.store, fallbackEmail)

	for _, seed := range config.Labels {
		userEmail := firstNonEmpty(seed.UserEmail, fallbackEmail)
		ensureSystemLabels(s.store, userEmail)
		if seed.ID != "" && s.findLabelByID(userEmail, seed.ID) != nil {
			continue
		}
		if s.findLabelByName(userEmail, seed.Name) != nil {
			continue
		}
		s.createLabelRecord(labelInput{
			GmailID:               seed.ID,
			UserEmail:             userEmail,
			Name:                  seed.Name,
			Type:                  firstNonEmpty(seed.Type, "user"),
			MessageListVisibility: firstNonEmpty(seed.MessageListVisibility, "show"),
			LabelListVisibility:   firstNonEmpty(seed.LabelListVisibility, "labelShow"),
			ColorBackground:       nullableString(seed.ColorBackground),
			ColorText:             nullableString(seed.ColorText),
		})
	}

	for _, seed := range config.Messages {
		userEmail := firstNonEmpty(seed.UserEmail, fallbackEmail)
		ensureSystemLabels(s.store, userEmail)
		if seed.ID != "" && s.getMessageByID(userEmail, seed.ID) != nil {
			continue
		}
		s.createStoredMessage(messageInput{
			GmailID:      seed.ID,
			ThreadID:     seed.ThreadID,
			UserEmail:    userEmail,
			Raw:          nullableString(seed.Raw),
			From:         seed.From,
			To:           seed.To,
			CC:           nullableString(seed.CC),
			BCC:          nullableString(seed.BCC),
			ReplyTo:      nullableString(seed.ReplyTo),
			Subject:      seed.Subject,
			Snippet:      seed.Snippet,
			BodyText:     nullableString(seed.BodyText),
			BodyHTML:     nullableString(seed.BodyHTML),
			LabelIDs:     defaultStringSlice(seed.LabelIDs, []string{"INBOX", "UNREAD"}),
			Date:         seed.Date,
			InternalDate: seed.InternalDate,
			MessageID:    seed.MessageID,
			References:   nullableString(seed.References),
			InReplyTo:    nullableString(seed.InReplyTo),
		})
	}

	for _, seed := range config.Calendars {
		userEmail := firstNonEmpty(seed.UserEmail, fallbackEmail)
		selected := true
		if seed.Selected != nil {
			selected = *seed.Selected
		}
		s.createCalendarRecord(calendarInput{
			GoogleID:    seed.ID,
			UserEmail:   userEmail,
			Summary:     seed.Summary,
			Description: nullableString(seed.Description),
			TimeZone:    firstNonEmpty(seed.TimeZone, "UTC"),
			Primary:     seed.Primary,
			Selected:    selected,
			AccessRole:  firstNonEmpty(seed.AccessRole, "owner"),
			Update:      true,
		})
	}

	for _, seed := range config.CalendarEvents {
		userEmail := firstNonEmpty(seed.UserEmail, fallbackEmail)
		attendees := make([]map[string]any, 0, len(seed.Attendees))
		for _, attendee := range seed.Attendees {
			if attendee.Email == "" {
				continue
			}
			attendees = append(attendees, map[string]any{
				"email":           attendee.Email,
				"display_name":    nullableString(attendee.DisplayName),
				"response_status": nil,
				"organizer":       false,
				"self":            attendee.Email == userEmail,
			})
		}
		entryPoints := make([]map[string]any, 0, len(seed.ConferenceEntryPoints))
		for _, entry := range seed.ConferenceEntryPoints {
			if entry.URI == "" {
				continue
			}
			entryPoints = append(entryPoints, map[string]any{
				"entry_point_type": firstNonEmpty(entry.EntryPointType, "video"),
				"uri":              entry.URI,
				"label":            nullableString(entry.Label),
			})
		}
		s.createCalendarEventRecord(calendarEventInput{
			GoogleID:              seed.ID,
			UserEmail:             userEmail,
			CalendarGoogleID:      firstNonEmpty(seed.CalendarID, "primary"),
			Status:                firstNonEmpty(seed.Status, "confirmed"),
			Summary:               seed.Summary,
			Description:           nullableString(seed.Description),
			Location:              nullableString(seed.Location),
			StartDateTime:         seed.StartDateTime,
			StartDate:             seed.StartDate,
			EndDateTime:           seed.EndDateTime,
			EndDate:               seed.EndDate,
			Attendees:             attendees,
			ConferenceEntryPoints: entryPoints,
			HangoutLink:           nullableString(seed.HangoutLink),
		})
	}

	for _, seed := range config.DriveItems {
		userEmail := firstNonEmpty(seed.UserEmail, fallbackEmail)
		if seed.ID != "" && s.getDriveItemByID(userEmail, seed.ID) != nil {
			continue
		}
		var data any
		var size *int
		if seed.Data != "" {
			data = base64URLString([]byte(seed.Data))
			size = intPtr(len(seed.Data))
		}
		s.createDriveItemRecord(driveItemInput{
			GoogleID:        seed.ID,
			UserEmail:       userEmail,
			Name:            seed.Name,
			MIMEType:        seed.MIMEType,
			ParentGoogleIDs: defaultStringSlice(seed.ParentIDs, []string{"root"}),
			Data:            data,
			Size:            size,
		})
	}
}

func userRecord(seed UserSeed) corestore.Record {
	email := strings.TrimSpace(seed.Email)
	name := seed.Name
	if name == "" {
		name = strings.Split(email, "@")[0]
	}
	parts := strings.Fields(name)
	givenName := seed.GivenName
	if givenName == "" && len(parts) > 0 {
		givenName = parts[0]
	}
	familyName := seed.FamilyName
	if familyName == "" && len(parts) > 1 {
		familyName = strings.Join(parts[1:], " ")
	}
	locale := seed.Locale
	if locale == "" {
		locale = "en"
	}
	emailVerified := true
	if seed.EmailVerified != nil {
		emailVerified = *seed.EmailVerified
	}
	hd := any(deriveHD(email))
	if seed.HD != nil {
		if *seed.HD == "" {
			hd = nil
		} else {
			hd = *seed.HD
		}
	}
	return corestore.Record{
		"uid":            generateUID("goog"),
		"email":          email,
		"name":           name,
		"given_name":     givenName,
		"family_name":    familyName,
		"picture":        nullableString(seed.Picture),
		"email_verified": emailVerified,
		"locale":         locale,
		"hd":             hd,
	}
}
