package aws

import (
	"net/http"
	"strings"

	corehttp "github.com/vercel-labs/emulate/internal/core/http"
	corestore "github.com/vercel-labs/emulate/internal/core/store"
	"github.com/vercel-labs/emulate/internal/services/aws/auth"
	"github.com/vercel-labs/emulate/internal/services/aws/gateway"
)

type Options struct {
	Store            *corestore.Store
	DefaultAccountID string
	DefaultRegion    string
	AuthMode         auth.Mode
	CredentialStore  *auth.Store
	S3PathFallback   bool
}

type Service struct {
	store            Store
	defaultAccountID string
	defaultRegion    string
	authMode         auth.Mode
	credentialStore  *auth.Store
	s3PathFallback   bool
}

func Register(router *corehttp.Router, options Options) {
	service := New(options)
	router.Get("/_inspector", service.handleInspector)
	router.Fallback(service.handleAWS)
}

func New(options Options) *Service {
	runtimeStore := options.Store
	if runtimeStore == nil {
		runtimeStore = corestore.New()
	}
	defaultAccountID := options.DefaultAccountID
	if defaultAccountID == "" {
		defaultAccountID = gateway.DefaultAccountID
	}
	defaultRegion := options.DefaultRegion
	if defaultRegion == "" {
		defaultRegion = gateway.DefaultRegion
	}
	return &Service{
		store:            NewStore(runtimeStore),
		defaultAccountID: defaultAccountID,
		defaultRegion:    defaultRegion,
		authMode:         options.AuthMode,
		credentialStore:  options.CredentialStore,
		s3PathFallback:   options.S3PathFallback,
	}
}

func (s *Service) handleAWS(c *corehttp.Context) {
	if !s.looksLikeAWSRequest(c.Request) {
		c.JSON(http.StatusNotFound, map[string]any{"message": "Not Found"})
		return
	}

	rawBody, err := readRequestBody(c.Request)
	if err != nil {
		c.JSON(http.StatusBadRequest, map[string]any{"message": "Failed to read request body"})
		return
	}

	ctx, err := gateway.BuildContext(c.Request, rawBody, gateway.Options{
		DefaultAccountID: s.defaultAccountID,
		DefaultRegion:    s.defaultRegion,
		AuthMode:         s.authMode,
		CredentialStore:  s.credentialStore,
	})
	if err != nil {
		s.writeParseError(c, err)
		return
	}
	if ctx.Auth.Error != nil {
		s.writeAWSError(c, ctx, awsAuthError(ctx))
		return
	}

	s.writeAWSError(c, ctx, notImplementedError(ctx))
}

func (s *Service) looksLikeAWSRequest(req *http.Request) bool {
	if req.URL.Query().Get("Action") != "" || req.URL.Query().Get("X-Amz-Algorithm") != "" {
		return true
	}
	if hasAWSHeader(req) {
		return true
	}
	if strings.HasPrefix(req.Header.Get("Authorization"), "AWS4-HMAC-SHA256") {
		return true
	}
	host := strings.ToLower(req.Host)
	if strings.Contains(host, "amazonaws.com") || hasKnownServiceLabel(host) {
		return true
	}
	if hasKnownServicePath(req.URL.Path) {
		return true
	}
	return looksLikeS3RESTRequest(req, s.s3PathFallback)
}

func hasAWSHeader(req *http.Request) bool {
	for key := range req.Header {
		if strings.HasPrefix(strings.ToLower(key), "x-amz-") {
			return true
		}
	}
	return false
}

func hasKnownServicePath(pathValue string) bool {
	first := firstPathSegment(pathValue)
	switch first {
	case "cloudformation", "dynamodb", "events", "iam", "kms", "lambda", "logs", "s3", "secretsmanager", "sns", "sqs", "ssm", "states", "sts":
		return true
	default:
		return false
	}
}

func looksLikeS3RESTRequest(req *http.Request, pathFallback bool) bool {
	first := firstPathSegment(req.URL.Path)
	if strings.HasPrefix(first, "_") {
		return false
	}
	if !pathFallback && !hasS3RequestHint(req) {
		return false
	}
	switch req.Method {
	case http.MethodGet, http.MethodHead, http.MethodPut, http.MethodPost, http.MethodDelete:
		return true
	default:
		return false
	}
}

func hasS3RequestHint(req *http.Request) bool {
	query := req.URL.Query()
	for _, key := range []string{
		"acl",
		"continuation-token",
		"delete",
		"delimiter",
		"list-type",
		"location",
		"max-keys",
		"partNumber",
		"policy",
		"prefix",
		"start-after",
		"tagging",
		"uploadId",
		"uploads",
		"versioning",
		"website",
	} {
		if _, ok := query[key]; ok {
			return true
		}
	}
	return false
}

func hasKnownServiceLabel(host string) bool {
	label := strings.Split(strings.TrimSuffix(host, "."), ".")[0]
	switch label {
	case "cloudformation", "dynamodb", "events", "iam", "kms", "lambda", "logs", "s3", "secretsmanager", "sns", "sqs", "ssm", "states", "sts":
		return true
	default:
		return false
	}
}

func firstPathSegment(pathValue string) string {
	trimmed := strings.Trim(pathValue, "/")
	if trimmed == "" {
		return ""
	}
	return strings.ToLower(strings.Split(trimmed, "/")[0])
}
