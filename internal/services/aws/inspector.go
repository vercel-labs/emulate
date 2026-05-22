package aws

import (
	"fmt"
	"strings"

	corehttp "github.com/vercel-labs/emulate/internal/core/http"
	corestore "github.com/vercel-labs/emulate/internal/core/store"
	"github.com/vercel-labs/emulate/internal/core/ui"
)

var inspectorTabs = []ui.InspectorTab{
	{ID: "s3", Label: "S3", Href: "/_inspector?tab=s3"},
	{ID: "sqs", Label: "SQS", Href: "/_inspector?tab=sqs"},
	{ID: "iam", Label: "IAM", Href: "/_inspector?tab=iam"},
	{ID: "logs", Label: "Logs", Href: "/_inspector?tab=logs"},
	{ID: "secretsmanager", Label: "Secrets", Href: "/_inspector?tab=secretsmanager"},
	{ID: "ssm", Label: "SSM", Href: "/_inspector?tab=ssm"},
	{ID: "kms", Label: "KMS", Href: "/_inspector?tab=kms"},
	{ID: "lambda", Label: "Lambda", Href: "/_inspector?tab=lambda"},
}

func (s *Service) handleInspector(c *corehttp.Context) {
	tab := c.Query("tab")
	if tab != "s3" && tab != "sqs" && tab != "iam" && tab != "logs" && tab != "secretsmanager" && tab != "ssm" && tab != "kms" && tab != "lambda" {
		tab = "s3"
	}
	tabs := make([]ui.InspectorTab, len(inspectorTabs))
	for index, item := range inspectorTabs {
		tabs[index] = item
		tabs[index].Active = item.ID == tab
	}

	var body string
	switch tab {
	case "sqs":
		body = s.renderSQSInspector()
	case "iam":
		body = s.renderIAMInspector()
	case "logs":
		body = s.renderLogsInspector()
	case "secretsmanager":
		body = s.renderSecretsManagerInspector()
	case "ssm":
		body = s.renderSSMInspector()
	case "kms":
		body = s.renderKMSInspector()
	case "lambda":
		body = s.renderLambdaInspector()
	default:
		body = s.renderS3Inspector()
	}

	c.HTML(200, ui.RenderInspectorPage("Inspector", tabs, tab, body, ui.PageOptions{Service: "AWS"}))
}

func (s *Service) renderS3Inspector() string {
	buckets := s.store.S3Buckets.All()
	var rows strings.Builder
	for _, bucket := range buckets {
		name := stringField(bucket, "bucket_name")
		objects := s.store.S3Objects.FindBy("bucket_name", name)
		rows.WriteString(`<tr><td>`)
		rows.WriteString(ui.EscapeHTML(name))
		rows.WriteString(`</td><td>`)
		rows.WriteString(fmt.Sprint(len(objects)))
		rows.WriteString(`</td><td>`)
		rows.WriteString(ui.EscapeHTML(stringField(bucket, "region")))
		rows.WriteString(`</td><td>`)
		rows.WriteString(ui.EscapeHTML(stringField(bucket, "creation_date")))
		rows.WriteString(`</td></tr>`)
	}
	return `<div class="inspector-section">
  <h2>S3 Buckets (` + fmt.Sprint(len(buckets)) + `)</h2>
  <table class="inspector-table">
    <thead><tr><th>Bucket</th><th>Objects</th><th>Region</th><th>Created</th></tr></thead>
    <tbody>` + rowsOrEmpty(rows.String(), 4, "No buckets") + `</tbody>
  </table>
</div>`
}

func (s *Service) renderSQSInspector() string {
	queues := s.store.SQSQueues.All()
	var rows strings.Builder
	for _, queue := range queues {
		name := stringField(queue, "queue_name")
		messages := s.store.SQSMessages.FindBy("queue_name", name)
		rows.WriteString(`<tr><td>`)
		rows.WriteString(ui.EscapeHTML(name))
		rows.WriteString(`</td><td>`)
		rows.WriteString(fmt.Sprint(len(messages)))
		rows.WriteString(`</td><td>`)
		rows.WriteString(yesNo(boolField(queue, "fifo")))
		rows.WriteString(`</td><td>`)
		rows.WriteString(ui.EscapeHTML(stringField(queue, "visibility_timeout")))
		rows.WriteString(`</td></tr>`)
	}
	return `<div class="inspector-section">
  <h2>SQS Queues (` + fmt.Sprint(len(queues)) + `)</h2>
  <table class="inspector-table">
    <thead><tr><th>Queue</th><th>Messages</th><th>FIFO</th><th>Visibility Timeout</th></tr></thead>
    <tbody>` + rowsOrEmpty(rows.String(), 4, "No queues") + `</tbody>
  </table>
</div>`
}

func (s *Service) renderIAMInspector() string {
	users := s.store.IAMUsers.All()
	roles := s.store.IAMRoles.All()
	var userRows strings.Builder
	for _, user := range users {
		userRows.WriteString(`<tr><td>`)
		userRows.WriteString(ui.EscapeHTML(stringField(user, "user_name")))
		userRows.WriteString(`</td><td>`)
		userRows.WriteString(ui.EscapeHTML(stringField(user, "user_id")))
		userRows.WriteString(`</td><td>`)
		userRows.WriteString(fmt.Sprint(accessKeyCount(user)))
		userRows.WriteString(`</td><td>`)
		userRows.WriteString(ui.EscapeHTML(stringField(user, "arn")))
		userRows.WriteString(`</td></tr>`)
	}
	var roleRows strings.Builder
	for _, role := range roles {
		roleRows.WriteString(`<tr><td>`)
		roleRows.WriteString(ui.EscapeHTML(stringField(role, "role_name")))
		roleRows.WriteString(`</td><td>`)
		roleRows.WriteString(ui.EscapeHTML(stringField(role, "role_id")))
		roleRows.WriteString(`</td><td>`)
		roleRows.WriteString(ui.EscapeHTML(stringField(role, "description")))
		roleRows.WriteString(`</td><td>`)
		roleRows.WriteString(ui.EscapeHTML(stringField(role, "arn")))
		roleRows.WriteString(`</td></tr>`)
	}
	return `<div class="inspector-section">
  <h2>IAM Users (` + fmt.Sprint(len(users)) + `)</h2>
  <table class="inspector-table">
    <thead><tr><th>User</th><th>User ID</th><th>Access Keys</th><th>ARN</th></tr></thead>
    <tbody>` + rowsOrEmpty(userRows.String(), 4, "No users") + `</tbody>
  </table>
</div>
<div class="inspector-section">
  <h2>IAM Roles (` + fmt.Sprint(len(roles)) + `)</h2>
  <table class="inspector-table">
    <thead><tr><th>Role</th><th>Role ID</th><th>Description</th><th>ARN</th></tr></thead>
    <tbody>` + rowsOrEmpty(roleRows.String(), 4, "No roles") + `</tbody>
  </table>
</div>`
}

func (s *Service) renderLogsInspector() string {
	groups := s.store.LogGroups.All()
	var groupRows strings.Builder
	for _, group := range groups {
		name := stringField(group, "log_group_name")
		streamCount := 0
		for _, stream := range s.store.LogStreams.FindBy("log_group_name", name) {
			if stringField(stream, "account_id") == stringField(group, "account_id") && stringField(stream, "region") == stringField(group, "region") {
				streamCount++
			}
		}
		eventCount := 0
		for _, event := range s.store.LogEvents.FindBy("log_group_name", name) {
			if stringField(event, "account_id") == stringField(group, "account_id") && stringField(event, "region") == stringField(group, "region") {
				eventCount++
			}
		}
		groupRows.WriteString(`<tr><td>`)
		groupRows.WriteString(ui.EscapeHTML(name))
		groupRows.WriteString(`</td><td>`)
		groupRows.WriteString(fmt.Sprint(streamCount))
		groupRows.WriteString(`</td><td>`)
		groupRows.WriteString(fmt.Sprint(eventCount))
		groupRows.WriteString(`</td><td>`)
		groupRows.WriteString(ui.EscapeHTML(stringField(group, "retention_in_days")))
		groupRows.WriteString(`</td><td>`)
		groupRows.WriteString(ui.EscapeHTML(stringField(group, "arn")))
		groupRows.WriteString(`</td></tr>`)
	}
	return `<div class="inspector-section">
  <h2>CloudWatch Log Groups (` + fmt.Sprint(len(groups)) + `)</h2>
  <table class="inspector-table">
    <thead><tr><th>Log Group</th><th>Streams</th><th>Events</th><th>Retention Days</th><th>ARN</th></tr></thead>
    <tbody>` + rowsOrEmpty(groupRows.String(), 5, "No log groups") + `</tbody>
  </table>
</div>`
}

func (s *Service) renderSecretsManagerInspector() string {
	secrets := s.store.Secrets.All()
	var rows strings.Builder
	for _, secret := range secrets {
		arn := stringField(secret, "arn")
		versionCount := len(s.store.SecretVersions.FindBy("secret_arn", arn))
		rows.WriteString(`<tr><td>`)
		rows.WriteString(ui.EscapeHTML(stringField(secret, "name")))
		rows.WriteString(`</td><td>`)
		rows.WriteString(fmt.Sprint(versionCount))
		rows.WriteString(`</td><td>`)
		rows.WriteString(ui.EscapeHTML(stringField(secret, "kms_key_id")))
		rows.WriteString(`</td><td>`)
		if stringField(secret, "deleted_date") != "" && stringField(secret, "deleted_date") != "0" {
			rows.WriteString(`Scheduled deletion`)
		} else {
			rows.WriteString(`Active`)
		}
		rows.WriteString(`</td><td>`)
		rows.WriteString(ui.EscapeHTML(arn))
		rows.WriteString(`</td></tr>`)
	}
	return `<div class="inspector-section">
  <h2>Secrets Manager Secrets (` + fmt.Sprint(len(secrets)) + `)</h2>
  <table class="inspector-table">
    <thead><tr><th>Secret</th><th>Versions</th><th>KMS Key</th><th>Status</th><th>ARN</th></tr></thead>
    <tbody>` + rowsOrEmpty(rows.String(), 5, "No secrets") + `</tbody>
  </table>
</div>`
}

func (s *Service) renderSSMInspector() string {
	parameters := s.store.SSMParameters.All()
	var rows strings.Builder
	for _, parameter := range parameters {
		rows.WriteString(`<tr><td>`)
		rows.WriteString(ui.EscapeHTML(stringField(parameter, "name")))
		rows.WriteString(`</td><td>`)
		rows.WriteString(ui.EscapeHTML(stringField(parameter, "type")))
		rows.WriteString(`</td><td>`)
		rows.WriteString(ui.EscapeHTML(stringField(parameter, "version")))
		rows.WriteString(`</td><td>`)
		rows.WriteString(ui.EscapeHTML(stringField(parameter, "tier")))
		rows.WriteString(`</td><td>`)
		rows.WriteString(ui.EscapeHTML(stringField(parameter, "arn")))
		rows.WriteString(`</td></tr>`)
	}
	return `<div class="inspector-section">
  <h2>SSM Parameters (` + fmt.Sprint(len(parameters)) + `)</h2>
  <table class="inspector-table">
    <thead><tr><th>Parameter</th><th>Type</th><th>Version</th><th>Tier</th><th>ARN</th></tr></thead>
    <tbody>` + rowsOrEmpty(rows.String(), 5, "No parameters") + `</tbody>
  </table>
</div>`
}

func (s *Service) renderKMSInspector() string {
	keys := s.store.KMSKeys.All()
	var rows strings.Builder
	for _, key := range keys {
		keyID := stringField(key, "key_id")
		aliasCount := len(s.store.KMSAliases.FindBy("target_key_id", keyID))
		rows.WriteString(`<tr><td>`)
		rows.WriteString(ui.EscapeHTML(keyID))
		rows.WriteString(`</td><td>`)
		rows.WriteString(fmt.Sprint(aliasCount))
		rows.WriteString(`</td><td>`)
		rows.WriteString(ui.EscapeHTML(stringField(key, "key_state")))
		rows.WriteString(`</td><td>`)
		rows.WriteString(ui.EscapeHTML(stringField(key, "key_usage")))
		rows.WriteString(`</td><td>`)
		rows.WriteString(ui.EscapeHTML(stringField(key, "arn")))
		rows.WriteString(`</td></tr>`)
	}
	return `<div class="inspector-section">
  <h2>KMS Keys (` + fmt.Sprint(len(keys)) + `)</h2>
  <table class="inspector-table">
    <thead><tr><th>Key ID</th><th>Aliases</th><th>State</th><th>Usage</th><th>ARN</th></tr></thead>
    <tbody>` + rowsOrEmpty(rows.String(), 5, "No KMS keys") + `</tbody>
  </table>
</div>`
}

func (s *Service) renderLambdaInspector() string {
	functions := s.store.LambdaFunctions.All()
	var rows strings.Builder
	for _, fn := range functions {
		rows.WriteString(`<tr><td>`)
		rows.WriteString(ui.EscapeHTML(stringField(fn, "function_name")))
		rows.WriteString(`</td><td>`)
		rows.WriteString(ui.EscapeHTML(stringField(fn, "runtime")))
		rows.WriteString(`</td><td>`)
		rows.WriteString(ui.EscapeHTML(stringField(fn, "handler")))
		rows.WriteString(`</td><td>`)
		rows.WriteString(ui.EscapeHTML(stringField(fn, "state")))
		rows.WriteString(`</td><td>`)
		rows.WriteString(ui.EscapeHTML(stringField(fn, "arn")))
		rows.WriteString(`</td></tr>`)
	}
	return `<div class="inspector-section">
  <h2>Lambda Functions (` + fmt.Sprint(len(functions)) + `)</h2>
  <table class="inspector-table">
    <thead><tr><th>Function</th><th>Runtime</th><th>Handler</th><th>State</th><th>ARN</th></tr></thead>
    <tbody>` + rowsOrEmpty(rows.String(), 5, "No Lambda functions") + `</tbody>
  </table>
</div>`
}

func rowsOrEmpty(rows string, columns int, label string) string {
	if rows != "" {
		return rows
	}
	return `<tr><td colspan="` + fmt.Sprint(columns) + `"><div class="inspector-empty">` + ui.EscapeHTML(label) + `</div></td></tr>`
}

func stringField(record corestore.Record, name string) string {
	switch value := record[name].(type) {
	case string:
		return value
	case int:
		return fmt.Sprint(value)
	case int64:
		return fmt.Sprint(value)
	case float64:
		return fmt.Sprint(value)
	default:
		return ""
	}
}

func boolField(record corestore.Record, name string) bool {
	value, _ := record[name].(bool)
	return value
}

func yesNo(value bool) string {
	if value {
		return "Yes"
	}
	return "No"
}

func accessKeyCount(record corestore.Record) int {
	switch value := record["access_keys"].(type) {
	case []corestore.Record:
		return len(value)
	case []any:
		return len(value)
	case []map[string]any:
		return len(value)
	default:
		return 0
	}
}
