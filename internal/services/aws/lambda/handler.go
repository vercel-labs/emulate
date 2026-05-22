package lambda

import (
	"crypto/sha256"
	"encoding/base64"
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
	"github.com/vercel-labs/emulate/internal/services/aws/auth"
	"github.com/vercel-labs/emulate/internal/services/aws/gateway"
	"github.com/vercel-labs/emulate/internal/services/aws/protocols"
)

const jsonContentType = "application/json"

type Handler struct {
	Functions               *corestore.Collection
	Versions                *corestore.Collection
	Aliases                 *corestore.Collection
	LogGroups               *corestore.Collection
	LogStreams              *corestore.Collection
	LogEvents               *corestore.Collection
	AccountID               string
	Region                  string
	AllowLocalCodeExecution bool
	Now                     func() time.Time
	IDGenerator             func(string) string
}

type route struct {
	Action       string
	FunctionName string
	Qualifier    string
	AliasName    string
	StatementID  string
	Resource     string
}

type functionListItem struct {
	Record  corestore.Record
	Version string
}

type functionIdentifier struct {
	Name      string
	Qualifier string
	Region    string
	AccountID string
	ARN       bool
}

var fallbackIDCounter atomic.Uint64

func (h *Handler) Handle(req *http.Request, ctx gateway.AwsRequestContext) protocols.ErrorResponse {
	requestID := ctx.RequestID
	if requestID == "" {
		requestID = h.generateID("req")
	}
	route, ok := parseRoute(req)
	if !ok {
		return withRequestID(h.error("NotImplementedException", "lambda route is not implemented in the native Go runtime yet.", http.StatusNotImplemented, requestID), requestID)
	}
	if ctx.Action == "" {
		ctx.Action = route.Action
	}

	var response protocols.ErrorResponse
	switch route.Action {
	case "CreateFunction":
		response = h.createFunction(ctx, requestID)
	case "GetFunction":
		response = h.getFunction(ctx, route, requestID)
	case "GetFunctionConfiguration":
		response = h.getFunctionConfiguration(ctx, route, requestID)
	case "ListFunctions":
		response = h.listFunctions(ctx, requestID)
	case "DeleteFunction":
		response = h.deleteFunction(ctx, route, requestID)
	case "UpdateFunctionConfiguration":
		response = h.updateFunctionConfiguration(ctx, route, requestID)
	case "UpdateFunctionCode":
		response = h.updateFunctionCode(ctx, route, requestID)
	case "Invoke":
		response = h.invoke(req, ctx, route, requestID)
	case "PublishVersion":
		response = h.publishVersion(ctx, route, requestID)
	case "ListVersionsByFunction":
		response = h.listVersionsByFunction(ctx, route, requestID)
	case "CreateAlias":
		response = h.createAlias(ctx, route, requestID)
	case "GetAlias":
		response = h.getAlias(ctx, route, requestID)
	case "ListAliases":
		response = h.listAliases(ctx, route, requestID)
	case "UpdateAlias":
		response = h.updateAlias(ctx, route, requestID)
	case "DeleteAlias":
		response = h.deleteAlias(ctx, route, requestID)
	case "TagResource":
		response = h.tagResource(ctx, route, requestID)
	case "UntagResource":
		response = h.untagResource(req, ctx, route, requestID)
	case "ListTags":
		response = h.listTags(ctx, route, requestID)
	case "AddPermission":
		response = h.addPermission(ctx, route, requestID)
	case "GetPolicy":
		response = h.getPolicy(ctx, route, requestID)
	case "RemovePermission":
		response = h.removePermission(ctx, route, requestID)
	default:
		response = h.error("NotImplementedException", fmt.Sprintf("lambda.%s is not implemented in the native Go runtime yet.", route.Action), http.StatusNotImplemented, requestID)
	}
	return withRequestID(response, requestID)
}

func (h *Handler) createFunction(ctx gateway.AwsRequestContext, requestID string) protocols.ErrorResponse {
	input, response, ok := h.input(ctx, requestID)
	if !ok {
		return response
	}
	name := strings.TrimSpace(stringInput(input, "FunctionName", "functionName"))
	if name == "" {
		return h.validation("FunctionName is required.", requestID)
	}
	if _, ok := h.findFunction(ctx, name); ok {
		return h.error("ResourceConflictException", "Function already exists.", http.StatusConflict, requestID)
	}
	runtime := strings.TrimSpace(stringInput(input, "Runtime", "runtime"))
	role := strings.TrimSpace(stringInput(input, "Role", "role"))
	handlerName := strings.TrimSpace(stringInput(input, "Handler", "handler"))
	packageType := firstNonEmpty(stringInput(input, "PackageType", "packageType"), "Zip")
	if packageType == "Zip" {
		if runtime == "" {
			return h.validation("Runtime is required for Zip functions.", requestID)
		}
		if handlerName == "" {
			return h.validation("Handler is required for Zip functions.", requestID)
		}
	}
	if role == "" {
		return h.validation("Role is required.", requestID)
	}
	codeValue := inputValue(input, "Code", "code")
	codeSize, codeSHA := codeSummary(codeValue)
	codeZip := codeZipBase64(codeValue)
	now := h.now().UTC()
	record := h.Functions.Insert(corestore.Record{
		"account_id":          h.accountID(ctx),
		"region":              h.region(ctx),
		"function_name":       name,
		"arn":                 functionARN(h.region(ctx), h.accountID(ctx), name),
		"runtime":             runtime,
		"role":                role,
		"handler":             handlerName,
		"description":         stringInput(input, "Description", "description"),
		"timeout":             intInputDefault(input, 3, "Timeout", "timeout"),
		"memory_size":         intInputDefault(input, 128, "MemorySize", "memorySize"),
		"package_type":        packageType,
		"architectures":       stringListDefault(inputValue(input, "Architectures", "architectures"), []string{"x86_64"}),
		"code_size":           codeSize,
		"code_sha256":         codeSHA,
		"code_zip_base64":     codeZip,
		"version":             "$LATEST",
		"revision_id":         h.generateID("rev"),
		"last_modified":       formatLambdaTime(now),
		"state":               "Active",
		"state_reason":        "The function is active in the local emulator.",
		"state_reason_code":   "Idle",
		"last_update_status":  "Successful",
		"environment":         environmentVariables(inputValue(input, "Environment", "environment")),
		"tags":                tagsMap(inputValue(input, "Tags", "tags")),
		"policy_statements":   []corestore.Record{},
		"invoke_payload":      stringInput(input, "InvokePayload", "invokePayload"),
		"log_group_name":      logGroupName(name),
		"tracing_mode":        tracingMode(inputValue(input, "TracingConfig", "tracingConfig")),
		"ephemeral_storage":   ephemeralStorage(inputValue(input, "EphemeralStorage", "ephemeralStorage")),
		"kms_key_arn":         stringInput(input, "KMSKeyArn", "kmsKeyArn"),
		"dead_letter_target":  deadLetterTarget(inputValue(input, "DeadLetterConfig", "deadLetterConfig")),
		"snap_start_apply_on": snapStartApplyOn(inputValue(input, "SnapStart", "snapStart")),
	})
	h.ensureLogGroup(ctx, name)
	return jsonResponse(http.StatusCreated, h.functionConfiguration(record, "$LATEST"))
}

func (h *Handler) getFunction(ctx gateway.AwsRequestContext, route route, requestID string) protocols.ErrorResponse {
	fn, response, ok := h.requireFunction(ctx, route.FunctionName, requestID)
	if !ok {
		return response
	}
	version := h.resolveQualifier(route, ctx)
	config, response, ok := h.configForQualifier(ctx, fn, version, requestID)
	if !ok {
		return response
	}
	return jsonResponse(http.StatusOK, map[string]any{
		"Configuration": config,
		"Code": map[string]any{
			"RepositoryType": "Local",
			"Location":       "local://" + stringField(fn, "function_name"),
		},
		"Tags": tagsResponse(mapRecord(fn["tags"])),
	})
}

func (h *Handler) getFunctionConfiguration(ctx gateway.AwsRequestContext, route route, requestID string) protocols.ErrorResponse {
	fn, response, ok := h.requireFunction(ctx, route.FunctionName, requestID)
	if !ok {
		return response
	}
	config, response, ok := h.configForQualifier(ctx, fn, h.resolveQualifier(route, ctx), requestID)
	if !ok {
		return response
	}
	return jsonResponse(http.StatusOK, config)
}

func (h *Handler) listFunctions(ctx gateway.AwsRequestContext, requestID string) protocols.ErrorResponse {
	functions := []corestore.Record{}
	for _, fn := range h.Functions.All() {
		if h.sameScope(ctx, fn) {
			functions = append(functions, fn)
		}
	}
	sort.Slice(functions, func(i int, j int) bool {
		return stringField(functions[i], "function_name") < stringField(functions[j], "function_name")
	})
	includeVersions := strings.EqualFold(stringInput(ctx.Input, "FunctionVersion", "functionVersion"), "ALL")
	items := make([]functionListItem, 0, len(functions))
	for _, fn := range functions {
		items = append(items, functionListItem{Record: fn, Version: "$LATEST"})
		if !includeVersions {
			continue
		}
		versions := []corestore.Record{}
		for _, version := range h.Versions.FindBy("function_name", stringField(fn, "function_name")) {
			if h.sameScope(ctx, version) {
				versions = append(versions, version)
			}
		}
		sort.SliceStable(versions, func(i int, j int) bool {
			return versionSortValue(stringField(versions[i], "version")) < versionSortValue(stringField(versions[j], "version"))
		})
		for _, version := range versions {
			items = append(items, functionListItem{Record: version, Version: stringField(version, "version")})
		}
	}
	start, end, nextMarker, response, ok := h.pageBounds(ctx.Input, len(items), 50, 10000, "Marker", "MaxItems", requestID)
	if !ok {
		return response
	}
	out := make([]map[string]any, 0, end-start)
	for _, item := range items[start:end] {
		out = append(out, h.functionConfiguration(item.Record, item.Version))
	}
	body := map[string]any{"Functions": out}
	if nextMarker != "" {
		body["NextMarker"] = nextMarker
	}
	return jsonResponse(http.StatusOK, body)
}

func (h *Handler) deleteFunction(ctx gateway.AwsRequestContext, route route, requestID string) protocols.ErrorResponse {
	fn, response, ok := h.requireFunction(ctx, route.FunctionName, requestID)
	if !ok {
		return response
	}
	functionName := stringField(fn, "function_name")
	qualifier := h.resolveQualifier(route, ctx)
	if qualifier != "" && qualifier != "$LATEST" {
		var target corestore.Record
		for _, version := range h.Versions.FindBy("function_name", functionName) {
			if h.sameScope(ctx, version) && stringField(version, "version") == qualifier {
				target = version
				break
			}
		}
		if target == nil {
			return h.notFound("Function version not found.", requestID)
		}
		for _, alias := range h.Aliases.FindBy("function_name", functionName) {
			if h.sameScope(ctx, alias) && aliasReferencesVersion(alias, qualifier) {
				return h.error("ResourceConflictException", "Function version is referenced by an alias.", http.StatusConflict, requestID)
			}
		}
		h.Versions.Delete(intField(target, "id"))
		return jsonResponse(http.StatusNoContent, map[string]any{})
	}
	for _, alias := range h.Aliases.FindBy("function_name", functionName) {
		if h.sameScope(ctx, alias) {
			h.Aliases.Delete(intField(alias, "id"))
		}
	}
	for _, version := range h.Versions.FindBy("function_name", functionName) {
		if h.sameScope(ctx, version) {
			h.Versions.Delete(intField(version, "id"))
		}
	}
	h.Functions.Delete(intField(fn, "id"))
	return jsonResponse(http.StatusNoContent, map[string]any{})
}

func (h *Handler) updateFunctionConfiguration(ctx gateway.AwsRequestContext, route route, requestID string) protocols.ErrorResponse {
	fn, response, ok := h.requireFunction(ctx, route.FunctionName, requestID)
	if !ok {
		return response
	}
	input, response, ok := h.input(ctx, requestID)
	if !ok {
		return response
	}
	patch := corestore.Record{
		"revision_id":        h.generateID("rev"),
		"last_modified":      formatLambdaTime(h.now().UTC()),
		"last_update_status": "Successful",
	}
	copyStringPatch(patch, input, "runtime", "Runtime", "runtime")
	copyStringPatch(patch, input, "role", "Role", "role")
	copyStringPatch(patch, input, "handler", "Handler", "handler")
	copyStringPatch(patch, input, "description", "Description", "description")
	copyStringPatch(patch, input, "kms_key_arn", "KMSKeyArn", "kmsKeyArn")
	if value, ok := optionalIntInput(input, "Timeout", "timeout"); ok {
		patch["timeout"] = value
	}
	if value, ok := optionalIntInput(input, "MemorySize", "memorySize"); ok {
		patch["memory_size"] = value
	}
	if value := inputValue(input, "Environment", "environment"); value != nil {
		patch["environment"] = environmentVariables(value)
	}
	if value := inputValue(input, "TracingConfig", "tracingConfig"); value != nil {
		patch["tracing_mode"] = tracingMode(value)
	}
	if value := inputValue(input, "EphemeralStorage", "ephemeralStorage"); value != nil {
		patch["ephemeral_storage"] = ephemeralStorage(value)
	}
	if value := inputValue(input, "DeadLetterConfig", "deadLetterConfig"); value != nil {
		patch["dead_letter_target"] = deadLetterTarget(value)
	}
	if value := inputValue(input, "Architectures", "architectures"); value != nil {
		patch["architectures"] = stringListDefault(value, []string{"x86_64"})
	}
	updated, _ := h.Functions.Update(intField(fn, "id"), patch)
	return jsonResponse(http.StatusOK, h.functionConfiguration(updated, "$LATEST"))
}

func (h *Handler) updateFunctionCode(ctx gateway.AwsRequestContext, route route, requestID string) protocols.ErrorResponse {
	fn, response, ok := h.requireFunction(ctx, route.FunctionName, requestID)
	if !ok {
		return response
	}
	input, response, ok := h.input(ctx, requestID)
	if !ok {
		return response
	}
	codeSize, codeSHA := codeSummary(input)
	codeZip := codeZipBase64(input)
	updated, _ := h.Functions.Update(intField(fn, "id"), corestore.Record{
		"code_size":          codeSize,
		"code_sha256":        codeSHA,
		"code_zip_base64":    codeZip,
		"revision_id":        h.generateID("rev"),
		"last_modified":      formatLambdaTime(h.now().UTC()),
		"last_update_status": "Successful",
	})
	return jsonResponse(http.StatusOK, h.functionConfiguration(updated, "$LATEST"))
}

func (h *Handler) invoke(req *http.Request, ctx gateway.AwsRequestContext, route route, requestID string) protocols.ErrorResponse {
	fn, response, ok := h.requireFunction(ctx, route.FunctionName, requestID)
	if !ok {
		return response
	}
	invocationType := firstNonEmpty(req.URL.Query().Get("InvocationType"), req.Header.Get("X-Amz-Invocation-Type"), "RequestResponse")
	logType := firstNonEmpty(req.URL.Query().Get("LogType"), req.Header.Get("X-Amz-Log-Type"))
	invoked, executedVersion, response, ok := h.recordForQualifier(ctx, fn, h.resolveQualifier(route, ctx), requestID)
	if !ok {
		return response
	}
	if invocationType == "DryRun" {
		return lambdaBodyResponse(http.StatusNoContent, nil, map[string]string{"x-amz-executed-version": executedVersion})
	}
	if invocationType == "Event" {
		h.recordInvocation(ctx, invoked, requestID, invocationType, executedVersion, []string{"Lambda async invoke accepted RequestId: " + requestID})
		return lambdaBodyResponse(http.StatusAccepted, nil, map[string]string{"x-amz-executed-version": executedVersion})
	}
	payload := []byte(strings.TrimSpace(stringField(invoked, "invoke_payload")))
	if len(payload) == 0 {
		payload = []byte("{}")
	}
	logLines := []string{"Lambda API-only invoke " + invocationType + " RequestId: " + requestID}
	functionError := ""
	if h.localCodeExecutionAllowed(req, ctx) {
		if result, ran := h.invokeLocalNode(ctx, invoked, executedVersion, ctx.RawBody, requestID); ran {
			payload = result.Payload
			logLines = result.Logs
			functionError = result.FunctionError
		}
	}
	tail := h.recordInvocation(ctx, invoked, requestID, invocationType, executedVersion, logLines)
	headers := map[string]string{"x-amz-executed-version": executedVersion}
	if functionError != "" {
		headers["x-amz-function-error"] = functionError
	}
	if logType == "Tail" {
		headers["x-amz-log-result"] = tail
	}
	return lambdaBodyResponse(http.StatusOK, payload, headers)
}

func (h *Handler) localCodeExecutionAllowed(req *http.Request, ctx gateway.AwsRequestContext) bool {
	return h.AllowLocalCodeExecution && ctx.Auth.Status == auth.StatusKnown && isDirectLocalRequest(req)
}

func isDirectLocalRequest(req *http.Request) bool {
	return isLoopbackRequest(req) && isLocalRequestHost(req) && !hasForwardedRequestHeaders(req)
}

func isLoopbackRequest(req *http.Request) bool {
	if req == nil || req.RemoteAddr == "" {
		return false
	}
	host := req.RemoteAddr
	if parsedHost, _, err := net.SplitHostPort(req.RemoteAddr); err == nil {
		host = parsedHost
	}
	host = strings.Trim(host, "[]")
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func isLocalRequestHost(req *http.Request) bool {
	if req == nil {
		return false
	}
	host := strings.TrimSpace(req.Host)
	if host == "" && req.URL != nil {
		host = strings.TrimSpace(req.URL.Host)
	}
	if host == "" {
		return false
	}
	if parsedHost, _, err := net.SplitHostPort(host); err == nil {
		host = parsedHost
	}
	host = strings.Trim(strings.TrimSuffix(strings.ToLower(host), "."), "[]")
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func hasForwardedRequestHeaders(req *http.Request) bool {
	if req == nil {
		return false
	}
	for _, header := range []string{"Forwarded", "X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto", "X-Real-IP"} {
		if strings.TrimSpace(req.Header.Get(header)) != "" {
			return true
		}
	}
	return false
}

func (h *Handler) publishVersion(ctx gateway.AwsRequestContext, route route, requestID string) protocols.ErrorResponse {
	fn, response, ok := h.requireFunction(ctx, route.FunctionName, requestID)
	if !ok {
		return response
	}
	functionName := stringField(fn, "function_name")
	next := 1
	for _, version := range h.Versions.FindBy("function_name", functionName) {
		if h.sameScope(ctx, version) {
			if parsed, err := strconv.Atoi(stringField(version, "version")); err == nil && parsed >= next {
				next = parsed + 1
			}
		}
	}
	versionValue := strconv.Itoa(next)
	record := cloneRecord(fn)
	record["id"] = nil
	record["version"] = versionValue
	record["arn"] = stringField(fn, "arn") + ":" + versionValue
	record["source_revision_id"] = stringField(fn, "revision_id")
	record["revision_id"] = h.generateID("rev")
	record["description"] = firstNonEmpty(stringInput(ctx.Input, "Description", "description"), stringField(fn, "description"))
	inserted := h.Versions.Insert(record)
	return jsonResponse(http.StatusCreated, h.functionConfiguration(inserted, versionValue))
}

func (h *Handler) listVersionsByFunction(ctx gateway.AwsRequestContext, route route, requestID string) protocols.ErrorResponse {
	fn, response, ok := h.requireFunction(ctx, route.FunctionName, requestID)
	if !ok {
		return response
	}
	functionName := stringField(fn, "function_name")
	versions := []corestore.Record{fn}
	for _, version := range h.Versions.FindBy("function_name", functionName) {
		if h.sameScope(ctx, version) {
			versions = append(versions, version)
		}
	}
	sort.SliceStable(versions, func(i int, j int) bool {
		return versionSortValue(stringField(versions[i], "version")) < versionSortValue(stringField(versions[j], "version"))
	})
	start, end, nextMarker, pageResponse, ok := h.pageBounds(ctx.Input, len(versions), 50, 10000, "Marker", "MaxItems", requestID)
	if !ok {
		return pageResponse
	}
	out := make([]map[string]any, 0, end-start)
	for _, version := range versions[start:end] {
		out = append(out, h.functionConfiguration(version, stringField(version, "version")))
	}
	body := map[string]any{"Versions": out}
	if nextMarker != "" {
		body["NextMarker"] = nextMarker
	}
	return jsonResponse(http.StatusOK, body)
}

func (h *Handler) createAlias(ctx gateway.AwsRequestContext, route route, requestID string) protocols.ErrorResponse {
	fn, response, ok := h.requireFunction(ctx, route.FunctionName, requestID)
	if !ok {
		return response
	}
	input, response, ok := h.input(ctx, requestID)
	if !ok {
		return response
	}
	name := strings.TrimSpace(stringInput(input, "Name", "name"))
	if name == "" {
		return h.validation("Name is required.", requestID)
	}
	functionName := stringField(fn, "function_name")
	if _, ok := h.findAlias(ctx, functionName, name); ok {
		return h.error("ResourceConflictException", "Alias already exists.", http.StatusConflict, requestID)
	}
	version := firstNonEmpty(stringInput(input, "FunctionVersion", "functionVersion"), "$LATEST")
	if !h.versionExists(ctx, functionName, version) {
		return h.notFound("Function version not found.", requestID)
	}
	record := h.Aliases.Insert(corestore.Record{
		"account_id":         h.accountID(ctx),
		"region":             h.region(ctx),
		"function_name":      functionName,
		"name":               name,
		"arn":                stringField(fn, "arn") + ":" + name,
		"function_version":   version,
		"description":        stringInput(input, "Description", "description"),
		"revision_id":        h.generateID("rev"),
		"routing_config":     routingConfig(inputValue(input, "RoutingConfig", "routingConfig")),
		"last_modified_time": formatLambdaTime(h.now().UTC()),
	})
	return jsonResponse(http.StatusCreated, aliasResponse(record))
}

func (h *Handler) getAlias(ctx gateway.AwsRequestContext, route route, requestID string) protocols.ErrorResponse {
	fn, response, ok := h.requireFunction(ctx, route.FunctionName, requestID)
	if !ok {
		return response
	}
	alias, response, ok := h.requireAlias(ctx, stringField(fn, "function_name"), route.AliasName, requestID)
	if !ok {
		return response
	}
	return jsonResponse(http.StatusOK, aliasResponse(alias))
}

func (h *Handler) listAliases(ctx gateway.AwsRequestContext, route route, requestID string) protocols.ErrorResponse {
	fn, response, ok := h.requireFunction(ctx, route.FunctionName, requestID)
	if !ok {
		return response
	}
	functionName := stringField(fn, "function_name")
	versionFilter := strings.TrimSpace(stringInput(ctx.Input, "FunctionVersion", "functionVersion"))
	aliases := []corestore.Record{}
	for _, alias := range h.Aliases.FindBy("function_name", functionName) {
		if h.sameScope(ctx, alias) && (versionFilter == "" || stringField(alias, "function_version") == versionFilter) {
			aliases = append(aliases, alias)
		}
	}
	sort.Slice(aliases, func(i int, j int) bool { return stringField(aliases[i], "name") < stringField(aliases[j], "name") })
	start, end, nextMarker, pageResponse, ok := h.pageBounds(ctx.Input, len(aliases), 50, 10000, "Marker", "MaxItems", requestID)
	if !ok {
		return pageResponse
	}
	out := make([]map[string]any, 0, end-start)
	for _, alias := range aliases[start:end] {
		out = append(out, aliasResponse(alias))
	}
	body := map[string]any{"Aliases": out}
	if nextMarker != "" {
		body["NextMarker"] = nextMarker
	}
	return jsonResponse(http.StatusOK, body)
}

func (h *Handler) updateAlias(ctx gateway.AwsRequestContext, route route, requestID string) protocols.ErrorResponse {
	fn, response, ok := h.requireFunction(ctx, route.FunctionName, requestID)
	if !ok {
		return response
	}
	alias, response, ok := h.requireAlias(ctx, stringField(fn, "function_name"), route.AliasName, requestID)
	if !ok {
		return response
	}
	input, response, ok := h.input(ctx, requestID)
	if !ok {
		return response
	}
	patch := corestore.Record{
		"revision_id":        h.generateID("rev"),
		"last_modified_time": formatLambdaTime(h.now().UTC()),
	}
	copyStringPatch(patch, input, "description", "Description", "description")
	if version := strings.TrimSpace(stringInput(input, "FunctionVersion", "functionVersion")); version != "" {
		if !h.versionExists(ctx, stringField(fn, "function_name"), version) {
			return h.notFound("Function version not found.", requestID)
		}
		patch["function_version"] = version
	}
	if value := inputValue(input, "RoutingConfig", "routingConfig"); value != nil {
		patch["routing_config"] = routingConfig(value)
	}
	updated, _ := h.Aliases.Update(intField(alias, "id"), patch)
	return jsonResponse(http.StatusOK, aliasResponse(updated))
}

func (h *Handler) deleteAlias(ctx gateway.AwsRequestContext, route route, requestID string) protocols.ErrorResponse {
	fn, response, ok := h.requireFunction(ctx, route.FunctionName, requestID)
	if !ok {
		return response
	}
	alias, response, ok := h.requireAlias(ctx, stringField(fn, "function_name"), route.AliasName, requestID)
	if !ok {
		return response
	}
	h.Aliases.Delete(intField(alias, "id"))
	return jsonResponse(http.StatusNoContent, map[string]any{})
}

func (h *Handler) tagResource(ctx gateway.AwsRequestContext, route route, requestID string) protocols.ErrorResponse {
	fn, response, ok := h.requireFunctionByResource(ctx, route.Resource, requestID)
	if !ok {
		return response
	}
	input, response, ok := h.input(ctx, requestID)
	if !ok {
		return response
	}
	tags := mapRecord(fn["tags"])
	for key, value := range tagsMap(inputValue(input, "Tags", "tags")) {
		tags[key] = value
	}
	h.Functions.Update(intField(fn, "id"), corestore.Record{"tags": tags})
	return jsonResponse(http.StatusNoContent, map[string]any{})
}

func (h *Handler) untagResource(req *http.Request, ctx gateway.AwsRequestContext, route route, requestID string) protocols.ErrorResponse {
	fn, response, ok := h.requireFunctionByResource(ctx, route.Resource, requestID)
	if !ok {
		return response
	}
	tags := mapRecord(fn["tags"])
	for _, key := range req.URL.Query()["tagKeys"] {
		delete(tags, key)
	}
	for _, key := range req.URL.Query()["TagKeys"] {
		delete(tags, key)
	}
	h.Functions.Update(intField(fn, "id"), corestore.Record{"tags": tags})
	return jsonResponse(http.StatusNoContent, map[string]any{})
}

func (h *Handler) listTags(ctx gateway.AwsRequestContext, route route, requestID string) protocols.ErrorResponse {
	fn, response, ok := h.requireFunctionByResource(ctx, route.Resource, requestID)
	if !ok {
		return response
	}
	return jsonResponse(http.StatusOK, map[string]any{"Tags": tagsResponse(mapRecord(fn["tags"]))})
}

func (h *Handler) addPermission(ctx gateway.AwsRequestContext, route route, requestID string) protocols.ErrorResponse {
	fn, response, ok := h.requireFunction(ctx, route.FunctionName, requestID)
	if !ok {
		return response
	}
	input, response, ok := h.input(ctx, requestID)
	if !ok {
		return response
	}
	statementID := strings.TrimSpace(stringInput(input, "StatementId", "statementId"))
	if statementID == "" {
		return h.validation("StatementId is required.", requestID)
	}
	statements := recordList(fn["policy_statements"])
	for _, statement := range statements {
		if stringField(statement, "sid") == statementID {
			return h.error("ResourceConflictException", "Statement already exists.", http.StatusConflict, requestID)
		}
	}
	statement := corestore.Record{
		"sid":            statementID,
		"effect":         "Allow",
		"action":         stringInput(input, "Action", "action"),
		"principal":      stringInput(input, "Principal", "principal"),
		"source_arn":     stringInput(input, "SourceArn", "sourceArn"),
		"source_account": stringInput(input, "SourceAccount", "sourceAccount"),
		"resource":       policyResourceARN(fn, h.resolveQualifier(route, ctx)),
	}
	statements = append(statements, statement)
	updated, _ := h.Functions.Update(intField(fn, "id"), corestore.Record{"policy_statements": statements, "revision_id": h.generateID("rev")})
	_ = updated
	return jsonResponse(http.StatusCreated, map[string]any{"Statement": policyStatementJSON(statement)})
}

func (h *Handler) getPolicy(ctx gateway.AwsRequestContext, route route, requestID string) protocols.ErrorResponse {
	fn, response, ok := h.requireFunction(ctx, route.FunctionName, requestID)
	if !ok {
		return response
	}
	return jsonResponse(http.StatusOK, map[string]any{"Policy": policyDocument(fn), "RevisionId": stringField(fn, "revision_id")})
}

func (h *Handler) removePermission(ctx gateway.AwsRequestContext, route route, requestID string) protocols.ErrorResponse {
	fn, response, ok := h.requireFunction(ctx, route.FunctionName, requestID)
	if !ok {
		return response
	}
	statements := recordList(fn["policy_statements"])
	kept := make([]corestore.Record, 0, len(statements))
	removed := false
	for _, statement := range statements {
		if stringField(statement, "sid") == route.StatementID {
			removed = true
			continue
		}
		kept = append(kept, statement)
	}
	if !removed {
		return h.notFound("Statement not found.", requestID)
	}
	h.Functions.Update(intField(fn, "id"), corestore.Record{"policy_statements": kept, "revision_id": h.generateID("rev")})
	return jsonResponse(http.StatusNoContent, map[string]any{})
}

func (h *Handler) configForQualifier(ctx gateway.AwsRequestContext, fn corestore.Record, qualifier string, requestID string) (map[string]any, protocols.ErrorResponse, bool) {
	record, version, response, ok := h.recordForQualifier(ctx, fn, qualifier, requestID)
	if !ok {
		return nil, response, false
	}
	return h.functionConfiguration(record, version), protocols.ErrorResponse{}, true
}

func (h *Handler) recordForQualifier(ctx gateway.AwsRequestContext, fn corestore.Record, qualifier string, requestID string) (corestore.Record, string, protocols.ErrorResponse, bool) {
	qualifier = strings.TrimSpace(qualifier)
	if qualifier == "" || qualifier == "$LATEST" {
		return fn, "$LATEST", protocols.ErrorResponse{}, true
	}
	functionName := stringField(fn, "function_name")
	for _, version := range h.Versions.FindBy("function_name", functionName) {
		if h.sameScope(ctx, version) && stringField(version, "version") == qualifier {
			return version, qualifier, protocols.ErrorResponse{}, true
		}
	}
	if alias, ok := h.findAlias(ctx, functionName, qualifier); ok {
		targetVersion := firstNonEmpty(stringField(alias, "function_version"), "$LATEST")
		return h.recordForQualifier(ctx, fn, targetVersion, requestID)
	}
	return nil, "", h.notFound("Function qualifier not found.", requestID), false
}

func (h *Handler) functionConfiguration(fn corestore.Record, version string) map[string]any {
	if version == "" {
		version = stringField(fn, "version")
	}
	if version == "" {
		version = "$LATEST"
	}
	arn := stringField(fn, "arn")
	if version != "$LATEST" && !strings.HasSuffix(arn, ":"+version) {
		arn = arn + ":" + version
	}
	body := map[string]any{
		"FunctionName":     stringField(fn, "function_name"),
		"FunctionArn":      arn,
		"Runtime":          stringField(fn, "runtime"),
		"Role":             stringField(fn, "role"),
		"Handler":          stringField(fn, "handler"),
		"CodeSize":         intField(fn, "code_size"),
		"Description":      stringField(fn, "description"),
		"Timeout":          intFieldDefault(fn, "timeout", 3),
		"MemorySize":       intFieldDefault(fn, "memory_size", 128),
		"LastModified":     stringField(fn, "last_modified"),
		"CodeSha256":       stringField(fn, "code_sha256"),
		"Version":          version,
		"RevisionId":       stringField(fn, "revision_id"),
		"State":            firstNonEmpty(stringField(fn, "state"), "Active"),
		"StateReason":      stringField(fn, "state_reason"),
		"StateReasonCode":  stringField(fn, "state_reason_code"),
		"LastUpdateStatus": firstNonEmpty(stringField(fn, "last_update_status"), "Successful"),
		"PackageType":      firstNonEmpty(stringField(fn, "package_type"), "Zip"),
		"Architectures":    stringListDefault(fn["architectures"], []string{"x86_64"}),
		"Environment":      map[string]any{"Variables": tagsResponse(mapRecord(fn["environment"]))},
		"TracingConfig":    map[string]any{"Mode": firstNonEmpty(stringField(fn, "tracing_mode"), "PassThrough")},
		"EphemeralStorage": map[string]any{"Size": intFieldDefault(fn, "ephemeral_storage", 512)},
		"LoggingConfig":    map[string]any{"LogFormat": "Text", "LogGroup": firstNonEmpty(stringField(fn, "log_group_name"), logGroupName(stringField(fn, "function_name")))},
	}
	if value := stringField(fn, "kms_key_arn"); value != "" {
		body["KMSKeyArn"] = value
	}
	if value := stringField(fn, "dead_letter_target"); value != "" {
		body["DeadLetterConfig"] = map[string]any{"TargetArn": value}
	}
	if value := stringField(fn, "snap_start_apply_on"); value != "" {
		body["SnapStart"] = map[string]any{"ApplyOn": value, "OptimizationStatus": "Off"}
	}
	return body
}

func aliasResponse(alias corestore.Record) map[string]any {
	body := map[string]any{
		"AliasArn":        stringField(alias, "arn"),
		"Name":            stringField(alias, "name"),
		"FunctionVersion": stringField(alias, "function_version"),
		"Description":     stringField(alias, "description"),
		"RevisionId":      stringField(alias, "revision_id"),
	}
	if routing := mapRecord(alias["routing_config"]); len(routing) > 0 {
		body["RoutingConfig"] = routing
	}
	return body
}

func aliasReferencesVersion(alias corestore.Record, version string) bool {
	version = strings.TrimSpace(version)
	if version == "" {
		return false
	}
	if stringField(alias, "function_version") == version {
		return true
	}
	routing := mapRecord(alias["routing_config"])
	for _, key := range []string{"AdditionalVersionWeights", "additionalVersionWeights"} {
		weights := mapRecord(routing[key])
		if _, ok := weights[version]; ok {
			return true
		}
	}
	return false
}

func (h *Handler) input(ctx gateway.AwsRequestContext, requestID string) (map[string]any, protocols.ErrorResponse, bool) {
	if len(ctx.Input) > 0 {
		return cloneAnyMap(ctx.Input), protocols.ErrorResponse{}, true
	}
	input := map[string]any{}
	if len(strings.TrimSpace(string(ctx.RawBody))) == 0 {
		return input, protocols.ErrorResponse{}, true
	}
	decoder := json.NewDecoder(strings.NewReader(string(ctx.RawBody)))
	decoder.UseNumber()
	if err := decoder.Decode(&input); err != nil {
		return nil, h.validation("Request body must be valid JSON.", requestID), false
	}
	return input, protocols.ErrorResponse{}, true
}

func (h *Handler) requireFunction(ctx gateway.AwsRequestContext, name string, requestID string) (corestore.Record, protocols.ErrorResponse, bool) {
	fn, ok := h.findFunction(ctx, name)
	if !ok {
		return nil, h.notFound("Function not found.", requestID), false
	}
	return fn, protocols.ErrorResponse{}, true
}

func (h *Handler) requireFunctionByResource(ctx gateway.AwsRequestContext, resource string, requestID string) (corestore.Record, protocols.ErrorResponse, bool) {
	resource = strings.TrimSpace(resource)
	for _, fn := range h.Functions.All() {
		if !h.sameScope(ctx, fn) {
			continue
		}
		if stringField(fn, "arn") == resource || stringField(fn, "function_name") == resource {
			return fn, protocols.ErrorResponse{}, true
		}
	}
	name := nameFromFunctionIdentifier(resource)
	if name == "" {
		return nil, h.notFound("Function not found.", requestID), false
	}
	return h.requireFunction(ctx, resource, requestID)
}

func (h *Handler) findFunction(ctx gateway.AwsRequestContext, identifier string) (corestore.Record, bool) {
	parsed := parseFunctionIdentifier(identifier)
	if parsed.Name == "" {
		return nil, false
	}
	if parsed.ARN && (parsed.AccountID != h.accountID(ctx) || parsed.Region != h.region(ctx)) {
		return nil, false
	}
	for _, fn := range h.Functions.FindBy("function_name", parsed.Name) {
		if !h.sameScope(ctx, fn) {
			continue
		}
		return fn, true
	}
	return nil, false
}

func (h *Handler) requireAlias(ctx gateway.AwsRequestContext, functionName string, aliasName string, requestID string) (corestore.Record, protocols.ErrorResponse, bool) {
	alias, ok := h.findAlias(ctx, functionName, aliasName)
	if !ok {
		return nil, h.notFound("Alias not found.", requestID), false
	}
	return alias, protocols.ErrorResponse{}, true
}

func (h *Handler) findAlias(ctx gateway.AwsRequestContext, functionName string, aliasName string) (corestore.Record, bool) {
	for _, alias := range h.Aliases.FindBy("function_name", functionName) {
		if h.sameScope(ctx, alias) && stringField(alias, "name") == aliasName {
			return alias, true
		}
	}
	return nil, false
}

func (h *Handler) versionExists(ctx gateway.AwsRequestContext, functionName string, version string) bool {
	if version == "$LATEST" || version == "" {
		return true
	}
	for _, item := range h.Versions.FindBy("function_name", functionName) {
		if h.sameScope(ctx, item) && stringField(item, "version") == version {
			return true
		}
	}
	return false
}

func (h *Handler) resolveQualifier(route route, ctx gateway.AwsRequestContext) string {
	return firstNonEmpty(route.Qualifier, stringInput(ctx.Input, "Qualifier", "qualifier"), parseFunctionIdentifier(route.FunctionName).Qualifier)
}

func (h *Handler) ensureLogGroup(ctx gateway.AwsRequestContext, functionName string) {
	if h.LogGroups == nil {
		return
	}
	name := logGroupName(functionName)
	for _, group := range h.LogGroups.FindBy("log_group_name", name) {
		if h.sameScope(ctx, group) {
			return
		}
	}
	h.LogGroups.Insert(corestore.Record{
		"account_id":        h.accountID(ctx),
		"region":            h.region(ctx),
		"log_group_name":    name,
		"arn":               logGroupARN(h.region(ctx), h.accountID(ctx), name),
		"creation_time":     h.now().UnixMilli(),
		"retention_in_days": 0,
		"kms_key_id":        "",
		"tags":              corestore.Record{},
	})
}

func (h *Handler) recordInvocation(ctx gateway.AwsRequestContext, fn corestore.Record, requestID string, invocationType string, executedVersion string, lines []string) string {
	functionName := stringField(fn, "function_name")
	executedVersion = firstNonEmpty(executedVersion, "$LATEST")
	messages := []string{"START RequestId: " + requestID + " Version: " + executedVersion}
	messages = append(messages, lines...)
	messages = append(messages, "END RequestId: "+requestID)
	tail := lambdaLogTail(messages)
	h.ensureLogGroup(ctx, functionName)
	if h.LogStreams == nil || h.LogEvents == nil {
		return tail
	}
	groupName := logGroupName(functionName)
	streamName := h.now().UTC().Format("2006/01/02") + "/[" + executedVersion + "]" + h.generateID("stream")
	stream := corestore.Record(nil)
	for _, existing := range h.LogStreams.FindBy("log_stream_name", streamName) {
		if stringField(existing, "log_group_name") == groupName && h.sameScope(ctx, existing) {
			stream = existing
			break
		}
	}
	if stream == nil {
		stream = h.LogStreams.Insert(corestore.Record{
			"account_id":            h.accountID(ctx),
			"region":                h.region(ctx),
			"log_group_name":        groupName,
			"log_stream_name":       streamName,
			"arn":                   logGroupARN(h.region(ctx), h.accountID(ctx), groupName) + ":log-stream:" + streamName,
			"creation_time":         h.now().UnixMilli(),
			"first_event_timestamp": int64(0),
			"last_event_timestamp":  int64(0),
			"last_ingestion_time":   int64(0),
			"upload_sequence_token": "0",
			"stored_bytes":          0,
		})
	}
	now := h.now().UnixMilli()
	storedBytes := 0
	for index, message := range messages {
		timestamp := now + int64(index)
		storedBytes += len(message)
		h.LogEvents.Insert(corestore.Record{
			"account_id":      h.accountID(ctx),
			"region":          h.region(ctx),
			"log_group_name":  groupName,
			"log_stream_name": stringField(stream, "log_stream_name"),
			"event_id":        h.generateID("event"),
			"timestamp":       timestamp,
			"ingestion_time":  timestamp,
			"message":         message,
		})
	}
	h.LogStreams.Update(intField(stream, "id"), corestore.Record{
		"first_event_timestamp": now,
		"last_event_timestamp":  now + int64(len(messages)-1),
		"last_ingestion_time":   now + int64(len(messages)-1),
		"stored_bytes":          storedBytes,
	})
	return tail
}

func (h *Handler) pageBounds(input map[string]any, total int, defaultLimit int, maxLimit int, markerKey string, limitKey string, requestID string) (int, int, string, protocols.ErrorResponse, bool) {
	limit := intInputDefault(input, defaultLimit, limitKey, strings.ToLower(limitKey[:1])+limitKey[1:])
	if limit <= 0 {
		return 0, 0, "", h.validation(limitKey+" must be greater than zero.", requestID), false
	}
	if limit > maxLimit {
		limit = maxLimit
	}
	start := 0
	if raw := strings.TrimSpace(stringInput(input, markerKey, strings.ToLower(markerKey[:1])+markerKey[1:])); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 0 || parsed > total {
			return 0, 0, "", h.validation(markerKey+" is invalid.", requestID), false
		}
		start = parsed
	}
	end := start + limit
	if end > total {
		end = total
	}
	next := ""
	if end < total {
		next = strconv.Itoa(end)
	}
	return start, end, next, protocols.ErrorResponse{}, true
}

func (h *Handler) validation(message string, requestID string) protocols.ErrorResponse {
	return h.error("InvalidParameterValueException", message, http.StatusBadRequest, requestID)
}

func (h *Handler) notFound(message string, requestID string) protocols.ErrorResponse {
	return h.error("ResourceNotFoundException", message, http.StatusNotFound, requestID)
}

func (h *Handler) error(code string, message string, status int, requestID string) protocols.ErrorResponse {
	return protocols.SerializeJSONError(protocols.AWSError{
		Code:       code,
		Message:    message,
		RequestID:  requestID,
		Service:    "com.amazonaws.lambda",
		StatusCode: status,
	})
}

func (h *Handler) sameScope(ctx gateway.AwsRequestContext, record corestore.Record) bool {
	return stringField(record, "account_id") == h.accountID(ctx) && stringField(record, "region") == h.region(ctx)
}

func (h *Handler) accountID(ctx gateway.AwsRequestContext) string {
	if ctx.AccountID != "" {
		return ctx.AccountID
	}
	if h.AccountID != "" {
		return h.AccountID
	}
	return gateway.DefaultAccountID
}

func (h *Handler) region(ctx gateway.AwsRequestContext) string {
	if ctx.Region != "" {
		return ctx.Region
	}
	if h.Region != "" {
		return h.Region
	}
	return gateway.DefaultRegion
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
	return fmt.Sprintf("%s-%016x", prefix, fallbackIDCounter.Add(1))
}

func parseRoute(req *http.Request) (route, bool) {
	segments := pathSegments(req.URL.Path)
	if len(segments) > 0 && segments[0] == "lambda" {
		segments = segments[1:]
	}
	if len(segments) < 2 {
		return route{}, false
	}
	if segments[0] == "2017-03-31" && len(segments) >= 3 && segments[1] == "tags" {
		resource := decodeSegment(strings.Join(segments[2:], "/"))
		switch req.Method {
		case http.MethodGet:
			return route{Action: "ListTags", Resource: resource}, true
		case http.MethodPost:
			return route{Action: "TagResource", Resource: resource}, true
		case http.MethodDelete:
			return route{Action: "UntagResource", Resource: resource}, true
		}
		return route{}, false
	}
	if segments[0] != "2015-03-31" || segments[1] != "functions" {
		return route{}, false
	}
	if len(segments) == 2 {
		switch req.Method {
		case http.MethodGet:
			return route{Action: "ListFunctions"}, true
		case http.MethodPost:
			return route{Action: "CreateFunction"}, true
		}
		return route{}, false
	}
	functionName := decodeSegment(segments[2])
	qualifier := req.URL.Query().Get("Qualifier")
	if len(segments) == 3 {
		switch req.Method {
		case http.MethodGet:
			return route{Action: "GetFunction", FunctionName: functionName, Qualifier: qualifier}, true
		case http.MethodDelete:
			return route{Action: "DeleteFunction", FunctionName: functionName, Qualifier: qualifier}, true
		}
		return route{}, false
	}
	switch segments[3] {
	case "configuration":
		switch req.Method {
		case http.MethodGet:
			return route{Action: "GetFunctionConfiguration", FunctionName: functionName, Qualifier: qualifier}, true
		case http.MethodPut:
			return route{Action: "UpdateFunctionConfiguration", FunctionName: functionName}, true
		}
	case "code":
		if req.Method == http.MethodPut {
			return route{Action: "UpdateFunctionCode", FunctionName: functionName}, true
		}
	case "invocations":
		if req.Method == http.MethodPost {
			return route{Action: "Invoke", FunctionName: functionName, Qualifier: qualifier}, true
		}
	case "versions":
		if len(segments) == 4 {
			if req.Method == http.MethodGet {
				return route{Action: "ListVersionsByFunction", FunctionName: functionName}, true
			}
			if req.Method == http.MethodPost {
				return route{Action: "PublishVersion", FunctionName: functionName}, true
			}
		}
		if len(segments) == 5 && req.Method == http.MethodGet {
			return route{Action: "GetFunction", FunctionName: functionName, Qualifier: decodeSegment(segments[4])}, true
		}
	case "aliases":
		if len(segments) == 4 {
			if req.Method == http.MethodGet {
				return route{Action: "ListAliases", FunctionName: functionName}, true
			}
			if req.Method == http.MethodPost {
				return route{Action: "CreateAlias", FunctionName: functionName}, true
			}
		}
		if len(segments) == 5 {
			aliasName := decodeSegment(segments[4])
			switch req.Method {
			case http.MethodGet:
				return route{Action: "GetAlias", FunctionName: functionName, AliasName: aliasName}, true
			case http.MethodPut:
				return route{Action: "UpdateAlias", FunctionName: functionName, AliasName: aliasName}, true
			case http.MethodDelete:
				return route{Action: "DeleteAlias", FunctionName: functionName, AliasName: aliasName}, true
			}
		}
	case "policy":
		if len(segments) == 4 {
			if req.Method == http.MethodGet {
				return route{Action: "GetPolicy", FunctionName: functionName, Qualifier: qualifier}, true
			}
			if req.Method == http.MethodPost {
				return route{Action: "AddPermission", FunctionName: functionName, Qualifier: qualifier}, true
			}
		}
		if len(segments) == 5 && req.Method == http.MethodDelete {
			return route{Action: "RemovePermission", FunctionName: functionName, StatementID: decodeSegment(segments[4]), Qualifier: qualifier}, true
		}
	}
	return route{}, false
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

func jsonResponse(status int, value map[string]any) protocols.ErrorResponse {
	body := []byte(nil)
	if status != http.StatusNoContent {
		body, _ = json.Marshal(value)
	}
	return protocols.ErrorResponse{
		StatusCode:  status,
		ContentType: jsonContentType,
		Headers:     map[string]string{"Content-Type": jsonContentType},
		Body:        body,
	}
}

func lambdaBodyResponse(status int, body []byte, headers map[string]string) protocols.ErrorResponse {
	outHeaders := map[string]string{"Content-Type": jsonContentType}
	for key, value := range headers {
		outHeaders[key] = value
	}
	return protocols.ErrorResponse{StatusCode: status, ContentType: jsonContentType, Headers: outHeaders, Body: body}
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

func codeSummary(value any) (int, string) {
	var raw []byte
	if record := mapRecord(value); len(record) > 0 {
		if zip := firstNonEmpty(stringField(record, "ZipFile"), stringField(record, "zipFile")); zip != "" {
			if decoded, err := base64.StdEncoding.DecodeString(strings.TrimSpace(zip)); err == nil {
				raw = decoded
			} else {
				raw = []byte(zip)
			}
		} else {
			raw = []byte(firstNonEmpty(stringField(record, "S3Bucket"), stringField(record, "s3Bucket"), stringField(record, "ImageUri"), stringField(record, "imageUri")) + firstNonEmpty(stringField(record, "S3Key"), stringField(record, "s3Key")) + firstNonEmpty(stringField(record, "S3ObjectVersion"), stringField(record, "s3ObjectVersion")))
		}
	} else if rawString, ok := value.(string); ok {
		raw = []byte(rawString)
	}
	if raw == nil {
		raw = []byte{}
	}
	sum := sha256.Sum256(raw)
	return len(raw), base64.StdEncoding.EncodeToString(sum[:])
}

func codeZipBase64(value any) string {
	record := mapRecord(value)
	if len(record) == 0 {
		return ""
	}
	zip := strings.TrimSpace(firstNonEmpty(stringField(record, "ZipFile"), stringField(record, "zipFile")))
	if zip == "" {
		return ""
	}
	if decoded, err := base64.StdEncoding.DecodeString(zip); err == nil {
		return base64.StdEncoding.EncodeToString(decoded)
	}
	return base64.StdEncoding.EncodeToString([]byte(zip))
}

func lambdaLogTail(messages []string) string {
	text := strings.Join(messages, "\n") + "\n"
	raw := []byte(text)
	if len(raw) > 4096 {
		raw = raw[len(raw)-4096:]
	}
	return base64.StdEncoding.EncodeToString(raw)
}

func environmentVariables(value any) corestore.Record {
	record := mapRecord(value)
	variables := mapRecord(record["Variables"])
	if len(variables) == 0 {
		variables = mapRecord(record["variables"])
	}
	out := corestore.Record{}
	for key, value := range variables {
		out[key] = fmt.Sprint(value)
	}
	return out
}

func tagsMap(value any) corestore.Record {
	out := corestore.Record{}
	for key, value := range mapRecord(value) {
		out[key] = fmt.Sprint(value)
	}
	return out
}

func tagsResponse(tags corestore.Record) map[string]string {
	out := make(map[string]string, len(tags))
	for key, value := range tags {
		out[key] = fmt.Sprint(value)
	}
	return out
}

func routingConfig(value any) corestore.Record {
	record := mapRecord(value)
	out := corestore.Record{}
	for key, value := range record {
		out[key] = value
	}
	return out
}

func tracingMode(value any) string {
	record := mapRecord(value)
	return firstNonEmpty(stringField(record, "Mode"), stringField(record, "mode"), "PassThrough")
}

func ephemeralStorage(value any) int {
	record := mapRecord(value)
	if value, ok := optionalIntInput(record, "Size", "size"); ok && value > 0 {
		return value
	}
	return 512
}

func deadLetterTarget(value any) string {
	record := mapRecord(value)
	return firstNonEmpty(stringField(record, "TargetArn"), stringField(record, "targetArn"))
}

func snapStartApplyOn(value any) string {
	record := mapRecord(value)
	return firstNonEmpty(stringField(record, "ApplyOn"), stringField(record, "applyOn"))
}

func policyDocument(fn corestore.Record) string {
	statements := recordList(fn["policy_statements"])
	out := make([]map[string]any, 0, len(statements))
	for _, statement := range statements {
		out = append(out, statementDocument(statement))
	}
	raw, _ := json.Marshal(map[string]any{"Version": "2012-10-17", "Statement": out})
	return string(raw)
}

func policyStatementJSON(statement corestore.Record) string {
	raw, _ := json.Marshal(statementDocument(statement))
	return string(raw)
}

func statementDocument(statement corestore.Record) map[string]any {
	principal := map[string]any{"AWS": stringField(statement, "principal")}
	if strings.Contains(stringField(statement, "principal"), ".amazonaws.com") {
		principal = map[string]any{"Service": stringField(statement, "principal")}
	}
	out := map[string]any{
		"Sid":       stringField(statement, "sid"),
		"Effect":    firstNonEmpty(stringField(statement, "effect"), "Allow"),
		"Action":    stringField(statement, "action"),
		"Principal": principal,
		"Resource":  firstNonEmpty(stringField(statement, "resource"), "*"),
	}
	condition := map[string]any{}
	if value := stringField(statement, "source_arn"); value != "" {
		condition["ArnLike"] = map[string]any{"AWS:SourceArn": value}
	}
	if value := stringField(statement, "source_account"); value != "" {
		condition["StringEquals"] = map[string]any{"AWS:SourceAccount": value}
	}
	if len(condition) > 0 {
		out["Condition"] = condition
	}
	return out
}

func functionIdentifierMatches(fn corestore.Record, identifier string) bool {
	parsed := parseFunctionIdentifier(identifier)
	if parsed.Name == "" {
		return false
	}
	if parsed.ARN {
		if parsed.AccountID != "" && stringField(fn, "account_id") != parsed.AccountID {
			return false
		}
		if parsed.Region != "" && stringField(fn, "region") != parsed.Region {
			return false
		}
	}
	if parsed.Name == stringField(fn, "function_name") {
		return true
	}
	return false
}

func nameFromFunctionIdentifier(identifier string) string {
	return parseFunctionIdentifier(identifier).Name
}

func parseFunctionIdentifier(identifier string) functionIdentifier {
	identifier = strings.TrimSpace(identifier)
	if identifier == "" {
		return functionIdentifier{}
	}
	if !strings.HasPrefix(identifier, "arn:") {
		return functionIdentifier{Name: identifier}
	}
	parts := strings.Split(identifier, ":")
	if len(parts) < 7 || parts[2] != "lambda" || parts[5] != "function" {
		return functionIdentifier{}
	}
	out := functionIdentifier{
		Name:      parts[6],
		Region:    parts[3],
		AccountID: parts[4],
		ARN:       true,
	}
	if len(parts) > 7 {
		out.Qualifier = strings.Join(parts[7:], ":")
	}
	return out
}

func policyResourceARN(fn corestore.Record, qualifier string) string {
	arn := stringField(fn, "arn")
	qualifier = strings.TrimSpace(qualifier)
	if arn == "" || qualifier == "" {
		return arn
	}
	if strings.HasSuffix(arn, ":"+qualifier) {
		return arn
	}
	return arn + ":" + qualifier
}

func functionARN(region string, accountID string, name string) string {
	return "arn:aws:lambda:" + region + ":" + accountID + ":function:" + name
}

func logGroupName(functionName string) string {
	return "/aws/lambda/" + functionName
}

func logGroupARN(region string, accountID string, name string) string {
	return "arn:aws:logs:" + region + ":" + accountID + ":log-group:" + name
}

func formatLambdaTime(value time.Time) string {
	return value.UTC().Format("2006-01-02T15:04:05.000-0700")
}

func versionSortValue(version string) int {
	if version == "$LATEST" || version == "" {
		return 0
	}
	parsed, err := strconv.Atoi(version)
	if err != nil {
		return 1 << 30
	}
	return parsed
}

func stringInput(input map[string]any, keys ...string) string {
	for _, key := range keys {
		if value, ok := input[key]; ok {
			return stringValue(value)
		}
	}
	return ""
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

func intFieldDefault(record corestore.Record, key string, fallback int) int {
	if value, ok := intValue(record[key]); ok {
		return value
	}
	return fallback
}

func intInputDefault(input map[string]any, fallback int, keys ...string) int {
	if value, ok := optionalIntInput(input, keys...); ok {
		return value
	}
	return fallback
}

func optionalIntInput(input map[string]any, keys ...string) (int, bool) {
	for _, key := range keys {
		if value, ok := input[key]; ok {
			return intValue(value)
		}
	}
	return 0, false
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

func inputValue(input map[string]any, keys ...string) any {
	for _, key := range keys {
		if value, ok := input[key]; ok {
			return value
		}
	}
	return nil
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

func recordList(value any) []corestore.Record {
	switch v := value.(type) {
	case []corestore.Record:
		out := make([]corestore.Record, len(v))
		copy(out, v)
		return out
	case []map[string]any:
		out := make([]corestore.Record, 0, len(v))
		for _, item := range v {
			out = append(out, mapRecord(item))
		}
		return out
	case []any:
		out := make([]corestore.Record, 0, len(v))
		for _, item := range v {
			out = append(out, mapRecord(item))
		}
		return out
	default:
		return nil
	}
}

func stringListDefault(value any, fallback []string) []string {
	var out []string
	switch v := value.(type) {
	case []string:
		out = append(out, v...)
	case []any:
		for _, item := range v {
			out = append(out, stringValue(item))
		}
	}
	if len(out) == 0 {
		return append([]string(nil), fallback...)
	}
	return out
}

func copyStringPatch(patch corestore.Record, input map[string]any, field string, keys ...string) {
	for _, key := range keys {
		if value, ok := input[key]; ok {
			patch[field] = stringValue(value)
			return
		}
	}
}

func cloneRecord(record corestore.Record) corestore.Record {
	out := corestore.Record{}
	for key, value := range record {
		out[key] = value
	}
	return out
}

func cloneAnyMap(input map[string]any) map[string]any {
	out := make(map[string]any, len(input))
	for key, value := range input {
		out[key] = value
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
