---
name: okta
description: Emulated Okta OAuth 2.0, OpenID Connect, and management APIs for local development and testing. Use when the user needs to test Okta sign-in locally, emulate Okta OIDC discovery, handle authorization code or token exchange, configure Okta users/groups/apps/authorization servers, use Okta SDKs against local endpoints, or scaffold Okta through npx emulate vercel init.
allowed-tools: Bash(npx emulate:*), Bash(curl:*)
---

# Okta Emulator

Okta OAuth 2.0, OpenID Connect, users, groups, apps, and authorization server emulation with authorization code, refresh token, client credentials, PKCE, RS256 ID tokens, JWKS, userinfo, introspection, revocation, and management APIs.

The native Go runtime implements this Okta OIDC and management API surface for local CLI runs and Vercel Go Function previews. To expose Okta on a Vercel preview without separate infrastructure, run `npx emulate vercel init --service okta`; the generated route serves Okta at `/emulate/okta/*`.

## Start

```bash
# Okta only
npx emulate --service okta

# Default port when all services run
# http://localhost:4006
```

Or programmatically:

```typescript
import { createEmulator } from 'emulate'

const okta = await createEmulator({ service: 'okta', port: 4006 })
// okta.url === 'http://localhost:4006'
```

## Pointing Your App at the Emulator

### Environment Variable

```bash
OKTA_EMULATOR_URL=http://localhost:4006
```

### URL Mapping

| Real Okta URL | Emulator URL |
|---------------|-------------|
| `https://{domain}/.well-known/openid-configuration` | `$OKTA_EMULATOR_URL/.well-known/openid-configuration` |
| `https://{domain}/oauth2/{authServerId}/.well-known/openid-configuration` | `$OKTA_EMULATOR_URL/oauth2/{authServerId}/.well-known/openid-configuration` |
| `https://{domain}/oauth2/v1/authorize` | `$OKTA_EMULATOR_URL/oauth2/v1/authorize` |
| `https://{domain}/oauth2/{authServerId}/v1/authorize` | `$OKTA_EMULATOR_URL/oauth2/{authServerId}/v1/authorize` |
| `https://{domain}/oauth2/v1/token` | `$OKTA_EMULATOR_URL/oauth2/v1/token` |
| `https://{domain}/oauth2/{authServerId}/v1/token` | `$OKTA_EMULATOR_URL/oauth2/{authServerId}/v1/token` |
| `https://{domain}/api/v1/users` | `$OKTA_EMULATOR_URL/api/v1/users` |
| `https://{domain}/api/v1/groups` | `$OKTA_EMULATOR_URL/api/v1/groups` |
| `https://{domain}/api/v1/apps` | `$OKTA_EMULATOR_URL/api/v1/apps` |
| `https://{domain}/api/v1/authorizationServers` | `$OKTA_EMULATOR_URL/api/v1/authorizationServers` |

## OIDC Routes

- `GET /.well-known/openid-configuration`
- `GET /oauth2/:authServerId/.well-known/openid-configuration`
- `GET /oauth2/v1/keys`, `GET /oauth2/:authServerId/v1/keys`
- `GET /oauth2/v1/authorize`, `GET /oauth2/:authServerId/v1/authorize`
- `POST /oauth2/v1/token`, `POST /oauth2/:authServerId/v1/token`
- `GET /oauth2/v1/userinfo`, `GET /oauth2/:authServerId/v1/userinfo`
- `POST /oauth2/v1/revoke`, `POST /oauth2/:authServerId/v1/revoke`
- `POST /oauth2/v1/introspect`, `POST /oauth2/:authServerId/v1/introspect`
- `GET /oauth2/v1/logout`, `GET /oauth2/:authServerId/v1/logout`

## Management Routes

Management APIs accept `Authorization: SSWS <token>` in local development. Any non-empty SSWS token is accepted except `invalid-token`.

- `/api/v1/users`
- `/api/v1/groups`
- `/api/v1/apps`
- `/api/v1/authorizationServers`

## Seed Config

```yaml
okta:
  users:
    - login: testuser@example.com
      email: testuser@example.com
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

## Multi-Service OIDC Discovery

When more than one of Apple, Google, Microsoft, and Okta is enabled on one native Go server, use `/okta/.well-known/openid-configuration` to avoid the shared root discovery path.
