package auth

import (
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

const AlgorithmSigV4 = "AWS4-HMAC-SHA256"

type Scope struct {
	Date     string
	Region   string
	Service  string
	Terminal string
}

type Signature struct {
	Present        bool
	Algorithm      string
	AccessKeyID    string
	Scope          Scope
	SignedHeaders  []string
	SignatureValue string
	SessionToken   string
	Presigned      bool
	RawCredential  string
}

func ParseSigV4(req *http.Request) (Signature, error) {
	if hasPresignParameters(req) {
		return parsePresignedSigV4(req)
	}
	return parseAuthorizationHeader(req)
}

func ParseCredentialScope(value string) (string, Scope, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", Scope{}, fmt.Errorf("missing SigV4 credential")
	}
	unescaped, err := url.QueryUnescape(value)
	if err == nil {
		value = unescaped
	}
	parts := strings.Split(value, "/")
	if parts[0] == "" {
		return "", Scope{}, fmt.Errorf("missing SigV4 access key id")
	}
	if len(parts) == 1 {
		return parts[0], Scope{}, nil
	}
	if len(parts) < 5 {
		return "", Scope{}, fmt.Errorf("invalid SigV4 credential scope")
	}
	return parts[0], Scope{
		Date:     parts[1],
		Region:   parts[2],
		Service:  parts[3],
		Terminal: parts[4],
	}, nil
}

func hasPresignParameters(req *http.Request) bool {
	query := req.URL.Query()
	return query.Get("X-Amz-Algorithm") != "" ||
		query.Get("X-Amz-Credential") != "" ||
		query.Get("X-Amz-Signature") != ""
}

func parsePresignedSigV4(req *http.Request) (Signature, error) {
	query := req.URL.Query()
	algorithm := strings.TrimSpace(query.Get("X-Amz-Algorithm"))
	if algorithm == "" {
		algorithm = AlgorithmSigV4
	}
	if algorithm != AlgorithmSigV4 {
		return Signature{}, fmt.Errorf("unsupported SigV4 algorithm %q", algorithm)
	}
	rawCredential := query.Get("X-Amz-Credential")
	accessKeyID, scope, err := ParseCredentialScope(rawCredential)
	if err != nil {
		return Signature{}, err
	}
	return Signature{
		Present:        true,
		Algorithm:      algorithm,
		AccessKeyID:    accessKeyID,
		Scope:          scope,
		SignedHeaders:  splitSignedHeaders(query.Get("X-Amz-SignedHeaders")),
		SignatureValue: query.Get("X-Amz-Signature"),
		SessionToken:   query.Get("X-Amz-Security-Token"),
		Presigned:      true,
		RawCredential:  rawCredential,
	}, nil
}

func parseAuthorizationHeader(req *http.Request) (Signature, error) {
	header := strings.TrimSpace(req.Header.Get("Authorization"))
	if header == "" {
		return Signature{}, nil
	}
	fields := strings.Fields(header)
	if len(fields) == 0 {
		return Signature{}, nil
	}
	algorithm := fields[0]
	if algorithm != AlgorithmSigV4 {
		return Signature{}, fmt.Errorf("unsupported SigV4 algorithm %q", algorithm)
	}
	params := parseAuthorizationParams(strings.TrimSpace(strings.TrimPrefix(header, algorithm)))
	rawCredential := params["Credential"]
	accessKeyID, scope, err := ParseCredentialScope(rawCredential)
	if err != nil {
		return Signature{}, err
	}
	return Signature{
		Present:        true,
		Algorithm:      algorithm,
		AccessKeyID:    accessKeyID,
		Scope:          scope,
		SignedHeaders:  splitSignedHeaders(params["SignedHeaders"]),
		SignatureValue: params["Signature"],
		SessionToken:   req.Header.Get("X-Amz-Security-Token"),
		RawCredential:  rawCredential,
	}, nil
}

func parseAuthorizationParams(value string) map[string]string {
	params := map[string]string{}
	for _, part := range strings.Split(value, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		key, value, ok := strings.Cut(part, "=")
		if !ok {
			continue
		}
		params[strings.TrimSpace(key)] = strings.TrimSpace(value)
	}
	return params
}

func splitSignedHeaders(value string) []string {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	parts := strings.Split(value, ";")
	headers := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(strings.ToLower(part))
		if part != "" {
			headers = append(headers, part)
		}
	}
	return headers
}
