package microsoft

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	corestore "github.com/vercel-labs/emulate/internal/core/store"
)

const defaultTenantID = "9188040d-6c67-4c5b-b112-36a304b66dad"

func generateOID() string {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		panic(err)
	}
	raw[6] = (raw[6] & 0x0f) | 0x40
	raw[8] = (raw[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", raw[0:4], raw[4:6], raw[6:8], raw[8:10], raw[10:16])
}

func generateHex(size int) string {
	raw := make([]byte, size)
	if _, err := rand.Read(raw); err != nil {
		panic(err)
	}
	return hex.EncodeToString(raw)
}

func generateToken(prefix string) string {
	raw := make([]byte, 20)
	if _, err := rand.Read(raw); err != nil {
		panic(err)
	}
	return prefix + base64.RawURLEncoding.EncodeToString(raw)
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

func matchesRedirectURI(candidate string, allowed []string) bool {
	if candidate == "" {
		return true
	}
	candidateURL, err := url.Parse(candidate)
	if err != nil {
		return false
	}
	for _, registered := range allowed {
		registeredURL, err := url.Parse(registered)
		if err != nil {
			continue
		}
		if candidateURL.Scheme == registeredURL.Scheme &&
			candidateURL.Host == registeredURL.Host &&
			strings.TrimRight(candidateURL.Path, "/") == strings.TrimRight(registeredURL.Path, "/") {
			return true
		}
	}
	return false
}

func verifyPKCEChallenge(challenge string, method string, verifier string) bool {
	if challenge == "" {
		return true
	}
	if verifier == "" {
		return false
	}
	switch strings.ToLower(method) {
	case "", "plain":
		return subtle.ConstantTimeCompare([]byte(verifier), []byte(challenge)) == 1
	case "s256":
		digest := sha256.Sum256([]byte(verifier))
		return base64.RawURLEncoding.EncodeToString(digest[:]) == challenge
	default:
		return false
	}
}

func constantTimeSecretEqual(candidate string, expected string) bool {
	if candidate == "" || expected == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(candidate), []byte(expected)) == 1
}

func bearerToken(req *http.Request) string {
	header := strings.TrimSpace(req.Header.Get("Authorization"))
	if header == "" {
		return ""
	}
	const prefix = "Bearer "
	if !strings.HasPrefix(header, prefix) {
		return ""
	}
	return strings.TrimSpace(strings.TrimPrefix(header, prefix))
}

func splitScopes(scope string) []string {
	fields := strings.Fields(scope)
	if len(fields) == 0 {
		return []string{}
	}
	return fields
}

func normalizeTenant(tenant string) string {
	switch tenant {
	case "", "common", "organizations", "consumers":
		return defaultTenantID
	default:
		return tenant
	}
}
