package apigatewayv2

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	corestore "github.com/vercel-labs/emulate/internal/core/store"
	"github.com/vercel-labs/emulate/internal/services/aws/gateway"
	awslambda "github.com/vercel-labs/emulate/internal/services/aws/lambda"
	"github.com/vercel-labs/emulate/internal/services/aws/protocols"
)

const jsonContentType = "application/json"

type Handler struct {
	APIs                     *corestore.Collection
	Integrations             *corestore.Collection
	Routes                   *corestore.Collection
	Stages                   *corestore.Collection
	LambdaFunctions          *corestore.Collection
	LambdaVersions           *corestore.Collection
	LambdaAliases            *corestore.Collection
	LogGroups                *corestore.Collection
	LogStreams               *corestore.Collection
	LogEvents                *corestore.Collection
	BaseURL                  string
	AccountID                string
	Region                   string
	LambdaLocalCodeExecution bool
	Now                      func() time.Time
	IDGenerator              func(string) string
}

type routeSpec struct {
	Action        string
	APIID         string
	IntegrationID string
	RouteID       string
	StageName     string
}

type invokeSpec struct {
	APIID     string
	StageName string
	RawPath   string
}

type routeMatch struct {
	Record         corestore.Record
	PathParameters map[string]string
}

type lambdaProxyResponse struct {
	StatusCode        int                 `json:"statusCode"`
	Headers           map[string]string   `json:"headers"`
	Body              string              `json:"body"`
	IsBase64Encoded   bool                `json:"isBase64Encoded"`
	Cookies           []string            `json:"cookies"`
	MultiValueHeaders map[string][]string `json:"multiValueHeaders"`
}

var fallbackIDCounter atomic.Uint64

func (h *Handler) Handle(req *http.Request, ctx gateway.AwsRequestContext) protocols.ErrorResponse {
	requestID := ctx.RequestID
	if requestID == "" {
		requestID = h.generateID("req")
	}
	if invoke, ok := parseInvokePath(req.URL.Path); ok {
		return withRequestID(h.invoke(req, ctx, invoke, requestID), requestID)
	}
	route, ok := parseControlRoute(req)
	if !ok {
		return withRequestID(h.error("NotImplementedException", "apigatewayv2 route is not implemented in the native Go runtime yet.", http.StatusNotImplemented, requestID), requestID)
	}
	var response protocols.ErrorResponse
	switch route.Action {
	case "CreateApi":
		response = h.createAPI(ctx, requestID)
	case "GetApi":
		response = h.getAPI(ctx, route.APIID, requestID)
	case "GetApis":
		response = h.getAPIs(ctx)
	case "DeleteApi":
		response = h.deleteAPI(ctx, route.APIID, requestID)
	case "CreateIntegration":
		response = h.createIntegration(ctx, route.APIID, requestID)
	case "GetIntegration":
		response = h.getIntegration(ctx, route.APIID, route.IntegrationID, requestID)
	case "GetIntegrations":
		response = h.getIntegrations(ctx, route.APIID, requestID)
	case "DeleteIntegration":
		response = h.deleteIntegration(ctx, route.APIID, route.IntegrationID, requestID)
	case "CreateRoute":
		response = h.createRoute(ctx, route.APIID, requestID)
	case "GetRoute":
		response = h.getRoute(ctx, route.APIID, route.RouteID, requestID)
	case "GetRoutes":
		response = h.getRoutes(ctx, route.APIID, requestID)
	case "DeleteRoute":
		response = h.deleteRoute(ctx, route.APIID, route.RouteID, requestID)
	case "CreateStage":
		response = h.createStage(ctx, route.APIID, requestID)
	case "GetStage":
		response = h.getStage(ctx, route.APIID, route.StageName, requestID)
	case "GetStages":
		response = h.getStages(ctx, route.APIID, requestID)
	case "DeleteStage":
		response = h.deleteStage(ctx, route.APIID, route.StageName, requestID)
	default:
		response = h.error("NotImplementedException", fmt.Sprintf("apigatewayv2.%s is not implemented in the native Go runtime yet.", route.Action), http.StatusNotImplemented, requestID)
	}
	return withRequestID(response, requestID)
}

func (h *Handler) createAPI(ctx gateway.AwsRequestContext, requestID string) protocols.ErrorResponse {
	name := strings.TrimSpace(stringInput(ctx.Input, "Name", "name"))
	if name == "" {
		return h.validation("Name is required.", requestID)
	}
	protocolType := strings.ToUpper(strings.TrimSpace(firstNonEmpty(stringInput(ctx.Input, "ProtocolType", "protocolType"), "HTTP")))
	if protocolType != "HTTP" && protocolType != "WEBSOCKET" {
		return h.validation("ProtocolType must be HTTP or WEBSOCKET.", requestID)
	}
	apiID := h.generateID("api")
	now := h.now().UTC().Format(time.RFC3339)
	record := h.APIs.Insert(corestore.Record{
		"account_id":                   h.accountID(ctx),
		"region":                       h.region(ctx),
		"api_id":                       apiID,
		"name":                         name,
		"protocol_type":                protocolType,
		"api_endpoint":                 h.apiEndpoint(apiID),
		"api_key_selection_expression": firstNonEmpty(stringInput(ctx.Input, "ApiKeySelectionExpression", "apiKeySelectionExpression"), "$request.header.x-api-key"),
		"route_selection_expression":   firstNonEmpty(stringInput(ctx.Input, "RouteSelectionExpression", "routeSelectionExpression"), "$request.method $request.path"),
		"description":                  stringInput(ctx.Input, "Description", "description"),
		"cors_configuration":           mapRecord(firstPresent(ctx.Input, "CorsConfiguration", "corsConfiguration")),
		"created_date":                 now,
		"tags":                         tagsMap(firstPresent(ctx.Input, "Tags", "tags")),
	})
	return jsonResponse(http.StatusCreated, h.apiResponse(record))
}

func (h *Handler) getAPI(ctx gateway.AwsRequestContext, apiID string, requestID string) protocols.ErrorResponse {
	api, response, ok := h.requireAPI(ctx, apiID, requestID)
	if !ok {
		return response
	}
	return jsonResponse(http.StatusOK, h.apiResponse(api))
}

func (h *Handler) getAPIs(ctx gateway.AwsRequestContext) protocols.ErrorResponse {
	apis := []corestore.Record{}
	for _, api := range h.APIs.All() {
		if h.sameScope(ctx, api) {
			apis = append(apis, api)
		}
	}
	sort.Slice(apis, func(i int, j int) bool { return stringField(apis[i], "name") < stringField(apis[j], "name") })
	items := make([]map[string]any, 0, len(apis))
	for _, api := range apis {
		items = append(items, h.apiResponse(api))
	}
	return jsonResponse(http.StatusOK, map[string]any{"items": items})
}

func (h *Handler) deleteAPI(ctx gateway.AwsRequestContext, apiID string, requestID string) protocols.ErrorResponse {
	api, response, ok := h.requireAPI(ctx, apiID, requestID)
	if !ok {
		return response
	}
	for _, integration := range h.Integrations.FindBy("api_id", apiID) {
		if h.sameScope(ctx, integration) {
			h.Integrations.Delete(intField(integration, "id"))
		}
	}
	for _, route := range h.Routes.FindBy("api_id", apiID) {
		if h.sameScope(ctx, route) {
			h.Routes.Delete(intField(route, "id"))
		}
	}
	for _, stage := range h.Stages.FindBy("api_id", apiID) {
		if h.sameScope(ctx, stage) {
			h.Stages.Delete(intField(stage, "id"))
		}
	}
	h.APIs.Delete(intField(api, "id"))
	return jsonResponse(http.StatusNoContent, nil)
}

func (h *Handler) createIntegration(ctx gateway.AwsRequestContext, apiID string, requestID string) protocols.ErrorResponse {
	if _, response, ok := h.requireAPI(ctx, apiID, requestID); !ok {
		return response
	}
	integrationType := strings.ToUpper(strings.TrimSpace(stringInput(ctx.Input, "IntegrationType", "integrationType")))
	if integrationType == "" {
		integrationType = "AWS_PROXY"
	}
	integrationURI := strings.TrimSpace(stringInput(ctx.Input, "IntegrationUri", "integrationUri"))
	if integrationURI == "" {
		return h.validation("IntegrationUri is required.", requestID)
	}
	payloadFormatVersion := firstNonEmpty(stringInput(ctx.Input, "PayloadFormatVersion", "payloadFormatVersion"), "2.0")
	if payloadFormatVersion != "2.0" {
		return h.validation("PayloadFormatVersion must be 2.0.", requestID)
	}
	integrationID := h.generateID("int")
	record := h.Integrations.Insert(corestore.Record{
		"account_id":             h.accountID(ctx),
		"region":                 h.region(ctx),
		"api_id":                 apiID,
		"integration_id":         integrationID,
		"integration_type":       integrationType,
		"integration_uri":        integrationURI,
		"integration_method":     firstNonEmpty(stringInput(ctx.Input, "IntegrationMethod", "integrationMethod"), "POST"),
		"payload_format_version": payloadFormatVersion,
		"timeout_in_millis":      intInputDefault(ctx.Input, 30000, "TimeoutInMillis", "timeoutInMillis"),
		"description":            stringInput(ctx.Input, "Description", "description"),
	})
	return jsonResponse(http.StatusCreated, h.integrationResponse(record))
}

func (h *Handler) getIntegration(ctx gateway.AwsRequestContext, apiID string, integrationID string, requestID string) protocols.ErrorResponse {
	integration, response, ok := h.requireIntegration(ctx, apiID, integrationID, requestID)
	if !ok {
		return response
	}
	return jsonResponse(http.StatusOK, h.integrationResponse(integration))
}

func (h *Handler) getIntegrations(ctx gateway.AwsRequestContext, apiID string, requestID string) protocols.ErrorResponse {
	if _, response, ok := h.requireAPI(ctx, apiID, requestID); !ok {
		return response
	}
	items := []map[string]any{}
	for _, integration := range h.Integrations.FindBy("api_id", apiID) {
		if h.sameScope(ctx, integration) {
			items = append(items, h.integrationResponse(integration))
		}
	}
	return jsonResponse(http.StatusOK, map[string]any{"items": items})
}

func (h *Handler) deleteIntegration(ctx gateway.AwsRequestContext, apiID string, integrationID string, requestID string) protocols.ErrorResponse {
	integration, response, ok := h.requireIntegration(ctx, apiID, integrationID, requestID)
	if !ok {
		return response
	}
	h.Integrations.Delete(intField(integration, "id"))
	return jsonResponse(http.StatusNoContent, nil)
}

func (h *Handler) createRoute(ctx gateway.AwsRequestContext, apiID string, requestID string) protocols.ErrorResponse {
	if _, response, ok := h.requireAPI(ctx, apiID, requestID); !ok {
		return response
	}
	routeKey := strings.TrimSpace(stringInput(ctx.Input, "RouteKey", "routeKey"))
	if routeKey == "" {
		return h.validation("RouteKey is required.", requestID)
	}
	target := strings.TrimSpace(stringInput(ctx.Input, "Target", "target"))
	if target == "" {
		return h.validation("Target is required.", requestID)
	}
	if _, ok := h.findRouteByKey(ctx, apiID, routeKey); ok {
		return h.conflict("Route already exists.", requestID)
	}
	routeID := h.generateID("route")
	record := h.Routes.Insert(corestore.Record{
		"account_id":         h.accountID(ctx),
		"region":             h.region(ctx),
		"api_id":             apiID,
		"route_id":           routeID,
		"route_key":          routeKey,
		"target":             target,
		"authorization_type": firstNonEmpty(stringInput(ctx.Input, "AuthorizationType", "authorizationType"), "NONE"),
	})
	return jsonResponse(http.StatusCreated, h.routeResponse(record))
}

func (h *Handler) getRoute(ctx gateway.AwsRequestContext, apiID string, routeID string, requestID string) protocols.ErrorResponse {
	route, response, ok := h.requireRoute(ctx, apiID, routeID, requestID)
	if !ok {
		return response
	}
	return jsonResponse(http.StatusOK, h.routeResponse(route))
}

func (h *Handler) getRoutes(ctx gateway.AwsRequestContext, apiID string, requestID string) protocols.ErrorResponse {
	if _, response, ok := h.requireAPI(ctx, apiID, requestID); !ok {
		return response
	}
	items := []map[string]any{}
	for _, route := range h.Routes.FindBy("api_id", apiID) {
		if h.sameScope(ctx, route) {
			items = append(items, h.routeResponse(route))
		}
	}
	return jsonResponse(http.StatusOK, map[string]any{"items": items})
}

func (h *Handler) deleteRoute(ctx gateway.AwsRequestContext, apiID string, routeID string, requestID string) protocols.ErrorResponse {
	route, response, ok := h.requireRoute(ctx, apiID, routeID, requestID)
	if !ok {
		return response
	}
	h.Routes.Delete(intField(route, "id"))
	return jsonResponse(http.StatusNoContent, nil)
}

func (h *Handler) createStage(ctx gateway.AwsRequestContext, apiID string, requestID string) protocols.ErrorResponse {
	if _, response, ok := h.requireAPI(ctx, apiID, requestID); !ok {
		return response
	}
	stageName := strings.TrimSpace(stringInput(ctx.Input, "StageName", "stageName"))
	if stageName == "" {
		return h.validation("StageName is required.", requestID)
	}
	if _, ok := h.findStage(ctx, apiID, stageName); ok {
		return h.conflict("Stage already exists.", requestID)
	}
	now := h.now().UTC().Format(time.RFC3339)
	record := corestore.Record{
		"account_id":        h.accountID(ctx),
		"region":            h.region(ctx),
		"api_id":            apiID,
		"stage_name":        stageName,
		"auto_deploy":       boolInput(ctx.Input, "AutoDeploy", "autoDeploy"),
		"deployment_id":     stringInput(ctx.Input, "DeploymentId", "deploymentId"),
		"description":       stringInput(ctx.Input, "Description", "description"),
		"stage_variables":   stringMap(firstPresent(ctx.Input, "StageVariables", "stageVariables")),
		"created_date":      now,
		"last_updated_date": now,
	}
	created := h.Stages.Insert(record)
	return jsonResponse(http.StatusCreated, h.stageResponse(created))
}

func (h *Handler) getStage(ctx gateway.AwsRequestContext, apiID string, stageName string, requestID string) protocols.ErrorResponse {
	stage, response, ok := h.requireStage(ctx, apiID, stageName, requestID)
	if !ok {
		return response
	}
	return jsonResponse(http.StatusOK, h.stageResponse(stage))
}

func (h *Handler) getStages(ctx gateway.AwsRequestContext, apiID string, requestID string) protocols.ErrorResponse {
	if _, response, ok := h.requireAPI(ctx, apiID, requestID); !ok {
		return response
	}
	items := []map[string]any{}
	for _, stage := range h.Stages.FindBy("api_id", apiID) {
		if h.sameScope(ctx, stage) {
			items = append(items, h.stageResponse(stage))
		}
	}
	return jsonResponse(http.StatusOK, map[string]any{"items": items})
}

func (h *Handler) deleteStage(ctx gateway.AwsRequestContext, apiID string, stageName string, requestID string) protocols.ErrorResponse {
	stage, response, ok := h.requireStage(ctx, apiID, stageName, requestID)
	if !ok {
		return response
	}
	h.Stages.Delete(intField(stage, "id"))
	return jsonResponse(http.StatusNoContent, nil)
}

func (h *Handler) invoke(req *http.Request, ctx gateway.AwsRequestContext, spec invokeSpec, requestID string) protocols.ErrorResponse {
	api, response, ok := h.requireAPI(ctx, spec.APIID, requestID)
	if !ok {
		return response
	}
	stageName, rawPath := h.resolveInvokeStage(ctx, spec.APIID, spec.StageName, spec.RawPath)
	stage, response, ok := h.requireStage(ctx, spec.APIID, stageName, requestID)
	if !ok {
		return response
	}
	route, ok := h.matchRoute(ctx, spec.APIID, req.Method, rawPath)
	if !ok {
		return h.error("NotFoundException", "No matching API Gateway route was found.", http.StatusNotFound, requestID)
	}
	integrationID := strings.TrimPrefix(stringField(route.Record, "target"), "integrations/")
	integration, response, ok := h.requireIntegration(ctx, spec.APIID, integrationID, requestID)
	if !ok {
		return response
	}
	if strings.ToUpper(stringField(integration, "integration_type")) != "AWS_PROXY" {
		return h.error("BadGatewayException", "Only AWS_PROXY integrations are supported for local API Gateway invokes.", http.StatusBadGateway, requestID)
	}
	if stringField(integration, "payload_format_version") != "2.0" {
		return h.error("BadGatewayException", "Only payload format version 2.0 is supported for local API Gateway invokes.", http.StatusBadGateway, requestID)
	}
	lambdaTarget := lambdaTargetFromIntegrationURI(stringField(integration, "integration_uri"))
	if lambdaTarget == "" {
		return h.error("BadGatewayException", "IntegrationUri must reference a Lambda function.", http.StatusBadGateway, requestID)
	}
	payload, err := json.Marshal(h.lambdaProxyEvent(req, ctx, api, stage, route, rawPath, requestID))
	if err != nil {
		return h.error("InternalFailure", err.Error(), http.StatusInternalServerError, requestID)
	}
	lambdaHandler := awslambda.Handler{
		Functions:               h.LambdaFunctions,
		Versions:                h.LambdaVersions,
		Aliases:                 h.LambdaAliases,
		LogGroups:               h.LogGroups,
		LogStreams:              h.LogStreams,
		LogEvents:               h.LogEvents,
		AccountID:               h.AccountID,
		Region:                  h.Region,
		AllowLocalCodeExecution: h.LambdaLocalCodeExecution,
		Now:                     h.Now,
		IDGenerator:             h.IDGenerator,
	}
	result, ok := lambdaHandler.InvokeFromProxy(req, ctx, lambdaTarget, payload, h.generateID("req"), "API Gateway")
	if !ok {
		return h.error("BadGatewayException", "Lambda function for API Gateway integration was not found.", http.StatusBadGateway, requestID)
	}
	if result.FunctionError != "" {
		return lambdaProxyGatewayError()
	}
	status, headers, headerValues, body := lambdaProxyHTTPResponse(result.Payload)
	return protocols.ErrorResponse{StatusCode: status, ContentType: firstNonEmpty(headerValue(headers, "Content-Type"), "text/plain"), Headers: headers, HeaderValues: headerValues, Body: body}
}

func (h *Handler) lambdaProxyEvent(req *http.Request, ctx gateway.AwsRequestContext, api corestore.Record, stage corestore.Record, route routeMatch, rawPath string, requestID string) map[string]any {
	headers := map[string]string{}
	for key, values := range req.Header {
		if len(values) > 0 {
			headers[strings.ToLower(key)] = strings.Join(values, ",")
		}
	}
	if req.Host != "" {
		headers["host"] = req.Host
	}
	query := map[string]string{}
	for key, values := range req.URL.Query() {
		if len(values) > 0 {
			query[key] = strings.Join(values, ",")
		}
	}
	body := string(ctx.RawBody)
	event := map[string]any{
		"version":               "2.0",
		"routeKey":              stringField(route.Record, "route_key"),
		"rawPath":               rawPath,
		"rawQueryString":        req.URL.RawQuery,
		"headers":               headers,
		"queryStringParameters": query,
		"requestContext": map[string]any{
			"accountId":    h.accountID(ctx),
			"apiId":        stringField(api, "api_id"),
			"domainName":   req.Host,
			"domainPrefix": stringField(api, "api_id"),
			"requestId":    requestID,
			"routeKey":     stringField(route.Record, "route_key"),
			"stage":        stringField(stage, "stage_name"),
			"time":         h.now().UTC().Format("02/Jan/2006:15:04:05 +0000"),
			"timeEpoch":    h.now().UnixMilli(),
			"http": map[string]any{
				"method":    req.Method,
				"path":      rawPath,
				"protocol":  req.Proto,
				"sourceIp":  sourceIP(req),
				"userAgent": req.UserAgent(),
			},
		},
		"body":            body,
		"isBase64Encoded": false,
	}
	if len(route.PathParameters) > 0 {
		event["pathParameters"] = route.PathParameters
	}
	return event
}

func lambdaProxyHTTPResponse(payload []byte) (int, map[string]string, map[string][]string, []byte) {
	payload = []byte(strings.TrimSpace(string(payload)))
	if len(payload) == 0 {
		return http.StatusOK, map[string]string{"Content-Type": "text/plain"}, nil, nil
	}
	var response lambdaProxyResponse
	if err := json.Unmarshal(payload, &response); err != nil || response.StatusCode == 0 {
		return http.StatusOK, map[string]string{"Content-Type": "application/json"}, nil, payload
	}
	status := response.StatusCode
	headers := map[string]string{}
	headerValues := map[string][]string{}
	for key, value := range response.Headers {
		addLambdaProxyHeader(headers, headerValues, key, value)
	}
	for key, values := range response.MultiValueHeaders {
		if len(values) > 0 {
			if strings.EqualFold(key, "Set-Cookie") {
				headerValues["Set-Cookie"] = append(headerValues["Set-Cookie"], values...)
			} else {
				headers[key] = strings.Join(values, ",")
			}
		}
	}
	for _, cookie := range response.Cookies {
		headerValues["Set-Cookie"] = append(headerValues["Set-Cookie"], cookie)
	}
	body := []byte(response.Body)
	if response.IsBase64Encoded {
		if decoded, err := base64.StdEncoding.DecodeString(response.Body); err == nil {
			body = decoded
		}
	}
	if headerValue(headers, "Content-Type") == "" {
		headers["Content-Type"] = "text/plain"
	}
	return status, headers, headerValues, body
}

func addLambdaProxyHeader(headers map[string]string, headerValues map[string][]string, key string, value string) {
	if strings.EqualFold(key, "Set-Cookie") {
		headerValues["Set-Cookie"] = append(headerValues["Set-Cookie"], value)
		return
	}
	headers[key] = value
}

func headerValue(headers map[string]string, name string) string {
	for key, value := range headers {
		if strings.EqualFold(key, name) {
			return value
		}
	}
	return ""
}

func lambdaProxyGatewayError() protocols.ErrorResponse {
	body, _ := json.Marshal(map[string]string{"message": "Internal server error"})
	return protocols.ErrorResponse{StatusCode: http.StatusBadGateway, ContentType: jsonContentType, Headers: map[string]string{"Content-Type": jsonContentType}, Body: body}
}

func parseControlRoute(req *http.Request) (routeSpec, bool) {
	segments := pathSegments(req.URL.Path)
	if len(segments) > 0 && (segments[0] == "apigatewayv2" || segments[0] == "apigateway") {
		segments = segments[1:]
	}
	if len(segments) < 2 || segments[0] != "v2" || segments[1] != "apis" {
		return routeSpec{}, false
	}
	if len(segments) == 2 {
		switch req.Method {
		case http.MethodPost:
			return routeSpec{Action: "CreateApi"}, true
		case http.MethodGet:
			return routeSpec{Action: "GetApis"}, true
		}
		return routeSpec{}, false
	}
	route := routeSpec{APIID: decodeSegment(segments[2])}
	if len(segments) == 3 {
		switch req.Method {
		case http.MethodGet:
			route.Action = "GetApi"
		case http.MethodDelete:
			route.Action = "DeleteApi"
		default:
			return routeSpec{}, false
		}
		return route, true
	}
	if len(segments) == 4 {
		switch segments[3] {
		case "integrations":
			if req.Method == http.MethodPost {
				route.Action = "CreateIntegration"
				return route, true
			}
			if req.Method == http.MethodGet {
				route.Action = "GetIntegrations"
				return route, true
			}
		case "routes":
			if req.Method == http.MethodPost {
				route.Action = "CreateRoute"
				return route, true
			}
			if req.Method == http.MethodGet {
				route.Action = "GetRoutes"
				return route, true
			}
		case "stages":
			if req.Method == http.MethodPost {
				route.Action = "CreateStage"
				return route, true
			}
			if req.Method == http.MethodGet {
				route.Action = "GetStages"
				return route, true
			}
		}
		return routeSpec{}, false
	}
	if len(segments) == 5 {
		switch segments[3] {
		case "integrations":
			route.IntegrationID = decodeSegment(segments[4])
			switch req.Method {
			case http.MethodGet:
				route.Action = "GetIntegration"
			case http.MethodDelete:
				route.Action = "DeleteIntegration"
			default:
				return routeSpec{}, false
			}
			return route, true
		case "routes":
			route.RouteID = decodeSegment(segments[4])
			switch req.Method {
			case http.MethodGet:
				route.Action = "GetRoute"
			case http.MethodDelete:
				route.Action = "DeleteRoute"
			default:
				return routeSpec{}, false
			}
			return route, true
		case "stages":
			route.StageName = decodeSegment(segments[4])
			switch req.Method {
			case http.MethodGet:
				route.Action = "GetStage"
			case http.MethodDelete:
				route.Action = "DeleteStage"
			default:
				return routeSpec{}, false
			}
			return route, true
		}
	}
	return routeSpec{}, false
}

func parseInvokePath(pathValue string) (invokeSpec, bool) {
	segments := pathSegments(pathValue)
	if len(segments) < 3 || segments[0] != "_aws" || segments[1] != "apigatewayv2" {
		return invokeSpec{}, false
	}
	apiID := decodeSegment(segments[2])
	remaining := segments[3:]
	rawPath := "/"
	if len(remaining) > 0 {
		rawPath = "/" + strings.Join(remaining, "/")
	}
	return invokeSpec{APIID: apiID, RawPath: rawPath}, true
}

func (h *Handler) resolveInvokeStage(ctx gateway.AwsRequestContext, apiID string, explicitStage string, rawPath string) (string, string) {
	if explicitStage != "" {
		return explicitStage, rawPath
	}
	trimmed := strings.Trim(rawPath, "/")
	if trimmed != "" {
		parts := strings.Split(trimmed, "/")
		if stage, ok := h.findStage(ctx, apiID, parts[0]); ok && stringField(stage, "stage_name") != "$default" {
			rest := "/"
			if len(parts) > 1 {
				rest += strings.Join(parts[1:], "/")
			}
			return parts[0], rest
		}
	}
	if _, ok := h.findStage(ctx, apiID, "$default"); ok {
		return "$default", rawPath
	}
	return firstStageName(h.stagesForAPI(ctx, apiID)), rawPath
}

func (h *Handler) matchRoute(ctx gateway.AwsRequestContext, apiID string, method string, pathValue string) (routeMatch, bool) {
	routes := h.routesForAPI(ctx, apiID)
	candidates := []string{method + " " + pathValue, "ANY " + pathValue}
	for _, candidate := range candidates {
		for _, route := range routes {
			if stringField(route, "route_key") == candidate {
				return routeMatch{Record: route}, true
			}
		}
	}
	best := routeMatch{}
	bestScore := -1
	for _, route := range routes {
		routeKey := stringField(route, "route_key")
		parts := strings.SplitN(routeKey, " ", 2)
		if len(parts) != 2 || (parts[0] != method && parts[0] != "ANY") {
			continue
		}
		params, score, ok := matchRoutePath(parts[1], pathValue)
		if !ok {
			continue
		}
		if parts[0] == method {
			score += 1 << 20
		}
		if score > bestScore {
			best = routeMatch{Record: route, PathParameters: params}
			bestScore = score
		}
	}
	if best.Record != nil {
		return best, true
	}
	for _, route := range routes {
		if stringField(route, "route_key") == "$default" {
			return routeMatch{Record: route}, true
		}
	}
	return routeMatch{}, false
}

func matchRoutePath(routePath string, pathValue string) (map[string]string, int, bool) {
	if !strings.Contains(routePath, "{") {
		return nil, 0, false
	}
	routeParts := pathParts(routePath)
	requestParts := pathParts(pathValue)
	params := map[string]string{}
	staticSegments := 0
	for index, routePart := range routeParts {
		name, greedy, param := routePathParameter(routePart)
		if !param {
			if index >= len(requestParts) || routePart != requestParts[index] {
				return nil, 0, false
			}
			staticSegments++
			continue
		}
		if greedy {
			if index != len(routeParts)-1 || len(requestParts) < index {
				return nil, 0, false
			}
			params[name] = decodeSegment(strings.Join(requestParts[index:], "/"))
			return params, 1<<18 + staticSegments*1000 + len(routePath), true
		}
		if index >= len(requestParts) {
			return nil, 0, false
		}
		params[name] = decodeSegment(requestParts[index])
	}
	if len(requestParts) != len(routeParts) {
		return nil, 0, false
	}
	return params, 1<<19 + staticSegments*1000 + len(routePath), true
}

func routePathParameter(segment string) (string, bool, bool) {
	if !strings.HasPrefix(segment, "{") || !strings.HasSuffix(segment, "}") {
		return "", false, false
	}
	name := strings.TrimSuffix(strings.TrimSuffix(strings.TrimPrefix(segment, "{"), "}"), "+")
	if name == "" {
		return "", false, false
	}
	return name, strings.HasSuffix(segment, "+}"), true
}

func pathParts(pathValue string) []string {
	trimmed := strings.Trim(pathValue, "/")
	if trimmed == "" {
		return nil
	}
	return strings.Split(trimmed, "/")
}

func (h *Handler) requireAPI(ctx gateway.AwsRequestContext, apiID string, requestID string) (corestore.Record, protocols.ErrorResponse, bool) {
	api, ok := h.findAPI(ctx, apiID)
	if !ok {
		return nil, h.error("NotFoundException", "API not found.", http.StatusNotFound, requestID), false
	}
	return api, protocols.ErrorResponse{}, true
}

func (h *Handler) findAPI(ctx gateway.AwsRequestContext, apiID string) (corestore.Record, bool) {
	for _, api := range h.APIs.FindBy("api_id", apiID) {
		if h.sameScope(ctx, api) {
			return api, true
		}
	}
	return nil, false
}

func (h *Handler) requireIntegration(ctx gateway.AwsRequestContext, apiID string, integrationID string, requestID string) (corestore.Record, protocols.ErrorResponse, bool) {
	for _, integration := range h.Integrations.FindBy("integration_id", integrationID) {
		if h.sameScope(ctx, integration) && stringField(integration, "api_id") == apiID {
			return integration, protocols.ErrorResponse{}, true
		}
	}
	return nil, h.error("NotFoundException", "Integration not found.", http.StatusNotFound, requestID), false
}

func (h *Handler) requireRoute(ctx gateway.AwsRequestContext, apiID string, routeID string, requestID string) (corestore.Record, protocols.ErrorResponse, bool) {
	for _, route := range h.Routes.FindBy("route_id", routeID) {
		if h.sameScope(ctx, route) && stringField(route, "api_id") == apiID {
			return route, protocols.ErrorResponse{}, true
		}
	}
	return nil, h.error("NotFoundException", "Route not found.", http.StatusNotFound, requestID), false
}

func (h *Handler) findRouteByKey(ctx gateway.AwsRequestContext, apiID string, routeKey string) (corestore.Record, bool) {
	for _, route := range h.Routes.FindBy("api_id", apiID) {
		if h.sameScope(ctx, route) && stringField(route, "route_key") == routeKey {
			return route, true
		}
	}
	return nil, false
}

func (h *Handler) requireStage(ctx gateway.AwsRequestContext, apiID string, stageName string, requestID string) (corestore.Record, protocols.ErrorResponse, bool) {
	if stage, ok := h.findStage(ctx, apiID, stageName); ok {
		return stage, protocols.ErrorResponse{}, true
	}
	return nil, h.error("NotFoundException", "Stage not found.", http.StatusNotFound, requestID), false
}

func (h *Handler) findStage(ctx gateway.AwsRequestContext, apiID string, stageName string) (corestore.Record, bool) {
	for _, stage := range h.Stages.FindBy("api_id", apiID) {
		if h.sameScope(ctx, stage) && stringField(stage, "stage_name") == stageName {
			return stage, true
		}
	}
	return nil, false
}

func (h *Handler) routesForAPI(ctx gateway.AwsRequestContext, apiID string) []corestore.Record {
	routes := []corestore.Record{}
	for _, route := range h.Routes.FindBy("api_id", apiID) {
		if h.sameScope(ctx, route) {
			routes = append(routes, route)
		}
	}
	return routes
}

func (h *Handler) stagesForAPI(ctx gateway.AwsRequestContext, apiID string) []corestore.Record {
	stages := []corestore.Record{}
	for _, stage := range h.Stages.FindBy("api_id", apiID) {
		if h.sameScope(ctx, stage) {
			stages = append(stages, stage)
		}
	}
	return stages
}

func firstStageName(stages []corestore.Record) string {
	if len(stages) == 0 {
		return ""
	}
	sort.Slice(stages, func(i int, j int) bool {
		return stringField(stages[i], "stage_name") < stringField(stages[j], "stage_name")
	})
	return stringField(stages[0], "stage_name")
}

func (h *Handler) apiResponse(api corestore.Record) map[string]any {
	out := map[string]any{
		"apiEndpoint":               stringField(api, "api_endpoint"),
		"apiId":                     stringField(api, "api_id"),
		"apiKeySelectionExpression": stringField(api, "api_key_selection_expression"),
		"createdDate":               stringField(api, "created_date"),
		"name":                      stringField(api, "name"),
		"protocolType":              stringField(api, "protocol_type"),
		"routeSelectionExpression":  stringField(api, "route_selection_expression"),
		"tags":                      tagsResponse(mapRecord(api["tags"])),
	}
	if description := stringField(api, "description"); description != "" {
		out["description"] = description
	}
	if cors := mapRecord(api["cors_configuration"]); len(cors) > 0 {
		out["corsConfiguration"] = cors
	}
	return out
}

func (h *Handler) integrationResponse(integration corestore.Record) map[string]any {
	return map[string]any{
		"apiId":                stringField(integration, "api_id"),
		"connectionType":       "INTERNET",
		"integrationId":        stringField(integration, "integration_id"),
		"integrationMethod":    stringField(integration, "integration_method"),
		"integrationType":      stringField(integration, "integration_type"),
		"integrationUri":       stringField(integration, "integration_uri"),
		"payloadFormatVersion": stringField(integration, "payload_format_version"),
		"timeoutInMillis":      intField(integration, "timeout_in_millis"),
	}
}

func (h *Handler) routeResponse(route corestore.Record) map[string]any {
	return map[string]any{
		"apiId":             stringField(route, "api_id"),
		"authorizationType": stringField(route, "authorization_type"),
		"routeId":           stringField(route, "route_id"),
		"routeKey":          stringField(route, "route_key"),
		"target":            stringField(route, "target"),
	}
}

func (h *Handler) stageResponse(stage corestore.Record) map[string]any {
	return map[string]any{
		"apiId":           stringField(stage, "api_id"),
		"autoDeploy":      boolField(stage, "auto_deploy"),
		"createdDate":     stringField(stage, "created_date"),
		"deploymentId":    stringField(stage, "deployment_id"),
		"description":     stringField(stage, "description"),
		"stageName":       stringField(stage, "stage_name"),
		"stageVariables":  stringMap(stage["stage_variables"]),
		"lastUpdatedDate": stringField(stage, "last_updated_date"),
	}
}

func lambdaTargetFromIntegrationURI(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	if strings.HasPrefix(value, "arn:aws:lambda:") {
		return value
	}
	marker := "/functions/"
	index := strings.Index(value, marker)
	if index < 0 {
		return value
	}
	rest := value[index+len(marker):]
	if end := strings.Index(rest, "/invocations"); end >= 0 {
		rest = rest[:end]
	}
	decoded, err := url.PathUnescape(rest)
	if err != nil {
		return rest
	}
	return decoded
}

func (h *Handler) apiEndpoint(apiID string) string {
	baseURL := strings.TrimRight(h.BaseURL, "/")
	if baseURL == "" {
		baseURL = "http://127.0.0.1"
	}
	return baseURL + "/_aws/apigatewayv2/" + apiID
}

func jsonResponse(status int, value map[string]any) protocols.ErrorResponse {
	body := []byte(nil)
	if status != http.StatusNoContent && value != nil {
		body, _ = json.Marshal(value)
	}
	return protocols.ErrorResponse{StatusCode: status, ContentType: jsonContentType, Headers: map[string]string{"Content-Type": jsonContentType}, Body: body}
}

func withRequestID(response protocols.ErrorResponse, requestID string) protocols.ErrorResponse {
	if response.Headers == nil {
		response.Headers = map[string]string{}
	}
	if requestID != "" {
		response.Headers["x-amzn-requestid"] = requestID
	}
	return response
}

func (h *Handler) validation(message string, requestID string) protocols.ErrorResponse {
	return h.error("BadRequestException", message, http.StatusBadRequest, requestID)
}

func (h *Handler) conflict(message string, requestID string) protocols.ErrorResponse {
	return h.error("ConflictException", message, http.StatusConflict, requestID)
}

func (h *Handler) error(code string, message string, status int, requestID string) protocols.ErrorResponse {
	return protocols.SerializeJSONError(protocols.AWSError{Code: code, Message: message, RequestID: requestID, Service: "com.amazonaws.apigatewayv2", StatusCode: status})
}

func (h *Handler) sameScope(ctx gateway.AwsRequestContext, record corestore.Record) bool {
	return stringField(record, "account_id") == h.accountID(ctx) && stringField(record, "region") == h.region(ctx)
}

func (h *Handler) accountID(ctx gateway.AwsRequestContext) string {
	return firstNonEmpty(ctx.AccountID, h.AccountID, gateway.DefaultAccountID)
}

func (h *Handler) region(ctx gateway.AwsRequestContext) string {
	return firstNonEmpty(ctx.Region, h.Region, gateway.DefaultRegion)
}

func (h *Handler) now() time.Time {
	if h.Now != nil {
		return h.Now()
	}
	return time.Now().UTC()
}

func (h *Handler) generateID(prefix string) string {
	if h.IDGenerator != nil {
		return h.IDGenerator(prefix)
	}
	var bytes [8]byte
	if _, err := rand.Read(bytes[:]); err == nil {
		if prefix == "" {
			return hex.EncodeToString(bytes[:])
		}
		return prefix + "-" + hex.EncodeToString(bytes[:])
	}
	id := fallbackIDCounter.Add(1)
	if prefix == "" {
		return fmt.Sprintf("%016x", id)
	}
	return fmt.Sprintf("%s-%016x", prefix, id)
}

func sourceIP(req *http.Request) string {
	if req == nil || req.RemoteAddr == "" {
		return ""
	}
	host := req.RemoteAddr
	if parsedHost, _, err := net.SplitHostPort(req.RemoteAddr); err == nil {
		host = parsedHost
	}
	return strings.Trim(host, "[]")
}

func pathSegments(pathValue string) []string {
	trimmed := strings.Trim(pathValue, "/")
	if trimmed == "" {
		return nil
	}
	parts := strings.Split(trimmed, "/")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		if part != "" {
			out = append(out, part)
		}
	}
	return out
}

func decodeSegment(value string) string {
	decoded, err := url.PathUnescape(value)
	if err != nil {
		return value
	}
	return decoded
}

func stringInput(input map[string]any, keys ...string) string {
	for _, key := range keys {
		if value, ok := input[key]; ok {
			return stringValue(value)
		}
	}
	return ""
}

func firstPresent(input map[string]any, keys ...string) any {
	for _, key := range keys {
		if value, ok := input[key]; ok {
			return value
		}
	}
	return nil
}

func stringValue(value any) string {
	switch v := value.(type) {
	case string:
		return v
	case json.Number:
		return v.String()
	case fmt.Stringer:
		return v.String()
	case nil:
		return ""
	default:
		return fmt.Sprint(v)
	}
}

func stringField(record corestore.Record, key string) string {
	if record == nil {
		return ""
	}
	return stringValue(record[key])
}

func intField(record corestore.Record, key string) int {
	value, _ := intValue(record[key])
	return value
}

func intInputDefault(input map[string]any, fallback int, keys ...string) int {
	for _, key := range keys {
		if value, ok := input[key]; ok {
			if parsed, ok := intValue(value); ok {
				return parsed
			}
		}
	}
	return fallback
}

func intValue(value any) (int, bool) {
	switch v := value.(type) {
	case int:
		return v, true
	case int64:
		return int(v), true
	case float64:
		return int(v), true
	case json.Number:
		parsed, err := v.Int64()
		return int(parsed), err == nil
	case string:
		parsed, err := strconv.Atoi(v)
		return parsed, err == nil
	default:
		return 0, false
	}
}

func boolInput(input map[string]any, keys ...string) bool {
	for _, key := range keys {
		if value, ok := input[key]; ok {
			return boolValue(value)
		}
	}
	return false
}

func boolField(record corestore.Record, key string) bool {
	if record == nil {
		return false
	}
	return boolValue(record[key])
}

func boolValue(value any) bool {
	switch v := value.(type) {
	case bool:
		return v
	case string:
		return strings.EqualFold(v, "true")
	default:
		return false
	}
}

func mapRecord(value any) corestore.Record {
	switch v := value.(type) {
	case corestore.Record:
		out := corestore.Record{}
		for key, value := range v {
			out[key] = value
		}
		return out
	case map[string]any:
		out := corestore.Record{}
		for key, value := range v {
			out[key] = value
		}
		return out
	case map[string]string:
		out := corestore.Record{}
		for key, value := range v {
			out[key] = value
		}
		return out
	default:
		return corestore.Record{}
	}
}

func stringMap(value any) map[string]string {
	out := map[string]string{}
	for key, value := range mapRecord(value) {
		out[key] = stringValue(value)
	}
	return out
}

func tagsMap(value any) corestore.Record {
	out := corestore.Record{}
	for key, value := range mapRecord(value) {
		out[key] = stringValue(value)
	}
	return out
}

func tagsResponse(tags corestore.Record) map[string]string {
	out := make(map[string]string, len(tags))
	for key, value := range tags {
		out[key] = stringValue(value)
	}
	return out
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}
