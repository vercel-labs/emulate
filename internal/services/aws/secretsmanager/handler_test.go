package secretsmanager

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	corestore "github.com/vercel-labs/emulate/internal/core/store"
	"github.com/vercel-labs/emulate/internal/services/aws/gateway"
	"github.com/vercel-labs/emulate/internal/services/aws/protocols"
)

func TestHandlerCreatesGetsRotatesAndDescribesSecrets(t *testing.T) {
	handler := newTestSecretsManagerHandler()

	response := handler.call("CreateSecret", map[string]any{
		"Name":               "app/database",
		"Description":        "database password",
		"KmsKeyId":           "alias/app",
		"ClientRequestToken": "version-one",
		"SecretString":       "initial",
		"Tags": []map[string]any{
			{"Key": "env", "Value": "test"},
		},
	})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("create status = %d, body = %s", response.StatusCode, response.Body)
	}
	var created struct {
		ARN       string `json:"ARN"`
		Name      string `json:"Name"`
		VersionID string `json:"VersionId"`
	}
	decodeSecretsBody(t, response, &created)
	if created.Name != "app/database" || created.VersionID != "version-one" || !strings.Contains(created.ARN, ":secret:app/database-") {
		t.Fatalf("unexpected create response: %#v", created)
	}

	response = handler.call("GetSecretValue", map[string]any{"SecretId": "app/database"})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("get status = %d, body = %s", response.StatusCode, response.Body)
	}
	var got struct {
		SecretString  string   `json:"SecretString"`
		VersionID     string   `json:"VersionId"`
		VersionStages []string `json:"VersionStages"`
	}
	decodeSecretsBody(t, response, &got)
	if got.SecretString != "initial" || got.VersionID != "version-one" || strings.Join(got.VersionStages, ",") != "AWSCURRENT" {
		t.Fatalf("unexpected secret value: %#v", got)
	}

	response = handler.call("PutSecretValue", map[string]any{
		"SecretId":           created.ARN,
		"ClientRequestToken": "version-two",
		"SecretString":       "rotated",
	})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("put status = %d, body = %s", response.StatusCode, response.Body)
	}

	response = handler.call("GetSecretValue", map[string]any{"SecretId": "app/database"})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("get rotated status = %d, body = %s", response.StatusCode, response.Body)
	}
	decodeSecretsBody(t, response, &got)
	if got.SecretString != "rotated" || got.VersionID != "version-two" || strings.Join(got.VersionStages, ",") != "AWSCURRENT" {
		t.Fatalf("unexpected rotated value: %#v", got)
	}

	response = handler.call("GetSecretValue", map[string]any{"SecretId": "app/database", "VersionId": "version-one"})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("get previous status = %d, body = %s", response.StatusCode, response.Body)
	}
	decodeSecretsBody(t, response, &got)
	if got.SecretString != "initial" || strings.Join(got.VersionStages, ",") != "AWSPREVIOUS" {
		t.Fatalf("unexpected previous value: %#v", got)
	}

	response = handler.call("DescribeSecret", map[string]any{"SecretId": created.ARN})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("describe status = %d, body = %s", response.StatusCode, response.Body)
	}
	var described struct {
		KMSKeyID           string              `json:"KmsKeyId"`
		Tags               []map[string]string `json:"Tags"`
		VersionIDsToStages map[string][]string `json:"VersionIdsToStages"`
	}
	decodeSecretsBody(t, response, &described)
	if described.KMSKeyID != "alias/app" {
		t.Fatalf("kms key id = %q", described.KMSKeyID)
	}
	if !containsTag(described.Tags, "env", "test") {
		t.Fatalf("missing tag in %#v", described.Tags)
	}
	if strings.Join(described.VersionIDsToStages["version-one"], ",") != "AWSPREVIOUS" || strings.Join(described.VersionIDsToStages["version-two"], ",") != "AWSCURRENT" {
		t.Fatalf("unexpected version stages: %#v", described.VersionIDsToStages)
	}
}

func TestHandlerSupportsBinarySecretsTagsDeleteAndRestore(t *testing.T) {
	handler := newTestSecretsManagerHandler()
	response := handler.call("CreateSecret", map[string]any{
		"Name":         "binary-secret",
		"SecretBinary": "AQIDBA==",
	})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("create status = %d, body = %s", response.StatusCode, response.Body)
	}

	response = handler.call("GetSecretValue", map[string]any{"SecretId": "binary-secret"})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("get binary status = %d, body = %s", response.StatusCode, response.Body)
	}
	var got struct {
		SecretBinary string `json:"SecretBinary"`
	}
	decodeSecretsBody(t, response, &got)
	if got.SecretBinary != "AQIDBA==" {
		t.Fatalf("secret binary = %q", got.SecretBinary)
	}

	response = handler.call("TagResource", map[string]any{
		"SecretId": "binary-secret",
		"Tags":     []map[string]any{{"Key": "team", "Value": "platform"}},
	})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("tag status = %d, body = %s", response.StatusCode, response.Body)
	}
	response = handler.call("UntagResource", map[string]any{"SecretId": "binary-secret", "TagKeys": []string{"team"}})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("untag status = %d, body = %s", response.StatusCode, response.Body)
	}
	response = handler.call("DescribeSecret", map[string]any{"SecretId": "binary-secret"})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("describe status = %d, body = %s", response.StatusCode, response.Body)
	}
	var described struct {
		Tags []map[string]string `json:"Tags"`
	}
	decodeSecretsBody(t, response, &described)
	if containsTag(described.Tags, "team", "platform") {
		t.Fatalf("tag was not removed: %#v", described.Tags)
	}

	response = handler.call("DeleteSecret", map[string]any{"SecretId": "binary-secret", "RecoveryWindowInDays": 7})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("delete status = %d, body = %s", response.StatusCode, response.Body)
	}
	var deleted struct {
		DeletionDate int64 `json:"DeletionDate"`
	}
	decodeSecretsBody(t, response, &deleted)
	if deleted.DeletionDate == 0 {
		t.Fatalf("missing deletion date in %s", response.Body)
	}

	response = handler.call("GetSecretValue", map[string]any{"SecretId": "binary-secret"})
	if response.StatusCode != http.StatusBadRequest || response.Headers["x-amzn-errortype"] != "InvalidRequestException" {
		t.Fatalf("deleted get status = %d, headers = %#v, body = %s", response.StatusCode, response.Headers, response.Body)
	}

	response = handler.call("ListSecrets", map[string]any{})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("list status = %d, body = %s", response.StatusCode, response.Body)
	}
	var listed struct {
		SecretList []struct {
			Name string `json:"Name"`
		} `json:"SecretList"`
	}
	decodeSecretsBody(t, response, &listed)
	if len(listed.SecretList) != 0 {
		t.Fatalf("deleted secret should be hidden by default: %#v", listed.SecretList)
	}

	response = handler.call("ListSecrets", map[string]any{"IncludePlannedDeletion": true})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("list deleted status = %d, body = %s", response.StatusCode, response.Body)
	}
	decodeSecretsBody(t, response, &listed)
	if len(listed.SecretList) != 1 || listed.SecretList[0].Name != "binary-secret" {
		t.Fatalf("planned deletion list = %#v", listed.SecretList)
	}

	response = handler.call("RestoreSecret", map[string]any{"SecretId": "binary-secret"})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("restore status = %d, body = %s", response.StatusCode, response.Body)
	}
	response = handler.call("GetSecretValue", map[string]any{"SecretId": "binary-secret"})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("get restored status = %d, body = %s", response.StatusCode, response.Body)
	}
}

func TestHandlerListsSecretVersionIds(t *testing.T) {
	handler := newTestSecretsManagerHandler()
	handler.call("CreateSecret", map[string]any{"Name": "versions", "ClientRequestToken": "one", "SecretString": "one"})
	handler.call("PutSecretValue", map[string]any{"SecretId": "versions", "ClientRequestToken": "two", "SecretString": "two"})

	response := handler.call("ListSecretVersionIds", map[string]any{"SecretId": "versions"})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("list versions status = %d, body = %s", response.StatusCode, response.Body)
	}
	var body struct {
		Versions []struct {
			VersionID     string   `json:"VersionId"`
			VersionStages []string `json:"VersionStages"`
		} `json:"Versions"`
	}
	decodeSecretsBody(t, response, &body)
	if len(body.Versions) != 2 {
		t.Fatalf("versions = %#v", body.Versions)
	}
}

func TestHandlerCreateSecretIsIdempotentForClientRequestToken(t *testing.T) {
	handler := newTestSecretsManagerHandler()
	input := map[string]any{
		"Name":               "idempotent",
		"ClientRequestToken": "stable-token",
		"SecretString":       "same-value",
	}

	response := handler.call("CreateSecret", input)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("first create status = %d, body = %s", response.StatusCode, response.Body)
	}
	response = handler.call("CreateSecret", input)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("second create status = %d, body = %s", response.StatusCode, response.Body)
	}
	var created struct {
		VersionID string `json:"VersionId"`
	}
	decodeSecretsBody(t, response, &created)
	if created.VersionID != "stable-token" {
		t.Fatalf("version id = %q", created.VersionID)
	}
	if handler.handler.Secrets.Count() != 1 || handler.handler.Versions.Count() != 1 {
		t.Fatalf("unexpected counts: secrets=%d versions=%d", handler.handler.Secrets.Count(), handler.handler.Versions.Count())
	}

	response = handler.call("CreateSecret", map[string]any{
		"Name":               "idempotent",
		"ClientRequestToken": "stable-token",
		"SecretString":       "different-value",
	})
	if response.StatusCode != http.StatusBadRequest || response.Headers["x-amzn-errortype"] != "ResourceExistsException" {
		t.Fatalf("conflicting create status = %d, headers = %#v, body = %s", response.StatusCode, response.Headers, response.Body)
	}
}

func TestHandlerIdempotentExistingVersionDoesNotMoveStages(t *testing.T) {
	handler := newTestSecretsManagerHandler()
	response := handler.call("CreateSecret", map[string]any{
		"Name":               "stage-retry",
		"ClientRequestToken": "one",
		"SecretString":       "one",
	})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("create status = %d, body = %s", response.StatusCode, response.Body)
	}
	response = handler.call("PutSecretValue", map[string]any{
		"SecretId":           "stage-retry",
		"ClientRequestToken": "two",
		"SecretString":       "two",
	})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("put status = %d, body = %s", response.StatusCode, response.Body)
	}

	response = handler.call("PutSecretValue", map[string]any{
		"SecretId":           "stage-retry",
		"ClientRequestToken": "one",
		"SecretString":       "one",
	})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("idempotent put status = %d, body = %s", response.StatusCode, response.Body)
	}
	var putBody struct {
		VersionStages []string `json:"VersionStages"`
	}
	decodeSecretsBody(t, response, &putBody)
	if strings.Join(putBody.VersionStages, ",") != "AWSPREVIOUS" {
		t.Fatalf("idempotent put moved stages: %#v", putBody.VersionStages)
	}

	response = handler.call("UpdateSecret", map[string]any{
		"SecretId":           "stage-retry",
		"ClientRequestToken": "one",
		"SecretString":       "one",
	})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("idempotent update status = %d, body = %s", response.StatusCode, response.Body)
	}

	response = handler.call("GetSecretValue", map[string]any{"SecretId": "stage-retry"})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("get current status = %d, body = %s", response.StatusCode, response.Body)
	}
	var current struct {
		SecretString  string   `json:"SecretString"`
		VersionID     string   `json:"VersionId"`
		VersionStages []string `json:"VersionStages"`
	}
	decodeSecretsBody(t, response, &current)
	if current.SecretString != "two" || current.VersionID != "two" || strings.Join(current.VersionStages, ",") != "AWSCURRENT" {
		t.Fatalf("current version changed after idempotent retry: %#v", current)
	}

	response = handler.call("DescribeSecret", map[string]any{"SecretId": "stage-retry"})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("describe status = %d, body = %s", response.StatusCode, response.Body)
	}
	var described struct {
		VersionIDsToStages map[string][]string `json:"VersionIdsToStages"`
	}
	decodeSecretsBody(t, response, &described)
	if strings.Join(described.VersionIDsToStages["one"], ",") != "AWSPREVIOUS" || strings.Join(described.VersionIDsToStages["two"], ",") != "AWSCURRENT" {
		t.Fatalf("unexpected stages after idempotent retry: %#v", described.VersionIDsToStages)
	}
}

func TestHandlerForceDeleteRemovesSecretAndVersions(t *testing.T) {
	handler := newTestSecretsManagerHandler()
	response := handler.call("CreateSecret", map[string]any{
		"Name":               "force-delete",
		"ClientRequestToken": "one",
		"SecretString":       "value",
	})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("create status = %d, body = %s", response.StatusCode, response.Body)
	}

	response = handler.call("DeleteSecret", map[string]any{"SecretId": "force-delete", "ForceDeleteWithoutRecovery": true})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("force delete status = %d, body = %s", response.StatusCode, response.Body)
	}
	if handler.handler.Secrets.Count() != 0 || handler.handler.Versions.Count() != 0 {
		t.Fatalf("force deleted records remain: secrets=%d versions=%d", handler.handler.Secrets.Count(), handler.handler.Versions.Count())
	}

	response = handler.call("RestoreSecret", map[string]any{"SecretId": "force-delete"})
	if response.StatusCode != http.StatusBadRequest || response.Headers["x-amzn-errortype"] != "ResourceNotFoundException" {
		t.Fatalf("restore force deleted status = %d, headers = %#v, body = %s", response.StatusCode, response.Headers, response.Body)
	}

	response = handler.call("CreateSecret", map[string]any{"Name": "force-delete", "SecretString": "new-value"})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("recreate status = %d, body = %s", response.StatusCode, response.Body)
	}
}

func TestHandlerUpdatesSecretMetadataAndValue(t *testing.T) {
	handler := newTestSecretsManagerHandler()
	handler.call("CreateSecret", map[string]any{
		"Name":               "update-me",
		"ClientRequestToken": "one",
		"SecretString":       "one",
	})

	response := handler.call("UpdateSecret", map[string]any{
		"SecretId":           "update-me",
		"Description":        "updated",
		"ClientRequestToken": "two",
		"SecretString":       "two",
	})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("update status = %d, body = %s", response.StatusCode, response.Body)
	}

	response = handler.call("GetSecretValue", map[string]any{"SecretId": "update-me"})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("get updated status = %d, body = %s", response.StatusCode, response.Body)
	}
	var got struct {
		SecretString string `json:"SecretString"`
	}
	decodeSecretsBody(t, response, &got)
	if got.SecretString != "two" {
		t.Fatalf("secret string = %q", got.SecretString)
	}

	response = handler.call("DescribeSecret", map[string]any{"SecretId": "update-me"})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("describe updated status = %d, body = %s", response.StatusCode, response.Body)
	}
	var described struct {
		Description        string              `json:"Description"`
		VersionIDsToStages map[string][]string `json:"VersionIdsToStages"`
	}
	decodeSecretsBody(t, response, &described)
	if described.Description != "updated" || strings.Join(described.VersionIDsToStages["two"], ",") != "AWSCURRENT" {
		t.Fatalf("unexpected description or stages: %#v", described)
	}
}

type testSecretsManagerHandler struct {
	handler Handler
	mu      sync.Mutex
	ids     int
}

func newTestSecretsManagerHandler() *testSecretsManagerHandler {
	store := corestore.New()
	tester := &testSecretsManagerHandler{}
	tester.handler = Handler{
		Secrets:   store.MustCollection("aws.secretsmanager_secrets", "account_id", "region", "name", "arn"),
		Versions:  store.MustCollection("aws.secretsmanager_versions", "account_id", "region", "secret_arn", "secret_name", "version_id"),
		AccountID: "123456789012",
		Region:    "us-east-1",
		Now: func() time.Time {
			return time.Unix(1700000000, 0).UTC()
		},
		IDGenerator: tester.generateID,
	}
	return tester
}

func (h *testSecretsManagerHandler) call(action string, input map[string]any) protocols.ErrorResponse {
	return h.handler.Handle(nil, gateway.AwsRequestContext{
		RequestID: "req-test",
		Service:   "secretsmanager",
		Action:    action,
		AccountID: "123456789012",
		Region:    "us-east-1",
		Input:     input,
	})
}

func (h *testSecretsManagerHandler) generateID(prefix string) string {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.ids++
	switch prefix {
	case "suffix":
		return "abc123"
	case "version":
		return fmtVersionID(h.ids)
	default:
		return prefix + "-test"
	}
}

func fmtVersionID(value int) string {
	return "generated-version-" + strconv.Itoa(value)
}

func decodeSecretsBody(t *testing.T, response protocols.ErrorResponse, target any) {
	t.Helper()
	if err := json.Unmarshal(response.Body, target); err != nil {
		t.Fatalf("decode body %s: %v", string(response.Body), err)
	}
}

func containsTag(tags []map[string]string, key string, value string) bool {
	for _, tag := range tags {
		if tag["Key"] == key && tag["Value"] == value {
			return true
		}
	}
	return false
}
