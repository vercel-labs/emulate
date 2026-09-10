---
name: graph
description: Emulated Microsoft Graph API for app-only integrations in local development and testing. Use when the user needs to look up Entra users by mail, invite guests, suspend or reactivate accounts, assign directory roles, run Graph $batch requests, or obtain tenant-scoped client_credentials tokens without a real Microsoft tenant. Triggers include "Microsoft Graph", "graph.microsoft.com", "emulate Graph", "invitations", "roleAssignments", "$batch", "client_credentials", "MS365_GRAPH", "Entra ID users", or any task requiring a local Graph API.
allowed-tools: Bash(npx emulate:*), Bash(emulate:*), Bash(curl:*)
---

# Microsoft Graph API Emulator

Fully stateful Graph emulation for application permissions. Tokens are issued per tenant with the Entra client credentials flow, users answer OData queries, invitations create guests with redeemable links, role assignments enforce duplicates and unknown principals like the real directory, and `$batch` runs mixed request sets in order.

Nothing leaves the machine. Every Graph call hits the emulator and produces Graph-shaped `@odata` responses and errors.

## Start

```bash
# Graph only
npx emulate --service graph

# Default port (when run alone)
# http://localhost:4000
```

Or programmatically:

```typescript
import { createEmulator } from 'emulate'

const graph = await createEmulator({ service: 'graph', port: 4000 })
// graph.url === 'http://localhost:4000'
```

## Defaults

```text
MS365_TOKENURL=http://localhost:4000
MS365_GRAPH_URL=http://localhost:4000/v1.0
MS365_GRAPH_SCOPES=https://graph.microsoft.com/.default
MS365_CLIENT_ID=00000000-0000-4000-8000-0000000000a9
MS365_CLIENT_SECRET=test_emulate_graph_client_secret
MS365_TENANT_ID=00000000-0000-4000-8000-00000000c0de
```

Seeded data:

- Tenant Contoso (`00000000-0000-4000-8000-00000000c0de`, domains `contoso.onmicrosoft.com` and `contoso.example`)
- Adele Vance (Global Administrator), Alex Wilber (Security Administrator, Privileged Authentication Administrator), guest Nora Analyst `nora.analyst@soc.example` (accepted, Security Administrator), a disabled guest `former.analyst@soc.example`, member Diego Siciliani
- Security group "Security Team", pending invitation for `pending.analyst@soc.example`
- Tenant Fabrikam (`00000000-0000-4000-8000-00000000fab1`) with Megan Bowen
- Twelve built-in role definitions with real template ids (Security Administrator `194ae4cb-b126-40b2-bd5b-6091b380977d`, Privileged Authentication Administrator `7be44c8a-adaf-4e2a-84d6-ab2649e08a13`, Global Administrator `62e90394-69f5-4237-9190-012177145e10`, and more)

## Authentication

```bash
TOKEN=$(curl -s -X POST http://localhost:4000/00000000-0000-4000-8000-00000000c0de/oauth2/v2.0/token \
  -d grant_type=client_credentials -d scope=https://graph.microsoft.com/.default \
  -d client_id=00000000-0000-4000-8000-0000000000a9 -d client_secret=test_emulate_graph_client_secret | jq -r .access_token)
```

The tenant segment accepts an id or a verified domain. Each token only sees its tenant. Errors mirror Entra (`invalid_client`, `AADSTS90002`, `unauthorized_client`). Apps seeded with `permissions` get 403 `Authorization_RequestDenied` ("Insufficient privileges to complete the operation.") on routes outside their list, which lets you test the read-only fallback paths.

## Users

```bash
# Look up users by mail (odata-query style)
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:4000/v1.0/users?\$filter=mail%20in%20('nora.analyst%40soc.example')&\$select=id,displayName,mail,userPrincipalName,accountEnabled"

# Suspend and reactivate
curl -X PATCH -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  http://localhost:4000/v1.0/users/10000000-0000-4000-8000-000000000003 -d '{ "accountEnabled": false }'
```

- `GET /v1.0/users` with `$filter` (`eq ne in startsWith endsWith contains and or not`), `$select`, `$top`, `$orderby`, `$count=true`, `$search`; pages with `@odata.nextLink`
- `POST /v1.0/users`, `GET|PATCH|DELETE /v1.0/users/{id or UPN}`, `GET .../memberOf`, `GET .../transitiveMemberOf`
- `GET /v1.0/directory/deletedItems/microsoft.graph.user`, `POST /v1.0/directory/deletedItems/{id}/restore`

## Invitations and Roles

```bash
# Invite a guest silently
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  http://localhost:4000/v1.0/invitations -d '{ "invitedUserDisplayName": "Sam Soc", "invitedUserEmailAddress": "sam.soc@soc.example", "inviteRedirectUrl": "https://security.microsoft.com", "sendInvitationMessage": false }'

# Assign Security Administrator
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  http://localhost:4000/v1.0/roleManagement/directory/roleAssignments \
  -d '{ "principalId": "<userId>", "roleDefinitionId": "194ae4cb-b126-40b2-bd5b-6091b380977d", "directoryScopeId": "/" }'
```

Invitations create a Guest (`mail`, `#EXT#` UPN, `externalUserState: PendingAcceptance`) and return `invitedUser { id, userPrincipalName }` plus `inviteRedeemUrl`. Duplicate role assignments return the "conflicting object" 400; unknown principals or roles return 404. Also `GET /v1.0/roleManagement/directory/roleAssignments?$filter=principalId eq '...'`, `GET|DELETE .../roleAssignments/{id}`, `GET .../roleDefinitions`, `GET /v1.0/directoryRoles`, `GET /v1.0/directoryRoles/{id}/members`.

## $batch

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" http://localhost:4000/v1.0/\$batch -d '{
  "requests": [
    { "id": "0", "method": "GET", "url": "/users?$filter=mail in ('nora.analyst@soc.example')", "headers": {}, "body": {} },
    { "id": "1", "method": "PATCH", "url": "/users/10000000-0000-4000-8000-000000000003", "headers": { "Content-Type": "application/json" }, "body": { "accountEnabled": false } }
  ] }'
```

Up to 20 requests per batch, executed in order with `dependsOn`; each answer is `{ id, status, headers, body }`.

## Groups, Organization, Simulator

- `GET|POST /v1.0/groups`, `GET|PATCH|DELETE /v1.0/groups/{id}`, `GET /v1.0/groups/{id}/members`, `POST .../members/$ref`, `DELETE .../members/{userId}/$ref`
- `GET /v1.0/organization`, `GET /v1.0/servicePrincipals`, `GET /v1.0/me` (400 for app tokens)
- `POST /_graph/simulate/accept-invitation` (`invitationId`, `email`, or `userId`), `GET /_graph/redeem/{code}`, `POST /_graph/simulate/sign-in`
- `GET /_graph/events?type=role_assignment.created`, `DELETE /_graph/events`
- `GET /` inspector tabs: users, role assignments, invitations, groups, tenants, events, auth

## Seed Configuration

```json
{
  "graph": {
    "apps": [{ "client_id": "212aa55e-c1f9-430c-aa36-4dcda6ae8c36", "client_secret": "secret", "permissions": ["User.ReadWrite.All", "User.Invite.All", "RoleManagement.ReadWrite.Directory"] }],
    "tenants": [
      {
        "id": "11111111-1111-4111-8111-111111111111",
        "displayName": "Customer A",
        "domain": "customera.onmicrosoft.com",
        "users": [
          { "displayName": "IT Admin", "userPrincipalName": "it.admin@customer-a.example", "mail": "it.admin@customer-a.example", "roles": ["Global Administrator"] },
          { "displayName": "Analyst One", "mail": "analyst.one@soc.example", "userType": "Guest", "roles": ["194ae4cb-b126-40b2-bd5b-6091b380977d"] }
        ],
        "invitations": [{ "email": "pending@soc.example" }]
      }
    ]
  }
}
```

Users accept explicit `id` values and `roles` by display name, role id, or template id. Seeding is idempotent by id, UPN, or email.

## Limits

Delegated flows and `/me`, mail, calendar, Teams, SharePoint, device management, delta queries, change notifications, and PIM eligibility schedules are not implemented.
