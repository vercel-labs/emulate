package okta

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	corehttp "github.com/vercel-labs/emulate/internal/core/http"
	corestore "github.com/vercel-labs/emulate/internal/core/store"
)

const (
	orgAuthServerID          = "org"
	defaultAuthServerID      = "default"
	defaultAudience          = "api://default"
	defaultEveryoneGroupID   = "00g_everyone"
	defaultEveryoneGroupName = "Everyone"
)

func oktaID(prefix string) string {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return prefix + strconv.FormatInt(time.Now().UnixNano(), 36)
	}
	return prefix + hex.EncodeToString(raw)[:17]
}

func oktaToken(prefix string) string {
	raw := make([]byte, 20)
	if _, err := rand.Read(raw); err != nil {
		return prefix + strconv.FormatInt(time.Now().UnixNano(), 36)
	}
	return prefix + base64.RawURLEncoding.EncodeToString(raw)
}

func nowISO() string {
	return time.Now().UTC().Format(time.RFC3339Nano)
}

func oktaError(c *corehttp.Context, status int, code string, summary string) {
	c.JSON(status, map[string]any{
		"errorCode":    code,
		"errorSummary": summary,
		"errorLink":    code,
		"errorId":      code + "-" + strconv.FormatInt(time.Now().UnixMilli(), 10),
		"errorCauses":  []any{},
		"status":       status,
	})
}

func oauthError(c *corehttp.Context, status int, code string, description string) {
	c.JSON(status, map[string]any{"error": code, "error_description": description})
}

func readJSONBody(r *http.Request) map[string]any {
	raw, _ := io.ReadAll(r.Body)
	if len(raw) == 0 {
		return map[string]any{}
	}
	var body map[string]any
	if err := json.Unmarshal(raw, &body); err != nil || body == nil {
		return map[string]any{}
	}
	return body
}

func parseTokenBody(r *http.Request) map[string]string {
	raw, _ := io.ReadAll(r.Body)
	if len(raw) == 0 {
		return map[string]string{}
	}
	if strings.Contains(r.Header.Get("Content-Type"), "application/json") {
		var body map[string]any
		if err := json.Unmarshal(raw, &body); err != nil {
			return map[string]string{}
		}
		out := map[string]string{}
		for key, value := range body {
			if text, ok := value.(string); ok {
				out[key] = text
			}
		}
		return out
	}
	values, err := url.ParseQuery(string(raw))
	if err != nil {
		return map[string]string{}
	}
	out := map[string]string{}
	for key, list := range values {
		if len(list) > 0 {
			out[key] = list[len(list)-1]
		}
	}
	return out
}

func firstRecord(records []corestore.Record) corestore.Record {
	if len(records) == 0 {
		return nil
	}
	return records[0]
}

func stringField(record corestore.Record, field string) string {
	if record == nil {
		return ""
	}
	return stringValue(record[field])
}

func intField(record corestore.Record, field string) int {
	if record == nil {
		return 0
	}
	return intValue(record[field])
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

func intValue(value any) int {
	switch v := value.(type) {
	case int:
		return v
	case int64:
		return int(v)
	case float64:
		return int(v)
	case string:
		n, _ := strconv.Atoi(v)
		return n
	default:
		n, _ := strconv.Atoi(fmt.Sprint(v))
		return n
	}
}

func boolFromQuery(value string, fallback bool) bool {
	switch strings.ToLower(value) {
	case "":
		return fallback
	case "true", "1":
		return true
	case "false", "0":
		return false
	default:
		return fallback
	}
}

func stringSliceValue(value any) []string {
	switch v := value.(type) {
	case []string:
		return append([]string(nil), v...)
	case []any:
		out := make([]string, 0, len(v))
		for _, item := range v {
			if text, ok := item.(string); ok {
				out = append(out, text)
			}
		}
		return out
	case nil:
		return nil
	default:
		return []string{stringValue(v)}
	}
}

func mapValue(value any) map[string]any {
	if m, ok := value.(map[string]any); ok {
		out := make(map[string]any, len(m))
		for key, item := range m {
			out[key] = item
		}
		return out
	}
	return map[string]any{}
}

func stringOrNil(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func normalizeUserStatus(value string, fallback string) string {
	switch value {
	case "STAGED", "PROVISIONED", "ACTIVE", "SUSPENDED", "DEPROVISIONED":
		return value
	default:
		return fallback
	}
}

func normalizeGroupType(value string, fallback string) string {
	switch value {
	case "OKTA_GROUP", "BUILT_IN":
		return value
	default:
		return fallback
	}
}

func normalizeActiveStatus(value string, fallback string) string {
	switch value {
	case "ACTIVE", "INACTIVE":
		return value
	default:
		return fallback
	}
}

func userDisplayName(user corestore.Record) string {
	if displayName := stringField(user, "display_name"); displayName != "" {
		return displayName
	}
	name := strings.TrimSpace(stringField(user, "first_name") + " " + stringField(user, "last_name"))
	if name != "" {
		return name
	}
	return stringField(user, "login")
}

func resolveIssuer(baseURL string, authServerID string) string {
	if authServerID == orgAuthServerID {
		return baseURL
	}
	return baseURL + "/oauth2/" + authServerID
}

func oauthBasePath(authServerID string) string {
	if authServerID == orgAuthServerID {
		return "/oauth2/v1"
	}
	return "/oauth2/" + url.PathEscape(authServerID) + "/v1"
}

func matchesRedirectURI(input string, allowed []string) bool {
	for _, candidate := range allowed {
		if input == candidate {
			return true
		}
	}
	return false
}

func parseScope(scope string) []string {
	fields := strings.Fields(scope)
	if len(fields) == 0 {
		return nil
	}
	return fields
}

func scopeHas(scope string, wanted string) bool {
	for _, item := range parseScope(scope) {
		if item == wanted {
			return true
		}
	}
	return false
}

func verifyPKCE(challenge string, method string, verifier string) bool {
	if challenge == "" {
		return true
	}
	if verifier == "" {
		return false
	}
	if strings.EqualFold(method, "S256") {
		digest := sha256.Sum256([]byte(verifier))
		return base64.RawURLEncoding.EncodeToString(digest[:]) == challenge
	}
	return verifier == challenge
}

func constantTimeEqual(left string, right string) bool {
	if len(left) != len(right) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(left), []byte(right)) == 1
}

func applyBasicCredentials(r *http.Request, clientID *string, clientSecret *string) {
	header := r.Header.Get("Authorization")
	if !strings.HasPrefix(header, "Basic ") {
		return
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(strings.TrimPrefix(header, "Basic ")))
	if err != nil {
		return
	}
	parts := strings.SplitN(string(raw), ":", 2)
	if len(parts) != 2 {
		return
	}
	if *clientID == "" {
		*clientID, _ = url.QueryUnescape(parts[0])
	}
	if *clientSecret == "" {
		*clientSecret, _ = url.QueryUnescape(parts[1])
	}
}

func tokenFromRequest(r *http.Request) string {
	header := r.Header.Get("Authorization")
	if strings.HasPrefix(strings.ToLower(header), "bearer ") {
		return strings.TrimSpace(header[len("Bearer "):])
	}
	return ""
}

func sswsTokenFromRequest(r *http.Request) string {
	header := r.Header.Get("Authorization")
	if strings.HasPrefix(strings.ToLower(header), "ssws ") {
		return strings.TrimSpace(header[len("SSWS "):])
	}
	return ""
}

func sortRecordsNewestFirst(records []corestore.Record) []corestore.Record {
	out := append([]corestore.Record(nil), records...)
	sort.SliceStable(out, func(i int, j int) bool {
		return intField(out[i], "id") > intField(out[j], "id")
	})
	return out
}

func paginate(c *corehttp.Context, records []corestore.Record, format func(corestore.Record) map[string]any) {
	page := intValue(c.Query("page"))
	if page < 1 {
		page = 1
	}
	perPage := intValue(c.Query("per_page"))
	if perPage < 1 {
		perPage = 200
	}
	if perPage > 200 {
		perPage = 200
	}
	total := len(records)
	start := (page - 1) * perPage
	if start > total {
		start = total
	}
	end := start + perPage
	if end > total {
		end = total
	}
	if end < total {
		next := *c.Request.URL
		query := next.Query()
		query.Set("page", strconv.Itoa(page+1))
		query.Set("per_page", strconv.Itoa(perPage))
		next.RawQuery = query.Encode()
		c.Writer.Header().Set("Link", "<"+next.String()+">; rel=\"next\"")
	}
	c.Writer.Header().Set("X-Total-Count", strconv.Itoa(total))
	data := make([]map[string]any, 0, end-start)
	for _, record := range records[start:end] {
		data = append(data, format(record))
	}
	c.JSON(http.StatusOK, data)
}

func authServerIDFromParam(value string) string {
	if value == "" {
		return orgAuthServerID
	}
	return value
}
