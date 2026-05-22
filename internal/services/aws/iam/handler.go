package iam

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/url"
	"sort"
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
	Policies        *corestore.Collection
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
	case "CreateUser":
		response = h.createUser(ctx.Query, requestID)
	case "GetUser":
		response = h.getUser(ctx.Query, requestID)
	case "DeleteUser":
		response = h.deleteUser(ctx.Query, requestID)
	case "ListUsers":
		response = h.listUsers(requestID)
	case "CreateAccessKey":
		response = h.createAccessKey(ctx.Query, requestID)
	case "ListAccessKeys":
		response = h.listAccessKeys(ctx.Query, requestID)
	case "DeleteAccessKey":
		response = h.deleteAccessKey(ctx.Query, requestID)
	case "CreateRole":
		response = h.createRole(ctx.Query, requestID)
	case "GetRole":
		response = h.getRole(ctx.Query, requestID)
	case "DeleteRole":
		response = h.deleteRole(ctx.Query, requestID)
	case "ListRoles":
		response = h.listRoles(requestID)
	case "PutUserPolicy":
		response = h.putUserPolicy(ctx.Query, requestID)
	case "GetUserPolicy":
		response = h.getUserPolicy(ctx.Query, requestID)
	case "ListUserPolicies":
		response = h.listUserPolicies(ctx.Query, requestID)
	case "DeleteUserPolicy":
		response = h.deleteUserPolicy(ctx.Query, requestID)
	case "PutRolePolicy":
		response = h.putRolePolicy(ctx.Query, requestID)
	case "GetRolePolicy":
		response = h.getRolePolicy(ctx.Query, requestID)
	case "ListRolePolicies":
		response = h.listRolePolicies(ctx.Query, requestID)
	case "DeleteRolePolicy":
		response = h.deleteRolePolicy(ctx.Query, requestID)
	case "CreatePolicy":
		response = h.createPolicy(ctx.Query, requestID)
	case "GetPolicy":
		response = h.getPolicy(ctx.Query, requestID)
	case "GetPolicyVersion":
		response = h.getPolicyVersion(ctx.Query, requestID)
	case "ListPolicies":
		response = h.listPolicies(ctx.Query, requestID)
	case "DeletePolicy":
		response = h.deletePolicy(ctx.Query, requestID)
	case "AttachUserPolicy":
		response = h.attachUserPolicy(ctx.Query, requestID)
	case "DetachUserPolicy":
		response = h.detachUserPolicy(ctx.Query, requestID)
	case "ListAttachedUserPolicies":
		response = h.listAttachedUserPolicies(ctx.Query, requestID)
	case "AttachRolePolicy":
		response = h.attachRolePolicy(ctx.Query, requestID)
	case "DetachRolePolicy":
		response = h.detachRolePolicy(ctx.Query, requestID)
	case "ListAttachedRolePolicies":
		response = h.listAttachedRolePolicies(ctx.Query, requestID)
	default:
		action := ctx.Action
		response = h.queryError("InvalidAction", "The action "+action+" is not valid for this endpoint.", http.StatusBadRequest, requestID)
	}
	return withRequestID(response, requestID)
}

func (h *Handler) createUser(params map[string]string, requestID string) protocols.ErrorResponse {
	userName := params["UserName"]
	if userName == "" {
		return h.queryError("ValidationError", "The request must contain the parameter UserName.", http.StatusBadRequest, requestID)
	}
	if _, ok := h.findUser(userName); ok {
		return h.queryError("EntityAlreadyExists", "User with name "+userName+" already exists.", http.StatusConflict, requestID)
	}
	path := params["Path"]
	if path == "" {
		path = "/"
	}
	user := h.Users.Insert(corestore.Record{
		"user_name":         userName,
		"user_id":           h.generateID("AIDA"),
		"arn":               "arn:aws:iam::" + h.accountID() + ":user" + path + userName,
		"path":              path,
		"inline_policies":   []corestore.Record{},
		"attached_policies": []string{},
		"access_keys":       []corestore.Record{},
	})
	return h.userResponse("CreateUser", user, requestID)
}

func (h *Handler) getUser(params map[string]string, requestID string) protocols.ErrorResponse {
	userName := params["UserName"]
	user, ok := h.findUser(userName)
	if !ok {
		return h.noSuchUser(userName, requestID)
	}
	return h.userResponse("GetUser", user, requestID)
}

func (h *Handler) deleteUser(params map[string]string, requestID string) protocols.ErrorResponse {
	userName := params["UserName"]
	user, ok := h.findUser(userName)
	if !ok {
		return h.noSuchUser(userName, requestID)
	}
	for _, key := range accessKeys(user) {
		h.CredentialStore.Delete(stringField(key, "access_key_id"))
	}
	h.Users.Delete(intField(user, "id"))
	body := `<?xml version="1.0" encoding="UTF-8"?>
<DeleteUserResponse>
  <ResponseMetadata><RequestId>` + xmlEscape(requestID) + `</RequestId></ResponseMetadata>
</DeleteUserResponse>`
	return xmlResponse(http.StatusOK, body)
}

func (h *Handler) listUsers(requestID string) protocols.ErrorResponse {
	var rows strings.Builder
	for _, user := range h.Users.All() {
		rows.WriteString(`      <member>
`)
		writeUserXML(&rows, user)
		rows.WriteString(`      </member>
`)
	}
	body := `<?xml version="1.0" encoding="UTF-8"?>
<ListUsersResponse>
  <ListUsersResult>
    <IsTruncated>false</IsTruncated>
    <Users>
` + strings.TrimRight(rows.String(), "\n") + `
    </Users>
  </ListUsersResult>
  <ResponseMetadata><RequestId>` + xmlEscape(requestID) + `</RequestId></ResponseMetadata>
</ListUsersResponse>`
	return xmlResponse(http.StatusOK, body)
}

func (h *Handler) createAccessKey(params map[string]string, requestID string) protocols.ErrorResponse {
	userName := params["UserName"]
	user, ok := h.findUser(userName)
	if !ok {
		return h.noSuchUser(userName, requestID)
	}
	accessKeyID := "AKIA" + h.generateID("")[0:16]
	secretAccessKey := h.generateSecret(30)
	key := corestore.Record{
		"access_key_id":     accessKeyID,
		"secret_access_key": secretAccessKey,
		"status":            "Active",
	}
	keys := append(accessKeys(user), key)
	updated, _ := h.Users.Update(intField(user, "id"), corestore.Record{"access_keys": keys})
	h.CredentialStore.Put(auth.Credential{
		AccessKeyID:     accessKeyID,
		SecretAccessKey: secretAccessKey,
		AccountID:       h.accountID(),
		PrincipalARN:    stringField(updated, "arn"),
	})
	body := `<?xml version="1.0" encoding="UTF-8"?>
<CreateAccessKeyResponse>
  <CreateAccessKeyResult>
    <AccessKey>
      <UserName>` + xmlEscape(userName) + `</UserName>
      <AccessKeyId>` + accessKeyID + `</AccessKeyId>
      <Status>Active</Status>
      <SecretAccessKey>` + xmlEscape(secretAccessKey) + `</SecretAccessKey>
      <CreateDate>` + xmlEscape(h.now().Format(time.RFC3339Nano)) + `</CreateDate>
    </AccessKey>
  </CreateAccessKeyResult>
  <ResponseMetadata><RequestId>` + xmlEscape(requestID) + `</RequestId></ResponseMetadata>
</CreateAccessKeyResponse>`
	return xmlResponse(http.StatusOK, body)
}

func (h *Handler) listAccessKeys(params map[string]string, requestID string) protocols.ErrorResponse {
	userName := params["UserName"]
	user, ok := h.findUser(userName)
	if !ok {
		return h.noSuchUser(userName, requestID)
	}
	var rows strings.Builder
	for _, key := range accessKeys(user) {
		rows.WriteString(`      <member>
        <UserName>`)
		rows.WriteString(xmlEscape(userName))
		rows.WriteString(`</UserName>
        <AccessKeyId>`)
		rows.WriteString(xmlEscape(stringField(key, "access_key_id")))
		rows.WriteString(`</AccessKeyId>
        <Status>`)
		rows.WriteString(xmlEscape(stringField(key, "status")))
		rows.WriteString(`</Status>
      </member>
`)
	}
	body := `<?xml version="1.0" encoding="UTF-8"?>
<ListAccessKeysResponse>
  <ListAccessKeysResult>
    <IsTruncated>false</IsTruncated>
    <AccessKeyMetadata>
` + strings.TrimRight(rows.String(), "\n") + `
    </AccessKeyMetadata>
  </ListAccessKeysResult>
  <ResponseMetadata><RequestId>` + xmlEscape(requestID) + `</RequestId></ResponseMetadata>
</ListAccessKeysResponse>`
	return xmlResponse(http.StatusOK, body)
}

func (h *Handler) deleteAccessKey(params map[string]string, requestID string) protocols.ErrorResponse {
	userName := params["UserName"]
	accessKeyID := params["AccessKeyId"]
	user, ok := h.findUser(userName)
	if !ok {
		return h.noSuchUser(userName, requestID)
	}
	keys := []corestore.Record{}
	for _, key := range accessKeys(user) {
		if stringField(key, "access_key_id") == accessKeyID {
			h.CredentialStore.Delete(accessKeyID)
			continue
		}
		keys = append(keys, key)
	}
	h.Users.Update(intField(user, "id"), corestore.Record{"access_keys": keys})
	body := `<?xml version="1.0" encoding="UTF-8"?>
<DeleteAccessKeyResponse>
  <ResponseMetadata><RequestId>` + xmlEscape(requestID) + `</RequestId></ResponseMetadata>
</DeleteAccessKeyResponse>`
	return xmlResponse(http.StatusOK, body)
}

func (h *Handler) createRole(params map[string]string, requestID string) protocols.ErrorResponse {
	roleName := params["RoleName"]
	if roleName == "" {
		return h.queryError("ValidationError", "The request must contain the parameter RoleName.", http.StatusBadRequest, requestID)
	}
	if _, ok := h.findRole(roleName); ok {
		return h.queryError("EntityAlreadyExists", "Role with name "+roleName+" already exists.", http.StatusConflict, requestID)
	}
	path := params["Path"]
	if path == "" {
		path = "/"
	}
	role := h.Roles.Insert(corestore.Record{
		"role_name":                   roleName,
		"role_id":                     h.generateID("AROA"),
		"arn":                         "arn:aws:iam::" + h.accountID() + ":role" + path + roleName,
		"path":                        path,
		"assume_role_policy_document": defaultString(params["AssumeRolePolicyDocument"], "{}"),
		"description":                 params["Description"],
		"inline_policies":             []corestore.Record{},
		"attached_policies":           []string{},
	})
	return h.roleResponse("CreateRole", role, requestID)
}

func (h *Handler) getRole(params map[string]string, requestID string) protocols.ErrorResponse {
	roleName := params["RoleName"]
	role, ok := h.findRole(roleName)
	if !ok {
		return h.noSuchRole(roleName, requestID)
	}
	return h.roleResponse("GetRole", role, requestID)
}

func (h *Handler) deleteRole(params map[string]string, requestID string) protocols.ErrorResponse {
	roleName := params["RoleName"]
	role, ok := h.findRole(roleName)
	if !ok {
		return h.noSuchRole(roleName, requestID)
	}
	h.Roles.Delete(intField(role, "id"))
	body := `<?xml version="1.0" encoding="UTF-8"?>
<DeleteRoleResponse>
  <ResponseMetadata><RequestId>` + xmlEscape(requestID) + `</RequestId></ResponseMetadata>
</DeleteRoleResponse>`
	return xmlResponse(http.StatusOK, body)
}

func (h *Handler) listRoles(requestID string) protocols.ErrorResponse {
	var rows strings.Builder
	for _, role := range h.Roles.All() {
		rows.WriteString(`      <member>
`)
		writeRoleXML(&rows, role)
		rows.WriteString(`      </member>
`)
	}
	body := `<?xml version="1.0" encoding="UTF-8"?>
<ListRolesResponse>
  <ListRolesResult>
    <IsTruncated>false</IsTruncated>
    <Roles>
` + strings.TrimRight(rows.String(), "\n") + `
    </Roles>
  </ListRolesResult>
  <ResponseMetadata><RequestId>` + xmlEscape(requestID) + `</RequestId></ResponseMetadata>
</ListRolesResponse>`
	return xmlResponse(http.StatusOK, body)
}

func (h *Handler) putUserPolicy(params map[string]string, requestID string) protocols.ErrorResponse {
	userName := params["UserName"]
	user, ok := h.findUser(userName)
	if !ok {
		return h.noSuchUser(userName, requestID)
	}
	policyName := params["PolicyName"]
	if policyName == "" {
		return h.queryError("ValidationError", "The request must contain the parameter PolicyName.", http.StatusBadRequest, requestID)
	}
	policies := upsertInlinePolicy(inlinePolicies(user), policyName, params["PolicyDocument"])
	h.Users.Update(intField(user, "id"), corestore.Record{"inline_policies": policies})
	return emptyResponse("PutUserPolicy", requestID)
}

func (h *Handler) getUserPolicy(params map[string]string, requestID string) protocols.ErrorResponse {
	userName := params["UserName"]
	user, ok := h.findUser(userName)
	if !ok {
		return h.noSuchUser(userName, requestID)
	}
	policyName := params["PolicyName"]
	policy, ok := findInlinePolicy(user, policyName)
	if !ok {
		return h.noSuchPolicy(policyName, requestID)
	}
	return inlinePolicyResponse("GetUserPolicy", "UserName", userName, policy, requestID)
}

func (h *Handler) listUserPolicies(params map[string]string, requestID string) protocols.ErrorResponse {
	userName := params["UserName"]
	user, ok := h.findUser(userName)
	if !ok {
		return h.noSuchUser(userName, requestID)
	}
	return listInlinePoliciesResponse("ListUserPolicies", inlinePolicies(user), requestID)
}

func (h *Handler) deleteUserPolicy(params map[string]string, requestID string) protocols.ErrorResponse {
	userName := params["UserName"]
	user, ok := h.findUser(userName)
	if !ok {
		return h.noSuchUser(userName, requestID)
	}
	h.Users.Update(intField(user, "id"), corestore.Record{"inline_policies": removeInlinePolicy(inlinePolicies(user), params["PolicyName"])})
	return emptyResponse("DeleteUserPolicy", requestID)
}

func (h *Handler) putRolePolicy(params map[string]string, requestID string) protocols.ErrorResponse {
	roleName := params["RoleName"]
	role, ok := h.findRole(roleName)
	if !ok {
		return h.noSuchRole(roleName, requestID)
	}
	policyName := params["PolicyName"]
	if policyName == "" {
		return h.queryError("ValidationError", "The request must contain the parameter PolicyName.", http.StatusBadRequest, requestID)
	}
	policies := upsertInlinePolicy(inlinePolicies(role), policyName, params["PolicyDocument"])
	h.Roles.Update(intField(role, "id"), corestore.Record{"inline_policies": policies})
	return emptyResponse("PutRolePolicy", requestID)
}

func (h *Handler) getRolePolicy(params map[string]string, requestID string) protocols.ErrorResponse {
	roleName := params["RoleName"]
	role, ok := h.findRole(roleName)
	if !ok {
		return h.noSuchRole(roleName, requestID)
	}
	policyName := params["PolicyName"]
	policy, ok := findInlinePolicy(role, policyName)
	if !ok {
		return h.noSuchPolicy(policyName, requestID)
	}
	return inlinePolicyResponse("GetRolePolicy", "RoleName", roleName, policy, requestID)
}

func (h *Handler) listRolePolicies(params map[string]string, requestID string) protocols.ErrorResponse {
	roleName := params["RoleName"]
	role, ok := h.findRole(roleName)
	if !ok {
		return h.noSuchRole(roleName, requestID)
	}
	return listInlinePoliciesResponse("ListRolePolicies", inlinePolicies(role), requestID)
}

func (h *Handler) deleteRolePolicy(params map[string]string, requestID string) protocols.ErrorResponse {
	roleName := params["RoleName"]
	role, ok := h.findRole(roleName)
	if !ok {
		return h.noSuchRole(roleName, requestID)
	}
	h.Roles.Update(intField(role, "id"), corestore.Record{"inline_policies": removeInlinePolicy(inlinePolicies(role), params["PolicyName"])})
	return emptyResponse("DeleteRolePolicy", requestID)
}

func (h *Handler) createPolicy(params map[string]string, requestID string) protocols.ErrorResponse {
	policyName := params["PolicyName"]
	if policyName == "" {
		return h.queryError("ValidationError", "The request must contain the parameter PolicyName.", http.StatusBadRequest, requestID)
	}
	path := normalizePath(params["Path"])
	arn := "arn:aws:iam::" + h.accountID() + ":policy" + path + policyName
	if _, ok := h.findPolicyByARN(arn); ok {
		return h.queryError("EntityAlreadyExists", "Policy with name "+policyName+" already exists.", http.StatusConflict, requestID)
	}
	policy := h.Policies.Insert(corestore.Record{
		"policy_name":        policyName,
		"policy_id":          h.generateID("ANPA"),
		"arn":                arn,
		"path":               path,
		"default_version_id": "v1",
		"policy_document":    params["PolicyDocument"],
		"description":        params["Description"],
		"tags":               indexedTags(params),
	})
	return h.policyResponse("CreatePolicy", policy, requestID)
}

func (h *Handler) getPolicy(params map[string]string, requestID string) protocols.ErrorResponse {
	policy, ok := h.findPolicyByARN(params["PolicyArn"])
	if !ok {
		return h.noSuchPolicy(params["PolicyArn"], requestID)
	}
	return h.policyResponse("GetPolicy", policy, requestID)
}

func (h *Handler) getPolicyVersion(params map[string]string, requestID string) protocols.ErrorResponse {
	policy, ok := h.findPolicyByARN(params["PolicyArn"])
	if !ok {
		return h.noSuchPolicy(params["PolicyArn"], requestID)
	}
	versionID := params["VersionId"]
	if versionID == "" {
		versionID = stringField(policy, "default_version_id")
	}
	if versionID != stringField(policy, "default_version_id") {
		return h.noSuchPolicy(versionID, requestID)
	}
	body := `<?xml version="1.0" encoding="UTF-8"?>
<GetPolicyVersionResponse>
  <GetPolicyVersionResult>
    <PolicyVersion>
`
	var rows strings.Builder
	writePolicyVersionXML(&rows, policy)
	body += strings.TrimRight(rows.String(), "\n") + `
    </PolicyVersion>
  </GetPolicyVersionResult>
  <ResponseMetadata><RequestId>` + xmlEscape(requestID) + `</RequestId></ResponseMetadata>
</GetPolicyVersionResponse>`
	return xmlResponse(http.StatusOK, body)
}

func (h *Handler) listPolicies(params map[string]string, requestID string) protocols.ErrorResponse {
	pathPrefix := params["PathPrefix"]
	if pathPrefix == "" {
		pathPrefix = "/"
	}
	var rows strings.Builder
	for _, policy := range h.sortedPolicies() {
		if !strings.HasPrefix(stringField(policy, "path"), pathPrefix) {
			continue
		}
		rows.WriteString(`      <member>
`)
		h.writePolicyXML(&rows, policy)
		rows.WriteString(`      </member>
`)
	}
	body := `<?xml version="1.0" encoding="UTF-8"?>
<ListPoliciesResponse>
  <ListPoliciesResult>
    <IsTruncated>false</IsTruncated>
    <Policies>
` + strings.TrimRight(rows.String(), "\n") + `
    </Policies>
  </ListPoliciesResult>
  <ResponseMetadata><RequestId>` + xmlEscape(requestID) + `</RequestId></ResponseMetadata>
</ListPoliciesResponse>`
	return xmlResponse(http.StatusOK, body)
}

func (h *Handler) deletePolicy(params map[string]string, requestID string) protocols.ErrorResponse {
	policy, ok := h.findPolicyByARN(params["PolicyArn"])
	if !ok {
		return h.noSuchPolicy(params["PolicyArn"], requestID)
	}
	policyARN := stringField(policy, "arn")
	for _, user := range h.Users.All() {
		h.Users.Update(intField(user, "id"), corestore.Record{"attached_policies": removeString(attachedPolicies(user), policyARN)})
	}
	for _, role := range h.Roles.All() {
		h.Roles.Update(intField(role, "id"), corestore.Record{"attached_policies": removeString(attachedPolicies(role), policyARN)})
	}
	h.Policies.Delete(intField(policy, "id"))
	return emptyResponse("DeletePolicy", requestID)
}

func (h *Handler) attachUserPolicy(params map[string]string, requestID string) protocols.ErrorResponse {
	user, ok := h.findUser(params["UserName"])
	if !ok {
		return h.noSuchUser(params["UserName"], requestID)
	}
	policy, ok := h.findPolicyByARN(params["PolicyArn"])
	if !ok {
		return h.noSuchPolicy(params["PolicyArn"], requestID)
	}
	h.Users.Update(intField(user, "id"), corestore.Record{"attached_policies": addString(attachedPolicies(user), stringField(policy, "arn"))})
	return emptyResponse("AttachUserPolicy", requestID)
}

func (h *Handler) detachUserPolicy(params map[string]string, requestID string) protocols.ErrorResponse {
	user, ok := h.findUser(params["UserName"])
	if !ok {
		return h.noSuchUser(params["UserName"], requestID)
	}
	h.Users.Update(intField(user, "id"), corestore.Record{"attached_policies": removeString(attachedPolicies(user), params["PolicyArn"])})
	return emptyResponse("DetachUserPolicy", requestID)
}

func (h *Handler) listAttachedUserPolicies(params map[string]string, requestID string) protocols.ErrorResponse {
	user, ok := h.findUser(params["UserName"])
	if !ok {
		return h.noSuchUser(params["UserName"], requestID)
	}
	return h.listAttachedPoliciesResponse("ListAttachedUserPolicies", attachedPolicies(user), requestID)
}

func (h *Handler) attachRolePolicy(params map[string]string, requestID string) protocols.ErrorResponse {
	role, ok := h.findRole(params["RoleName"])
	if !ok {
		return h.noSuchRole(params["RoleName"], requestID)
	}
	policy, ok := h.findPolicyByARN(params["PolicyArn"])
	if !ok {
		return h.noSuchPolicy(params["PolicyArn"], requestID)
	}
	h.Roles.Update(intField(role, "id"), corestore.Record{"attached_policies": addString(attachedPolicies(role), stringField(policy, "arn"))})
	return emptyResponse("AttachRolePolicy", requestID)
}

func (h *Handler) detachRolePolicy(params map[string]string, requestID string) protocols.ErrorResponse {
	role, ok := h.findRole(params["RoleName"])
	if !ok {
		return h.noSuchRole(params["RoleName"], requestID)
	}
	h.Roles.Update(intField(role, "id"), corestore.Record{"attached_policies": removeString(attachedPolicies(role), params["PolicyArn"])})
	return emptyResponse("DetachRolePolicy", requestID)
}

func (h *Handler) listAttachedRolePolicies(params map[string]string, requestID string) protocols.ErrorResponse {
	role, ok := h.findRole(params["RoleName"])
	if !ok {
		return h.noSuchRole(params["RoleName"], requestID)
	}
	return h.listAttachedPoliciesResponse("ListAttachedRolePolicies", attachedPolicies(role), requestID)
}

func (h *Handler) userResponse(action string, user corestore.Record, requestID string) protocols.ErrorResponse {
	body := `<?xml version="1.0" encoding="UTF-8"?>
<` + action + `Response>
  <` + action + `Result>
    <User>
`
	var rows strings.Builder
	writeUserXML(&rows, user)
	body += strings.TrimRight(rows.String(), "\n") + `
    </User>
  </` + action + `Result>
  <ResponseMetadata><RequestId>` + xmlEscape(requestID) + `</RequestId></ResponseMetadata>
</` + action + `Response>`
	return xmlResponse(http.StatusOK, body)
}

func (h *Handler) roleResponse(action string, role corestore.Record, requestID string) protocols.ErrorResponse {
	body := `<?xml version="1.0" encoding="UTF-8"?>
<` + action + `Response>
  <` + action + `Result>
    <Role>
`
	var rows strings.Builder
	writeRoleXML(&rows, role)
	body += strings.TrimRight(rows.String(), "\n") + `
    </Role>
  </` + action + `Result>
  <ResponseMetadata><RequestId>` + xmlEscape(requestID) + `</RequestId></ResponseMetadata>
</` + action + `Response>`
	return xmlResponse(http.StatusOK, body)
}

func (h *Handler) policyResponse(action string, policy corestore.Record, requestID string) protocols.ErrorResponse {
	body := `<?xml version="1.0" encoding="UTF-8"?>
<` + action + `Response>
  <` + action + `Result>
    <Policy>
`
	var rows strings.Builder
	h.writePolicyXML(&rows, policy)
	body += strings.TrimRight(rows.String(), "\n") + `
    </Policy>
  </` + action + `Result>
  <ResponseMetadata><RequestId>` + xmlEscape(requestID) + `</RequestId></ResponseMetadata>
</` + action + `Response>`
	return xmlResponse(http.StatusOK, body)
}

func writeUserXML(rows *strings.Builder, user corestore.Record) {
	rows.WriteString(`      <Path>`)
	rows.WriteString(xmlEscape(stringField(user, "path")))
	rows.WriteString(`</Path>
      <UserName>`)
	rows.WriteString(xmlEscape(stringField(user, "user_name")))
	rows.WriteString(`</UserName>
      <UserId>`)
	rows.WriteString(xmlEscape(stringField(user, "user_id")))
	rows.WriteString(`</UserId>
      <Arn>`)
	rows.WriteString(xmlEscape(stringField(user, "arn")))
	rows.WriteString(`</Arn>
      <CreateDate>`)
	rows.WriteString(xmlEscape(stringField(user, "created_at")))
	rows.WriteString(`</CreateDate>
`)
}

func writeRoleXML(rows *strings.Builder, role corestore.Record) {
	rows.WriteString(`      <Path>`)
	rows.WriteString(xmlEscape(stringField(role, "path")))
	rows.WriteString(`</Path>
      <RoleName>`)
	rows.WriteString(xmlEscape(stringField(role, "role_name")))
	rows.WriteString(`</RoleName>
      <RoleId>`)
	rows.WriteString(xmlEscape(stringField(role, "role_id")))
	rows.WriteString(`</RoleId>
      <Arn>`)
	rows.WriteString(xmlEscape(stringField(role, "arn")))
	rows.WriteString(`</Arn>
      <CreateDate>`)
	rows.WriteString(xmlEscape(stringField(role, "created_at")))
	rows.WriteString(`</CreateDate>
      <AssumeRolePolicyDocument>`)
	rows.WriteString(xmlEscape(urlEncode(stringField(role, "assume_role_policy_document"))))
	rows.WriteString(`</AssumeRolePolicyDocument>
      <Description>`)
	rows.WriteString(xmlEscape(stringField(role, "description")))
	rows.WriteString(`</Description>
`)
}

func (h *Handler) writePolicyXML(rows *strings.Builder, policy corestore.Record) {
	rows.WriteString(`      <PolicyName>`)
	rows.WriteString(xmlEscape(stringField(policy, "policy_name")))
	rows.WriteString(`</PolicyName>
      <PolicyId>`)
	rows.WriteString(xmlEscape(stringField(policy, "policy_id")))
	rows.WriteString(`</PolicyId>
      <Arn>`)
	rows.WriteString(xmlEscape(stringField(policy, "arn")))
	rows.WriteString(`</Arn>
      <Path>`)
	rows.WriteString(xmlEscape(stringField(policy, "path")))
	rows.WriteString(`</Path>
      <DefaultVersionId>`)
	rows.WriteString(xmlEscape(stringField(policy, "default_version_id")))
	rows.WriteString(`</DefaultVersionId>
      <AttachmentCount>`)
	rows.WriteString(fmt.Sprint(h.policyAttachmentCount(stringField(policy, "arn"))))
	rows.WriteString(`</AttachmentCount>
      <PermissionsBoundaryUsageCount>0</PermissionsBoundaryUsageCount>
      <IsAttachable>true</IsAttachable>
      <Description>`)
	rows.WriteString(xmlEscape(stringField(policy, "description")))
	rows.WriteString(`</Description>
      <CreateDate>`)
	rows.WriteString(xmlEscape(stringField(policy, "created_at")))
	rows.WriteString(`</CreateDate>
      <UpdateDate>`)
	rows.WriteString(xmlEscape(stringField(policy, "updated_at")))
	rows.WriteString(`</UpdateDate>
`)
}

func writePolicyVersionXML(rows *strings.Builder, policy corestore.Record) {
	rows.WriteString(`      <Document>`)
	rows.WriteString(xmlEscape(urlEncode(stringField(policy, "policy_document"))))
	rows.WriteString(`</Document>
      <VersionId>`)
	rows.WriteString(xmlEscape(stringField(policy, "default_version_id")))
	rows.WriteString(`</VersionId>
      <IsDefaultVersion>true</IsDefaultVersion>
      <CreateDate>`)
	rows.WriteString(xmlEscape(stringField(policy, "created_at")))
	rows.WriteString(`</CreateDate>
`)
}

func inlinePolicyResponse(action string, ownerElement string, ownerName string, policy corestore.Record, requestID string) protocols.ErrorResponse {
	body := `<?xml version="1.0" encoding="UTF-8"?>
<` + action + `Response>
  <` + action + `Result>
    <` + ownerElement + `>` + xmlEscape(ownerName) + `</` + ownerElement + `>
    <PolicyName>` + xmlEscape(stringField(policy, "policy_name")) + `</PolicyName>
    <PolicyDocument>` + xmlEscape(urlEncode(stringField(policy, "policy_document"))) + `</PolicyDocument>
  </` + action + `Result>
  <ResponseMetadata><RequestId>` + xmlEscape(requestID) + `</RequestId></ResponseMetadata>
</` + action + `Response>`
	return xmlResponse(http.StatusOK, body)
}

func listInlinePoliciesResponse(action string, policies []corestore.Record, requestID string) protocols.ErrorResponse {
	var rows strings.Builder
	for _, policy := range sortedInlinePolicies(policies) {
		rows.WriteString(`      <member>`)
		rows.WriteString(xmlEscape(stringField(policy, "policy_name")))
		rows.WriteString(`</member>
`)
	}
	body := `<?xml version="1.0" encoding="UTF-8"?>
<` + action + `Response>
  <` + action + `Result>
    <IsTruncated>false</IsTruncated>
    <PolicyNames>
` + strings.TrimRight(rows.String(), "\n") + `
    </PolicyNames>
  </` + action + `Result>
  <ResponseMetadata><RequestId>` + xmlEscape(requestID) + `</RequestId></ResponseMetadata>
</` + action + `Response>`
	return xmlResponse(http.StatusOK, body)
}

func (h *Handler) listAttachedPoliciesResponse(action string, policyARNs []string, requestID string) protocols.ErrorResponse {
	var rows strings.Builder
	for _, policyARN := range sortedStrings(policyARNs) {
		policy, ok := h.findPolicyByARN(policyARN)
		if !ok {
			continue
		}
		rows.WriteString(`      <member>
        <PolicyName>`)
		rows.WriteString(xmlEscape(stringField(policy, "policy_name")))
		rows.WriteString(`</PolicyName>
        <PolicyArn>`)
		rows.WriteString(xmlEscape(policyARN))
		rows.WriteString(`</PolicyArn>
      </member>
`)
	}
	body := `<?xml version="1.0" encoding="UTF-8"?>
<` + action + `Response>
  <` + action + `Result>
    <IsTruncated>false</IsTruncated>
    <AttachedPolicies>
` + strings.TrimRight(rows.String(), "\n") + `
    </AttachedPolicies>
  </` + action + `Result>
  <ResponseMetadata><RequestId>` + xmlEscape(requestID) + `</RequestId></ResponseMetadata>
</` + action + `Response>`
	return xmlResponse(http.StatusOK, body)
}

func emptyResponse(action string, requestID string) protocols.ErrorResponse {
	body := `<?xml version="1.0" encoding="UTF-8"?>
<` + action + `Response>
  <ResponseMetadata><RequestId>` + xmlEscape(requestID) + `</RequestId></ResponseMetadata>
</` + action + `Response>`
	return xmlResponse(http.StatusOK, body)
}

func (h *Handler) noSuchUser(userName string, requestID string) protocols.ErrorResponse {
	return h.queryError("NoSuchEntity", "The user with name "+userName+" cannot be found.", http.StatusNotFound, requestID)
}

func (h *Handler) noSuchRole(roleName string, requestID string) protocols.ErrorResponse {
	return h.queryError("NoSuchEntity", "The role with name "+roleName+" cannot be found.", http.StatusNotFound, requestID)
}

func (h *Handler) noSuchPolicy(policyName string, requestID string) protocols.ErrorResponse {
	return h.queryError("NoSuchEntity", "The policy with name "+policyName+" cannot be found.", http.StatusNotFound, requestID)
}

func (h *Handler) queryError(code string, message string, status int, requestID string) protocols.ErrorResponse {
	return protocols.SerializeXMLError(protocols.AWSError{
		Code:       code,
		Message:    message,
		RequestID:  requestID,
		StatusCode: status,
	})
}

func (h *Handler) findUser(userName string) (corestore.Record, bool) {
	for _, user := range h.Users.FindBy("user_name", userName) {
		return user, true
	}
	return nil, false
}

func (h *Handler) findRole(roleName string) (corestore.Record, bool) {
	for _, role := range h.Roles.FindBy("role_name", roleName) {
		return role, true
	}
	return nil, false
}

func (h *Handler) findPolicyByARN(policyARN string) (corestore.Record, bool) {
	if h.Policies == nil {
		return nil, false
	}
	for _, policy := range h.Policies.FindBy("arn", policyARN) {
		return policy, true
	}
	return nil, false
}

func (h *Handler) sortedPolicies() []corestore.Record {
	if h.Policies == nil {
		return nil
	}
	policies := h.Policies.All()
	sort.SliceStable(policies, func(i int, j int) bool {
		return stringField(policies[i], "policy_name") < stringField(policies[j], "policy_name")
	})
	return policies
}

func (h *Handler) policyAttachmentCount(policyARN string) int {
	count := 0
	for _, user := range h.Users.All() {
		if containsString(attachedPolicies(user), policyARN) {
			count++
		}
	}
	for _, role := range h.Roles.All() {
		if containsString(attachedPolicies(role), policyARN) {
			count++
		}
	}
	return count
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

func accessKeys(user corestore.Record) []corestore.Record {
	switch value := user["access_keys"].(type) {
	case []corestore.Record:
		return append([]corestore.Record(nil), value...)
	case []map[string]any:
		keys := make([]corestore.Record, 0, len(value))
		for _, item := range value {
			keys = append(keys, corestore.Record(item))
		}
		return keys
	case []any:
		keys := make([]corestore.Record, 0, len(value))
		for _, item := range value {
			if record := recordValue(item); len(record) > 0 {
				keys = append(keys, record)
			}
		}
		return keys
	default:
		return []corestore.Record{}
	}
}

func inlinePolicies(record corestore.Record) []corestore.Record {
	switch value := record["inline_policies"].(type) {
	case []corestore.Record:
		return append([]corestore.Record(nil), value...)
	case []map[string]any:
		policies := make([]corestore.Record, 0, len(value))
		for _, item := range value {
			policies = append(policies, corestore.Record(item))
		}
		return policies
	case []any:
		policies := make([]corestore.Record, 0, len(value))
		for _, item := range value {
			if record := recordValue(item); len(record) > 0 {
				policies = append(policies, record)
			}
		}
		return policies
	default:
		return []corestore.Record{}
	}
}

func upsertInlinePolicy(policies []corestore.Record, policyName string, policyDocument string) []corestore.Record {
	next := []corestore.Record{}
	replaced := false
	for _, policy := range policies {
		if stringField(policy, "policy_name") == policyName {
			next = append(next, corestore.Record{"policy_name": policyName, "policy_document": policyDocument})
			replaced = true
			continue
		}
		next = append(next, policy)
	}
	if !replaced {
		next = append(next, corestore.Record{"policy_name": policyName, "policy_document": policyDocument})
	}
	return next
}

func findInlinePolicy(record corestore.Record, policyName string) (corestore.Record, bool) {
	for _, policy := range inlinePolicies(record) {
		if stringField(policy, "policy_name") == policyName {
			return policy, true
		}
	}
	return nil, false
}

func removeInlinePolicy(policies []corestore.Record, policyName string) []corestore.Record {
	next := []corestore.Record{}
	for _, policy := range policies {
		if stringField(policy, "policy_name") == policyName {
			continue
		}
		next = append(next, policy)
	}
	return next
}

func sortedInlinePolicies(policies []corestore.Record) []corestore.Record {
	next := append([]corestore.Record(nil), policies...)
	sort.SliceStable(next, func(i int, j int) bool {
		return stringField(next[i], "policy_name") < stringField(next[j], "policy_name")
	})
	return next
}

func attachedPolicies(record corestore.Record) []string {
	switch value := record["attached_policies"].(type) {
	case []string:
		return append([]string(nil), value...)
	case []any:
		values := make([]string, 0, len(value))
		for _, item := range value {
			values = append(values, fmt.Sprint(item))
		}
		return values
	default:
		return []string{}
	}
}

func addString(values []string, value string) []string {
	if value == "" || containsString(values, value) {
		return values
	}
	return append(values, value)
}

func removeString(values []string, value string) []string {
	next := []string{}
	for _, item := range values {
		if item == value {
			continue
		}
		next = append(next, item)
	}
	return next
}

func containsString(values []string, value string) bool {
	for _, item := range values {
		if item == value {
			return true
		}
	}
	return false
}

func sortedStrings(values []string) []string {
	next := append([]string(nil), values...)
	sort.Strings(next)
	return next
}

func indexedTags(params map[string]string) []corestore.Record {
	tags := []corestore.Record{}
	for index := 1; ; index++ {
		prefix := "Tags.member." + fmt.Sprint(index)
		key := params[prefix+".Key"]
		if key == "" {
			prefix = "Tag." + fmt.Sprint(index)
			key = params[prefix+".Key"]
		}
		if key == "" {
			break
		}
		tags = append(tags, corestore.Record{"key": key, "value": params[prefix+".Value"]})
	}
	return tags
}

func normalizePath(path string) string {
	if path == "" {
		return "/"
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	if !strings.HasSuffix(path, "/") {
		path += "/"
	}
	return path
}

func recordValue(value any) corestore.Record {
	switch typed := value.(type) {
	case corestore.Record:
		return typed
	case map[string]any:
		return corestore.Record(typed)
	default:
		return corestore.Record{}
	}
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

func intField(record corestore.Record, name string) int {
	switch value := record[name].(type) {
	case int:
		return value
	case int64:
		return int(value)
	case float64:
		return int(value)
	default:
		return 0
	}
}

func defaultString(value string, fallback string) string {
	if value != "" {
		return value
	}
	return fallback
}

func urlEncode(value string) string {
	return strings.ReplaceAll(url.QueryEscape(value), "+", "%20")
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
