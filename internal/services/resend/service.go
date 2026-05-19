package resend

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	corehttp "github.com/vercel-labs/emulate/internal/core/http"
	corestore "github.com/vercel-labs/emulate/internal/core/store"
	"github.com/vercel-labs/emulate/internal/core/ui"
)

type Options struct {
	Store *corestore.Store
	Seed  *SeedConfig
}

type SeedConfig struct {
	Domains  []DomainSeed  `json:"domains"`
	Contacts []ContactSeed `json:"contacts"`
}

type DomainSeed struct {
	Name   string `json:"name"`
	Region string `json:"region"`
}

type ContactSeed struct {
	Email     string `json:"email"`
	FirstName string `json:"first_name"`
	LastName  string `json:"last_name"`
	Audience  string `json:"audience"`
}

type Service struct {
	store Store
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
	service := &Service{
		store: NewStore(runtimeStore),
	}
	if options.Seed != nil {
		service.SeedFromConfig(*options.Seed)
	}
	return service
}

func (s *Service) RegisterRoutes(router *corehttp.Router) {
	router.Post("/emails/batch", s.handleCreateBatchEmails)
	router.Post("/emails", s.handleCreateEmail)
	router.Get("/emails", s.handleListEmails)
	router.Get("/emails/:id", s.handleGetEmail)
	router.Post("/emails/:id/cancel", s.handleCancelEmail)

	router.Post("/domains", s.handleCreateDomain)
	router.Get("/domains", s.handleListDomains)
	router.Get("/domains/:id", s.handleGetDomain)
	router.Delete("/domains/:id", s.handleDeleteDomain)
	router.Post("/domains/:id/verify", s.handleVerifyDomain)

	router.Post("/api-keys", s.handleCreateAPIKey)
	router.Get("/api-keys", s.handleListAPIKeys)
	router.Delete("/api-keys/:id", s.handleDeleteAPIKey)

	router.Post("/audiences", s.handleCreateAudience)
	router.Get("/audiences", s.handleListAudiences)
	router.Delete("/audiences/:id", s.handleDeleteAudience)
	router.Post("/audiences/:audience_id/contacts", s.handleCreateContact)
	router.Get("/audiences/:audience_id/contacts", s.handleListContacts)
	router.Delete("/audiences/:audience_id/contacts/:id", s.handleDeleteContact)

	router.Get("/inbox", s.handleInbox)
	router.Get("/inbox/:id", s.handleInboxEmail)
}

func SeedFromConfig(runtimeStore *corestore.Store, config SeedConfig) {
	New(Options{Store: runtimeStore, Seed: &config})
}

func (s *Service) SeedFromConfig(config SeedConfig) {
	for _, domain := range config.Domains {
		if domain.Name == "" || len(s.store.Domains.FindBy("name", domain.Name)) > 0 {
			continue
		}
		region := domain.Region
		if region == "" {
			region = "us-east-1"
		}
		s.store.Domains.Insert(corestore.Record{
			"uuid":    generateUUID(),
			"name":    domain.Name,
			"status":  "verified",
			"region":  region,
			"records": domainRecords(domain.Name, region, "verified"),
		})
	}

	if len(config.Contacts) == 0 {
		return
	}

	defaultAudience := s.findAudienceByName("Default")
	if defaultAudience == nil {
		defaultAudience = s.store.Audiences.Insert(corestore.Record{
			"uuid": generateUUID(),
			"name": "Default",
		})
	}

	for _, contact := range config.Contacts {
		if contact.Email == "" {
			continue
		}
		audienceID := stringField(defaultAudience, "uuid")
		if contact.Audience != "" {
			audience := s.findAudienceByName(contact.Audience)
			if audience == nil {
				audience = s.store.Audiences.Insert(corestore.Record{
					"uuid": generateUUID(),
					"name": contact.Audience,
				})
			}
			audienceID = stringField(audience, "uuid")
		}
		s.store.Contacts.Insert(corestore.Record{
			"uuid":         generateUUID(),
			"audience_id":  audienceID,
			"email":        contact.Email,
			"first_name":   nullableString(contact.FirstName),
			"last_name":    nullableString(contact.LastName),
			"unsubscribed": false,
		})
	}
}

func (s *Service) handleCreateBatchEmails(c *corehttp.Context) {
	var emails []map[string]any
	if err := decodeJSON(c.Request, &emails); err != nil || emails == nil {
		writeResendError(c, http.StatusUnprocessableEntity, "validation_error", "Request body must be an array")
		return
	}
	if len(emails) > 100 {
		writeResendError(c, http.StatusUnprocessableEntity, "validation_error", "Batch size cannot exceed 100 emails")
		return
	}
	for _, email := range emails {
		if stringValue(email["from"]) == "" {
			writeResendError(c, http.StatusUnprocessableEntity, "validation_error", "Missing required field: from")
			return
		}
		if _, ok := email["to"]; !ok || len(stringSlice(email["to"])) == 0 {
			writeResendError(c, http.StatusUnprocessableEntity, "validation_error", "Missing required field: to")
			return
		}
		if stringValue(email["subject"]) == "" {
			writeResendError(c, http.StatusUnprocessableEntity, "validation_error", "Missing required field: subject")
			return
		}
	}

	results := make([]map[string]any, 0, len(emails))
	for _, email := range emails {
		record := s.insertEmail(email)
		results = append(results, map[string]any{"id": stringField(record, "uuid")})
	}
	c.JSON(http.StatusOK, map[string]any{"data": results})
}

func (s *Service) handleCreateEmail(c *corehttp.Context) {
	body, err := parseResendBody(c.Request)
	if err != nil {
		body = map[string]any{}
	}
	if stringValue(body["from"]) == "" {
		writeResendError(c, http.StatusUnprocessableEntity, "validation_error", "Missing required field: from")
		return
	}
	if _, ok := body["to"]; !ok || len(stringSlice(body["to"])) == 0 {
		writeResendError(c, http.StatusUnprocessableEntity, "validation_error", "Missing required field: to")
		return
	}
	if stringValue(body["subject"]) == "" {
		writeResendError(c, http.StatusUnprocessableEntity, "validation_error", "Missing required field: subject")
		return
	}
	record := s.insertEmail(body)
	c.JSON(http.StatusOK, map[string]any{"id": stringField(record, "uuid")})
}

func (s *Service) handleListEmails(c *corehttp.Context) {
	emails := s.store.Emails.All()
	data := make([]map[string]any, 0, len(emails))
	for _, email := range emails {
		data = append(data, formatEmail(email))
	}
	c.JSON(http.StatusOK, listResponse(data))
}

func (s *Service) handleGetEmail(c *corehttp.Context) {
	email := s.findEmail(c.Param("id"))
	if email == nil {
		writeResendError(c, http.StatusNotFound, "not_found", "Email not found")
		return
	}
	c.JSON(http.StatusOK, formatEmail(email))
}

func (s *Service) handleCancelEmail(c *corehttp.Context) {
	email := s.findEmail(c.Param("id"))
	if email == nil {
		writeResendError(c, http.StatusNotFound, "not_found", "Email not found")
		return
	}
	if stringField(email, "status") != "scheduled" {
		writeResendError(c, http.StatusUnprocessableEntity, "validation_error", "Only scheduled emails can be canceled")
		return
	}
	id := intField(email, "id")
	updated, _ := s.store.Emails.Update(id, corestore.Record{
		"status":     "canceled",
		"last_event": "email.canceled",
	})
	c.JSON(http.StatusOK, map[string]any{"id": stringField(updated, "uuid"), "object": "email", "canceled": true})
}

func (s *Service) handleCreateDomain(c *corehttp.Context) {
	body, _ := parseResendBody(c.Request)
	name := stringValue(body["name"])
	if name == "" {
		writeResendError(c, http.StatusUnprocessableEntity, "validation_error", "Missing required field: name")
		return
	}
	region := stringValue(body["region"])
	if region == "" {
		region = "us-east-1"
	}
	domain := s.store.Domains.Insert(corestore.Record{
		"uuid":    generateUUID(),
		"name":    name,
		"status":  "pending",
		"region":  region,
		"records": domainRecords(name, region, "pending"),
	})
	c.JSON(http.StatusOK, formatDomain(domain))
}

func (s *Service) handleListDomains(c *corehttp.Context) {
	domains := s.store.Domains.All()
	data := make([]map[string]any, 0, len(domains))
	for _, domain := range domains {
		data = append(data, formatDomain(domain))
	}
	c.JSON(http.StatusOK, listResponse(data))
}

func (s *Service) handleGetDomain(c *corehttp.Context) {
	domain := s.findDomain(c.Param("id"))
	if domain == nil {
		writeResendError(c, http.StatusNotFound, "not_found", "Domain not found")
		return
	}
	c.JSON(http.StatusOK, formatDomain(domain))
}

func (s *Service) handleDeleteDomain(c *corehttp.Context) {
	domain := s.findDomain(c.Param("id"))
	if domain == nil {
		writeResendError(c, http.StatusNotFound, "not_found", "Domain not found")
		return
	}
	s.store.Domains.Delete(intField(domain, "id"))
	c.JSON(http.StatusOK, map[string]any{"object": "domain", "id": stringField(domain, "uuid"), "deleted": true})
}

func (s *Service) handleVerifyDomain(c *corehttp.Context) {
	domain := s.findDomain(c.Param("id"))
	if domain == nil {
		writeResendError(c, http.StatusNotFound, "not_found", "Domain not found")
		return
	}
	name := stringField(domain, "name")
	region := stringField(domain, "region")
	s.store.Domains.Update(intField(domain, "id"), corestore.Record{
		"status":  "verified",
		"records": domainRecords(name, region, "verified"),
	})
	c.JSON(http.StatusOK, map[string]any{"object": "domain", "id": stringField(domain, "uuid"), "status": "verified"})
}

func (s *Service) handleCreateAPIKey(c *corehttp.Context) {
	body, _ := parseResendBody(c.Request)
	name := stringValue(body["name"])
	if name == "" {
		writeResendError(c, http.StatusUnprocessableEntity, "validation_error", "Missing required field: name")
		return
	}
	apiKey := s.store.APIKeys.Insert(corestore.Record{
		"uuid":  generateUUID(),
		"name":  name,
		"token": "re_" + randomHex(16),
	})
	c.JSON(http.StatusOK, map[string]any{
		"id":    stringField(apiKey, "uuid"),
		"token": stringField(apiKey, "token"),
	})
}

func (s *Service) handleListAPIKeys(c *corehttp.Context) {
	keys := s.store.APIKeys.All()
	data := make([]map[string]any, 0, len(keys))
	for _, key := range keys {
		data = append(data, map[string]any{
			"id":         stringField(key, "uuid"),
			"name":       stringField(key, "name"),
			"created_at": key["created_at"],
		})
	}
	c.JSON(http.StatusOK, listResponse(data))
}

func (s *Service) handleDeleteAPIKey(c *corehttp.Context) {
	key := findByUUID(s.store.APIKeys, c.Param("id"))
	if key == nil {
		writeResendError(c, http.StatusNotFound, "not_found", "API key not found")
		return
	}
	s.store.APIKeys.Delete(intField(key, "id"))
	c.JSON(http.StatusOK, map[string]any{"deleted": true})
}

func (s *Service) handleCreateAudience(c *corehttp.Context) {
	body, _ := parseResendBody(c.Request)
	name := stringValue(body["name"])
	if name == "" {
		writeResendError(c, http.StatusUnprocessableEntity, "validation_error", "Missing required field: name")
		return
	}
	audience := s.store.Audiences.Insert(corestore.Record{"uuid": generateUUID(), "name": name})
	c.JSON(http.StatusOK, formatAudience(audience))
}

func (s *Service) handleListAudiences(c *corehttp.Context) {
	audiences := s.store.Audiences.All()
	data := make([]map[string]any, 0, len(audiences))
	for _, audience := range audiences {
		data = append(data, formatAudience(audience))
	}
	c.JSON(http.StatusOK, listResponse(data))
}

func (s *Service) handleDeleteAudience(c *corehttp.Context) {
	audience := findByUUID(s.store.Audiences, c.Param("id"))
	if audience == nil {
		writeResendError(c, http.StatusNotFound, "not_found", "Audience not found")
		return
	}
	s.store.Audiences.Delete(intField(audience, "id"))
	c.JSON(http.StatusOK, map[string]any{"object": "audience", "id": stringField(audience, "uuid"), "deleted": true})
}

func (s *Service) handleCreateContact(c *corehttp.Context) {
	audienceID := c.Param("audience_id")
	audience := findByUUID(s.store.Audiences, audienceID)
	if audience == nil {
		writeResendError(c, http.StatusNotFound, "not_found", "Audience not found")
		return
	}
	body, _ := parseResendBody(c.Request)
	email := stringValue(body["email"])
	if email == "" {
		writeResendError(c, http.StatusUnprocessableEntity, "validation_error", "Missing required field: email")
		return
	}
	contact := s.store.Contacts.Insert(corestore.Record{
		"uuid":         generateUUID(),
		"audience_id":  audienceID,
		"email":        email,
		"first_name":   nullableAnyString(body["first_name"]),
		"last_name":    nullableAnyString(body["last_name"]),
		"unsubscribed": boolValue(body["unsubscribed"]),
	})
	c.JSON(http.StatusOK, map[string]any{
		"id":     stringField(contact, "uuid"),
		"object": "contact",
		"email":  stringField(contact, "email"),
	})
}

func (s *Service) handleListContacts(c *corehttp.Context) {
	audienceID := c.Param("audience_id")
	if findByUUID(s.store.Audiences, audienceID) == nil {
		writeResendError(c, http.StatusNotFound, "not_found", "Audience not found")
		return
	}
	contacts := s.store.Contacts.FindBy("audience_id", audienceID)
	data := make([]map[string]any, 0, len(contacts))
	for _, contact := range contacts {
		data = append(data, formatContact(contact))
	}
	c.JSON(http.StatusOK, listResponse(data))
}

func (s *Service) handleDeleteContact(c *corehttp.Context) {
	audienceID := c.Param("audience_id")
	contact := findByUUID(s.store.Contacts, c.Param("id"))
	if contact == nil || stringField(contact, "audience_id") != audienceID {
		writeResendError(c, http.StatusNotFound, "not_found", "Contact not found")
		return
	}
	s.store.Contacts.Delete(intField(contact, "id"))
	c.JSON(http.StatusOK, map[string]any{"object": "contact", "id": stringField(contact, "uuid"), "deleted": true})
}

func (s *Service) handleInbox(c *corehttp.Context) {
	emails := s.store.Emails.All()
	var rows strings.Builder
	for i := len(emails) - 1; i >= 0; i-- {
		email := emails[i]
		rows.WriteString(`<tr><td><a href="/inbox/`)
		rows.WriteString(ui.EscapeAttr(stringField(email, "uuid")))
		rows.WriteString(`">`)
		rows.WriteString(ui.EscapeHTML(stringField(email, "subject")))
		rows.WriteString(`</a></td><td>`)
		rows.WriteString(ui.EscapeHTML(stringField(email, "from")))
		rows.WriteString(` &rarr; `)
		rows.WriteString(ui.EscapeHTML(strings.Join(stringSlice(email["to"]), ", ")))
		rows.WriteString(`</td><td><span class="badge">`)
		rows.WriteString(ui.EscapeHTML(stringField(email, "status")))
		rows.WriteString(`</span></td></tr>`)
	}
	body := `<div class="inspector-section">
  <table class="inspector-table">
    <thead><tr><th>Subject</th><th>Route</th><th>Status</th></tr></thead>
    <tbody>` + rowsOrEmpty(rows.String(), 3, "No emails sent yet. Use POST /emails to send one.") + `</tbody>
  </table>
</div>`
	subtitle := fmt.Sprintf("%d emails sent", len(emails))
	if len(emails) == 1 {
		subtitle = "1 email sent"
	}
	c.HTML(http.StatusOK, ui.RenderCardPage("Inbox", subtitle, body, ui.PageOptions{Service: "Resend"}))
}

func (s *Service) handleInboxEmail(c *corehttp.Context) {
	email := s.findEmail(c.Param("id"))
	if email == nil {
		html := ui.RenderCardPage("Not Found", "The requested email was not found.", `<div class="empty">Email not found</div>`, ui.PageOptions{Service: "Resend"})
		c.HTML(http.StatusNotFound, html)
		return
	}

	var preview string
	if htmlBody := stringField(email, "html"); htmlBody != "" {
		preview = `<iframe sandbox="allow-popups allow-popups-to-escape-sandbox" srcdoc="` + ui.EscapeAttr(`<base target="_blank">`+htmlBody) + `" class="email-preview-frame"></iframe>`
	} else if textBody := stringField(email, "text"); textBody != "" {
		preview = `<div class="s-card"><pre class="email-preview-text">` + ui.EscapeHTML(textBody) + `</pre></div>`
	} else {
		preview = `<div class="empty">No content</div>`
	}

	body := `<div class="s-card">
  <div class="section-heading">Recipients <span class="badge">` + ui.EscapeHTML(stringField(email, "status")) + `</span></div>
  <div class="user-meta"><strong>From:</strong> ` + ui.EscapeHTML(stringField(email, "from")) + `</div>
  <div class="user-meta"><strong>To:</strong> ` + ui.EscapeHTML(strings.Join(stringSlice(email["to"]), ", ")) + `</div>
</div>
<div class="section-heading">Preview</div>
` + preview + `
<div class="user-meta"><strong>Last event:</strong> ` + ui.EscapeHTML(stringField(email, "last_event")) + `</div>`
	c.HTML(http.StatusOK, ui.RenderCardPage(stringField(email, "subject"), "Email "+ui.EscapeHTML(stringField(email, "uuid")), body, ui.PageOptions{Service: "Resend"}))
}

func (s *Service) insertEmail(body map[string]any) corestore.Record {
	scheduledAt := stringValue(body["scheduled_at"])
	status := "delivered"
	lastEvent := "email.delivered"
	if scheduledAt != "" {
		status = "scheduled"
		lastEvent = "email.scheduled"
	}
	return s.store.Emails.Insert(corestore.Record{
		"uuid":         generateUUID(),
		"from":         stringValue(body["from"]),
		"to":           stringSlice(body["to"]),
		"subject":      stringValue(body["subject"]),
		"html":         nullableAnyString(body["html"]),
		"text":         nullableAnyString(body["text"]),
		"cc":           stringSlice(body["cc"]),
		"bcc":          stringSlice(body["bcc"]),
		"reply_to":     stringSlice(body["reply_to"]),
		"headers":      stringMap(body["headers"]),
		"tags":         tags(body["tags"]),
		"status":       status,
		"scheduled_at": nullableString(scheduledAt),
		"last_event":   lastEvent,
	})
}

func (s *Service) findEmail(uuid string) corestore.Record {
	return findByUUID(s.store.Emails, uuid)
}

func (s *Service) findDomain(uuid string) corestore.Record {
	return findByUUID(s.store.Domains, uuid)
}

func (s *Service) findAudienceByName(name string) corestore.Record {
	found := s.store.Audiences.FindBy("name", name)
	if len(found) == 0 {
		return nil
	}
	return found[0]
}

func findByUUID(collection *corestore.Collection, uuid string) corestore.Record {
	found := collection.FindBy("uuid", uuid)
	if len(found) == 0 {
		return nil
	}
	return found[0]
}

func parseResendBody(req *http.Request) (map[string]any, error) {
	contentType := req.Header.Get("Content-Type")
	raw, err := io.ReadAll(req.Body)
	if err != nil {
		return nil, err
	}
	if strings.Contains(contentType, "application/x-www-form-urlencoded") {
		values, err := url.ParseQuery(string(raw))
		if err != nil {
			return nil, err
		}
		out := map[string]any{}
		for key, values := range values {
			if len(values) > 0 {
				out[key] = values[len(values)-1]
			}
		}
		return out, nil
	}
	var body map[string]any
	if err := json.Unmarshal(raw, &body); err != nil {
		return map[string]any{}, nil
	}
	if body == nil {
		body = map[string]any{}
	}
	return body, nil
}

func decodeJSON(req *http.Request, out any) error {
	raw, err := io.ReadAll(req.Body)
	if err != nil {
		return err
	}
	return json.Unmarshal(raw, out)
}

func writeResendError(c *corehttp.Context, status int, name string, message string) {
	c.JSON(status, map[string]any{"statusCode": status, "name": name, "message": message})
}

func listResponse(data []map[string]any) map[string]any {
	return map[string]any{"object": "list", "data": data}
}

func rowsOrEmpty(rows string, columns int, label string) string {
	if rows != "" {
		return rows
	}
	return `<tr><td colspan="` + fmt.Sprint(columns) + `"><div class="inspector-empty">` + ui.EscapeHTML(label) + `</div></td></tr>`
}

func formatEmail(email corestore.Record) map[string]any {
	return map[string]any{
		"id":           stringField(email, "uuid"),
		"object":       "email",
		"from":         stringField(email, "from"),
		"to":           stringSlice(email["to"]),
		"subject":      stringField(email, "subject"),
		"html":         email["html"],
		"text":         email["text"],
		"cc":           stringSlice(email["cc"]),
		"bcc":          stringSlice(email["bcc"]),
		"reply_to":     stringSlice(email["reply_to"]),
		"headers":      stringMap(email["headers"]),
		"tags":         tags(email["tags"]),
		"status":       stringField(email, "status"),
		"scheduled_at": email["scheduled_at"],
		"last_event":   stringField(email, "last_event"),
		"created_at":   email["created_at"],
	}
}

func formatDomain(domain corestore.Record) map[string]any {
	return map[string]any{
		"id":         stringField(domain, "uuid"),
		"object":     "domain",
		"name":       stringField(domain, "name"),
		"status":     stringField(domain, "status"),
		"region":     stringField(domain, "region"),
		"records":    domainRecordsFromValue(domain["records"]),
		"created_at": domain["created_at"],
	}
}

func formatAudience(audience corestore.Record) map[string]any {
	return map[string]any{
		"id":         stringField(audience, "uuid"),
		"object":     "audience",
		"name":       stringField(audience, "name"),
		"created_at": audience["created_at"],
	}
}

func formatContact(contact corestore.Record) map[string]any {
	return map[string]any{
		"id":           stringField(contact, "uuid"),
		"object":       "contact",
		"email":        stringField(contact, "email"),
		"first_name":   contact["first_name"],
		"last_name":    contact["last_name"],
		"unsubscribed": boolField(contact, "unsubscribed"),
		"created_at":   contact["created_at"],
	}
}

func domainRecords(name string, region string, status string) []map[string]any {
	return []map[string]any{
		{
			"record":   "SPF",
			"name":     name,
			"type":     "MX",
			"ttl":      "Auto",
			"status":   status,
			"value":    "feedback-smtp." + region + ".amazonses.com",
			"priority": 10,
		},
		{
			"record": "SPF",
			"name":   name,
			"type":   "TXT",
			"ttl":    "Auto",
			"status": status,
			"value":  "v=spf1 include:amazonses.com ~all",
		},
		{
			"record": "DKIM",
			"name":   "resend._domainkey." + name,
			"type":   "CNAME",
			"ttl":    "Auto",
			"status": status,
			"value":  "resend.domainkey." + region + ".amazonses.com",
		},
	}
}

func domainRecordsFromValue(value any) []map[string]any {
	switch records := value.(type) {
	case []map[string]any:
		return records
	case []any:
		out := make([]map[string]any, 0, len(records))
		for _, item := range records {
			if record, ok := item.(map[string]any); ok {
				out = append(out, record)
			}
		}
		return out
	default:
		return nil
	}
}

func tags(value any) []map[string]any {
	switch raw := value.(type) {
	case []map[string]any:
		return raw
	case []any:
		out := make([]map[string]any, 0, len(raw))
		for _, item := range raw {
			if tag, ok := item.(map[string]any); ok {
				out = append(out, map[string]any{
					"name":  stringValue(tag["name"]),
					"value": stringValue(tag["value"]),
				})
			}
		}
		return out
	default:
		return []map[string]any{}
	}
}

func stringMap(value any) map[string]any {
	switch raw := value.(type) {
	case map[string]any:
		out := make(map[string]any, len(raw))
		for key, value := range raw {
			out[key] = stringValue(value)
		}
		return out
	case map[string]string:
		out := make(map[string]any, len(raw))
		for key, value := range raw {
			out[key] = value
		}
		return out
	default:
		return map[string]any{}
	}
}

func stringSlice(value any) []string {
	switch raw := value.(type) {
	case nil:
		return []string{}
	case []string:
		return append([]string(nil), raw...)
	case []any:
		out := make([]string, 0, len(raw))
		for _, item := range raw {
			out = append(out, stringValue(item))
		}
		return out
	case string:
		if raw == "" {
			return []string{}
		}
		return []string{raw}
	default:
		return []string{fmt.Sprint(raw)}
	}
}

func stringValue(value any) string {
	switch raw := value.(type) {
	case nil:
		return ""
	case string:
		return raw
	default:
		return fmt.Sprint(raw)
	}
}

func stringField(record corestore.Record, field string) string {
	return stringValue(record[field])
}

func intField(record corestore.Record, field string) int {
	switch value := record[field].(type) {
	case int:
		return value
	case int64:
		return int(value)
	case float64:
		return int(value)
	default:
		return 0
	}
}

func boolField(record corestore.Record, field string) bool {
	return boolValue(record[field])
}

func boolValue(value any) bool {
	raw, _ := value.(bool)
	return raw
}

func nullableString(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func nullableAnyString(value any) any {
	text := stringValue(value)
	if text == "" {
		return nil
	}
	return text
}

func generateUUID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return randomHex(16)
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

func randomHex(size int) string {
	buf := make([]byte, size)
	if _, err := rand.Read(buf); err != nil {
		return strings.Repeat("0", size*2)
	}
	return hex.EncodeToString(buf)
}
