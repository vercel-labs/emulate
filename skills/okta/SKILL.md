---
name: okta
description: Emulated Okta API for local development and testing. Use when the user needs to manage users, groups, and apps locally, test Okta OAuth/OIDC flows, manage authorization servers, handle user lifecycle operations, or work with the Okta API without hitting the real Okta API. Triggers include "Okta API", "emulate Okta", "Okta auth", "Okta OIDC", "authorization server", "Okta users", or any task requiring a local identity provider API.
allowed-tools: Bash(npx emulate:*), Bash(emulate:*), Bash(curl:*)
---

# Okta API Emulator

Fully stateful Okta API emulation with users, groups, apps, authorization servers, and OAuth/OIDC. Supports user lifecycle management (activate, deactivate, suspend, unsuspend, reactivate), group-based access control, and per-authorization-server OAuth flows.

## Start

```bash
# Okta only
npx emulate --service okta

# Default port (when run alone)
# http://localhost:4000
```

Or programmatically:

```typescript
import { createEmulator } from 'emulate'

const okta = await createEmulator({ service: 'okta', port: 4000 })
// okta.url === 'http://localhost:4000'
```

## Auth

All admin API endpoints use SSWS token auth:

```bash
curl http://localhost:4000/api/v1/users \
  -H "Authorization: SSWS test_api_token"
```

Any token is accepted. When no token is provided, requests fall back to the default admin context.

## Pointing Your App at the Emulator

### Okta Node.js SDK

```typescript
import { Client } from '@okta/okta-sdk-nodejs'

const client = new Client({
  orgUrl: 'http://localhost:4000',
  token: 'test_api_token',
})
```

### Environment Variable

```bash
OKTA_ORG_URL=http://localhost:4000
OKTA_API_TOKEN=test_api_token
```

### Embedded in Next.js (adapter-next)

```typescript
// next.config.ts
import { withEmulate } from '@emulators/adapter-next'

export default withEmulate({
  env: {
    OKTA_ORG_URL: `http://localhost:${process.env.PORT ?? '3000'}/emulate/okta`,
    OKTA_API_TOKEN: 'test_api_token',
  },
})
```

```typescript
// app/emulate/[...path]/route.ts
import { createEmulateHandler } from '@emulators/adapter-next'
import * as okta from '@emulators/okta'

export const { GET, POST, PUT, PATCH, DELETE } = createEmulateHandler({
  services: {
    okta: {
      emulator: okta,
      seed: {
        users: [{ login: 'admin@example.com', first_name: 'Admin', last_name: 'User' }],
        groups: [{ name: 'Engineering' }],
      },
    },
  },
})
```

## Seed Config

```yaml
okta:
  users:
    - login: admin@example.com
      first_name: Admin
      last_name: User
      status: ACTIVE
    - login: dev@example.com
      first_name: Developer
      last_name: One
  groups:
    - name: Everyone
      type: BUILT_IN
    - name: Engineering
      description: Engineering team
  apps:
    - name: myapp
      label: My Application
      sign_on_mode: OPENID_CONNECT
  authorization_servers:
    - id: default
      name: default
      description: Default authorization server
      audiences:
        - api://default
  oauth_clients:
    - client_id: emu_okta_client_id
      client_secret: emu_okta_client_secret
      name: My App
      redirect_uris:
        - http://localhost:3000/api/auth/callback/okta
      grant_types:
        - authorization_code
        - refresh_token
      auth_server_id: default
  group_memberships:
    - group_okta_id: <group_id>
      user_okta_id: <user_id>
```

Without seed config, the emulator creates a default admin user, an Everyone group, and a default authorization server.

## API Endpoints

### Users

```bash
TOKEN="test_api_token"
BASE="http://localhost:4000"

# Create user
curl -X POST $BASE/api/v1/users \
  -H "Authorization: SSWS $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"profile": {"login": "jane@example.com", "email": "jane@example.com", "firstName": "Jane", "lastName": "Doe"}}'

# List users (supports ?q= search, ?filter=, ?limit=, ?after=)
curl "$BASE/api/v1/users?q=jane" \
  -H "Authorization: SSWS $TOKEN"

# Get current user
curl $BASE/api/v1/users/me \
  -H "Authorization: SSWS $TOKEN"

# Get user by ID
curl $BASE/api/v1/users/<userId> \
  -H "Authorization: SSWS $TOKEN"

# Update user (PUT replaces profile)
curl -X PUT $BASE/api/v1/users/<userId> \
  -H "Authorization: SSWS $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"profile": {"firstName": "Updated"}}'

# Partial update (POST merges profile)
curl -X POST $BASE/api/v1/users/<userId> \
  -H "Authorization: SSWS $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"profile": {"nickName": "JD"}}'

# Delete user (must be DEPROVISIONED first)
curl -X DELETE $BASE/api/v1/users/<userId> \
  -H "Authorization: SSWS $TOKEN"

# Get user's groups
curl $BASE/api/v1/users/<userId>/groups \
  -H "Authorization: SSWS $TOKEN"
```

### User Lifecycle

Users progress through states: `STAGED` -> `ACTIVE` -> `SUSPENDED` -> `DEPROVISIONED`.

```bash
# Activate user
curl -X POST $BASE/api/v1/users/<userId>/lifecycle/activate \
  -H "Authorization: SSWS $TOKEN"

# Deactivate user
curl -X POST $BASE/api/v1/users/<userId>/lifecycle/deactivate \
  -H "Authorization: SSWS $TOKEN"

# Suspend user (ACTIVE -> SUSPENDED)
curl -X POST $BASE/api/v1/users/<userId>/lifecycle/suspend \
  -H "Authorization: SSWS $TOKEN"

# Unsuspend user (SUSPENDED -> ACTIVE)
curl -X POST $BASE/api/v1/users/<userId>/lifecycle/unsuspend \
  -H "Authorization: SSWS $TOKEN"

# Reactivate user (DEPROVISIONED -> ACTIVE)
curl -X POST $BASE/api/v1/users/<userId>/lifecycle/reactivate \
  -H "Authorization: SSWS $TOKEN"
```

### Groups

```bash
# Create group
curl -X POST $BASE/api/v1/groups \
  -H "Authorization: SSWS $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"profile": {"name": "Backend Team", "description": "Backend engineers"}}'

# List groups (supports ?q= search)
curl "$BASE/api/v1/groups?q=backend" \
  -H "Authorization: SSWS $TOKEN"

# Get group
curl $BASE/api/v1/groups/<groupId> \
  -H "Authorization: SSWS $TOKEN"

# Update group
curl -X PUT $BASE/api/v1/groups/<groupId> \
  -H "Authorization: SSWS $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"profile": {"name": "Updated Team"}}'

# Delete group
curl -X DELETE $BASE/api/v1/groups/<groupId> \
  -H "Authorization: SSWS $TOKEN"

# List group members
curl $BASE/api/v1/groups/<groupId>/users \
  -H "Authorization: SSWS $TOKEN"

# Add user to group
curl -X PUT $BASE/api/v1/groups/<groupId>/users/<userId> \
  -H "Authorization: SSWS $TOKEN"

# Remove user from group
curl -X DELETE $BASE/api/v1/groups/<groupId>/users/<userId> \
  -H "Authorization: SSWS $TOKEN"
```

### Apps

```bash
# Create app
curl -X POST $BASE/api/v1/apps \
  -H "Authorization: SSWS $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "myapp", "label": "My App", "signOnMode": "OPENID_CONNECT"}'

# List apps
curl $BASE/api/v1/apps \
  -H "Authorization: SSWS $TOKEN"

# Get app
curl $BASE/api/v1/apps/<appId> \
  -H "Authorization: SSWS $TOKEN"

# Update app
curl -X PUT $BASE/api/v1/apps/<appId> \
  -H "Authorization: SSWS $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"label": "Updated App"}'

# Delete app
curl -X DELETE $BASE/api/v1/apps/<appId> \
  -H "Authorization: SSWS $TOKEN"

# Activate / Deactivate app
curl -X POST $BASE/api/v1/apps/<appId>/lifecycle/activate -H "Authorization: SSWS $TOKEN"
curl -X POST $BASE/api/v1/apps/<appId>/lifecycle/deactivate -H "Authorization: SSWS $TOKEN"

# List app users
curl $BASE/api/v1/apps/<appId>/users \
  -H "Authorization: SSWS $TOKEN"

# Assign user to app
curl -X PUT $BASE/api/v1/apps/<appId>/users/<userId> \
  -H "Authorization: SSWS $TOKEN"

# Remove user from app
curl -X DELETE $BASE/api/v1/apps/<appId>/users/<userId> \
  -H "Authorization: SSWS $TOKEN"
```

### Authorization Servers

```bash
# Create authorization server
curl -X POST $BASE/api/v1/authorizationServers \
  -H "Authorization: SSWS $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "custom", "description": "Custom auth server", "audiences": ["api://custom"]}'

# List authorization servers
curl $BASE/api/v1/authorizationServers \
  -H "Authorization: SSWS $TOKEN"

# Get authorization server
curl $BASE/api/v1/authorizationServers/<authServerId> \
  -H "Authorization: SSWS $TOKEN"

# Update authorization server
curl -X PUT $BASE/api/v1/authorizationServers/<authServerId> \
  -H "Authorization: SSWS $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "updated", "description": "Updated description"}'

# Delete authorization server
curl -X DELETE $BASE/api/v1/authorizationServers/<authServerId> \
  -H "Authorization: SSWS $TOKEN"

# Activate / Deactivate
curl -X POST $BASE/api/v1/authorizationServers/<authServerId>/lifecycle/activate \
  -H "Authorization: SSWS $TOKEN"
curl -X POST $BASE/api/v1/authorizationServers/<authServerId>/lifecycle/deactivate \
  -H "Authorization: SSWS $TOKEN"
```

### OAuth / OIDC

Each authorization server has its own set of OAuth endpoints. Routes are available both at the org level (`/oauth2/v1/...`) and per-server (`/oauth2/<authServerId>/v1/...`).

```bash
# OpenID Configuration (org-level)
curl $BASE/.well-known/openid-configuration

# OpenID Configuration (per-server)
curl $BASE/oauth2/<authServerId>/.well-known/openid-configuration

# JSON Web Key Set
curl $BASE/oauth2/v1/keys
curl $BASE/oauth2/<authServerId>/v1/keys

# Authorization (browser flow - renders user selection UI)
# GET $BASE/oauth2/v1/authorize?client_id=xxx&redirect_uri=xxx&response_type=code&scope=openid+profile+email
# GET $BASE/oauth2/<authServerId>/v1/authorize?...

# Token exchange
curl -X POST $BASE/oauth2/v1/token \
  -d "grant_type=authorization_code" \
  -d "code=xxx" \
  -d "redirect_uri=http://localhost:3000/callback" \
  -d "client_id=xxx" \
  -d "client_secret=xxx"

# User info
curl $BASE/oauth2/v1/userinfo \
  -H "Authorization: Bearer <access_token>"

# Token revocation
curl -X POST $BASE/oauth2/v1/revoke \
  -d "token=<token>" \
  -d "client_id=xxx"

# Token introspection
curl -X POST $BASE/oauth2/v1/introspect \
  -d "token=<token>" \
  -d "client_id=xxx"

# Logout
# GET $BASE/oauth2/v1/logout?post_logout_redirect_uri=http://localhost:3000
```

Supported grant types: `authorization_code`, `client_credentials`, `refresh_token`.

## Common Patterns

### OIDC Login Flow

```bash
BASE="http://localhost:4000"

# 1. Start authorization (opens browser for user selection)
open "$BASE/oauth2/default/v1/authorize?client_id=emu_okta_client_id&redirect_uri=http://localhost:3000/callback&response_type=code&scope=openid+profile+email&state=random123"

# 2. After user selects, exchange code at the per-server token endpoint
curl -X POST $BASE/oauth2/default/v1/token \
  -d "grant_type=authorization_code" \
  -d "code=<code_from_redirect>" \
  -d "redirect_uri=http://localhost:3000/callback" \
  -d "client_id=emu_okta_client_id" \
  -d "client_secret=emu_okta_client_secret"

# 3. Get user info with the access token
curl $BASE/oauth2/default/v1/userinfo \
  -H "Authorization: Bearer <access_token>"
```

### User Lifecycle Management

```typescript
import { createEmulator } from 'emulate'

const emu = await createEmulator({ service: 'okta', port: 4000 })
const BASE = emu.url
const headers = { Authorization: 'SSWS test_api_token', 'Content-Type': 'application/json' }

// Create user (starts as STAGED)
const res = await fetch(`${BASE}/api/v1/users`, {
  method: 'POST',
  headers,
  body: JSON.stringify({
    profile: { login: 'new@example.com', email: 'new@example.com', firstName: 'New', lastName: 'User' },
  }),
})
const user = await res.json()
// user.status === 'STAGED'

// Activate
await fetch(`${BASE}/api/v1/users/${user.id}/lifecycle/activate`, { method: 'POST', headers })
// user.status === 'ACTIVE'

// Suspend
await fetch(`${BASE}/api/v1/users/${user.id}/lifecycle/suspend`, { method: 'POST', headers })
// user.status === 'SUSPENDED'
```
