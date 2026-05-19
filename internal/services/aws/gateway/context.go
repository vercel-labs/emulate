package gateway

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net"
	"net/http"
	"strings"
	"sync/atomic"

	"github.com/vercel-labs/emulate/internal/services/aws/auth"
	"github.com/vercel-labs/emulate/internal/services/aws/protocols"
)

const (
	DefaultAccountID = "123456789012"
	DefaultRegion    = "us-east-1"
)

type Options struct {
	DefaultAccountID   string
	DefaultRegion      string
	RequestIDGenerator func() string
	AuthMode           auth.Mode
	CredentialStore    *auth.Store
}

type AwsRequestContext struct {
	RequestID string
	Service   string
	Action    string
	Protocol  protocols.Protocol
	Region    string
	AccountID string

	RawBody []byte
	Query   map[string]string
	Input   map[string]any
	Target  string

	Credentials Credentials
	Principal   Principal
	Auth        auth.Context
	S3          *protocols.S3Route
}

type Credentials struct {
	AccessKeyID string
	Scope       CredentialScope
}

type CredentialScope struct {
	Date     string
	Region   string
	Service  string
	Terminal string
}

type Principal struct {
	AccountID string
	ARN       string
}

type hostDetection struct {
	Service string
	Region  string
}

var requestIDCounter atomic.Uint64

func BuildContext(req *http.Request, rawBody []byte, options Options) (AwsRequestContext, error) {
	options = normalizeOptions(options)
	authContext := auth.Resolve(req, auth.Options{
		Mode:             options.AuthMode,
		Store:            options.CredentialStore,
		DefaultAccountID: options.DefaultAccountID,
	})
	credentials := credentialsFromSignature(authContext.Signature)
	host := detectHost(req.Host)
	pathService := serviceFromPath(req.URL.Path)
	region := firstNonEmpty(credentials.Scope.Region, host.Region, options.DefaultRegion)
	accountID := firstNonEmpty(authContext.AccountID, options.DefaultAccountID)

	ctx := AwsRequestContext{
		RequestID:   options.RequestIDGenerator(),
		Protocol:    protocols.ProtocolUnknown,
		Region:      region,
		AccountID:   accountID,
		RawBody:     append([]byte(nil), rawBody...),
		Query:       map[string]string{},
		Input:       map[string]any{},
		Credentials: credentials,
		Auth:        authContext,
		Principal: Principal{
			AccountID: accountID,
			ARN:       authContext.PrincipalARN,
		},
	}

	if target := req.Header.Get("X-Amz-Target"); target != "" {
		parsed, err := protocols.ParseJSONRPCRequest(target, rawBody)
		if err != nil {
			return AwsRequestContext{}, err
		}
		ctx.Protocol = protocols.ProtocolJSONRPC
		ctx.Target = parsed.Target
		ctx.Service = firstNonEmpty(serviceFromJSONTargetPrefix(parsed.TargetPrefix), host.Service, pathService, credentials.Scope.Service)
		ctx.Action = parsed.Action
		ctx.Input = parsed.Input
		return ctx, nil
	}

	if host.Service == "s3" || pathService == "s3" {
		s3Route, err := protocols.ParseS3RESTRequest(req)
		if err != nil {
			return AwsRequestContext{}, err
		}
		ctx.Protocol = protocols.ProtocolRESTXML
		ctx.Service = "s3"
		ctx.Action = s3Route.Action
		ctx.Query = s3Route.Query
		ctx.Input = s3Input(s3Route)
		ctx.S3 = &s3Route
		return ctx, nil
	}

	queryReq, err := protocols.ParseQueryRequest(req, rawBody)
	if err != nil {
		return AwsRequestContext{}, err
	}
	ctx.Query = queryReq.Parameters
	if queryReq.Action != "" {
		ctx.Protocol = protocols.ProtocolQuery
		ctx.Service = firstNonEmpty(pathService, host.Service, credentials.Scope.Service, serviceFromQueryAction(queryReq.Action))
		ctx.Action = queryReq.Action
		ctx.Input = queryInput(queryReq.Parameters)
		return ctx, nil
	}

	if shouldTreatAsS3(req, host.Service, pathService, credentials.Scope.Service) {
		s3Route, err := protocols.ParseS3RESTRequest(req)
		if err != nil {
			return AwsRequestContext{}, err
		}
		ctx.Protocol = protocols.ProtocolRESTXML
		ctx.Service = "s3"
		ctx.Action = s3Route.Action
		ctx.Query = s3Route.Query
		ctx.Input = s3Input(s3Route)
		ctx.S3 = &s3Route
		return ctx, nil
	}

	ctx.Service = firstNonEmpty(pathService, host.Service, credentials.Scope.Service)
	return ctx, nil
}

func ParseCredentials(req *http.Request) Credentials {
	signature, err := auth.ParseSigV4(req)
	if err != nil || !signature.Present {
		return Credentials{}
	}
	return credentialsFromSignature(signature)
}

func credentialsFromSignature(signature auth.Signature) Credentials {
	if !signature.Present {
		return Credentials{}
	}
	return Credentials{
		AccessKeyID: signature.AccessKeyID,
		Scope: CredentialScope{
			Date:     signature.Scope.Date,
			Region:   signature.Scope.Region,
			Service:  signature.Scope.Service,
			Terminal: signature.Scope.Terminal,
		},
	}
}

func NewRequestID() string {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err == nil {
		return strings.ToUpper(hex.EncodeToString(bytes[:]))
	}
	return fmt.Sprintf("REQ%016X", requestIDCounter.Add(1))
}

func normalizeOptions(options Options) Options {
	if options.DefaultAccountID == "" {
		options.DefaultAccountID = DefaultAccountID
	}
	if options.DefaultRegion == "" {
		options.DefaultRegion = DefaultRegion
	}
	if options.RequestIDGenerator == nil {
		options.RequestIDGenerator = NewRequestID
	}
	return options
}

func queryInput(params map[string]string) map[string]any {
	input := make(map[string]any, len(params))
	for key, value := range params {
		input[key] = value
	}
	return input
}

func s3Input(route protocols.S3Route) map[string]any {
	return map[string]any{
		"bucket":      route.Bucket,
		"copySource":  route.CopySource,
		"key":         route.Key,
		"query":       route.Query,
		"subresource": route.Subresource,
	}
}

func shouldTreatAsS3(req *http.Request, hostService string, pathService string, credentialService string) bool {
	if hostService == "s3" || pathService == "s3" || credentialService == "s3" {
		return true
	}
	if req.URL.Query().Get("Action") != "" || req.Header.Get("X-Amz-Target") != "" {
		return false
	}
	if credentialService != "" {
		return false
	}
	return hostService == ""
}

func detectHost(host string) hostDetection {
	host = normalizeHost(host)
	if host == "" {
		return hostDetection{}
	}
	labels := strings.Split(host, ".")
	for index := len(labels) - 1; index >= 0; index-- {
		label := labels[index]
		if label == "s3" {
			return hostDetection{Service: "s3", Region: regionAfterS3Label(labels, index)}
		}
		if strings.HasPrefix(label, "s3-") {
			return hostDetection{Service: "s3", Region: regionFromDashedS3Label(labels, index)}
		}
	}
	if service := knownHostService(labels[0]); service != "" {
		return hostDetection{Service: service, Region: regionAfterLabel(labels, 0)}
	}
	return hostDetection{}
}

func normalizeHost(host string) string {
	if value, _, err := net.SplitHostPort(host); err == nil {
		host = value
	}
	return strings.TrimSuffix(strings.ToLower(host), ".")
}

func regionAfterLabel(labels []string, index int) string {
	for _, candidate := range labels[index+1:] {
		if candidate == "amazonaws" {
			return ""
		}
		if looksLikeAWSRegion(candidate) {
			return candidate
		}
	}
	return ""
}

func regionAfterS3Label(labels []string, index int) string {
	return firstAWSRegionLabelAfter(labels, index)
}

func regionFromDashedS3Label(labels []string, index int) string {
	region := strings.TrimPrefix(labels[index], "s3-")
	if looksLikeAWSRegion(region) {
		return region
	}
	return firstAWSRegionLabelAfter(labels, index)
}

func firstAWSRegionLabelAfter(labels []string, index int) string {
	for _, label := range labels[index+1:] {
		if label == "amazonaws" {
			return ""
		}
		if looksLikeAWSRegion(label) {
			return label
		}
	}
	return ""
}

func looksLikeAWSRegion(label string) bool {
	parts := strings.Split(label, "-")
	if len(parts) < 3 {
		return false
	}
	last := parts[len(parts)-1]
	if len(last) != 1 || last[0] < '0' || last[0] > '9' {
		return false
	}
	for _, part := range parts[:len(parts)-1] {
		if part == "" {
			return false
		}
		for _, char := range part {
			if char < 'a' || char > 'z' {
				return false
			}
		}
	}
	return true
}

func serviceFromPath(pathValue string) string {
	trimmed := strings.Trim(pathValue, "/")
	if trimmed == "" {
		return ""
	}
	first := strings.Split(trimmed, "/")[0]
	return knownPathService(strings.ToLower(first))
}

func serviceFromQueryAction(action string) string {
	return queryActionServices[action]
}

func serviceFromJSONTargetPrefix(prefix string) string {
	for marker, service := range jsonTargetServices {
		if strings.HasPrefix(prefix, marker) {
			return service
		}
	}
	return ""
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func knownHostService(label string) string {
	return knownServices[label]
}

func knownPathService(label string) string {
	return knownServices[label]
}

var knownServices = map[string]string{
	"cloudformation": "cloudformation",
	"dynamodb":       "dynamodb",
	"events":         "events",
	"iam":            "iam",
	"kms":            "kms",
	"lambda":         "lambda",
	"logs":           "logs",
	"s3":             "s3",
	"secretsmanager": "secretsmanager",
	"sns":            "sns",
	"sqs":            "sqs",
	"ssm":            "ssm",
	"states":         "states",
	"sts":            "sts",
}

var queryActionServices = map[string]string{
	"AddPermission":      "sqs",
	"AssumeRole":         "sts",
	"CreateQueue":        "sqs",
	"CreateRole":         "iam",
	"CreateUser":         "iam",
	"CreateAccessKey":    "iam",
	"DeleteAccessKey":    "iam",
	"DeleteMessage":      "sqs",
	"DeleteQueue":        "sqs",
	"DeleteRole":         "iam",
	"DeleteUser":         "iam",
	"GetCallerIdentity":  "sts",
	"GetQueueAttributes": "sqs",
	"GetQueueUrl":        "sqs",
	"GetRole":            "iam",
	"GetUser":            "iam",
	"ListAccessKeys":     "iam",
	"ListQueues":         "sqs",
	"ListRoles":          "iam",
	"ListUsers":          "iam",
	"PurgeQueue":         "sqs",
	"ReceiveMessage":     "sqs",
	"SendMessage":        "sqs",
}

var jsonTargetServices = map[string]string{
	"AmazonCloudWatchLogs": "logs",
	"DynamoDB":             "dynamodb",
	"Lambda":               "lambda",
	"AWSEvents":            "events",
	"SecretsManager":       "secretsmanager",
	"Logs_20140328":        "logs",
	"secretsmanager":       "secretsmanager",
	"AmazonSSM":            "ssm",
	"TrentService":         "kms",
	"AWSStepFunctions":     "states",
}
