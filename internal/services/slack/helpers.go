package slack

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	corehttp "github.com/vercel-labs/emulate/internal/core/http"
	corestore "github.com/vercel-labs/emulate/internal/core/store"
)

var timestampState = struct {
	sync.Mutex
	second  int64
	counter int
}{}

func generateSlackID(prefix string) string {
	raw := make([]byte, 5)
	if _, err := rand.Read(raw); err != nil {
		return prefix + strconv.FormatInt(time.Now().UnixNano(), 36)
	}
	return prefix + strings.ToUpper(hex.EncodeToString(raw))[:9]
}

func generateSlackToken() string {
	raw := make([]byte, 20)
	if _, err := rand.Read(raw); err != nil {
		return "xoxb-" + strconv.FormatInt(time.Now().UnixNano(), 36)
	}
	return "xoxb-" + base64.RawURLEncoding.EncodeToString(raw)
}

func generateSlackCode() string {
	raw := make([]byte, 20)
	if _, err := rand.Read(raw); err != nil {
		return strconv.FormatInt(time.Now().UnixNano(), 36)
	}
	return hex.EncodeToString(raw)
}

func generateSlackTS() string {
	now := time.Now().Unix()
	timestampState.Lock()
	defer timestampState.Unlock()
	if now != timestampState.second {
		timestampState.second = now
		timestampState.counter = 0
	}
	timestampState.counter++
	return fmt.Sprintf("%d.%06d", now, timestampState.counter)
}

func slackOK(c *corehttp.Context, data map[string]any) {
	out := map[string]any{"ok": true}
	for key, value := range data {
		out[key] = value
	}
	c.JSON(http.StatusOK, out)
}

func slackError(c *corehttp.Context, errorName string) {
	c.JSON(http.StatusOK, map[string]any{"ok": false, "error": errorName})
}

func parseSlackBody(r *http.Request) map[string]any {
	if r.Method == http.MethodGet {
		return valuesToMap(r.URL.Query())
	}
	contentType := r.Header.Get("Content-Type")
	raw, _ := io.ReadAll(r.Body)
	if strings.Contains(contentType, "application/json") {
		var body map[string]any
		if err := json.Unmarshal(raw, &body); err == nil && body != nil {
			return body
		}
		return map[string]any{}
	}
	values, err := url.ParseQuery(string(raw))
	if err != nil {
		return map[string]any{}
	}
	return valuesToMap(values)
}

func valuesToMap(values url.Values) map[string]any {
	out := map[string]any{}
	for key, value := range values {
		if len(value) > 0 {
			out[key] = value[len(value)-1]
		}
	}
	return out
}

func (s *Service) authenticatedUser(c *corehttp.Context) (corestore.Record, bool) {
	token := bearerToken(c.Header("Authorization"))
	if token == "" {
		slackError(c, "not_authed")
		return nil, false
	}
	tokenRecord := firstRecord(s.store.Tokens.FindBy("token", token))
	if tokenRecord == nil {
		slackError(c, "not_authed")
		return nil, false
	}
	user := s.findUser(stringField(tokenRecord, "login"))
	if user == nil {
		slackError(c, "invalid_auth")
		return nil, false
	}
	return user, true
}

func bearerToken(value string) string {
	value = strings.TrimSpace(value)
	for _, prefix := range []string{"Bearer ", "bearer ", "token ", "Token "} {
		if strings.HasPrefix(value, prefix) {
			return strings.TrimSpace(strings.TrimPrefix(value, prefix))
		}
	}
	return value
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
	switch value := record[field].(type) {
	case int:
		return value
	case int64:
		return int(value)
	case float64:
		return int(value)
	case json.Number:
		n, _ := value.Int64()
		return int(n)
	default:
		n, _ := strconv.Atoi(fmt.Sprint(value))
		return n
	}
}

func boolField(record corestore.Record, field string) bool {
	if record == nil {
		return false
	}
	switch value := record[field].(type) {
	case bool:
		return value
	case string:
		return value == "true"
	default:
		return false
	}
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

func boolValue(value any) bool {
	switch v := value.(type) {
	case bool:
		return v
	case string:
		return v == "true"
	default:
		return false
	}
}

func stringSliceValue(value any) []string {
	switch v := value.(type) {
	case []string:
		return append([]string(nil), v...)
	case []any:
		out := make([]string, 0, len(v))
		for _, item := range v {
			out = append(out, stringValue(item))
		}
		return out
	default:
		return nil
	}
}

func recordSliceValue(value any) []map[string]any {
	switch v := value.(type) {
	case []map[string]any:
		out := make([]map[string]any, 0, len(v))
		for _, item := range v {
			out = append(out, cloneMap(item))
		}
		return out
	case []any:
		out := make([]map[string]any, 0, len(v))
		for _, item := range v {
			if m, ok := item.(map[string]any); ok {
				out = append(out, cloneMap(m))
			}
		}
		return out
	default:
		return nil
	}
}

func mapValue(value any) map[string]any {
	if m, ok := value.(map[string]any); ok {
		return cloneMap(m)
	}
	return map[string]any{}
}

func cloneMap(in map[string]any) map[string]any {
	out := make(map[string]any, len(in))
	for key, value := range in {
		out[key] = value
	}
	return out
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func removeString(values []string, target string) []string {
	out := make([]string, 0, len(values))
	for _, value := range values {
		if value != target {
			out = append(out, value)
		}
	}
	return out
}

func constantTimeEqual(a string, b string) bool {
	if len(a) != len(b) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

func matchesRedirectURI(value string, allowed []string) bool {
	if value == "" {
		return true
	}
	valueURL, err := url.Parse(value)
	if err != nil {
		return false
	}
	for _, candidate := range allowed {
		candidateURL, err := url.Parse(candidate)
		if err != nil {
			continue
		}
		if valueURL.Scheme == candidateURL.Scheme &&
			valueURL.Host == candidateURL.Host &&
			strings.TrimRight(valueURL.Path, "/") == strings.TrimRight(candidateURL.Path, "/") {
			return true
		}
	}
	return false
}

func createdUnix(value string) int64 {
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return time.Now().Unix()
	}
	return parsed.Unix()
}
