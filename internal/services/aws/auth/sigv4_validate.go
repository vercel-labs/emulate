package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/url"
	"sort"
	"strings"
)

func ValidateSigV4(req *http.Request, rawBody []byte, credential Credential) bool {
	signature, err := ParseSigV4(req)
	if err != nil || !signature.Present || credential.SecretAccessKey == "" {
		return false
	}
	if signature.AccessKeyID != credential.AccessKeyID {
		return false
	}
	if credential.SessionToken != "" && signature.SessionToken != credential.SessionToken {
		return false
	}
	expected, ok := sigV4Signature(req, rawBody, signature, credential.SecretAccessKey)
	if !ok {
		return false
	}
	return hmac.Equal([]byte(strings.ToLower(signature.SignatureValue)), []byte(expected))
}

func sigV4Signature(req *http.Request, rawBody []byte, signature Signature, secretAccessKey string) (string, bool) {
	requestDate := sigV4RequestDate(req, signature)
	if requestDate == "" {
		return "", false
	}
	canonicalHeaders, signedHeaders, ok := sigV4CanonicalHeaders(req, signature.SignedHeaders)
	if !ok {
		return "", false
	}
	canonicalRequest := strings.Join([]string{
		req.Method,
		sigV4CanonicalURI(req.URL),
		sigV4CanonicalQuery(req.URL.Query(), signature.Presigned),
		canonicalHeaders,
		signedHeaders,
		sigV4PayloadHash(req, rawBody, signature.Presigned),
	}, "\n")
	canonicalHash := sha256.Sum256([]byte(canonicalRequest))
	scope := strings.Join([]string{signature.Scope.Date, signature.Scope.Region, signature.Scope.Service, signature.Scope.Terminal}, "/")
	stringToSign := strings.Join([]string{AlgorithmSigV4, requestDate, scope, hex.EncodeToString(canonicalHash[:])}, "\n")
	signingKey := sigV4SigningKey(secretAccessKey, signature.Scope.Date, signature.Scope.Region, signature.Scope.Service)
	return hex.EncodeToString(sigV4HMAC(signingKey, []byte(stringToSign))), true
}

func sigV4RequestDate(req *http.Request, signature Signature) string {
	if signature.Presigned {
		return req.URL.Query().Get("X-Amz-Date")
	}
	return req.Header.Get("X-Amz-Date")
}

func sigV4CanonicalURI(urlValue *url.URL) string {
	if urlValue == nil {
		return "/"
	}
	path := urlValue.EscapedPath()
	if path == "" {
		return "/"
	}
	return path
}

func sigV4CanonicalQuery(values url.Values, presigned bool) string {
	pairs := make([]string, 0)
	for key, items := range values {
		if presigned && strings.EqualFold(key, "X-Amz-Signature") {
			continue
		}
		sortedItems := append([]string(nil), items...)
		sort.Strings(sortedItems)
		for _, value := range sortedItems {
			pairs = append(pairs, sigV4Escape(key)+"="+sigV4Escape(value))
		}
	}
	sort.Strings(pairs)
	return strings.Join(pairs, "&")
}

func sigV4CanonicalHeaders(req *http.Request, signed []string) (string, string, bool) {
	if len(signed) == 0 {
		return "", "", false
	}
	headers := append([]string(nil), signed...)
	sort.Strings(headers)
	var out strings.Builder
	for _, header := range headers {
		header = strings.ToLower(strings.TrimSpace(header))
		if header == "" {
			return "", "", false
		}
		values := req.Header.Values(header)
		if header == "host" {
			host := strings.TrimSpace(req.Host)
			if host == "" {
				return "", "", false
			}
			values = []string{host}
		}
		if values == nil {
			return "", "", false
		}
		out.WriteString(header)
		out.WriteByte(':')
		out.WriteString(sigV4CanonicalHeaderValue(values))
		out.WriteByte('\n')
	}
	return out.String(), strings.Join(headers, ";"), true
}

func sigV4CanonicalHeaderValue(values []string) string {
	out := make([]string, 0, len(values))
	for _, value := range values {
		out = append(out, strings.Join(strings.Fields(value), " "))
	}
	return strings.Join(out, ",")
}

func sigV4PayloadHash(req *http.Request, rawBody []byte, presigned bool) string {
	if presigned {
		if value := req.URL.Query().Get("X-Amz-Content-Sha256"); value != "" {
			return value
		}
		return "UNSIGNED-PAYLOAD"
	}
	if value := req.Header.Get("X-Amz-Content-Sha256"); value != "" {
		return value
	}
	sum := sha256.Sum256(rawBody)
	return hex.EncodeToString(sum[:])
}

func sigV4SigningKey(secretAccessKey string, date string, region string, service string) []byte {
	dateKey := sigV4HMAC([]byte("AWS4"+secretAccessKey), []byte(date))
	regionKey := sigV4HMAC(dateKey, []byte(region))
	serviceKey := sigV4HMAC(regionKey, []byte(service))
	return sigV4HMAC(serviceKey, []byte("aws4_request"))
}

func sigV4HMAC(key []byte, data []byte) []byte {
	hash := hmac.New(sha256.New, key)
	hash.Write(data)
	return hash.Sum(nil)
}

func sigV4Escape(value string) string {
	escaped := url.QueryEscape(value)
	escaped = strings.ReplaceAll(escaped, "+", "%20")
	escaped = strings.ReplaceAll(escaped, "%7E", "~")
	return escaped
}
