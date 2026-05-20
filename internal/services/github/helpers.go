package github

import (
	"crypto/rand"
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

const docsURL = "https://emulate.dev/github"

type authUser struct {
	Login  string
	ID     int
	Scopes []string
}

type pagination struct {
	Page    int
	PerPage int
}

func generateNodeID(kind string, id int) string {
	return base64.RawStdEncoding.EncodeToString([]byte(fmt.Sprintf("0:%s%d", kind, id)))
}

func generateHex(size int) string {
	raw := make([]byte, size)
	if _, err := rand.Read(raw); err != nil {
		panic(err)
	}
	return hex.EncodeToString(raw)
}

func generateSha() string {
	return generateHex(20)
}

func nowISO() string {
	return time.Now().UTC().Format(time.RFC3339Nano)
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

func nullableIntField(record corestore.Record, key string) *int {
	value := intField(record, key)
	if value == 0 && record[key] == nil {
		return nil
	}
	return &value
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

func boolPtr(value bool) *bool {
	return &value
}

func boolOption(value *bool, fallback bool) bool {
	if value == nil {
		return fallback
	}
	return *value
}

func nullableString(value string) any {
	if value == "" {
		return nil
	}
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

func stringSliceOrEmpty(value any) []string {
	out := stringSliceValue(value)
	if out == nil {
		return []string{}
	}
	return out
}

func intSliceValue(value any) []int {
	switch v := value.(type) {
	case []int:
		out := make([]int, len(v))
		copy(out, v)
		return out
	case []any:
		out := make([]int, 0, len(v))
		for _, item := range v {
			switch n := item.(type) {
			case int:
				out = append(out, n)
			case float64:
				out = append(out, int(n))
			case json.Number:
				parsed, _ := n.Int64()
				out = append(out, int(parsed))
			}
		}
		return out
	default:
		return nil
	}
}

func mapStringIntValue(value any) map[string]int {
	out := map[string]int{}
	switch v := value.(type) {
	case map[string]int:
		for key, item := range v {
			out[key] = item
		}
	case map[string]any:
		for key, item := range v {
			switch n := item.(type) {
			case int:
				out[key] = n
			case float64:
				out[key] = int(n)
			case json.Number:
				parsed, _ := n.Int64()
				out[key] = int(parsed)
			}
		}
	}
	return out
}

func mapStringStringValue(value any) map[string]string {
	out := map[string]string{}
	switch v := value.(type) {
	case map[string]string:
		for key, item := range v {
			out[key] = item
		}
	case map[string]any:
		for key, item := range v {
			if s, ok := item.(string); ok {
				out[key] = s
			}
		}
	}
	return out
}

func parseJSONBody(req *http.Request) (map[string]any, error) {
	defer req.Body.Close()
	raw, err := io.ReadAll(req.Body)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(string(raw)) == "" {
		return map[string]any{}, nil
	}
	var body map[string]any
	if err := json.Unmarshal(raw, &body); err != nil {
		return nil, err
	}
	if body == nil {
		body = map[string]any{}
	}
	return body, nil
}

func parseOAuthBody(req *http.Request) (map[string]any, error) {
	defer req.Body.Close()
	raw, err := io.ReadAll(req.Body)
	if err != nil {
		return nil, err
	}
	if strings.Contains(req.Header.Get("Content-Type"), "application/json") {
		if strings.TrimSpace(string(raw)) == "" {
			return map[string]any{}, nil
		}
		var body map[string]any
		if err := json.Unmarshal(raw, &body); err != nil {
			return map[string]any{}, nil
		}
		return body, nil
	}
	values, err := url.ParseQuery(string(raw))
	if err != nil {
		return nil, err
	}
	body := make(map[string]any, len(values))
	for key := range values {
		body[key] = values.Get(key)
	}
	return body, nil
}

func writeGitHubError(c *corehttp.Context, status int, message string) {
	c.JSON(status, map[string]any{
		"message":           message,
		"documentation_url": docsURL,
	})
}

func writeNotFound(c *corehttp.Context) {
	writeGitHubError(c, http.StatusNotFound, "Not Found")
}

func writeUnauthorized(c *corehttp.Context) {
	writeGitHubError(c, http.StatusUnauthorized, "Requires authentication")
}

func writeForbidden(c *corehttp.Context) {
	writeGitHubError(c, http.StatusForbidden, "Forbidden")
}

func writeValidation(c *corehttp.Context, message string) {
	if message == "" {
		message = "Validation Failed"
	}
	writeGitHubError(c, http.StatusUnprocessableEntity, message)
}

func parsePagination(c *corehttp.Context) pagination {
	page, err := strconv.Atoi(c.Query("page"))
	if err != nil || page < 1 {
		page = 1
	}
	perPage, err := strconv.Atoi(c.Query("per_page"))
	if err != nil || perPage < 1 {
		perPage = 30
	}
	if perPage > 100 {
		perPage = 100
	}
	return pagination{Page: page, PerPage: perPage}
}

func paginateRecords(c *corehttp.Context, items []corestore.Record, p pagination) []corestore.Record {
	setLinkHeader(c, len(items), p)
	start := (p.Page - 1) * p.PerPage
	if start >= len(items) {
		return nil
	}
	end := start + p.PerPage
	if end > len(items) {
		end = len(items)
	}
	return items[start:end]
}

func setLinkHeader(c *corehttp.Context, total int, p pagination) {
	if p.PerPage <= 0 || total <= p.PerPage {
		return
	}
	last := (total + p.PerPage - 1) / p.PerPage
	links := make([]string, 0, 4)
	if p.Page < last {
		links = append(links, linkForPage(c, p.Page+1, `next`))
		links = append(links, linkForPage(c, last, `last`))
	}
	if p.Page > 1 {
		links = append(links, linkForPage(c, 1, `first`))
		links = append(links, linkForPage(c, p.Page-1, `prev`))
	}
	if len(links) > 0 {
		c.Writer.Header().Set("Link", strings.Join(links, ", "))
	}
}

func linkForPage(c *corehttp.Context, page int, rel string) string {
	nextURL := *c.Request.URL
	query := nextURL.Query()
	query.Set("page", strconv.Itoa(page))
	query.Set("per_page", strconv.Itoa(parsePagination(c).PerPage))
	nextURL.RawQuery = query.Encode()
	return fmt.Sprintf("<%s>; rel=\"%s\"", nextURL.String(), rel)
}

func sortRecordsByString(records []corestore.Record, key string, descending bool) {
	sort.SliceStable(records, func(i, j int) bool {
		left := stringField(records[i], key)
		right := stringField(records[j], key)
		if descending {
			return left > right
		}
		return left < right
	})
}

func sortRecordsByInt(records []corestore.Record, key string) {
	sort.SliceStable(records, func(i, j int) bool {
		return intField(records[i], key) < intField(records[j], key)
	})
}

func tokenFromRequest(req *http.Request) string {
	header := strings.TrimSpace(req.Header.Get("Authorization"))
	if header == "" {
		return ""
	}
	lower := strings.ToLower(header)
	for _, prefix := range []string{"bearer ", "token "} {
		if strings.HasPrefix(lower, prefix) {
			return strings.TrimSpace(header[len(prefix):])
		}
	}
	return ""
}

func uniqueInts(values []int) []int {
	out := make([]int, 0, len(values))
	seen := map[int]bool{}
	for _, value := range values {
		if seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	return out
}

func containsInt(values []int, target int) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func jsonStringMap(value map[string]int) map[string]any {
	out := make(map[string]any, len(value))
	for key, item := range value {
		out[key] = item
	}
	return out
}
