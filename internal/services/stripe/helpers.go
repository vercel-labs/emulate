package stripe

import (
	"crypto/rand"
	"encoding/base64"
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

var numericBodyKeys = map[string]bool{
	"amount":                 true,
	"amount_subtotal":        true,
	"amount_total":           true,
	"application_fee_amount": true,
	"quantity":               true,
	"transfer_amount":        true,
	"unit_amount":            true,
}

func stripeID(prefix string) string {
	raw := make([]byte, 12)
	if _, err := rand.Read(raw); err != nil {
		return prefix + "_" + strconv.FormatInt(time.Now().UnixNano(), 36)
	}
	return prefix + "_" + base64.RawURLEncoding.EncodeToString(raw)
}

func parseStripeBody(r *http.Request) map[string]any {
	raw, _ := io.ReadAll(r.Body)
	if len(raw) == 0 {
		return map[string]any{}
	}
	if strings.Contains(r.Header.Get("Content-Type"), "application/json") {
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
	out := map[string]any{}
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		list := values[key]
		if len(list) == 0 {
			continue
		}
		setStripeBodyValue(out, key, coerceStripeValue(lastBracketPart(key), list[len(list)-1]))
	}
	return out
}

func setStripeBodyValue(out map[string]any, key string, value any) {
	if !strings.Contains(key, "[") {
		out[key] = value
		return
	}
	parts := bracketParts(key)
	if len(parts) == 0 {
		return
	}
	if len(parts) >= 3 && parts[0] == "line_items" {
		index, err := strconv.Atoi(parts[1])
		if err != nil || index < 0 {
			return
		}
		items, _ := out["line_items"].([]any)
		for len(items) <= index {
			items = append(items, map[string]any{})
		}
		item, _ := items[index].(map[string]any)
		item[parts[2]] = value
		items[index] = item
		out["line_items"] = items
		return
	}
	target := out
	for index, part := range parts {
		if part == "" {
			continue
		}
		if index == len(parts)-1 {
			target[part] = value
			return
		}
		next, _ := target[part].(map[string]any)
		if next == nil {
			next = map[string]any{}
			target[part] = next
		}
		target = next
	}
}

func bracketParts(key string) []string {
	cleaned := strings.ReplaceAll(key, "]", "")
	return strings.Split(cleaned, "[")
}

func lastBracketPart(key string) string {
	parts := bracketParts(key)
	if len(parts) == 0 {
		return key
	}
	return parts[len(parts)-1]
}

func coerceStripeValue(key string, value string) any {
	if numericBodyKeys[key] {
		if number, err := strconv.Atoi(value); err == nil {
			return number
		}
	}
	if value == "true" {
		return true
	}
	if value == "false" {
		return false
	}
	return value
}

func stripeError(c *corehttp.Context, status int, errorType string, message string, code string, param string) {
	body := map[string]any{
		"type":    errorType,
		"message": message,
	}
	if code != "" {
		body["code"] = code
	}
	if param != "" {
		body["param"] = param
	}
	c.JSON(status, map[string]any{"error": body})
}

func stripeList(c *corehttp.Context, records []corestore.Record, urlPath string, format func(corestore.Record) map[string]any) {
	limit := normalizeLimit(c.Query("limit"), 10, 100)
	createdGTE := int64Value(c.Query("created[gte]"))
	createdLTE := int64Value(c.Query("created[lte]"))
	filtered := make([]corestore.Record, 0, len(records))
	for _, record := range records {
		created := createdUnix(stringField(record, "created_at"))
		if createdGTE > 0 && created < createdGTE {
			continue
		}
		if createdLTE > 0 && created > createdLTE {
			continue
		}
		filtered = append(filtered, record)
	}
	sort.SliceStable(filtered, func(i int, j int) bool {
		return intField(filtered[i], "id") > intField(filtered[j], "id")
	})
	if startingAfter := c.Query("starting_after"); startingAfter != "" {
		if index := indexByStripeID(filtered, startingAfter); index >= 0 {
			filtered = filtered[index+1:]
		}
	} else if endingBefore := c.Query("ending_before"); endingBefore != "" {
		if index := indexByStripeID(filtered, endingBefore); index >= 0 {
			filtered = filtered[:index]
			if len(filtered) > limit {
				filtered = filtered[len(filtered)-limit:]
			}
		}
	}
	pageEnd := limit
	if pageEnd > len(filtered) {
		pageEnd = len(filtered)
	}
	page := filtered[:pageEnd]
	data := make([]map[string]any, 0, len(page))
	for _, record := range page {
		data = append(data, format(record))
	}
	c.JSON(http.StatusOK, map[string]any{
		"object":   "list",
		"url":      urlPath,
		"has_more": len(filtered) > limit,
		"data":     data,
	})
}

func indexByStripeID(records []corestore.Record, id string) int {
	for index, record := range records {
		if stringField(record, "stripe_id") == id {
			return index
		}
	}
	return -1
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

func int64Value(value string) int64 {
	number, _ := strconv.ParseInt(value, 10, 64)
	return number
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

func intValue(value any) int {
	switch v := value.(type) {
	case int:
		return v
	case int64:
		return int(v)
	case float64:
		return int(v)
	case json.Number:
		n, _ := v.Int64()
		return int(n)
	case string:
		n, _ := strconv.Atoi(v)
		return n
	default:
		n, _ := strconv.Atoi(fmt.Sprint(v))
		return n
	}
}

func boolField(record corestore.Record, field string) bool {
	if record == nil {
		return false
	}
	return boolValue(record[field])
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

func nullableString(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func stringOrNil(value any) any {
	text := stringValue(value)
	if text == "" {
		return nil
	}
	return text
}

func metadataValue(value any) map[string]any {
	switch v := value.(type) {
	case map[string]any:
		return cloneMap(v)
	case map[string]string:
		out := make(map[string]any, len(v))
		for key, item := range v {
			out[key] = item
		}
		return out
	default:
		return map[string]any{}
	}
}

func mapValue(value any) map[string]any {
	if m, ok := value.(map[string]any); ok {
		return cloneMap(m)
	}
	return map[string]any{}
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

func cloneMap(in map[string]any) map[string]any {
	out := make(map[string]any, len(in))
	for key, value := range in {
		out[key] = value
	}
	return out
}

func createdUnix(value string) int64 {
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return time.Now().Unix()
	}
	return parsed.Unix()
}

func expandRequested(c *corehttp.Context, field string) bool {
	for key, values := range c.Request.URL.Query() {
		if !isExpandQueryKey(key) {
			continue
		}
		for _, value := range values {
			if value == field {
				return true
			}
		}
	}
	return false
}

func isExpandQueryKey(key string) bool {
	if key == "expand[]" {
		return true
	}
	if !strings.HasPrefix(key, "expand[") || !strings.HasSuffix(key, "]") {
		return false
	}
	index := strings.TrimSuffix(strings.TrimPrefix(key, "expand["), "]")
	if index == "" {
		return false
	}
	_, err := strconv.Atoi(index)
	return err == nil
}
