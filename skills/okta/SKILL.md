---
name: okta
description: Emulated Okta OAuth 2.0 / OpenID Connect and management API for local development and testing. Use when the user needs to test Okta sign-in locally, emulate Okta OIDC discovery, configure authorization servers, manage Okta users/groups/apps, or point an Okta SDK/Auth.js/Passport flow at a local API. Triggers include "Okta API", "emulate Okta", "test Okta login", "Okta OIDC", "Okta authorization server", "OKTA_EMULATOR_URL", or any task requiring a local Okta identity provider.
allowed-tools: Bash(npx emulate:*)
---

# Okta Emulator

Okta identity provider emulation with OAuth 2.0 / OIDC, user management, groups, apps, and authorization servers. Supports both the default org server and custom authorization server paths.

## Start

```bash
# Okta only
npx emulate --service okta

# Default port when run alone
# http://localhost:4000
```

Or programmatically:

```typescript
import { createEmulator } from 'emulate'

const okta = await createEmulator({ service: 'okta', port: 4000 })
// okta.url === 'http://localhost:4000'
```

## Pointing Your App at the Emulator

```bash
OKTA_EMULATOR_URL=http://localhost:4000
```

Map real Okta URLs to the emulator base URL:

| Real Okta URL | Emulator URL |
|---------------|--------------|
| `https://{org}/.well-known/openid-configuration` | `$OKTA_EMULATOR_URL/.well-known/openid-configuration` |
| `https://{org}/oauth2/default/.well-known/openid-configuration` | `$OKTA_EMULATOR_URL/oauth2/default/.well-known/openid-configuration` |
| `https://{org}/oauth2/v1/authorize` | `$OKTA_EMULATOR_URL/oauth2/v1/authorize` |
| `https://{org}/oauth2/v1/token` | `$OKTA_EMULATOR_URL/oauth2/v1/token` |
| `https://{org}/oauth2/v1/userinfo` | `$OKTA_EMULATOR_URL/oauth2/v1/userinfo` |

## Seed Config

```yaml
okta:
  users:
    - login: testuser@okta.local
      email: testuser@okta.local
      first_name: Test
      last_name: User
  groups:
    - name: Everyone
      description: All users
      type: BUILT_IN
      okta_id: 00g_everyone
  authorization_servers:
    - id: default
      name: default
      audiences: ["api://default"]
  oauth_clients:
    - client_id: okta-test-client
      client_secret: okta-test-secret
      name: Sample OIDC Client
      redirect_uris:
        - http://localhost:3000/callback
      auth_server_id: default
```

## API Endpoints

- `GET /.well-known/openid-configuration` and `GET /oauth2/:authServerId/.well-known/openid-configuration`
- `GET /oauth2/v1/keys`
- `GET /oauth2/v1/authorize`
- `POST /oauth2/v1/token`
- `GET /oauth2/v1/userinfo`
- `POST /oauth2/v1/revoke`
- `POST /oauth2/v1/introspect`
- `GET /oauth2/v1/logout`
- `/api/v1/users`
- `/api/v1/groups`
- `/api/v1/apps`
- `/api/v1/authorizationServers`
