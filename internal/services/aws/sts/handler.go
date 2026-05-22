package sts

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	corestore "github.com/vercel-labs/emulate/internal/core/store"
	"github.com/vercel-labs/emulate/internal/services/aws/auth"
	"github.com/vercel-labs/emulate/internal/services/aws/gateway"
	"github.com/vercel-labs/emulate/internal/services/aws/protocols"
)

type Handler struct {
	Users           *corestore.Collection
	Roles           *corestore.Collection
	CredentialStore *auth.Store
	AccountID       string
	Now             func() time.Time
	IDGenerator     func(string) string
	SecretGenerator func(int) string
}

var fallbackIDCounter atomic.Uint64

func (h *Handler) Handle(_ *http.Request, ctx gateway.AwsRequestContext) protocols.ErrorResponse {
	requestID := ctx.RequestID
	if requestID == "" {
		requestID = h.generateID("req")
	}
	var response protocols.ErrorResponse
	switch ctx.Action {
	case "GetCallerIdentity":
		response = h.getCallerIdentity(ctx, requestID)
	case "AssumeRole":
		response = h.assumeRole(ctx.Query, requestID)
	default:
		action := ctx.Action
		response = h.queryError("InvalidAction", "The action "+action+" is not valid for this endpoint.", http.StatusBadRequest, requestID)
	}
	return withRequestID(response, requestID)
}

func (h *Handler) getCallerIdentity(ctx gateway.AwsRequestContext, requestID string) protocols.ErrorResponse {
	accountID := ctx.AccountID
	if accountID == "" {
		accountID = h.accountID()
	}
	arn := ctx.Principal.ARN
	if arn == "" {
		arn = "arn:aws:iam::" + accountID + ":user/emulate"
	}
	body := `<?xml version="1.0" encoding="UTF-8"?>
<GetCallerIdentityResponse>
  <GetCallerIdentityResult>
    <Arn>` + xmlEscape(arn) + `</Arn>
    <UserId>` + xmlEscape(h.userIDForPrincipal(arn)) + `</UserId>
    <Account>` + xmlEscape(accountID) + `</Account>
  </GetCallerIdentityResult>
  <ResponseMetadata><RequestId>` + xmlEscape(requestID) + `</RequestId></ResponseMetadata>
</GetCallerIdentityResponse>`
	return xmlResponse(http.StatusOK, body)
}

func (h *Handler) assumeRole(params map[string]string, requestID string) protocols.ErrorResponse {
	roleARN := params["RoleArn"]
	sessionName := params["RoleSessionName"]
	if sessionName == "" {
		sessionName = "session"
	}
	role, ok := h.findRoleByARN(roleARN)
	if !ok {
		return h.queryError("NoSuchEntity", "The role specified cannot be found.", http.StatusNotFound, requestID)
	}
	accessKeyID := "ASIA" + h.generateID("")[0:16]
	secretAccessKey := h.generateSecret(30)
	sessionToken := h.generateSecret(64)
	durationSeconds := intParam(params["DurationSeconds"], 3600)
	if durationSeconds <= 0 {
		durationSeconds = 3600
	}
	expirationTime := h.now().Add(time.Duration(durationSeconds) * time.Second)
	expiration := expirationTime.Format(time.RFC3339Nano)
	principalARN := roleARN + "/" + sessionName
	h.CredentialStore.Put(auth.Credential{
		AccessKeyID:     accessKeyID,
		SecretAccessKey: secretAccessKey,
		SessionToken:    sessionToken,
		AccountID:       h.accountID(),
		PrincipalARN:    principalARN,
		ExpiresAt:       expirationTime,
		SessionTags:     indexedTags(params),
		TransitiveTags:  indexedNames(params, "TransitiveTagKeys.member"),
	})
	body := `<?xml version="1.0" encoding="UTF-8"?>
<AssumeRoleResponse>
  <AssumeRoleResult>
    <Credentials>
      <AccessKeyId>` + accessKeyID + `</AccessKeyId>
      <SecretAccessKey>` + xmlEscape(secretAccessKey) + `</SecretAccessKey>
      <SessionToken>` + xmlEscape(sessionToken) + `</SessionToken>
      <Expiration>` + xmlEscape(expiration) + `</Expiration>
    </Credentials>
    <AssumedRoleUser>
      <Arn>` + xmlEscape(principalARN) + `</Arn>
      <AssumedRoleId>` + xmlEscape(stringField(role, "role_id")+":"+sessionName) + `</AssumedRoleId>
    </AssumedRoleUser>
    <PackedPolicySize>0</PackedPolicySize>
  </AssumeRoleResult>
  <ResponseMetadata><RequestId>` + xmlEscape(requestID) + `</RequestId></ResponseMetadata>
</AssumeRoleResponse>`
	return xmlResponse(http.StatusOK, body)
}

func (h *Handler) userIDForPrincipal(arn string) string {
	for _, user := range h.Users.All() {
		if stringField(user, "arn") == arn {
			return stringField(user, "user_id")
		}
	}
	for _, role := range h.Roles.All() {
		prefix := stringField(role, "arn") + "/"
		if strings.HasPrefix(arn, prefix) {
			sessionName := strings.TrimPrefix(arn, prefix)
			return stringField(role, "role_id") + ":" + sessionName
		}
	}
	if name, ok := strings.CutPrefix(arn, "arn:aws:iam::"+h.accountID()+":user/"); ok {
		if user := h.userByName(name); user != nil {
			return stringField(user, "user_id")
		}
	}
	return "AIDAEMULATEUSERID"
}

func (h *Handler) findRoleByARN(roleARN string) (corestore.Record, bool) {
	for _, role := range h.Roles.All() {
		if stringField(role, "arn") == roleARN {
			return role, true
		}
	}
	return nil, false
}

func (h *Handler) userByName(userName string) corestore.Record {
	for _, user := range h.Users.FindBy("user_name", userName) {
		return user
	}
	return nil
}

func (h *Handler) queryError(code string, message string, status int, requestID string) protocols.ErrorResponse {
	return protocols.SerializeXMLError(protocols.AWSError{
		Code:       code,
		Message:    message,
		RequestID:  requestID,
		StatusCode: status,
	})
}

func (h *Handler) now() time.Time {
	if h.Now != nil {
		return h.Now().UTC()
	}
	return time.Now().UTC()
}

func (h *Handler) accountID() string {
	if h.AccountID != "" {
		return h.AccountID
	}
	return gateway.DefaultAccountID
}

func (h *Handler) generateID(prefix string) string {
	if h.IDGenerator != nil {
		return h.IDGenerator(prefix)
	}
	var bytes [8]byte
	if _, err := rand.Read(bytes[:]); err == nil {
		return prefix + strings.ToUpper(hex.EncodeToString(bytes[:]))
	}
	return fmt.Sprintf("%s%016X", prefix, fallbackIDCounter.Add(1))
}

func (h *Handler) generateSecret(size int) string {
	if h.SecretGenerator != nil {
		return h.SecretGenerator(size)
	}
	bytes := make([]byte, size)
	if _, err := rand.Read(bytes); err == nil {
		return base64.StdEncoding.EncodeToString(bytes)
	}
	return fmt.Sprintf("secret-%d", fallbackIDCounter.Add(1))
}

func stringField(record corestore.Record, name string) string {
	switch value := record[name].(type) {
	case string:
		return value
	default:
		if value == nil {
			return ""
		}
		return fmt.Sprint(value)
	}
}

func intParam(raw string, fallback int) int {
	value, err := strconv.Atoi(raw)
	if err != nil {
		return fallback
	}
	return value
}

func indexedTags(params map[string]string) map[string]string {
	tags := map[string]string{}
	for index := 1; ; index++ {
		prefix := "Tags.member." + strconv.Itoa(index)
		key := params[prefix+".Key"]
		if key == "" {
			prefix = "Tag." + strconv.Itoa(index)
			key = params[prefix+".Key"]
		}
		if key == "" {
			break
		}
		tags[key] = params[prefix+".Value"]
	}
	return tags
}

func indexedNames(params map[string]string, prefix string) []string {
	names := []string{}
	for index := 1; ; index++ {
		name := params[prefix+"."+strconv.Itoa(index)]
		if name == "" {
			break
		}
		names = append(names, name)
	}
	return names
}

func xmlResponse(status int, body string) protocols.ErrorResponse {
	return protocols.ErrorResponse{
		StatusCode:  status,
		ContentType: "application/xml",
		Headers:     map[string]string{"Content-Type": "application/xml"},
		Body:        []byte(body),
	}
}

func withRequestID(response protocols.ErrorResponse, requestID string) protocols.ErrorResponse {
	if requestID == "" {
		return response
	}
	if response.Headers == nil {
		response.Headers = map[string]string{}
	}
	if response.Headers["x-amzn-requestid"] == "" {
		response.Headers["x-amzn-requestid"] = requestID
	}
	return response
}

func xmlEscape(value string) string {
	replacer := strings.NewReplacer(
		"&", "&amp;",
		"<", "&lt;",
		">", "&gt;",
		`"`, "&quot;",
		"'", "&apos;",
	)
	return replacer.Replace(value)
}
