package google

import (
	"bytes"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	corehttp "github.com/vercel-labs/emulate/internal/core/http"
	corestore "github.com/vercel-labs/emulate/internal/core/store"
)

type messageInput struct {
	GmailID      string
	ThreadID     string
	UserEmail    string
	Raw          any
	From         string
	To           string
	CC           any
	BCC          any
	ReplyTo      any
	Subject      string
	Snippet      string
	BodyText     any
	BodyHTML     any
	LabelIDs     []string
	Date         string
	InternalDate string
	MessageID    string
	References   any
	InReplyTo    any
}

type labelInput struct {
	GmailID               string
	UserEmail             string
	Name                  string
	Type                  string
	MessageListVisibility string
	LabelListVisibility   string
	ColorBackground       any
	ColorText             any
}

type calendarInput struct {
	GoogleID    string
	UserEmail   string
	Summary     string
	Description any
	TimeZone    string
	Primary     bool
	Selected    bool
	AccessRole  string
	Update      bool
}

type calendarEventInput struct {
	GoogleID              string
	UserEmail             string
	CalendarGoogleID      string
	Status                string
	Summary               string
	Description           any
	Location              any
	StartDateTime         string
	StartDate             string
	EndDateTime           string
	EndDate               string
	Attendees             []map[string]any
	ConferenceEntryPoints []map[string]any
	HangoutLink           any
	Transparency          any
}

type driveItemInput struct {
	GoogleID        string
	UserEmail       string
	Name            string
	MIMEType        string
	ParentGoogleIDs []string
	WebViewLink     any
	Size            *int
	Trashed         bool
	Data            any
}

var systemLabels = []corestore.Record{
	{"gmail_id": "INBOX", "name": "INBOX", "message_list_visibility": "show", "label_list_visibility": "labelShow"},
	{"gmail_id": "SENT", "name": "SENT", "message_list_visibility": "show", "label_list_visibility": "labelShow"},
	{"gmail_id": "UNREAD", "name": "UNREAD", "message_list_visibility": "show", "label_list_visibility": "labelShow"},
	{"gmail_id": "STARRED", "name": "STARRED", "message_list_visibility": "show", "label_list_visibility": "labelShow"},
	{"gmail_id": "IMPORTANT", "name": "IMPORTANT", "message_list_visibility": "show", "label_list_visibility": "labelShow"},
	{"gmail_id": "TRASH", "name": "TRASH", "message_list_visibility": "show", "label_list_visibility": "labelShow"},
	{"gmail_id": "SPAM", "name": "SPAM", "message_list_visibility": "show", "label_list_visibility": "labelShow"},
	{"gmail_id": "DRAFT", "name": "DRAFT", "message_list_visibility": "hide", "label_list_visibility": "labelHide"},
	{"gmail_id": "CATEGORY_PERSONAL", "name": "CATEGORY_PERSONAL", "message_list_visibility": "hide", "label_list_visibility": "labelHide"},
	{"gmail_id": "CATEGORY_SOCIAL", "name": "CATEGORY_SOCIAL", "message_list_visibility": "hide", "label_list_visibility": "labelHide"},
	{"gmail_id": "CATEGORY_PROMOTIONS", "name": "CATEGORY_PROMOTIONS", "message_list_visibility": "hide", "label_list_visibility": "labelHide"},
	{"gmail_id": "CATEGORY_UPDATES", "name": "CATEGORY_UPDATES", "message_list_visibility": "hide", "label_list_visibility": "labelHide"},
	{"gmail_id": "CATEGORY_FORUMS", "name": "CATEGORY_FORUMS", "message_list_visibility": "hide", "label_list_visibility": "labelHide"},
}

var systemLabelAliases = map[string]string{
	"inbox":      "INBOX",
	"sent":       "SENT",
	"draft":      "DRAFT",
	"drafts":     "DRAFT",
	"unread":     "UNREAD",
	"starred":    "STARRED",
	"important":  "IMPORTANT",
	"spam":       "SPAM",
	"trash":      "TRASH",
	"personal":   "CATEGORY_PERSONAL",
	"social":     "CATEGORY_SOCIAL",
	"promotions": "CATEGORY_PROMOTIONS",
	"updates":    "CATEGORY_UPDATES",
	"forums":     "CATEGORY_FORUMS",
}

var historyIDMu sync.Mutex
var lastHistoryID int64

func generateUID(prefix string) string {
	raw := make([]byte, 12)
	if _, err := rand.Read(raw); err != nil {
		panic(err)
	}
	id := base64.RawURLEncoding.EncodeToString(raw)
	if len(id) > 20 {
		id = id[:20]
	}
	if prefix == "" {
		return id
	}
	return prefix + "_" + id
}

func generateHex(size int) string {
	raw := make([]byte, size)
	if _, err := rand.Read(raw); err != nil {
		panic(err)
	}
	return hex.EncodeToString(raw)
}

func generateHistoryID() string {
	next := time.Now().UnixNano()
	historyIDMu.Lock()
	defer historyIDMu.Unlock()
	if next <= lastHistoryID {
		next = lastHistoryID + 1
	}
	lastHistoryID = next
	return strconv.FormatInt(next, 10)
}

func generateDraftID() string {
	return fmt.Sprintf("r-%d%s", time.Now().UnixMilli(), generateHex(4))
}

func base64URLString(raw []byte) string {
	return base64.RawURLEncoding.EncodeToString(raw)
}

func firstRecord(records []corestore.Record) corestore.Record {
	if len(records) == 0 {
		return nil
	}
	return records[0]
}

func intField(record corestore.Record, key string) int {
	if record == nil {
		return 0
	}
	switch value := record[key].(type) {
	case int:
		return value
	case int64:
		return int(value)
	case float64:
		return int(value)
	case json.Number:
		number, _ := value.Int64()
		return int(number)
	default:
		return 0
	}
}

func stringField(record corestore.Record, key string) string {
	if record == nil {
		return ""
	}
	return stringValue(record[key])
}

func stringValue(value any) string {
	switch v := value.(type) {
	case string:
		return v
	case fmt.Stringer:
		return v.String()
	case nil:
		return ""
	default:
		return fmt.Sprint(v)
	}
}

func boolField(record corestore.Record, key string) bool {
	if record == nil {
		return false
	}
	value, _ := record[key].(bool)
	return value
}

func stringSliceValue(value any) []string {
	switch v := value.(type) {
	case []string:
		out := make([]string, len(v))
		copy(out, v)
		return out
	case []any:
		out := make([]string, 0, len(v))
		for _, item := range v {
			if s, ok := item.(string); ok {
				out = append(out, s)
			}
		}
		return out
	default:
		return nil
	}
}

func recordSliceValue(value any) []map[string]any {
	switch v := value.(type) {
	case []map[string]any:
		out := make([]map[string]any, len(v))
		copy(out, v)
		return out
	case []any:
		out := make([]map[string]any, 0, len(v))
		for _, item := range v {
			if record, ok := item.(map[string]any); ok {
				out = append(out, record)
			}
		}
		return out
	default:
		return nil
	}
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func nullableString(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func defaultStringSlice(value []string, fallback []string) []string {
	if len(value) == 0 {
		return append([]string(nil), fallback...)
	}
	return append([]string(nil), value...)
}

func intPtr(value int) *int {
	return &value
}

func historyIDAfter(value string, start string) bool {
	current, currentErr := strconv.ParseInt(value, 10, 64)
	baseline, baselineErr := strconv.ParseInt(start, 10, 64)
	if currentErr == nil && baselineErr == nil {
		return current > baseline
	}
	return value > start
}

func nowISO() string {
	return time.Now().UTC().Format(time.RFC3339Nano)
}

func deriveHD(email string) any {
	parts := strings.Split(email, "@")
	if len(parts) != 2 {
		return nil
	}
	domain := strings.ToLower(parts[1])
	if domain == "gmail.com" || domain == "googlemail.com" {
		return nil
	}
	return domain
}

func googleAPIError(c *corehttp.Context, code int, message string, reason string, status string) {
	c.JSON(code, map[string]any{
		"error": map[string]any{
			"code":    code,
			"message": message,
			"errors": []map[string]any{
				{"message": message, "domain": "global", "reason": reason},
			},
			"status": status,
		},
	})
}

func parseJSONBody(r *http.Request) map[string]any {
	raw, _ := io.ReadAll(r.Body)
	if len(bytes.TrimSpace(raw)) == 0 {
		return map[string]any{}
	}
	contentType := r.Header.Get("Content-Type")
	if strings.Contains(contentType, "application/x-www-form-urlencoded") {
		values, _ := url.ParseQuery(string(raw))
		out := map[string]any{}
		for key := range values {
			out[key] = values.Get(key)
		}
		return out
	}
	if !strings.Contains(contentType, "application/json") {
		return map[string]any{"raw": base64URLString(raw)}
	}
	var parsed map[string]any
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return map[string]any{}
	}
	if nested, ok := parsed["requestBody"].(map[string]any); ok {
		return nested
	}
	return parsed
}

func parseTokenBody(r *http.Request) (map[string]string, error) {
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		return nil, err
	}
	out := map[string]string{}
	if strings.Contains(r.Header.Get("Content-Type"), "application/json") {
		var parsed map[string]any
		if err := json.Unmarshal(raw, &parsed); err != nil {
			return out, nil
		}
		for key, value := range parsed {
			if s, ok := value.(string); ok {
				out[key] = s
			}
		}
		return out, nil
	}
	values, err := url.ParseQuery(string(raw))
	if err != nil {
		return nil, err
	}
	for key := range values {
		out[key] = values.Get(key)
	}
	return out, nil
}

func applyBasicCredentials(r *http.Request, clientID *string, clientSecret *string) {
	username, password, ok := r.BasicAuth()
	if !ok {
		return
	}
	if *clientID == "" {
		*clientID = username
	}
	if *clientSecret == "" {
		*clientSecret = password
	}
}

func constantTimeEqual(a string, b string) bool {
	return hmac.Equal([]byte(a), []byte(b))
}

func matchesRedirectURI(value string, allowed []string) bool {
	for _, candidate := range allowed {
		if value == candidate {
			return true
		}
	}
	return false
}

func normalizeScope(scope string) string {
	parts := strings.Fields(scope)
	sort.Strings(parts)
	return strings.Join(parts, " ")
}

func addAuthorizationResponseValues(values url.Values, code string, state string) {
	values.Set("code", code)
	if state != "" {
		values.Set("state", state)
	}
}

func verifyCodeChallenge(verifier string, challenge string, method string) bool {
	if challenge == "" {
		return true
	}
	if method == "" || method == "plain" {
		return verifier == challenge
	}
	if method == "S256" {
		sum := sha256.Sum256([]byte(verifier))
		return base64.RawURLEncoding.EncodeToString(sum[:]) == challenge
	}
	return false
}

func (s *Service) validateClient(c *corehttp.Context, clientID string, clientSecret string) bool {
	if s.store.OAuthClients.Count() == 0 {
		return true
	}
	client := firstRecord(s.store.OAuthClients.FindBy("client_id", clientID))
	if client == nil {
		writeOAuthError(c, http.StatusUnauthorized, "invalid_client", "The client_id is incorrect.")
		return false
	}
	expected := stringField(client, "client_secret")
	if expected != "" && !constantTimeEqual(expected, clientSecret) {
		writeOAuthError(c, http.StatusUnauthorized, "invalid_client", "The client_secret is incorrect.")
		return false
	}
	return true
}

func (s *Service) authenticatedEmail(c *corehttp.Context) (string, bool) {
	header := c.Request.Header.Get("Authorization")
	if !strings.HasPrefix(strings.ToLower(header), "bearer ") {
		googleAPIError(c, http.StatusUnauthorized, "Request had invalid authentication credentials.", "authError", "UNAUTHENTICATED")
		return "", false
	}
	token := strings.TrimSpace(header[len("Bearer "):])
	if token == "test-token" {
		if user := firstRecord(s.store.Users.FindBy("email", "testuser@example.com")); user != nil {
			return stringField(user, "email"), true
		}
		if user := firstRecord(s.store.Users.All()); user != nil {
			return stringField(user, "email"), true
		}
	}
	record := firstRecord(s.store.AccessTokens.FindBy("token", token))
	if record == nil {
		googleAPIError(c, http.StatusUnauthorized, "Request had invalid authentication credentials.", "authError", "UNAUTHENTICATED")
		return "", false
	}
	return stringField(record, "email"), true
}

func (s *Service) authenticatedGmailUser(c *corehttp.Context) (string, bool) {
	email, ok := s.authenticatedEmail(c)
	if !ok {
		return "", false
	}
	userID := c.Param("userId")
	if userID != "" && userID != "me" && userID != email {
		googleAPIError(c, http.StatusNotFound, "Requested entity was not found.", "notFound", "NOT_FOUND")
		return "", false
	}
	return email, true
}

func ensureSystemLabels(store Store, userEmail string) {
	existing := map[string]struct{}{}
	for _, label := range store.Labels.FindBy("user_email", userEmail) {
		existing[stringField(label, "gmail_id")] = struct{}{}
	}
	for _, label := range systemLabels {
		labelID := stringField(label, "gmail_id")
		if _, ok := existing[labelID]; ok {
			continue
		}
		store.Labels.Insert(corestore.Record{
			"gmail_id":                labelID,
			"user_email":              userEmail,
			"name":                    stringField(label, "name"),
			"type":                    "system",
			"message_list_visibility": label["message_list_visibility"],
			"label_list_visibility":   label["label_list_visibility"],
			"color_background":        nil,
			"color_text":              nil,
		})
	}
}

func ensureDefaultSendAs(store Store, userEmail string) {
	if firstRecord(store.SendAs.FindBy("user_email", userEmail)) != nil {
		return
	}
	user := firstRecord(store.Users.FindBy("email", userEmail))
	store.SendAs.Insert(corestore.Record{
		"user_email":    userEmail,
		"send_as_email": userEmail,
		"display_name":  stringField(user, "name"),
		"is_default":    true,
		"signature":     "",
	})
}

func (s *Service) createLabelRecord(input labelInput) corestore.Record {
	ensureSystemLabels(s.store, input.UserEmail)
	labelID := input.GmailID
	if labelID == "" {
		labelID = "Label_" + generateHex(8)
	}
	return s.store.Labels.Insert(corestore.Record{
		"gmail_id":                labelID,
		"user_email":              input.UserEmail,
		"name":                    input.Name,
		"type":                    firstNonEmpty(input.Type, "user"),
		"message_list_visibility": firstNonEmpty(input.MessageListVisibility, "show"),
		"label_list_visibility":   firstNonEmpty(input.LabelListVisibility, "labelShow"),
		"color_background":        input.ColorBackground,
		"color_text":              input.ColorText,
	})
}

func (s *Service) findLabelByID(userEmail string, labelID string) corestore.Record {
	for _, label := range s.store.Labels.FindBy("user_email", userEmail) {
		if stringField(label, "gmail_id") == labelID {
			return label
		}
	}
	return nil
}

func (s *Service) findLabelByName(userEmail string, name string) corestore.Record {
	for _, label := range s.store.Labels.FindBy("user_email", userEmail) {
		if stringField(label, "name") == name {
			return label
		}
	}
	return nil
}

func (s *Service) ensureCustomLabel(userEmail string, labelID string) {
	if labelID == "" || s.findLabelByID(userEmail, labelID) != nil {
		return
	}
	s.createLabelRecord(labelInput{
		GmailID:               labelID,
		UserEmail:             userEmail,
		Name:                  labelID,
		Type:                  "user",
		MessageListVisibility: "show",
		LabelListVisibility:   "labelShow",
	})
}

func (s *Service) createStoredMessage(input messageInput) corestore.Record {
	ensureSystemLabels(s.store, input.UserEmail)
	if input.GmailID != "" {
		if existing := s.getMessageByID(input.UserEmail, input.GmailID); existing != nil {
			return existing
		}
	}
	for _, labelID := range input.LabelIDs {
		if !isSystemLabel(labelID) {
			s.ensureCustomLabel(input.UserEmail, labelID)
		}
	}
	gmailID := input.GmailID
	if gmailID == "" {
		gmailID = "msg_" + generateUID("")
	}
	threadID := input.ThreadID
	if threadID == "" {
		threadID = "thread_" + gmailID
	}
	dateHeader := input.Date
	subject := input.Subject
	from := input.From
	to := input.To
	cc := input.CC
	bcc := input.BCC
	replyTo := input.ReplyTo
	headerMessageID := input.MessageID
	references := input.References
	inReplyTo := input.InReplyTo
	bodyText := stringValue(input.BodyText)
	bodyHTML := stringValue(input.BodyHTML)
	raw := stringValue(input.Raw)
	if raw != "" {
		parsed := parseRawMessage(raw)
		if subject == "" {
			subject = parsed.Subject
		}
		if from == "" {
			from = parsed.From
		}
		if to == "" {
			to = parsed.To
		}
		if stringValue(cc) == "" {
			cc = nullableString(parsed.CC)
		}
		if stringValue(bcc) == "" {
			bcc = nullableString(parsed.BCC)
		}
		if stringValue(replyTo) == "" {
			replyTo = nullableString(parsed.ReplyTo)
		}
		if headerMessageID == "" {
			headerMessageID = parsed.MessageID
		}
		if stringValue(references) == "" {
			references = nullableString(parsed.References)
		}
		if stringValue(inReplyTo) == "" {
			inReplyTo = nullableString(parsed.InReplyTo)
		}
		if dateHeader == "" {
			dateHeader = parsed.DateHeader
		}
		if bodyText == "" {
			bodyText = parsed.BodyText
		}
		if bodyHTML == "" {
			bodyHTML = parsed.BodyHTML
		}
		for _, attachment := range parsed.Attachments {
			attachmentID := "att_" + generateUID("")
			s.store.Attachments.Insert(corestore.Record{
				"gmail_id":          attachmentID,
				"user_email":        input.UserEmail,
				"message_gmail_id":  gmailID,
				"filename":          attachment.Filename,
				"mime_type":         attachment.MIMEType,
				"disposition":       nullableString(attachment.Disposition),
				"content_id":        nullableString(attachment.ContentID),
				"transfer_encoding": nullableString(attachment.TransferEncoding),
				"data":              base64URLString(attachment.Body),
				"size":              len(attachment.Body),
			})
		}
	}
	if subject == "" {
		subject = "(no subject)"
	}
	if input.Snippet == "" {
		input.Snippet = firstNonEmpty(bodyText, stripHTML(bodyHTML), subject)
	}
	if dateHeader == "" {
		dateHeader = nowISO()
	}
	internalDate := input.InternalDate
	if internalDate == "" {
		internalDate = dateHeader
	}
	labels := dedupeStrings(input.LabelIDs)
	if len(labels) == 0 {
		labels = []string{}
	}
	historyID := generateHistoryID()
	message := s.store.Messages.Insert(corestore.Record{
		"gmail_id":      gmailID,
		"thread_id":     threadID,
		"user_email":    input.UserEmail,
		"history_id":    historyID,
		"internal_date": internalDate,
		"raw":           nullableString(raw),
		"label_ids":     labels,
		"snippet":       truncate(input.Snippet, 120),
		"subject":       subject,
		"from":          from,
		"to":            to,
		"cc":            cc,
		"bcc":           bcc,
		"reply_to":      replyTo,
		"message_id":    firstNonEmpty(headerMessageID, "<"+gmailID+"@emulate.google.local>"),
		"references":    references,
		"in_reply_to":   inReplyTo,
		"date_header":   dateHeader,
		"body_text":     nullableString(bodyText),
		"body_html":     nullableString(bodyHTML),
	})
	s.recordHistoryWithID(historyID, "messageAdded", message, nil)
	s.applyFilters(message)
	return message
}

func (s *Service) getMessageByID(userEmail string, messageID string) corestore.Record {
	for _, message := range s.store.Messages.FindBy("user_email", userEmail) {
		if stringField(message, "gmail_id") == messageID {
			return message
		}
	}
	return nil
}

func (s *Service) recordHistory(changeType string, message corestore.Record, labelIDs []string) {
	s.recordHistoryWithID(generateHistoryID(), changeType, message, labelIDs)
}

func (s *Service) recordHistoryWithID(historyID string, changeType string, message corestore.Record, labelIDs []string) {
	if message == nil {
		return
	}
	if historyID == "" {
		historyID = generateHistoryID()
	}
	s.store.History.Insert(corestore.Record{
		"gmail_id":         historyID,
		"user_email":       stringField(message, "user_email"),
		"change_type":      changeType,
		"message_gmail_id": stringField(message, "gmail_id"),
		"thread_id":        stringField(message, "thread_id"),
		"label_ids":        dedupeStrings(labelIDs),
	})
}

func (s *Service) updateMessageLabels(message corestore.Record, labels []string) corestore.Record {
	current := stringSliceValue(message["label_ids"])
	added, removed := diffLabels(current, labels)
	historyID := generateHistoryID()
	updated, ok := s.store.Messages.Update(intField(message, "id"), corestore.Record{
		"label_ids":  dedupeStrings(labels),
		"history_id": historyID,
	})
	if !ok {
		return message
	}
	if len(added) > 0 {
		s.recordHistoryWithID(historyID, "labelAdded", updated, added)
	}
	if len(removed) > 0 {
		s.recordHistoryWithID(historyID, "labelRemoved", updated, removed)
	}
	return updated
}

func (s *Service) deleteMessage(message corestore.Record) {
	s.recordHistory("messageDeleted", message, nil)
	s.store.Messages.Delete(intField(message, "id"))
	for _, draft := range s.store.Drafts.FindBy("message_gmail_id", stringField(message, "gmail_id")) {
		if stringField(draft, "user_email") != stringField(message, "user_email") {
			continue
		}
		s.store.Drafts.Delete(intField(draft, "id"))
	}
	for _, attachment := range s.listAttachmentsForMessage(message) {
		s.store.Attachments.Delete(intField(attachment, "id"))
	}
}

func (s *Service) applyFilters(message corestore.Record) {
	from := strings.ToLower(stringField(message, "from"))
	for _, filter := range s.store.Filters.FindBy("user_email", stringField(message, "user_email")) {
		criteriaFrom := strings.ToLower(stringField(filter, "criteria_from"))
		if criteriaFrom == "" || !strings.Contains(from, criteriaFrom) {
			continue
		}
		labels := applyLabelMutation(stringSliceValue(message["label_ids"]), stringSliceValue(filter["add_label_ids"]), stringSliceValue(filter["remove_label_ids"]))
		updated := s.updateMessageLabels(message, labels)
		message = updated
	}
}

func applyLabelMutation(current []string, add []string, remove []string) []string {
	set := map[string]struct{}{}
	for _, label := range current {
		if label != "" {
			set[label] = struct{}{}
		}
	}
	for _, label := range add {
		if label != "" {
			set[label] = struct{}{}
		}
	}
	for _, label := range remove {
		delete(set, label)
	}
	out := make([]string, 0, len(set))
	for label := range set {
		out = append(out, label)
	}
	sort.Strings(out)
	return out
}

func diffLabels(before []string, after []string) ([]string, []string) {
	beforeSet := map[string]struct{}{}
	afterSet := map[string]struct{}{}
	for _, label := range before {
		beforeSet[label] = struct{}{}
	}
	for _, label := range after {
		afterSet[label] = struct{}{}
	}
	var added []string
	var removed []string
	for label := range afterSet {
		if _, ok := beforeSet[label]; !ok {
			added = append(added, label)
		}
	}
	for label := range beforeSet {
		if _, ok := afterSet[label]; !ok {
			removed = append(removed, label)
		}
	}
	sort.Strings(added)
	sort.Strings(removed)
	return added, removed
}

func dedupeStrings(values []string) []string {
	seen := map[string]struct{}{}
	out := make([]string, 0, len(values))
	for _, value := range values {
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	return out
}

func isSystemLabel(labelID string) bool {
	for _, label := range systemLabels {
		if stringField(label, "gmail_id") == labelID {
			return true
		}
	}
	return false
}

func (s *Service) listMessages(userEmail string, query url.Values) []corestore.Record {
	messages := s.store.Messages.FindBy("user_email", userEmail)
	labelFilters := query["labelIds"]
	search := strings.TrimSpace(query.Get("q"))
	includeSpamTrash := query.Get("includeSpamTrash") == "true" || query.Get("includeSpamTrash") == "1"
	filtered := make([]corestore.Record, 0, len(messages))
	for _, message := range messages {
		labels := stringSliceValue(message["label_ids"])
		if !includeSpamTrash && (containsString(labels, "TRASH") || containsString(labels, "SPAM")) {
			continue
		}
		if len(labelFilters) > 0 && !containsAll(labels, labelFilters) {
			continue
		}
		if !matchesMessageQuery(s, message, search) {
			continue
		}
		filtered = append(filtered, message)
	}
	sort.SliceStable(filtered, func(i int, j int) bool {
		return messageSortTime(filtered[i]) > messageSortTime(filtered[j])
	})
	return filtered
}

func matchesMessageQuery(s *Service, message corestore.Record, query string) bool {
	if query == "" {
		return !containsString(stringSliceValue(message["label_ids"]), "DRAFT")
	}
	labels := stringSliceValue(message["label_ids"])
	parts := strings.Fields(query)
	for _, part := range parts {
		lower := strings.ToLower(part)
		switch {
		case strings.HasPrefix(lower, "-label:"):
			label := resolveLabelAlias(strings.TrimPrefix(lower, "-label:"))
			if containsString(labels, label) {
				return false
			}
		case strings.HasPrefix(lower, "label:"):
			label := resolveLabelAlias(strings.TrimPrefix(lower, "label:"))
			if !containsString(labels, label) {
				return false
			}
		case strings.HasPrefix(lower, "in:"):
			label := resolveLabelAlias(strings.TrimPrefix(lower, "in:"))
			if !containsString(labels, label) {
				return false
			}
		case lower == "has:attachment":
			if len(s.store.Attachments.FindBy("message_gmail_id", stringField(message, "gmail_id"))) == 0 {
				return false
			}
		default:
			haystack := strings.ToLower(strings.Join([]string{
				stringField(message, "from"),
				stringField(message, "to"),
				stringField(message, "subject"),
				stringField(message, "snippet"),
				stringField(message, "body_text"),
				stringField(message, "body_html"),
			}, " "))
			if !strings.Contains(haystack, lower) {
				return false
			}
		}
	}
	return true
}

func resolveLabelAlias(value string) string {
	if label, ok := systemLabelAliases[strings.ToLower(value)]; ok {
		return label
	}
	return value
}

func formatMessageResource(s *Service, message corestore.Record, format string, metadataHeaders []string) map[string]any {
	if format == "" {
		format = "full"
	}
	out := map[string]any{
		"id":           stringField(message, "gmail_id"),
		"threadId":     stringField(message, "thread_id"),
		"labelIds":     stringSliceValue(message["label_ids"]),
		"snippet":      stringField(message, "snippet"),
		"historyId":    stringField(message, "history_id"),
		"internalDate": internalDateMillis(stringField(message, "internal_date")),
	}
	if format == "minimal" {
		return out
	}
	if format == "raw" {
		raw := stringField(message, "raw")
		if raw == "" {
			raw = base64URLString([]byte(buildMessageText(message)))
		}
		out["raw"] = raw
		return out
	}
	out["payload"] = s.messagePayload(message, format, metadataHeaders)
	return out
}

func (s *Service) messagePayload(message corestore.Record, format string, metadataHeaders []string) map[string]any {
	headers := []map[string]string{
		{"name": "From", "value": stringField(message, "from")},
		{"name": "To", "value": stringField(message, "to")},
	}
	headers = appendHeaderIfPresent(headers, "Cc", stringField(message, "cc"))
	headers = appendHeaderIfPresent(headers, "Bcc", stringField(message, "bcc"))
	headers = appendHeaderIfPresent(headers, "Reply-To", stringField(message, "reply_to"))
	headers = append(headers,
		map[string]string{"name": "Subject", "value": stringField(message, "subject")},
		map[string]string{"name": "Date", "value": stringField(message, "date_header")},
		map[string]string{"name": "Message-ID", "value": stringField(message, "message_id")},
	)
	headers = appendHeaderIfPresent(headers, "References", stringField(message, "references"))
	headers = appendHeaderIfPresent(headers, "In-Reply-To", stringField(message, "in_reply_to"))
	if len(metadataHeaders) > 0 {
		allowed := map[string]struct{}{}
		for _, header := range metadataHeaders {
			allowed[strings.ToLower(header)] = struct{}{}
		}
		filtered := make([]map[string]string, 0, len(headers))
		for _, header := range headers {
			if _, ok := allowed[strings.ToLower(header["name"])]; ok {
				filtered = append(filtered, header)
			}
		}
		headers = filtered
	}
	payload := map[string]any{
		"partId":   "",
		"mimeType": "text/plain",
		"filename": "",
		"headers":  headers,
		"body": map[string]any{
			"size": len(stringField(message, "body_text")),
			"data": base64URLString([]byte(stringField(message, "body_text"))),
		},
	}
	attachments := s.listAttachmentsForMessage(message)
	if len(attachments) > 0 || stringField(message, "body_html") != "" {
		parts := []map[string]any{}
		if stringField(message, "body_text") != "" {
			parts = append(parts, map[string]any{
				"partId":   "0",
				"mimeType": "text/plain",
				"filename": "",
				"headers":  []map[string]string{},
				"body": map[string]any{
					"size": len(stringField(message, "body_text")),
					"data": base64URLString([]byte(stringField(message, "body_text"))),
				},
			})
		}
		if stringField(message, "body_html") != "" {
			parts = append(parts, map[string]any{
				"partId":   strconv.Itoa(len(parts)),
				"mimeType": "text/html",
				"filename": "",
				"headers":  []map[string]string{},
				"body": map[string]any{
					"size": len(stringField(message, "body_html")),
					"data": base64URLString([]byte(stringField(message, "body_html"))),
				},
			})
		}
		for _, attachment := range attachments {
			parts = append(parts, map[string]any{
				"partId":   strconv.Itoa(len(parts)),
				"mimeType": stringField(attachment, "mime_type"),
				"filename": stringField(attachment, "filename"),
				"headers":  []map[string]string{},
				"body": map[string]any{
					"attachmentId": stringField(attachment, "gmail_id"),
					"size":         intField(attachment, "size"),
				},
			})
		}
		payload["mimeType"] = "multipart/mixed"
		payload["body"] = map[string]any{"size": 0}
		payload["parts"] = parts
	}
	if format == "metadata" {
		payload["body"] = map[string]any{"size": 0}
		delete(payload, "parts")
	}
	return payload
}

func appendHeaderIfPresent(headers []map[string]string, name string, value string) []map[string]string {
	if value == "" {
		return headers
	}
	return append(headers, map[string]string{"name": name, "value": value})
}

func (s *Service) listAttachmentsForMessage(message corestore.Record) []corestore.Record {
	attachments := []corestore.Record{}
	for _, attachment := range s.store.Attachments.FindBy("message_gmail_id", stringField(message, "gmail_id")) {
		if stringField(attachment, "user_email") != stringField(message, "user_email") {
			continue
		}
		attachments = append(attachments, attachment)
	}
	return attachments
}

func (s *Service) replaceMessageAttachments(message corestore.Record, attachments []parsedAttachment) {
	for _, attachment := range s.listAttachmentsForMessage(message) {
		s.store.Attachments.Delete(intField(attachment, "id"))
	}
	for _, attachment := range attachments {
		s.store.Attachments.Insert(corestore.Record{
			"gmail_id":          "att_" + generateUID(""),
			"user_email":        stringField(message, "user_email"),
			"message_gmail_id":  stringField(message, "gmail_id"),
			"filename":          attachment.Filename,
			"mime_type":         attachment.MIMEType,
			"disposition":       nullableString(attachment.Disposition),
			"content_id":        nullableString(attachment.ContentID),
			"transfer_encoding": nullableString(attachment.TransferEncoding),
			"data":              base64URLString(attachment.Body),
			"size":              len(attachment.Body),
		})
	}
}

func buildMessageText(message corestore.Record) string {
	headers := []string{
		"From: " + stringField(message, "from"),
		"To: " + stringField(message, "to"),
	}
	headers = appendTextHeaderIfPresent(headers, "Cc", stringField(message, "cc"))
	headers = appendTextHeaderIfPresent(headers, "Bcc", stringField(message, "bcc"))
	headers = appendTextHeaderIfPresent(headers, "Reply-To", stringField(message, "reply_to"))
	headers = append(headers,
		"Subject: "+stringField(message, "subject"),
		"Date: "+stringField(message, "date_header"),
		"Message-ID: "+stringField(message, "message_id"),
	)
	headers = appendTextHeaderIfPresent(headers, "References", stringField(message, "references"))
	headers = appendTextHeaderIfPresent(headers, "In-Reply-To", stringField(message, "in_reply_to"))
	return strings.Join(headers, "\r\n") + "\r\n\r\n" + firstNonEmpty(stringField(message, "body_text"), stripHTML(stringField(message, "body_html")))
}

func appendTextHeaderIfPresent(headers []string, name string, value string) []string {
	if value == "" {
		return headers
	}
	return append(headers, name+": "+value)
}

func internalDateMillis(value string) string {
	if value == "" {
		return strconv.FormatInt(time.Now().UnixMilli(), 10)
	}
	if parsed, err := strconv.ParseInt(value, 10, 64); err == nil {
		return strconv.FormatInt(parsed, 10)
	}
	if parsed, err := time.Parse(time.RFC3339Nano, value); err == nil {
		return strconv.FormatInt(parsed.UnixMilli(), 10)
	}
	if parsed, err := http.ParseTime(value); err == nil {
		return strconv.FormatInt(parsed.UnixMilli(), 10)
	}
	return value
}

func messageSortTime(message corestore.Record) int64 {
	value := internalDateMillis(stringField(message, "internal_date"))
	parsed, _ := strconv.ParseInt(value, 10, 64)
	return parsed
}

func containsString(values []string, needle string) bool {
	for _, value := range values {
		if value == needle {
			return true
		}
	}
	return false
}

func containsAll(values []string, needles []string) bool {
	for _, needle := range needles {
		if !containsString(values, needle) {
			return false
		}
	}
	return true
}

func parseOffset(value string) int {
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed < 0 {
		return 0
	}
	return parsed
}

func normalizeLimit(value string, fallback int, max int) int {
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed <= 0 {
		return fallback
	}
	if parsed > max {
		return max
	}
	return parsed
}

func truncate(value string, max int) string {
	if len(value) <= max {
		return value
	}
	return value[:max]
}

func stripHTML(value string) string {
	replacer := strings.NewReplacer("<p>", "", "</p>", "", "<br>", "\n", "<br/>", "\n", "<br />", "\n")
	return replacer.Replace(value)
}

type parsedRawMessage struct {
	From        string
	To          string
	CC          string
	BCC         string
	ReplyTo     string
	Subject     string
	MessageID   string
	References  string
	InReplyTo   string
	DateHeader  string
	BodyText    string
	BodyHTML    string
	Attachments []parsedAttachment
	Valid       bool
}

type parsedAttachment struct {
	Filename         string
	MIMEType         string
	Disposition      string
	ContentID        string
	TransferEncoding string
	Body             []byte
}

func parseRawMessage(raw string) parsedRawMessage {
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		decoded, err = base64.StdEncoding.DecodeString(raw)
		if err != nil {
			return parsedRawMessage{}
		}
	}
	headerText, body, _ := strings.Cut(string(decoded), "\r\n\r\n")
	if body == "" {
		headerText, body, _ = strings.Cut(string(decoded), "\n\n")
	}
	headers := parseMIMEHeaders(headerText)
	out := parsedRawMessage{
		Valid:      true,
		From:       headers["from"],
		To:         headers["to"],
		CC:         headers["cc"],
		BCC:        headers["bcc"],
		ReplyTo:    headers["reply-to"],
		Subject:    headers["subject"],
		MessageID:  headers["message-id"],
		References: headers["references"],
		InReplyTo:  headers["in-reply-to"],
		DateHeader: headers["date"],
	}
	contentType := headers["content-type"]
	mediaType, params, _ := mime.ParseMediaType(contentType)
	if strings.HasPrefix(mediaType, "multipart/") && params["boundary"] != "" {
		parseMultipartBody(params["boundary"], body, &out)
		return out
	}
	if mediaType == "text/html" {
		out.BodyHTML = strings.TrimSpace(body)
	} else {
		out.BodyText = strings.TrimSpace(body)
	}
	return out
}

func parseMIMEHeaders(headerText string) map[string]string {
	headers := map[string]string{}
	var current string
	for _, line := range strings.Split(strings.ReplaceAll(headerText, "\r\n", "\n"), "\n") {
		if strings.HasPrefix(line, " ") || strings.HasPrefix(line, "\t") {
			if current != "" {
				headers[current] += " " + strings.TrimSpace(line)
			}
			continue
		}
		name, value, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		current = strings.ToLower(strings.TrimSpace(name))
		headers[current] = strings.TrimSpace(value)
	}
	return headers
}

func parseMultipartBody(boundary string, body string, out *parsedRawMessage) {
	parts := strings.Split(body, "--"+boundary)
	for _, part := range parts {
		part = trimMultipartStringPrefix(part)
		if part == "" || strings.HasPrefix(part, "--") {
			continue
		}
		headerText, partBody, _ := strings.Cut(part, "\r\n\r\n")
		if partBody == "" {
			headerText, partBody, _ = strings.Cut(part, "\n\n")
		}
		headers := parseMIMEHeaders(headerText)
		contentType := headers["content-type"]
		mediaType, params, _ := mime.ParseMediaType(contentType)
		disposition, dispositionParams, _ := mime.ParseMediaType(headers["content-disposition"])
		bodyBytes := []byte(trimMultipartStringSuffix(partBody))
		if strings.EqualFold(headers["content-transfer-encoding"], "base64") {
			if decoded, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(bodyBytes))); err == nil {
				bodyBytes = decoded
			}
		}
		switch {
		case disposition == "attachment" || dispositionParams["filename"] != "":
			filename := firstNonEmpty(dispositionParams["filename"], params["name"])
			out.Attachments = append(out.Attachments, parsedAttachment{
				Filename:         filename,
				MIMEType:         firstNonEmpty(mediaType, "application/octet-stream"),
				Disposition:      disposition,
				ContentID:        strings.Trim(headers["content-id"], "<>"),
				TransferEncoding: headers["content-transfer-encoding"],
				Body:             bodyBytes,
			})
		case mediaType == "text/html":
			out.BodyHTML = string(bodyBytes)
		default:
			out.BodyText = string(bodyBytes)
		}
	}
}

func trimMultipartStringPrefix(part string) string {
	if strings.HasPrefix(part, "\r\n") {
		return part[2:]
	}
	if strings.HasPrefix(part, "\n") {
		return part[1:]
	}
	return part
}

func trimMultipartStringSuffix(body string) string {
	if strings.HasSuffix(body, "\r\n") {
		return body[:len(body)-2]
	}
	if strings.HasSuffix(body, "\n") {
		return body[:len(body)-1]
	}
	return body
}

func ensureDefaultCalendars(store Store, userEmail string) {
	existing := store.Calendars.FindBy("user_email", userEmail)
	if len(existing) > 0 {
		hasPrimary := false
		for _, calendar := range existing {
			if boolField(calendar, "primary") {
				hasPrimary = true
				break
			}
		}
		if !hasPrimary {
			store.Calendars.Update(intField(existing[0], "id"), corestore.Record{"primary": true})
		}
		return
	}
	store.Calendars.Insert(corestore.Record{
		"google_id":        "primary",
		"user_email":       userEmail,
		"summary":          userEmail,
		"description":      nil,
		"time_zone":        "UTC",
		"primary":          true,
		"selected":         true,
		"access_role":      "owner",
		"background_color": nil,
		"foreground_color": nil,
	})
}

func (s *Service) createCalendarRecord(input calendarInput) corestore.Record {
	ensureDefaultCalendars(s.store, input.UserEmail)
	calendarID := input.GoogleID
	if calendarID == "" {
		calendarID = generateUID("cal")
	}
	if existing := s.getCalendarByID(input.UserEmail, calendarID); existing != nil {
		if !input.Update {
			return existing
		}
		patch := corestore.Record{
			"summary":     firstNonEmpty(input.Summary, stringField(existing, "summary"), input.UserEmail),
			"description": input.Description,
			"time_zone":   firstNonEmpty(input.TimeZone, stringField(existing, "time_zone"), "UTC"),
			"selected":    input.Selected,
			"access_role": firstNonEmpty(input.AccessRole, stringField(existing, "access_role"), "owner"),
		}
		if input.Primary {
			patch["primary"] = true
		}
		updated, ok := s.store.Calendars.Update(intField(existing, "id"), patch)
		if !ok {
			return existing
		}
		if input.Primary {
			for _, calendar := range s.store.Calendars.FindBy("user_email", input.UserEmail) {
				if intField(calendar, "id") != intField(updated, "id") && boolField(calendar, "primary") {
					s.store.Calendars.Update(intField(calendar, "id"), corestore.Record{"primary": false})
				}
			}
		}
		return updated
	}
	summary := firstNonEmpty(input.Summary, input.UserEmail)
	record := s.store.Calendars.Insert(corestore.Record{
		"google_id":        calendarID,
		"user_email":       input.UserEmail,
		"summary":          summary,
		"description":      input.Description,
		"time_zone":        firstNonEmpty(input.TimeZone, "UTC"),
		"primary":          input.Primary,
		"selected":         input.Selected,
		"access_role":      firstNonEmpty(input.AccessRole, "owner"),
		"background_color": nil,
		"foreground_color": nil,
	})
	if input.Primary {
		for _, calendar := range s.store.Calendars.FindBy("user_email", input.UserEmail) {
			if intField(calendar, "id") != intField(record, "id") && boolField(calendar, "primary") {
				s.store.Calendars.Update(intField(calendar, "id"), corestore.Record{"primary": false})
			}
		}
	}
	return record
}

func (s *Service) listCalendars(userEmail string) []corestore.Record {
	ensureDefaultCalendars(s.store, userEmail)
	calendars := s.store.Calendars.FindBy("user_email", userEmail)
	sort.SliceStable(calendars, func(i int, j int) bool {
		if boolField(calendars[i], "primary") != boolField(calendars[j], "primary") {
			return boolField(calendars[i], "primary")
		}
		return stringField(calendars[i], "summary") < stringField(calendars[j], "summary")
	})
	return calendars
}

func (s *Service) getCalendarByID(userEmail string, calendarID string) corestore.Record {
	ensureDefaultCalendars(s.store, userEmail)
	if calendarID == "primary" || calendarID == "" {
		for _, calendar := range s.store.Calendars.FindBy("user_email", userEmail) {
			if boolField(calendar, "primary") {
				return calendar
			}
		}
	}
	for _, calendar := range s.store.Calendars.FindBy("user_email", userEmail) {
		if stringField(calendar, "google_id") == calendarID {
			return calendar
		}
	}
	return nil
}

func formatCalendarResource(calendar corestore.Record) map[string]any {
	out := map[string]any{
		"kind":       "calendar#calendarListEntry",
		"etag":       `"` + stringField(calendar, "google_id") + `"`,
		"id":         stringField(calendar, "google_id"),
		"summary":    stringField(calendar, "summary"),
		"timeZone":   stringField(calendar, "time_zone"),
		"selected":   boolField(calendar, "selected"),
		"accessRole": stringField(calendar, "access_role"),
	}
	if description := stringField(calendar, "description"); description != "" {
		out["description"] = description
	}
	if boolField(calendar, "primary") {
		out["primary"] = true
	}
	return out
}

func (s *Service) createCalendarEventRecord(input calendarEventInput) corestore.Record {
	calendar := s.getCalendarByID(input.UserEmail, input.CalendarGoogleID)
	if calendar == nil {
		return nil
	}
	eventID := input.GoogleID
	if eventID == "" {
		eventID = generateUID("evt")
	}
	if existing := s.getCalendarEventByID(input.UserEmail, stringField(calendar, "google_id"), eventID); existing != nil {
		return existing
	}
	hangoutLink := input.HangoutLink
	if hangoutLink == nil {
		for _, entry := range input.ConferenceEntryPoints {
			if stringValue(entry["entry_point_type"]) == "video" {
				hangoutLink = entry["uri"]
				break
			}
		}
	}
	return s.store.CalendarEvents.Insert(corestore.Record{
		"google_id":               eventID,
		"user_email":              input.UserEmail,
		"calendar_google_id":      stringField(calendar, "google_id"),
		"status":                  firstNonEmpty(input.Status, "confirmed"),
		"summary":                 firstNonEmpty(input.Summary, "Untitled Event"),
		"description":             input.Description,
		"location":                input.Location,
		"html_link":               "https://calendar.google.com/calendar/u/0/r/eventedit/" + stringField(calendar, "google_id") + "/" + eventID,
		"hangout_link":            hangoutLink,
		"start_date_time":         nullableString(input.StartDateTime),
		"start_date":              nullableString(input.StartDate),
		"end_date_time":           nullableString(input.EndDateTime),
		"end_date":                nullableString(input.EndDate),
		"attendees":               input.Attendees,
		"conference_entry_points": input.ConferenceEntryPoints,
		"transparency":            input.Transparency,
	})
}

func (s *Service) getCalendarEventByID(userEmail string, calendarID string, eventID string) corestore.Record {
	calendar := s.getCalendarByID(userEmail, calendarID)
	if calendar == nil {
		return nil
	}
	for _, event := range s.store.CalendarEvents.FindBy("user_email", userEmail) {
		if stringField(event, "calendar_google_id") == stringField(calendar, "google_id") && stringField(event, "google_id") == eventID {
			return event
		}
	}
	return nil
}

func (s *Service) listCalendarEvents(userEmail string, calendarID string, query url.Values) []corestore.Record {
	calendar := s.getCalendarByID(userEmail, calendarID)
	if calendar == nil {
		return nil
	}
	var events []corestore.Record
	minTime := parseMaybeTime(query.Get("timeMin"))
	maxTime := parseMaybeTime(query.Get("timeMax"))
	search := strings.ToLower(strings.TrimSpace(query.Get("q")))
	for _, event := range s.store.CalendarEvents.FindBy("user_email", userEmail) {
		if stringField(event, "calendar_google_id") != stringField(calendar, "google_id") || stringField(event, "status") == "cancelled" {
			continue
		}
		if !eventOverlaps(event, minTime, maxTime) {
			continue
		}
		if search != "" && !strings.Contains(strings.ToLower(strings.Join([]string{stringField(event, "summary"), stringField(event, "description"), stringField(event, "location")}, " ")), search) {
			continue
		}
		events = append(events, event)
	}
	sort.SliceStable(events, func(i int, j int) bool {
		return eventSortTime(events[i]) < eventSortTime(events[j])
	})
	return events
}

func formatCalendarEventResource(s *Service, event corestore.Record) map[string]any {
	calendar := s.getCalendarByID(stringField(event, "user_email"), stringField(event, "calendar_google_id"))
	timeZone := "UTC"
	if calendar != nil && stringField(calendar, "time_zone") != "" {
		timeZone = stringField(calendar, "time_zone")
	}
	out := map[string]any{
		"kind":      "calendar#event",
		"etag":      `"` + stringField(event, "google_id") + `"`,
		"id":        stringField(event, "google_id"),
		"status":    stringField(event, "status"),
		"summary":   stringField(event, "summary"),
		"created":   stringField(event, "created_at"),
		"updated":   stringField(event, "updated_at"),
		"start":     calendarDateRange(event, "start", timeZone),
		"end":       calendarDateRange(event, "end", timeZone),
		"attendees": formatCalendarAttendees(recordSliceValue(event["attendees"])),
	}
	if value := stringField(event, "html_link"); value != "" {
		out["htmlLink"] = value
	}
	if value := stringField(event, "hangout_link"); value != "" {
		out["hangoutLink"] = value
	}
	if value := stringField(event, "description"); value != "" {
		out["description"] = value
	}
	if value := stringField(event, "location"); value != "" {
		out["location"] = value
	}
	if entries := recordSliceValue(event["conference_entry_points"]); len(entries) > 0 {
		formatted := make([]map[string]any, 0, len(entries))
		for _, entry := range entries {
			formatted = append(formatted, map[string]any{
				"entryPointType": stringValue(entry["entry_point_type"]),
				"uri":            stringValue(entry["uri"]),
				"label":          entry["label"],
			})
		}
		out["conferenceData"] = map[string]any{"entryPoints": formatted}
	}
	return out
}

func formatCalendarAttendees(attendees []map[string]any) []map[string]any {
	formatted := make([]map[string]any, 0, len(attendees))
	for _, attendee := range attendees {
		email := stringValue(attendee["email"])
		if email == "" {
			continue
		}
		item := map[string]any{"email": email}
		if value := stringValue(attendee["display_name"]); value != "" {
			item["displayName"] = value
		}
		if value := stringValue(attendee["response_status"]); value != "" {
			item["responseStatus"] = value
		}
		if value, ok := attendee["organizer"].(bool); ok {
			item["organizer"] = value
		}
		if value, ok := attendee["self"].(bool); ok {
			item["self"] = value
		}
		formatted = append(formatted, item)
	}
	return formatted
}

func calendarDateRange(event corestore.Record, prefix string, timeZone string) map[string]any {
	dateTimeKey := prefix + "_date_time"
	dateKey := prefix + "_date"
	if value := stringField(event, dateTimeKey); value != "" {
		return map[string]any{"dateTime": value, "timeZone": timeZone}
	}
	return map[string]any{"date": stringField(event, dateKey), "timeZone": timeZone}
}

func buildFreeBusyResponse(s *Service, userEmail string, timeMin string, timeMax string, items []map[string]any) map[string]any {
	calendars := map[string]any{}
	minTime := parseMaybeTime(timeMin)
	maxTime := parseMaybeTime(timeMax)
	for _, item := range items {
		id := stringValue(item["id"])
		if id == "" {
			continue
		}
		events := s.listCalendarEvents(userEmail, id, url.Values{})
		busy := []map[string]string{}
		for _, event := range events {
			if stringField(event, "transparency") == "transparent" || !eventOverlaps(event, minTime, maxTime) {
				continue
			}
			busy = append(busy, map[string]string{
				"start": firstNonEmpty(stringField(event, "start_date_time"), stringField(event, "start_date")+"T00:00:00.000Z"),
				"end":   firstNonEmpty(stringField(event, "end_date_time"), stringField(event, "end_date")+"T00:00:00.000Z"),
			})
		}
		calendars[id] = map[string]any{"busy": busy}
	}
	return map[string]any{"kind": "calendar#freeBusy", "timeMin": timeMin, "timeMax": timeMax, "calendars": calendars}
}

func parseMaybeTime(value string) *time.Time {
	if value == "" {
		return nil
	}
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return nil
	}
	return &parsed
}

func eventOverlaps(event corestore.Record, minTime *time.Time, maxTime *time.Time) bool {
	start := parseMaybeTime(firstNonEmpty(stringField(event, "start_date_time"), stringField(event, "start_date")+"T00:00:00Z"))
	end := parseMaybeTime(firstNonEmpty(stringField(event, "end_date_time"), stringField(event, "end_date")+"T00:00:00Z"))
	if start == nil || end == nil {
		return true
	}
	if minTime != nil && !end.After(*minTime) {
		return false
	}
	if maxTime != nil && !start.Before(*maxTime) {
		return false
	}
	return true
}

func eventSortTime(event corestore.Record) int64 {
	value := firstNonEmpty(stringField(event, "start_date_time"), stringField(event, "start_date")+"T00:00:00Z")
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return 0
	}
	return parsed.UnixNano()
}

func (s *Service) createDriveItemRecord(input driveItemInput) corestore.Record {
	itemID := input.GoogleID
	if itemID == "" {
		itemID = generateUID("drv")
	}
	if existing := s.getDriveItemByID(input.UserEmail, itemID); existing != nil {
		return existing
	}
	mimeType := firstNonEmpty(input.MIMEType, "application/octet-stream")
	size := any(nil)
	if input.Size != nil {
		size = *input.Size
	}
	return s.store.DriveItems.Insert(corestore.Record{
		"google_id":         itemID,
		"user_email":        input.UserEmail,
		"name":              firstNonEmpty(input.Name, "Untitled"),
		"mime_type":         mimeType,
		"parent_google_ids": normalizeParentIDs(input.ParentGoogleIDs),
		"web_view_link":     firstNonNil(input.WebViewLink, buildDriveWebViewLink(itemID, mimeType)),
		"size":              size,
		"trashed":           input.Trashed,
		"data":              input.Data,
	})
}

func (s *Service) getDriveItemByID(userEmail string, fileID string) corestore.Record {
	for _, item := range s.store.DriveItems.FindBy("user_email", userEmail) {
		if stringField(item, "google_id") == fileID {
			return item
		}
	}
	return nil
}

func (s *Service) listDriveItems(userEmail string, query url.Values) []corestore.Record {
	items := s.store.DriveItems.FindBy("user_email", userEmail)
	driveQuery := query.Get("q")
	parentID := parseParentQuery(driveQuery)
	requireNotTrashed := strings.Contains(driveQuery, "trashed = false")
	mimeTypes := parseDriveMimeMatches(driveQuery, "mimeType = '")
	excludedMimeTypes := parseDriveMimeMatches(driveQuery, "mimeType != '")
	filtered := make([]corestore.Record, 0, len(items))
	for _, item := range items {
		if parentID != "" && !containsString(stringSliceValue(item["parent_google_ids"]), parentID) {
			continue
		}
		if requireNotTrashed && boolField(item, "trashed") {
			continue
		}
		if len(mimeTypes) > 0 && !containsString(mimeTypes, stringField(item, "mime_type")) {
			continue
		}
		if len(excludedMimeTypes) > 0 && containsString(excludedMimeTypes, stringField(item, "mime_type")) {
			continue
		}
		filtered = append(filtered, item)
	}
	sort.SliceStable(filtered, func(i int, j int) bool {
		if strings.Contains(query.Get("orderBy"), "name") {
			return stringField(filtered[i], "name") < stringField(filtered[j], "name")
		}
		return stringField(filtered[i], "created_at") < stringField(filtered[j], "created_at")
	})
	return filtered
}

func (s *Service) updateDriveItemRecord(item corestore.Record, addParents []string, removeParents []string, name string) corestore.Record {
	parentSet := map[string]struct{}{}
	for _, parent := range stringSliceValue(item["parent_google_ids"]) {
		parentSet[parent] = struct{}{}
	}
	for _, parent := range addParents {
		parentSet[parent] = struct{}{}
	}
	for _, parent := range removeParents {
		delete(parentSet, parent)
	}
	parents := make([]string, 0, len(parentSet))
	for parent := range parentSet {
		parents = append(parents, parent)
	}
	sort.Strings(parents)
	if name == "" {
		name = stringField(item, "name")
	}
	updated, ok := s.store.DriveItems.Update(intField(item, "id"), corestore.Record{
		"name":              name,
		"parent_google_ids": normalizeParentIDs(parents),
		"web_view_link":     buildDriveWebViewLink(stringField(item, "google_id"), stringField(item, "mime_type")),
	})
	if !ok {
		return item
	}
	return updated
}

func formatDriveItemResource(item corestore.Record) map[string]any {
	out := map[string]any{
		"kind":         "drive#file",
		"id":           stringField(item, "google_id"),
		"name":         stringField(item, "name"),
		"mimeType":     stringField(item, "mime_type"),
		"parents":      stringSliceValue(item["parent_google_ids"]),
		"webViewLink":  stringField(item, "web_view_link"),
		"createdTime":  stringField(item, "created_at"),
		"modifiedTime": stringField(item, "updated_at"),
	}
	if item["size"] != nil {
		out["size"] = stringValue(item["size"])
	}
	if boolField(item, "trashed") {
		out["trashed"] = true
	}
	return out
}

func parseDriveMultipartUpload(contentType string, raw []byte) (map[string]any, string, []byte) {
	_, params, _ := mime.ParseMediaType(contentType)
	boundary := params["boundary"]
	if boundary == "" {
		return map[string]any{}, "application/octet-stream", nil
	}
	parts := bytes.Split(raw, []byte("--"+boundary))
	body := map[string]any{}
	mediaType := "application/octet-stream"
	var mediaBody []byte
	for _, part := range parts {
		part = trimMultipartPartPrefix(part)
		if len(part) == 0 || bytes.HasPrefix(part, []byte("--")) {
			continue
		}
		headerRaw, partBody, ok := bytes.Cut(part, []byte("\r\n\r\n"))
		if !ok {
			headerRaw, partBody, ok = bytes.Cut(part, []byte("\n\n"))
			if !ok {
				continue
			}
		}
		headers := parseMIMEHeaders(string(headerRaw))
		if strings.Contains(headers["content-type"], "application/json") {
			_ = json.Unmarshal(bytes.TrimSpace(partBody), &body)
			continue
		}
		mediaType, _, _ = mime.ParseMediaType(headers["content-type"])
		if mediaType == "" {
			mediaType = "application/octet-stream"
		}
		mediaBody = trimMultipartPartSuffix(partBody)
	}
	return body, mediaType, mediaBody
}

func trimMultipartPartPrefix(part []byte) []byte {
	if bytes.HasPrefix(part, []byte("\r\n")) {
		return part[2:]
	}
	if bytes.HasPrefix(part, []byte("\n")) {
		return part[1:]
	}
	return part
}

func trimMultipartPartSuffix(body []byte) []byte {
	if bytes.HasSuffix(body, []byte("\r\n")) {
		return body[:len(body)-2]
	}
	if bytes.HasSuffix(body, []byte("\n")) {
		return body[:len(body)-1]
	}
	return body
}

func parseParentQuery(query string) string {
	remaining := query
	for {
		start := strings.Index(remaining, "'")
		if start < 0 {
			return ""
		}
		rest := remaining[start+1:]
		end := strings.Index(rest, "'")
		if end < 0 {
			return ""
		}
		parent := rest[:end]
		after := strings.TrimSpace(strings.ToLower(rest[end+1:]))
		if strings.HasPrefix(after, "in parents") {
			return parent
		}
		remaining = rest[end+1:]
	}
}

func parseDriveMimeMatches(query string, prefix string) []string {
	var out []string
	remaining := query
	for {
		index := strings.Index(remaining, prefix)
		if index < 0 {
			break
		}
		remaining = remaining[index+len(prefix):]
		end := strings.Index(remaining, "'")
		if end < 0 {
			break
		}
		out = append(out, remaining[:end])
		remaining = remaining[end+1:]
	}
	return out
}

func normalizeParentIDs(parentIDs []string) []string {
	parents := dedupeStrings(parentIDs)
	if len(parents) == 0 {
		return []string{"root"}
	}
	return parents
}

func buildDriveWebViewLink(itemID string, mimeType string) string {
	if mimeType == googleDriveFolderMIME {
		return "https://drive.google.com/drive/folders/" + itemID
	}
	return "https://drive.google.com/file/d/" + itemID + "/view"
}

func firstNonNil(values ...any) any {
	for _, value := range values {
		if value != nil {
			return value
		}
	}
	return nil
}
