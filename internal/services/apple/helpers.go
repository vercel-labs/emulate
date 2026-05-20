package apple

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/url"
	"strings"

	corestore "github.com/vercel-labs/emulate/internal/core/store"
)

func generateAppleUID() string {
	prefix := strings.ToUpper(generateHex(3))
	middle := generateHex(16)
	suffix := strings.ToUpper(generateHex(2))
	return prefix + "." + middle + "." + suffix
}

func generatePrivateRelayEmail() string {
	return generateHex(12) + "@privaterelay.appleid.com"
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

func boolField(record corestore.Record, key string) bool {
	if record == nil {
		return false
	}
	value, _ := record[key].(bool)
	return value
}

func nullableString(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func appleEmailForUser(user corestore.Record) string {
	email := stringField(user, "email")
	if boolField(user, "is_private_email") && stringField(user, "private_relay_email") != "" {
		return stringField(user, "private_relay_email")
	}
	return email
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
		return verifier == challenge
	case "s256":
		digest := sha256.Sum256([]byte(verifier))
		return base64.RawURLEncoding.EncodeToString(digest[:]) == challenge
	default:
		return false
	}
}
