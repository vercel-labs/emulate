package secretsmanager

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	corestore "github.com/vercel-labs/emulate/internal/core/store"
	"github.com/vercel-labs/emulate/internal/services/aws/gateway"
	"github.com/vercel-labs/emulate/internal/services/aws/protocols"
)

const jsonContentType = "application/x-amz-json-1.1"

type Handler struct {
	Secrets     *corestore.Collection
	Versions    *corestore.Collection
	AccountID   string
	Region      string
	Now         func() time.Time
	IDGenerator func(string) string
}

var fallbackIDCounter atomic.Uint64

func (h *Handler) Handle(_ *http.Request, ctx gateway.AwsRequestContext) protocols.ErrorResponse {
	requestID := ctx.RequestID
	if requestID == "" {
		requestID = h.generateID("req")
	}
	var response protocols.ErrorResponse
	switch ctx.Action {
	case "CreateSecret":
		response = h.createSecret(ctx, requestID)
	case "GetSecretValue":
		response = h.getSecretValue(ctx, requestID)
	case "PutSecretValue":
		response = h.putSecretValue(ctx, requestID)
	case "UpdateSecret":
		response = h.updateSecret(ctx, requestID)
	case "DeleteSecret":
		response = h.deleteSecret(ctx, requestID)
	case "RestoreSecret":
		response = h.restoreSecret(ctx, requestID)
	case "ListSecrets":
		response = h.listSecrets(ctx, requestID)
	case "DescribeSecret":
		response = h.describeSecret(ctx, requestID)
	case "TagResource":
		response = h.tagResource(ctx, requestID)
	case "UntagResource":
		response = h.untagResource(ctx, requestID)
	case "ListSecretVersionIds":
		response = h.listSecretVersionIds(ctx, requestID)
	default:
		response = h.error("NotImplementedException", fmt.Sprintf("secretsmanager.%s is not implemented in the native Go runtime yet.", ctx.Action), http.StatusNotImplemented, requestID)
	}
	return withRequestID(response, requestID)
}

func (h *Handler) createSecret(ctx gateway.AwsRequestContext, requestID string) protocols.ErrorResponse {
	name := strings.TrimSpace(stringInput(ctx.Input, "Name"))
	if name == "" {
		return h.validation("Name is required.", requestID)
	}
	secretString, hasString, secretBinary, hasBinary, response, ok := h.secretPayload(ctx.Input, requestID, false)
	if !ok {
		return response
	}
	clientRequestToken := stringInput(ctx.Input, "ClientRequestToken")
	if existing, ok := h.findSecretByName(ctx, name); ok {
		if clientRequestToken != "" {
			if version, ok := h.findVersionByID(existing, clientRequestToken); ok {
				if !samePayload(version, secretString, hasString, secretBinary, hasBinary) {
					return h.error("ResourceExistsException", "A secret version with this ClientRequestToken already exists and has a different value.", http.StatusBadRequest, requestID)
				}
				body := map[string]any{
					"ARN":       stringField(existing, "arn"),
					"Name":      stringField(existing, "name"),
					"VersionId": clientRequestToken,
				}
				return jsonResponse(http.StatusOK, body)
			}
		}
		return h.error("ResourceExistsException", "The operation failed because the secret already exists.", http.StatusBadRequest, requestID)
	}
	now := h.now().Unix()
	accountID := h.accountID(ctx)
	region := h.region(ctx)
	suffix := h.generateSuffix()
	arn := secretARN(region, accountID, name, suffix)
	secret := h.Secrets.Insert(corestore.Record{
		"account_id":           accountID,
		"region":               region,
		"name":                 name,
		"arn":                  arn,
		"arn_suffix":           suffix,
		"description":          stringInput(ctx.Input, "Description"),
		"kms_key_id":           stringInput(ctx.Input, "KmsKeyId"),
		"created_date":         now,
		"last_changed_date":    now,
		"last_accessed_date":   int64(0),
		"deleted_date":         int64(0),
		"recovery_window_days": 0,
		"force_deleted":        false,
		"tags":                 tagsFromInput(ctx.Input["Tags"], ctx.Input["tags"]),
	})
	body := map[string]any{"ARN": arn, "Name": name}
	if hasString || hasBinary {
		versionID := firstNonEmpty(clientRequestToken, h.generateVersionID())
		h.insertVersion(secret, versionID, secretString, hasString, secretBinary, hasBinary, []string{"AWSCURRENT"}, now)
		body["VersionId"] = versionID
	}
	return jsonResponse(http.StatusOK, body)
}

func (h *Handler) getSecretValue(ctx gateway.AwsRequestContext, requestID string) protocols.ErrorResponse {
	secret, response, ok := h.requireActiveSecret(ctx, secretIDInput(ctx.Input), requestID)
	if !ok {
		return response
	}
	versionID := stringInput(ctx.Input, "VersionId")
	versionStage := stringInput(ctx.Input, "VersionStage")
	version, response, ok := h.requireVersion(secret, versionID, versionStage, requestID)
	if !ok {
		return response
	}
	h.Secrets.Update(intField(secret, "id"), corestore.Record{"last_accessed_date": h.now().Unix()})
	body := map[string]any{
		"ARN":           stringField(secret, "arn"),
		"Name":          stringField(secret, "name"),
		"VersionId":     stringField(version, "version_id"),
		"VersionStages": stringSlice(version["version_stages"]),
		"CreatedDate":   int64Field(version, "created_date"),
	}
	if boolField(version, "has_secret_string") {
		body["SecretString"] = stringField(version, "secret_string")
	}
	if boolField(version, "has_secret_binary") {
		body["SecretBinary"] = stringField(version, "secret_binary")
	}
	return jsonResponse(http.StatusOK, body)
}

func (h *Handler) putSecretValue(ctx gateway.AwsRequestContext, requestID string) protocols.ErrorResponse {
	secret, response, ok := h.requireActiveSecret(ctx, secretIDInput(ctx.Input), requestID)
	if !ok {
		return response
	}
	secretString, hasString, secretBinary, hasBinary, response, ok := h.secretPayload(ctx.Input, requestID, true)
	if !ok {
		return response
	}
	versionID := firstNonEmpty(stringInput(ctx.Input, "ClientRequestToken"), h.generateVersionID())
	stages := versionStagesInput(ctx.Input)
	now := h.now().Unix()
	if existing, ok := h.findVersionByID(secret, versionID); ok {
		if !samePayload(existing, secretString, hasString, secretBinary, hasBinary) {
			return h.error("ResourceExistsException", "A secret version with this ClientRequestToken already exists and has a different value.", http.StatusBadRequest, requestID)
		}
		return jsonResponse(http.StatusOK, map[string]any{
			"ARN":           stringField(secret, "arn"),
			"Name":          stringField(secret, "name"),
			"VersionId":     versionID,
			"VersionStages": uniqueStrings(stringSlice(existing["version_stages"])),
		})
	}
	h.insertVersion(secret, versionID, secretString, hasString, secretBinary, hasBinary, nil, now)
	h.moveVersionStages(secret, versionID, stages)
	h.touchSecret(secret, now)
	return jsonResponse(http.StatusOK, map[string]any{
		"ARN":           stringField(secret, "arn"),
		"Name":          stringField(secret, "name"),
		"VersionId":     versionID,
		"VersionStages": stages,
	})
}

func (h *Handler) updateSecret(ctx gateway.AwsRequestContext, requestID string) protocols.ErrorResponse {
	secret, response, ok := h.requireActiveSecret(ctx, secretIDInput(ctx.Input), requestID)
	if !ok {
		return response
	}
	secretString, hasString, secretBinary, hasBinary, response, ok := h.secretPayload(ctx.Input, requestID, false)
	if !ok {
		return response
	}
	now := h.now().Unix()
	patch := corestore.Record{}
	if value, exists := stringInputPresent(ctx.Input, "Description"); exists {
		patch["description"] = value
	}
	if value, exists := stringInputPresent(ctx.Input, "KmsKeyId"); exists {
		patch["kms_key_id"] = value
	}
	versionID := ""
	insertedVersion := false
	if hasString || hasBinary {
		versionID = firstNonEmpty(stringInput(ctx.Input, "ClientRequestToken"), h.generateVersionID())
		if existing, ok := h.findVersionByID(secret, versionID); ok {
			if !samePayload(existing, secretString, hasString, secretBinary, hasBinary) {
				return h.error("ResourceExistsException", "A secret version with this ClientRequestToken already exists and has a different value.", http.StatusBadRequest, requestID)
			}
		} else {
			h.insertVersion(secret, versionID, secretString, hasString, secretBinary, hasBinary, nil, now)
			insertedVersion = true
			h.moveVersionStages(secret, versionID, []string{"AWSCURRENT"})
		}
	}
	if len(patch) > 0 || insertedVersion {
		patch["last_changed_date"] = now
		h.Secrets.Update(intField(secret, "id"), patch)
	}
	body := map[string]any{"ARN": stringField(secret, "arn"), "Name": stringField(secret, "name")}
	if versionID != "" {
		body["VersionId"] = versionID
	}
	return jsonResponse(http.StatusOK, body)
}

func (h *Handler) deleteSecret(ctx gateway.AwsRequestContext, requestID string) protocols.ErrorResponse {
	secret, response, ok := h.requireSecret(ctx, secretIDInput(ctx.Input), requestID)
	if !ok {
		return response
	}
	force := boolInput(ctx.Input, "ForceDeleteWithoutRecovery")
	hasRecoveryWindow := inputValue(ctx.Input, "RecoveryWindowInDays", "recoveryWindowInDays") != nil
	if force && hasRecoveryWindow {
		return h.validation("ForceDeleteWithoutRecovery and RecoveryWindowInDays can't both be set.", requestID)
	}
	if int64Field(secret, "deleted_date") > 0 {
		if !force {
			return h.invalidRequest("You can't perform this operation on the secret because it was deleted.", requestID)
		}
		deletedAt := h.now().Unix()
		body := map[string]any{
			"ARN":          stringField(secret, "arn"),
			"Name":         stringField(secret, "name"),
			"DeletionDate": deletedAt,
		}
		h.deleteSecretAndVersions(secret)
		return jsonResponse(http.StatusOK, body)
	}
	now := h.now()
	recoveryWindow := intInput(ctx.Input, "RecoveryWindowInDays", 30)
	if force {
		body := map[string]any{
			"ARN":          stringField(secret, "arn"),
			"Name":         stringField(secret, "name"),
			"DeletionDate": now.Unix(),
		}
		h.deleteSecretAndVersions(secret)
		return jsonResponse(http.StatusOK, body)
	} else if recoveryWindow < 7 || recoveryWindow > 30 {
		return h.validation("RecoveryWindowInDays must be between 7 and 30.", requestID)
	}
	deletedAt := now.Unix()
	if !force {
		deletedAt = now.Add(time.Duration(recoveryWindow) * 24 * time.Hour).Unix()
	}
	h.Secrets.Update(intField(secret, "id"), corestore.Record{
		"deleted_date":         deletedAt,
		"recovery_window_days": recoveryWindow,
		"force_deleted":        force,
		"last_changed_date":    now.Unix(),
	})
	return jsonResponse(http.StatusOK, map[string]any{
		"ARN":          stringField(secret, "arn"),
		"Name":         stringField(secret, "name"),
		"DeletionDate": deletedAt,
	})
}

func (h *Handler) restoreSecret(ctx gateway.AwsRequestContext, requestID string) protocols.ErrorResponse {
	secret, response, ok := h.requireSecret(ctx, secretIDInput(ctx.Input), requestID)
	if !ok {
		return response
	}
	if int64Field(secret, "deleted_date") == 0 {
		return h.invalidRequest("The secret is not scheduled for deletion.", requestID)
	}
	h.Secrets.Update(intField(secret, "id"), corestore.Record{
		"deleted_date":         int64(0),
		"recovery_window_days": 0,
		"force_deleted":        false,
		"last_changed_date":    h.now().Unix(),
	})
	return jsonResponse(http.StatusOK, map[string]any{
		"ARN":  stringField(secret, "arn"),
		"Name": stringField(secret, "name"),
	})
}

func (h *Handler) deleteSecretAndVersions(secret corestore.Record) {
	for _, version := range h.Versions.FindBy("secret_arn", stringField(secret, "arn")) {
		h.Versions.Delete(intField(version, "id"))
	}
	h.Secrets.Delete(intField(secret, "id"))
}

func (h *Handler) listSecrets(ctx gateway.AwsRequestContext, requestID string) protocols.ErrorResponse {
	includeDeleted := boolInput(ctx.Input, "IncludePlannedDeletion")
	secrets := []corestore.Record{}
	for _, secret := range h.Secrets.All() {
		if !h.sameScope(ctx, secret) {
			continue
		}
		if !includeDeleted && int64Field(secret, "deleted_date") > 0 {
			continue
		}
		secrets = append(secrets, secret)
	}
	sort.Slice(secrets, func(i int, j int) bool {
		return stringField(secrets[i], "name") < stringField(secrets[j], "name")
	})
	if strings.EqualFold(stringInput(ctx.Input, "SortOrder"), "desc") {
		reverseRecords(secrets)
	}
	start, end, nextToken, response, ok := h.pageBounds(ctx.Input, len(secrets), 100, requestID)
	if !ok {
		return response
	}
	out := make([]map[string]any, 0, end-start)
	for _, secret := range secrets[start:end] {
		out = append(out, h.secretResponse(secret, false))
	}
	body := map[string]any{"SecretList": out}
	if nextToken != "" {
		body["NextToken"] = nextToken
	}
	return jsonResponse(http.StatusOK, body)
}

func (h *Handler) describeSecret(ctx gateway.AwsRequestContext, requestID string) protocols.ErrorResponse {
	secret, response, ok := h.requireSecret(ctx, secretIDInput(ctx.Input), requestID)
	if !ok {
		return response
	}
	return jsonResponse(http.StatusOK, h.secretResponse(secret, true))
}

func (h *Handler) tagResource(ctx gateway.AwsRequestContext, requestID string) protocols.ErrorResponse {
	secret, response, ok := h.requireSecret(ctx, secretIDInput(ctx.Input), requestID)
	if !ok {
		return response
	}
	tags := tagsFromInput(ctx.Input["Tags"], ctx.Input["tags"])
	merged := mergeTags(mapRecord(secret["tags"]), tags)
	h.Secrets.Update(intField(secret, "id"), corestore.Record{"tags": merged, "last_changed_date": h.now().Unix()})
	return jsonResponse(http.StatusOK, map[string]any{})
}

func (h *Handler) untagResource(ctx gateway.AwsRequestContext, requestID string) protocols.ErrorResponse {
	secret, response, ok := h.requireSecret(ctx, secretIDInput(ctx.Input), requestID)
	if !ok {
		return response
	}
	tags := mapRecord(secret["tags"])
	for _, key := range stringSlice(inputValue(ctx.Input, "TagKeys", "tagKeys")) {
		delete(tags, key)
	}
	h.Secrets.Update(intField(secret, "id"), corestore.Record{"tags": tags, "last_changed_date": h.now().Unix()})
	return jsonResponse(http.StatusOK, map[string]any{})
}

func (h *Handler) listSecretVersionIds(ctx gateway.AwsRequestContext, requestID string) protocols.ErrorResponse {
	secret, response, ok := h.requireSecret(ctx, secretIDInput(ctx.Input), requestID)
	if !ok {
		return response
	}
	includeDeprecated := boolInput(ctx.Input, "IncludeDeprecated")
	versions := h.secretVersions(secret)
	filtered := versions[:0]
	for _, version := range versions {
		if includeDeprecated || len(stringSlice(version["version_stages"])) > 0 {
			filtered = append(filtered, version)
		}
	}
	start, end, nextToken, response, ok := h.pageBounds(ctx.Input, len(filtered), 100, requestID)
	if !ok {
		return response
	}
	out := make([]map[string]any, 0, end-start)
	for _, version := range filtered[start:end] {
		out = append(out, map[string]any{
			"VersionId":     stringField(version, "version_id"),
			"VersionStages": stringSlice(version["version_stages"]),
			"CreatedDate":   int64Field(version, "created_date"),
		})
	}
	body := map[string]any{
		"ARN":      stringField(secret, "arn"),
		"Name":     stringField(secret, "name"),
		"Versions": out,
	}
	if nextToken != "" {
		body["NextToken"] = nextToken
	}
	return jsonResponse(http.StatusOK, body)
}

func (h *Handler) requireActiveSecret(ctx gateway.AwsRequestContext, secretID string, requestID string) (corestore.Record, protocols.ErrorResponse, bool) {
	secret, response, ok := h.requireSecret(ctx, secretID, requestID)
	if !ok {
		return nil, response, false
	}
	if int64Field(secret, "deleted_date") > 0 {
		return nil, h.invalidRequest("You can't perform this operation on the secret because it was deleted.", requestID), false
	}
	return secret, protocols.ErrorResponse{}, true
}

func (h *Handler) requireSecret(ctx gateway.AwsRequestContext, secretID string, requestID string) (corestore.Record, protocols.ErrorResponse, bool) {
	secretID = strings.TrimSpace(secretID)
	if secretID == "" {
		return nil, h.validation("SecretId is required.", requestID), false
	}
	secret, ok := h.findSecret(ctx, secretID)
	if !ok {
		return nil, h.notFound("Secrets Manager can't find the specified secret.", requestID), false
	}
	return secret, protocols.ErrorResponse{}, true
}

func (h *Handler) findSecret(ctx gateway.AwsRequestContext, secretID string) (corestore.Record, bool) {
	secretID = strings.TrimSpace(secretID)
	if strings.HasPrefix(secretID, "arn:") {
		parts, ok := parseSecretARN(secretID)
		if !ok || parts.AccountID != h.accountID(ctx) || parts.Region != h.region(ctx) {
			return nil, false
		}
		for _, secret := range h.Secrets.FindBy("arn", secretID) {
			if h.sameScope(ctx, secret) {
				return secret, true
			}
		}
		for _, secret := range h.Secrets.All() {
			if !h.sameScope(ctx, secret) {
				continue
			}
			name := stringField(secret, "name")
			if parts.Name == name || parts.Name == name+"-"+stringField(secret, "arn_suffix") {
				return secret, true
			}
		}
		return nil, false
	}
	return h.findSecretByName(ctx, secretID)
}

func (h *Handler) findSecretByName(ctx gateway.AwsRequestContext, name string) (corestore.Record, bool) {
	for _, secret := range h.Secrets.FindBy("name", name) {
		if h.sameScope(ctx, secret) {
			return secret, true
		}
	}
	return nil, false
}

func (h *Handler) requireVersion(secret corestore.Record, versionID string, versionStage string, requestID string) (corestore.Record, protocols.ErrorResponse, bool) {
	if versionID != "" {
		version, ok := h.findVersionByID(secret, versionID)
		if !ok {
			return nil, h.notFound("Secrets Manager can't find the specified secret value.", requestID), false
		}
		if versionStage != "" && !hasString(stringSlice(version["version_stages"]), versionStage) {
			return nil, h.notFound("Secrets Manager can't find the specified secret value.", requestID), false
		}
		return version, protocols.ErrorResponse{}, true
	}
	if versionStage == "" {
		versionStage = "AWSCURRENT"
	}
	for _, version := range h.secretVersions(secret) {
		if hasString(stringSlice(version["version_stages"]), versionStage) {
			return version, protocols.ErrorResponse{}, true
		}
	}
	return nil, h.notFound("Secrets Manager can't find the specified secret value.", requestID), false
}

func (h *Handler) findVersionByID(secret corestore.Record, versionID string) (corestore.Record, bool) {
	for _, version := range h.Versions.FindBy("version_id", versionID) {
		if stringField(version, "secret_arn") == stringField(secret, "arn") {
			return version, true
		}
	}
	return nil, false
}

func (h *Handler) secretVersions(secret corestore.Record) []corestore.Record {
	versions := []corestore.Record{}
	for _, version := range h.Versions.FindBy("secret_arn", stringField(secret, "arn")) {
		versions = append(versions, version)
	}
	sort.Slice(versions, func(i int, j int) bool {
		left := int64Field(versions[i], "created_date")
		right := int64Field(versions[j], "created_date")
		if left == right {
			return stringField(versions[i], "version_id") < stringField(versions[j], "version_id")
		}
		return left < right
	})
	return versions
}

func (h *Handler) insertVersion(secret corestore.Record, versionID string, secretString string, hasString bool, secretBinary string, hasBinary bool, stages []string, createdDate int64) corestore.Record {
	return h.Versions.Insert(corestore.Record{
		"account_id":         stringField(secret, "account_id"),
		"region":             stringField(secret, "region"),
		"secret_arn":         stringField(secret, "arn"),
		"secret_name":        stringField(secret, "name"),
		"version_id":         versionID,
		"secret_string":      secretString,
		"has_secret_string":  hasString,
		"secret_binary":      secretBinary,
		"has_secret_binary":  hasBinary,
		"version_stages":     uniqueStrings(stages),
		"created_date":       createdDate,
		"last_accessed_date": int64(0),
	})
}

func (h *Handler) moveVersionStages(secret corestore.Record, versionID string, stages []string) {
	stages = uniqueStrings(stages)
	moveCurrent := hasString(stages, "AWSCURRENT")
	removeStages := map[string]bool{}
	for _, stage := range stages {
		removeStages[stage] = true
	}
	if moveCurrent {
		removeStages["AWSPREVIOUS"] = true
	}
	for _, version := range h.secretVersions(secret) {
		currentStages := stringSlice(version["version_stages"])
		hadCurrent := hasString(currentStages, "AWSCURRENT")
		updatedStages := make([]string, 0, len(currentStages)+1)
		for _, stage := range currentStages {
			if !removeStages[stage] {
				updatedStages = append(updatedStages, stage)
			}
		}
		if moveCurrent && hadCurrent && stringField(version, "version_id") != versionID {
			updatedStages = append(updatedStages, "AWSPREVIOUS")
		}
		if stringField(version, "version_id") == versionID {
			updatedStages = append(updatedStages, stages...)
		}
		h.Versions.Update(intField(version, "id"), corestore.Record{"version_stages": uniqueStrings(updatedStages)})
	}
}

func (h *Handler) secretResponse(secret corestore.Record, includeVersions bool) map[string]any {
	response := map[string]any{
		"ARN":             stringField(secret, "arn"),
		"Name":            stringField(secret, "name"),
		"CreatedDate":     int64Field(secret, "created_date"),
		"LastChangedDate": int64Field(secret, "last_changed_date"),
	}
	if description := stringField(secret, "description"); description != "" {
		response["Description"] = description
	}
	if kmsKeyID := stringField(secret, "kms_key_id"); kmsKeyID != "" {
		response["KmsKeyId"] = kmsKeyID
	}
	if value := int64Field(secret, "last_accessed_date"); value > 0 {
		response["LastAccessedDate"] = value
	}
	if value := int64Field(secret, "deleted_date"); value > 0 {
		response["DeletedDate"] = value
	}
	if tags := tagListResponse(mapRecord(secret["tags"])); len(tags) > 0 {
		response["Tags"] = tags
	}
	if includeVersions {
		response["VersionIdsToStages"] = h.versionStagesMap(secret)
	} else if versions := h.versionStagesMap(secret); len(versions) > 0 {
		response["SecretVersionsToStages"] = versions
	}
	return response
}

func (h *Handler) versionStagesMap(secret corestore.Record) map[string][]string {
	out := map[string][]string{}
	for _, version := range h.secretVersions(secret) {
		out[stringField(version, "version_id")] = stringSlice(version["version_stages"])
	}
	return out
}

func (h *Handler) pageBounds(input map[string]any, total int, fallbackLimit int, requestID string) (int, int, string, protocols.ErrorResponse, bool) {
	limit := intInput(input, "MaxResults", fallbackLimit)
	if limit <= 0 {
		limit = fallbackLimit
	}
	if limit > 100 {
		limit = 100
	}
	start := 0
	if raw := strings.TrimSpace(stringInput(input, "NextToken")); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 0 || parsed > total {
			return 0, 0, "", h.validation("NextToken is invalid.", requestID), false
		}
		start = parsed
	}
	end := start + limit
	if end > total {
		end = total
	}
	nextToken := ""
	if end < total {
		nextToken = strconv.Itoa(end)
	}
	return start, end, nextToken, protocols.ErrorResponse{}, true
}

func (h *Handler) secretPayload(input map[string]any, requestID string, required bool) (string, bool, string, bool, protocols.ErrorResponse, bool) {
	secretString, hasString := stringInputPresent(input, "SecretString")
	secretBinary, hasBinary := stringInputPresent(input, "SecretBinary")
	if hasString && hasBinary {
		return "", false, "", false, h.validation("Specify either SecretString or SecretBinary, not both.", requestID), false
	}
	if required && !hasString && !hasBinary {
		return "", false, "", false, h.validation("SecretString or SecretBinary is required.", requestID), false
	}
	return secretString, hasString, secretBinary, hasBinary, protocols.ErrorResponse{}, true
}

func (h *Handler) touchSecret(secret corestore.Record, timestamp int64) {
	h.Secrets.Update(intField(secret, "id"), corestore.Record{"last_changed_date": timestamp})
}

func (h *Handler) validation(message string, requestID string) protocols.ErrorResponse {
	return h.error("InvalidParameterException", message, http.StatusBadRequest, requestID)
}

func (h *Handler) invalidRequest(message string, requestID string) protocols.ErrorResponse {
	return h.error("InvalidRequestException", message, http.StatusBadRequest, requestID)
}

func (h *Handler) notFound(message string, requestID string) protocols.ErrorResponse {
	return h.error("ResourceNotFoundException", message, http.StatusBadRequest, requestID)
}

func (h *Handler) error(code string, message string, status int, requestID string) protocols.ErrorResponse {
	return protocols.SerializeJSONError(protocols.AWSError{
		Code:       code,
		Message:    message,
		RequestID:  requestID,
		Service:    "com.amazonaws.secretsmanager",
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
		return h.Now().UTC()
	}
	return time.Now().UTC()
}

func (h *Handler) generateID(prefix string) string {
	if h.IDGenerator != nil {
		return h.IDGenerator(prefix)
	}
	return fmt.Sprintf("%s-%d", prefix, fallbackIDCounter.Add(1))
}

func (h *Handler) generateVersionID() string {
	if h.IDGenerator != nil {
		return h.IDGenerator("version")
	}
	if value := randomHex(16); value != "" {
		return value
	}
	return fmt.Sprintf("%032d", fallbackIDCounter.Add(1))
}

func (h *Handler) generateSuffix() string {
	if h.IDGenerator != nil {
		generated := strings.TrimSpace(h.IDGenerator("suffix"))
		if len(generated) >= 6 {
			return generated[:6]
		}
		if generated != "" {
			return (generated + "000000")[:6]
		}
	}
	if value := randomHex(3); value != "" {
		return value
	}
	return fmt.Sprintf("%06d", fallbackIDCounter.Add(1)%1000000)
}

func randomHex(size int) string {
	raw := make([]byte, size)
	if _, err := rand.Read(raw); err != nil {
		return ""
	}
	return hex.EncodeToString(raw)
}

type secretARNParts struct {
	Region    string
	AccountID string
	Name      string
}

func parseSecretARN(value string) (secretARNParts, bool) {
	parts := strings.SplitN(value, ":", 6)
	if len(parts) != 6 || parts[0] != "arn" || parts[2] != "secretsmanager" || parts[3] == "" || parts[4] == "" {
		return secretARNParts{}, false
	}
	name, ok := strings.CutPrefix(parts[5], "secret:")
	if !ok || name == "" {
		return secretARNParts{}, false
	}
	return secretARNParts{Region: parts[3], AccountID: parts[4], Name: name}, true
}

func secretARN(region string, accountID string, name string, suffix string) string {
	return "arn:aws:secretsmanager:" + region + ":" + accountID + ":secret:" + name + "-" + suffix
}

func secretIDInput(input map[string]any) string {
	return stringInput(input, "SecretId", "secretId", "ResourceArn", "resourceArn")
}

func versionStagesInput(input map[string]any) []string {
	stages := stringSlice(inputValue(input, "VersionStages", "versionStages"))
	if len(stages) == 0 {
		return []string{"AWSCURRENT"}
	}
	return uniqueStrings(stages)
}

func samePayload(record corestore.Record, secretString string, hasString bool, secretBinary string, hasBinary bool) bool {
	return boolField(record, "has_secret_string") == hasString &&
		boolField(record, "has_secret_binary") == hasBinary &&
		stringField(record, "secret_string") == secretString &&
		stringField(record, "secret_binary") == secretBinary
}

func jsonResponse(status int, value map[string]any) protocols.ErrorResponse {
	body, _ := json.Marshal(value)
	return protocols.ErrorResponse{
		StatusCode:  status,
		ContentType: jsonContentType,
		Headers:     map[string]string{"Content-Type": jsonContentType},
		Body:        body,
	}
}

func withRequestID(response protocols.ErrorResponse, requestID string) protocols.ErrorResponse {
	if response.Headers == nil {
		response.Headers = map[string]string{}
	}
	if requestID != "" {
		response.Headers["x-amzn-requestid"] = requestID
	}
	if response.ContentType == "" {
		response.ContentType = jsonContentType
	}
	if _, ok := response.Headers["Content-Type"]; !ok {
		response.Headers["Content-Type"] = response.ContentType
	}
	return response
}

func inputValue(input map[string]any, names ...string) any {
	for _, name := range names {
		if value, ok := input[name]; ok {
			return value
		}
	}
	return nil
}

func stringInput(input map[string]any, names ...string) string {
	value, _ := stringInputPresent(input, names...)
	return value
}

func stringInputPresent(input map[string]any, names ...string) (string, bool) {
	for _, name := range names {
		value, ok := input[name]
		if !ok {
			continue
		}
		return stringValue(value), true
	}
	return "", false
}

func boolInput(input map[string]any, names ...string) bool {
	for _, name := range names {
		switch value := input[name].(type) {
		case bool:
			return value
		case string:
			return strings.EqualFold(value, "true")
		}
	}
	return false
}

func intInput(input map[string]any, name string, fallback int) int {
	value, ok := input[name]
	if !ok {
		return fallback
	}
	switch v := value.(type) {
	case int:
		return v
	case int64:
		return int(v)
	case float64:
		return int(v)
	case json.Number:
		parsed, err := v.Int64()
		if err == nil {
			return int(parsed)
		}
	case string:
		parsed, err := strconv.Atoi(v)
		if err == nil {
			return parsed
		}
	}
	return fallback
}

func stringField(record corestore.Record, name string) string {
	return stringValue(record[name])
}

func stringValue(value any) string {
	switch v := value.(type) {
	case string:
		return v
	case fmt.Stringer:
		return v.String()
	case json.Number:
		return v.String()
	case []byte:
		return string(v)
	default:
		if value == nil {
			return ""
		}
		return fmt.Sprint(value)
	}
}

func intField(record corestore.Record, name string) int {
	switch value := record[name].(type) {
	case int:
		return value
	case int64:
		return int(value)
	case float64:
		return int(value)
	case json.Number:
		parsed, err := value.Int64()
		if err == nil {
			return int(parsed)
		}
	}
	return 0
}

func int64Field(record corestore.Record, name string) int64 {
	switch value := record[name].(type) {
	case int:
		return int64(value)
	case int64:
		return value
	case float64:
		return int64(value)
	case json.Number:
		parsed, err := value.Int64()
		if err == nil {
			return parsed
		}
	}
	return 0
}

func boolField(record corestore.Record, name string) bool {
	value, _ := record[name].(bool)
	return value
}

func stringSlice(value any) []string {
	switch values := value.(type) {
	case []string:
		return append([]string(nil), values...)
	case []any:
		out := make([]string, 0, len(values))
		for _, value := range values {
			text := stringValue(value)
			if text != "" {
				out = append(out, text)
			}
		}
		return out
	case []map[string]any:
		out := make([]string, 0, len(values))
		for _, value := range values {
			text := stringValue(value)
			if text != "" {
				out = append(out, text)
			}
		}
		return out
	default:
		text := stringValue(value)
		if text == "" {
			return nil
		}
		return []string{text}
	}
}

func uniqueStrings(values []string) []string {
	out := make([]string, 0, len(values))
	seen := map[string]bool{}
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	return out
}

func hasString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func tagsFromInput(values ...any) corestore.Record {
	tags := corestore.Record{}
	for _, value := range values {
		switch raw := value.(type) {
		case map[string]any:
			for key, tagValue := range raw {
				tags[key] = stringValue(tagValue)
			}
		case corestore.Record:
			for key, tagValue := range raw {
				tags[key] = stringValue(tagValue)
			}
		case []any:
			for _, item := range raw {
				tag := mapRecord(item)
				key := stringValue(inputValue(tag, "Key", "key"))
				if key != "" {
					tags[key] = stringValue(inputValue(tag, "Value", "value"))
				}
			}
		case []map[string]any:
			for _, tag := range raw {
				key := stringValue(inputValue(tag, "Key", "key"))
				if key != "" {
					tags[key] = stringValue(inputValue(tag, "Value", "value"))
				}
			}
		case []corestore.Record:
			for _, tag := range raw {
				key := stringValue(inputValue(tag, "Key", "key"))
				if key != "" {
					tags[key] = stringValue(inputValue(tag, "Value", "value"))
				}
			}
		}
	}
	return tags
}

func mapRecord(value any) corestore.Record {
	switch typed := value.(type) {
	case corestore.Record:
		out := corestore.Record{}
		for key, value := range typed {
			out[key] = value
		}
		return out
	case map[string]any:
		out := corestore.Record{}
		for key, value := range typed {
			out[key] = value
		}
		return out
	default:
		return corestore.Record{}
	}
}

func mergeTags(base corestore.Record, patch corestore.Record) corestore.Record {
	merged := corestore.Record{}
	for key, value := range base {
		merged[key] = stringValue(value)
	}
	for key, value := range patch {
		merged[key] = stringValue(value)
	}
	return merged
}

func tagListResponse(tags corestore.Record) []map[string]string {
	keys := make([]string, 0, len(tags))
	for key := range tags {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	out := make([]map[string]string, 0, len(keys))
	for _, key := range keys {
		out = append(out, map[string]string{"Key": key, "Value": stringValue(tags[key])})
	}
	return out
}

func reverseRecords(records []corestore.Record) {
	for i, j := 0, len(records)-1; i < j; i, j = i+1, j-1 {
		records[i], records[j] = records[j], records[i]
	}
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}
