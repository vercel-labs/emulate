---
name: okta
description: Emulated Okta identity provider with the Users, Groups, Apps and Authorization Servers Management APIs plus OAuth 2.0 / OIDC endpoints. Use when the user needs to test Okta integrations locally, emulate Okta users, groups, app assignments, lifecycle transitions, or run Okta OIDC sign-in flows without hitting a real Okta org. Triggers include "Okta API", "emulate Okta", "mock Okta", "test Okta OIDC", "Okta authorization server", "Okta groups", "local Okta", or any task requiring a local Okta API.
allowed-tools: Bash(npx emulate:*), Bash(curl:*)
---

# Okta Emulator

Okta Management API emulation (users, groups, apps, authorization servers) plus a
full OAuth 2.0 / OIDC provider. All state is in-memory and resets when the
process restarts.

## Start

```bash
# Okta only, pinned to the port used throughout this guide
npx emulate --service okta --port 4006

# Or run all 14 services; Okta is the 7th, so it also lands on 4006
npx emulate
```

Ports are `--port` (default 4000) plus the service's index in the **enabled**
set, so a bare `npx emulate --service okta` puts Okta on 4000, not 4006. The
`--port 4006` above makes every example on this page valid in both modes. To pin
the port no matter what else runs, set `okta.port` in the seed config.

Or programmatically:

```typescript
import { createEmulator } from 'emulate'

const okta = await createEmulator({ service: 'okta', port: 4006 })
// okta.url === 'http://localhost:4006'
```

## Auth

Pass tokens as `Authorization: Bearer <token>`. Any non-empty token is accepted
and unrecognized ones resolve to the fallback user; a request with **no**
`Authorization` header is unauthenticated and protected routes return 401.

```bash
curl http://localhost:4006/api/v1/users \
  -H "Authorization: Bearer test_token_admin"
```

## Default Seed

Always created on startup: an authorization server with id `default`, an
`Everyone` group, a default app, and a default user.

## Pointing Your App at the Emulator

```bash
OKTA_EMULATOR_URL=http://localhost:4006
```

```typescript
import { Client } from '@okta/okta-sdk-nodejs'

const client = new Client({
  orgUrl: process.env.OKTA_EMULATOR_URL,
  token: 'anything',
})
```

The OIDC issuer is `${OKTA_EMULATOR_URL}/oauth2/default`. Any OIDC-aware library
(Auth.js, `openid-client`, Passport) can be pointed at the discovery document and
will find the rest on its own:

| Real Okta URL | Emulator URL |
|---|---|
| `https://<org>.okta.com/.well-known/openid-configuration` | `$OKTA_EMULATOR_URL/.well-known/openid-configuration` |
| `https://<org>.okta.com/oauth2/default/.well-known/openid-configuration` | `$OKTA_EMULATOR_URL/oauth2/default/.well-known/openid-configuration` |
| `https://<org>.okta.com/oauth2/default/v1/authorize` | `$OKTA_EMULATOR_URL/oauth2/default/v1/authorize` |
| `https://<org>.okta.com/oauth2/default/v1/token` | `$OKTA_EMULATOR_URL/oauth2/default/v1/token` |
| `https://<org>.okta.com/api/v1/users` | `$OKTA_EMULATOR_URL/api/v1/users` |

Every `/oauth2/...` route exists both with and without an `:authServerId`
segment, so `/oauth2/v1/token` and `/oauth2/default/v1/token` both work.

## Seed Config

```yaml
okta:
  users:
    - login: testuser@example.com
      email: testuser@example.com
      first_name: Test # snake_case, not firstName
      last_name: User
      status: ACTIVE
  groups:
    - name: Everyone
      description: All users
  apps:
    - name: My App
      label: My App
  oauth_clients:
    - client_id: okta_example_client
      client_secret: okta_example_secret
      name: My App
      redirect_uris: ["http://localhost:3000/api/auth/callback/okta"]
  authorization_servers:
    - id: default # required — the primary key used in /oauth2/:id/... paths
      name: default
      audiences: ["api://default"]
```

Seed config is never validated, so both of these fail silently:

- **User name fields are snake_case.** `first_name` / `last_name`, not
  `firstName` / `lastName`. A camelCase key is ignored and the user is seeded
  with the default name `Test User`.
- **`authorization_servers[].id` is required.** It becomes the `server_id` that
  the OAuth routes look up, so a server seeded without it is created but
  unreachable.

`group_memberships` and `app_assignments` link by Okta id
(`group_okta_id` + `user_okta_id`, `app_okta_id` + `user_okta_id`).

## Management API

```bash
BASE=http://localhost:4006/api/v1

# Users
curl $BASE/users -H "Authorization: Bearer $TOKEN"
curl $BASE/users/me -H "Authorization: Bearer $TOKEN"
curl $BASE/users/$USER_ID -H "Authorization: Bearer $TOKEN"
curl $BASE/users/$USER_ID/groups -H "Authorization: Bearer $TOKEN"

curl -X POST $BASE/users \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"profile":{"login":"new@example.com","email":"new@example.com","firstName":"New","lastName":"User"}}'

# Full replace with PUT, partial update with POST
curl -X PUT $BASE/users/$USER_ID \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"profile":{"firstName":"Renamed"}}'
curl -X DELETE $BASE/users/$USER_ID -H "Authorization: Bearer $TOKEN"

# User lifecycle
curl -X POST $BASE/users/$USER_ID/lifecycle/activate -H "Authorization: Bearer $TOKEN"
curl -X POST $BASE/users/$USER_ID/lifecycle/deactivate -H "Authorization: Bearer $TOKEN"
curl -X POST $BASE/users/$USER_ID/lifecycle/suspend -H "Authorization: Bearer $TOKEN"
curl -X POST $BASE/users/$USER_ID/lifecycle/unsuspend -H "Authorization: Bearer $TOKEN"
curl -X POST $BASE/users/$USER_ID/lifecycle/reactivate -H "Authorization: Bearer $TOKEN"

# Groups, and group membership
curl $BASE/groups -H "Authorization: Bearer $TOKEN"
curl $BASE/groups/$GROUP_ID -H "Authorization: Bearer $TOKEN"
curl $BASE/groups/$GROUP_ID/users -H "Authorization: Bearer $TOKEN"
curl -X POST $BASE/groups \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"profile":{"name":"Engineers","description":"Eng team"}}'
curl -X PUT $BASE/groups/$GROUP_ID/users/$USER_ID -H "Authorization: Bearer $TOKEN"
curl -X DELETE $BASE/groups/$GROUP_ID/users/$USER_ID -H "Authorization: Bearer $TOKEN"

# Apps, and app assignment
curl $BASE/apps -H "Authorization: Bearer $TOKEN"
curl $BASE/apps/$APP_ID -H "Authorization: Bearer $TOKEN"
curl $BASE/apps/$APP_ID/users -H "Authorization: Bearer $TOKEN"
curl -X PUT $BASE/apps/$APP_ID/users/$USER_ID -H "Authorization: Bearer $TOKEN"
curl -X DELETE $BASE/apps/$APP_ID/users/$USER_ID -H "Authorization: Bearer $TOKEN"
curl -X POST $BASE/apps/$APP_ID/lifecycle/activate -H "Authorization: Bearer $TOKEN"
curl -X POST $BASE/apps/$APP_ID/lifecycle/deactivate -H "Authorization: Bearer $TOKEN"

# Authorization servers
curl $BASE/authorizationServers -H "Authorization: Bearer $TOKEN"
curl $BASE/authorizationServers/default -H "Authorization: Bearer $TOKEN"
curl -X POST $BASE/authorizationServers \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"custom","audiences":["api://custom"]}'
curl -X POST $BASE/authorizationServers/default/lifecycle/deactivate -H "Authorization: Bearer $TOKEN"
curl -X POST $BASE/authorizationServers/default/lifecycle/activate -H "Authorization: Bearer $TOKEN"
```

## OAuth 2.0 / OIDC

```bash
BASE=http://localhost:4006

# Discovery and keys
curl $BASE/.well-known/openid-configuration
curl $BASE/oauth2/default/.well-known/openid-configuration
curl $BASE/oauth2/default/v1/keys

# Authorize (browser redirect in a real flow; shows a user picker)
curl "$BASE/oauth2/default/v1/authorize?client_id=okta_example_client&redirect_uri=http://localhost:3000/api/auth/callback/okta&response_type=code&scope=openid+email+profile&state=xyz"

# Token exchange
curl -X POST $BASE/oauth2/default/v1/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=authorization_code&code=$CODE&client_id=okta_example_client&client_secret=okta_example_secret&redirect_uri=http://localhost:3000/api/auth/callback/okta"

# Userinfo, introspect, revoke, logout
curl $BASE/oauth2/default/v1/userinfo -H "Authorization: Bearer $ACCESS_TOKEN"
curl -X POST $BASE/oauth2/default/v1/introspect -d "token=$ACCESS_TOKEN"
curl -X POST $BASE/oauth2/default/v1/revoke -d "token=$ACCESS_TOKEN"
curl "$BASE/oauth2/default/v1/logout?id_token_hint=$ID_TOKEN"
```
