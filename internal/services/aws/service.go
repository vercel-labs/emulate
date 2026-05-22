package aws

import (
	"net/http"
	"strings"

	coreassets "github.com/vercel-labs/emulate/internal/core/assets"
	corehttp "github.com/vercel-labs/emulate/internal/core/http"
	corestore "github.com/vercel-labs/emulate/internal/core/store"
	"github.com/vercel-labs/emulate/internal/services/aws/auth"
	awsdynamodb "github.com/vercel-labs/emulate/internal/services/aws/dynamodb"
	awsevents "github.com/vercel-labs/emulate/internal/services/aws/eventbridge"
	"github.com/vercel-labs/emulate/internal/services/aws/gateway"
	awsiam "github.com/vercel-labs/emulate/internal/services/aws/iam"
	awskms "github.com/vercel-labs/emulate/internal/services/aws/kms"
	awslogs "github.com/vercel-labs/emulate/internal/services/aws/logs"
	"github.com/vercel-labs/emulate/internal/services/aws/protocols"
	awss3 "github.com/vercel-labs/emulate/internal/services/aws/s3"
	awssecretsmanager "github.com/vercel-labs/emulate/internal/services/aws/secretsmanager"
	awssns "github.com/vercel-labs/emulate/internal/services/aws/sns"
	awssqs "github.com/vercel-labs/emulate/internal/services/aws/sqs"
	awsssm "github.com/vercel-labs/emulate/internal/services/aws/ssm"
	awssts "github.com/vercel-labs/emulate/internal/services/aws/sts"
)

type Options struct {
	Store            *corestore.Store
	DefaultAccountID string
	DefaultRegion    string
	AuthMode         auth.Mode
	CredentialStore  *auth.Store
	S3PathFallback   bool
	AssetStore       *coreassets.Store
	BaseURL          string
	Seed             *SeedConfig
}

type Service struct {
	store            Store
	assets           *coreassets.Store
	defaultAccountID string
	defaultRegion    string
	authMode         auth.Mode
	credentialStore  *auth.Store
	s3PathFallback   bool
	s3               awss3.Handler
	sqs              awssqs.Handler
	sns              awssns.Handler
	iam              awsiam.Handler
	sts              awssts.Handler
	dynamodb         awsdynamodb.Handler
	events           awsevents.Handler
	logs             awslogs.Handler
	secretsmanager   awssecretsmanager.Handler
	ssm              awsssm.Handler
	kms              awskms.Handler
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
	if options.Seed != nil {
		if defaultAccountID == gateway.DefaultAccountID && options.Seed.AccountID != "" {
			defaultAccountID = options.Seed.AccountID
		}
		if defaultRegion == gateway.DefaultRegion && options.Seed.Region != "" {
			defaultRegion = options.Seed.Region
		}
	}
	assetStore := options.AssetStore
	if assetStore == nil {
		assetStore = coreassets.New()
	}
	awsStore := NewStore(runtimeStore)
	credentialStore := options.CredentialStore
	if credentialStore == nil {
		credentialStore = auth.NewStore()
	}
	seedS3Defaults(awsStore, defaultRegion)
	seedSQSDefaults(awsStore, options.BaseURL, defaultAccountID, defaultRegion)
	seedEventBridgeDefaults(awsStore, defaultAccountID, defaultRegion)
	seedIAMDefaults(awsStore, credentialStore, defaultAccountID)
	seedKMSDefaults(awsStore, defaultAccountID, defaultRegion)
	if options.Seed != nil {
		seedFromConfig(awsStore, credentialStore, options.BaseURL, defaultAccountID, defaultRegion, *options.Seed)
	}
	return &Service{
		store:            awsStore,
		assets:           assetStore,
		defaultAccountID: defaultAccountID,
		defaultRegion:    defaultRegion,
		authMode:         options.AuthMode,
		credentialStore:  credentialStore,
		s3PathFallback:   options.S3PathFallback,
		s3: awss3.Handler{
			Buckets: awsStore.S3Buckets,
			Objects: awsStore.S3Objects,
			Assets:  assetStore,
			BaseURL: options.BaseURL,
			Region:  defaultRegion,
		},
		sqs: awssqs.Handler{
			Queues:    awsStore.SQSQueues,
			Messages:  awsStore.SQSMessages,
			BaseURL:   options.BaseURL,
			AccountID: defaultAccountID,
			Region:    defaultRegion,
		},
		sns: awssns.Handler{
			Topics:        awsStore.SNSTopics,
			Subscriptions: awsStore.SNSSubscriptions,
			Deliveries:    awsStore.SNSDeliveries,
			SQSQueues:     awsStore.SQSQueues,
			SQSMessages:   awsStore.SQSMessages,
			AccountID:     defaultAccountID,
			Region:        defaultRegion,
		},
		iam: awsiam.Handler{
			Users:           awsStore.IAMUsers,
			Roles:           awsStore.IAMRoles,
			Policies:        awsStore.IAMPolicies,
			CredentialStore: credentialStore,
			AccountID:       defaultAccountID,
		},
		sts: awssts.Handler{
			Users:           awsStore.IAMUsers,
			Roles:           awsStore.IAMRoles,
			CredentialStore: credentialStore,
			AccountID:       defaultAccountID,
		},
		dynamodb: awsdynamodb.Handler{
			Tables:    awsStore.DynamoDBTables,
			Items:     awsStore.DynamoDBItems,
			AccountID: defaultAccountID,
			Region:    defaultRegion,
		},
		events: awsevents.Handler{
			EventBuses:       awsStore.EventBuses,
			EventRules:       awsStore.EventRules,
			EventTargets:     awsStore.EventTargets,
			EventDeliveries:  awsStore.EventDeliveries,
			SQSQueues:        awsStore.SQSQueues,
			SQSMessages:      awsStore.SQSMessages,
			SNSTopics:        awsStore.SNSTopics,
			SNSSubscriptions: awsStore.SNSSubscriptions,
			SNSDeliveries:    awsStore.SNSDeliveries,
			AccountID:        defaultAccountID,
			Region:           defaultRegion,
		},
		logs: awslogs.Handler{
			LogGroups:  awsStore.LogGroups,
			LogStreams: awsStore.LogStreams,
			LogEvents:  awsStore.LogEvents,
			AccountID:  defaultAccountID,
			Region:     defaultRegion,
		},
		secretsmanager: awssecretsmanager.Handler{
			Secrets:   awsStore.Secrets,
			Versions:  awsStore.SecretVersions,
			AccountID: defaultAccountID,
			Region:    defaultRegion,
		},
		ssm: awsssm.Handler{
			Parameters: awsStore.SSMParameters,
			Versions:   awsStore.SSMParamVersions,
			AccountID:  defaultAccountID,
			Region:     defaultRegion,
		},
		kms: awskms.Handler{
			Keys:      awsStore.KMSKeys,
			Aliases:   awsStore.KMSAliases,
			AccountID: defaultAccountID,
			Region:    defaultRegion,
		},
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

	if ctx.Service == "s3" && ctx.Protocol == protocols.ProtocolRESTXML {
		writeErrorResponse(c, s.s3.Handle(c.Request, ctx))
		return
	}
	if ctx.Service == "sqs" && (ctx.Protocol == protocols.ProtocolQuery || ctx.Protocol == protocols.ProtocolJSONRPC) {
		writeErrorResponse(c, s.sqs.Handle(c.Request, ctx))
		return
	}
	if ctx.Service == "sns" && ctx.Protocol == protocols.ProtocolQuery {
		writeErrorResponse(c, s.sns.Handle(c.Request, ctx))
		return
	}
	if ctx.Service == "iam" && ctx.Protocol == protocols.ProtocolQuery {
		writeErrorResponse(c, s.iam.Handle(c.Request, ctx))
		return
	}
	if ctx.Service == "sts" && ctx.Protocol == protocols.ProtocolQuery {
		writeErrorResponse(c, s.sts.Handle(c.Request, ctx))
		return
	}
	if ctx.Service == "dynamodb" && ctx.Protocol == protocols.ProtocolJSONRPC {
		writeErrorResponse(c, s.dynamodb.Handle(c.Request, ctx))
		return
	}
	if ctx.Service == "events" && ctx.Protocol == protocols.ProtocolJSONRPC {
		writeErrorResponse(c, s.events.Handle(c.Request, ctx))
		return
	}
	if ctx.Service == "logs" && ctx.Protocol == protocols.ProtocolJSONRPC {
		writeErrorResponse(c, s.logs.Handle(c.Request, ctx))
		return
	}
	if ctx.Service == "secretsmanager" && ctx.Protocol == protocols.ProtocolJSONRPC {
		writeErrorResponse(c, s.secretsmanager.Handle(c.Request, ctx))
		return
	}
	if ctx.Service == "ssm" && ctx.Protocol == protocols.ProtocolJSONRPC {
		writeErrorResponse(c, s.ssm.Handle(c.Request, ctx))
		return
	}
	if ctx.Service == "kms" && ctx.Protocol == protocols.ProtocolJSONRPC {
		writeErrorResponse(c, s.kms.Handle(c.Request, ctx))
		return
	}

	s.writeAWSError(c, ctx, notImplementedError(ctx))
}

func (s *Service) looksLikeAWSRequest(req *http.Request) bool {
	if req.URL.Query().Get("Action") != "" || hasAWSPresignQuery(req) {
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
	if hasKnownServiceEndpointPath(req.URL.Path) {
		return true
	}
	return looksLikeS3RESTRequest(req, s.s3PathFallback)
}

func hasAWSPresignQuery(req *http.Request) bool {
	query := req.URL.Query()
	for _, key := range []string{"X-Amz-Algorithm", "X-Amz-Credential", "X-Amz-Signature"} {
		if query.Get(key) != "" {
			return true
		}
	}
	return false
}

func hasAWSHeader(req *http.Request) bool {
	for key := range req.Header {
		if strings.HasPrefix(strings.ToLower(key), "x-amz-") {
			return true
		}
	}
	return false
}

func hasKnownServiceEndpointPath(pathValue string) bool {
	first, rest := splitFirstPathSegment(pathValue)
	if first == "s3" {
		return true
	}
	if rest != "" {
		return false
	}
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
	if query.Get("list-type") == "2" {
		return true
	}
	for _, key := range []string{
		"acl",
		"delete",
		"lifecycle",
		"location",
		"notification",
		"policy",
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
	first, _ := splitFirstPathSegment(pathValue)
	return first
}

func splitFirstPathSegment(pathValue string) (string, string) {
	trimmed := strings.Trim(pathValue, "/")
	if trimmed == "" {
		return "", ""
	}
	first, rest, _ := strings.Cut(trimmed, "/")
	return strings.ToLower(first), rest
}
