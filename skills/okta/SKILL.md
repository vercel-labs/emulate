---
name: okta
description: Emulated Okta for local development and testing. Use when the user needs to test Okta sign-in locally, run OAuth 2.0 / OIDC flows against an Okta org or custom authorization server, test SAML 2.0 single sign-on with Okta as the identity provider, manage Okta users, groups, apps, and app assignments through the management API, or exercise user lifecycle operations without a real Okta org. Triggers include "Okta", "emulate Okta", "mock Okta login", "Okta OIDC", "Okta SAML", "Okta management API", "SSWS token", "authorization server", or any task requiring a local Okta identity provider.
allowed-tools: Bash(npx emulate:*), Bash(curl:*)
---

# Okta Emulator

Okta emulation with OAuth 2.0 / OpenID Connect on the org authorization server and custom authorization servers, SAML 2.0 app integrations, and the management API for users, groups, apps, app assignments, and authorization servers.

## Start

Local listeners bind to `127.0.0.1` by default. For access from containers or other machines, pass `--host 0.0.0.0` to the CLI or `hostname: '0.0.0.0'` to `createEmulator`. Configure `--base-url` or `baseUrl` for advertised URLs reachable by those clients.

```bash
# Okta only
npx emulate --service okta

# Default port (when run alone)
# http://localhost:4000
```

Or programmatically:

```typescript
import { createEmulator } from 'emulate'

const okta = await createEmulator({ service: 'okta', port: 4006 })
// okta.url === 'http://localhost:4006'
```

## Pointing Your App at the Emulator

Use the emulator URL as the Okta org URL. The org authorization server's issuer is the base URL itself; a custom authorization server's issuer is `$OKTA_URL/oauth2/{authServerId}`, and the seeded `default` server is `$OKTA_URL/oauth2/default`.

| Real Okta URL | Emulator URL |
|---------------|-------------|
| `https://{yourOktaDomain}/oauth2/default/.well-known/openid-configuration` | `$OKTA_URL/oauth2/default/.well-known/openid-configuration` |
| `https://{yourOktaDomain}/oauth2/default/v1/authorize` | `$OKTA_URL/oauth2/default/v1/authorize` |
| `https://{yourOktaDomain}/oauth2/default/v1/token` | `$OKTA_URL/oauth2/default/v1/token` |
| `https://{yourOktaDomain}/api/v1/users` | `$OKTA_URL/api/v1/users` |
| `https://{yourOktaDomain}/app/{appName}/{externalKey}/sso/saml` | `$OKTA_URL/app/{appName}/{externalKey}/sso/saml` |

### Okta Node.js SDK

```typescript
import { Client } from '@okta/okta-sdk-nodejs'

const client = new Client({
  orgUrl: process.env.OKTA_URL,
  token: 'test-api-token',
})
```

### Auth.js / NextAuth.js

```typescript
import Okta from '@auth/core/providers/okta'

Okta({
  clientId: 'okta-test-client',
  clientSecret: 'okta-test-secret',
  issuer: `${process.env.OKTA_URL}/oauth2/default`,
})
```

## Management API Authentication

Management routes under `/api/v1` take an `SSWS` API token or a bearer access token. Authentication is permissive by default: an unknown token acts as the default user. Set `strict_scopes: true` in seed config to require a token from seed config, server options, or an OAuth exchange; Okta answers an unknown one with `401` and `E0000011`.

```bash
curl $OKTA_URL/api/v1/users -H "Authorization: SSWS test-api-token"
```

## Seed Config

```yaml
okta:
  users:
    - okta_id: 00u_alice
      login: alice@example.com
      first_name: Alice
      last_name: Example
  groups:
    - okta_id: 00g_eng
      name: Engineering
  group_memberships:
    - group_okta_id: 00g_eng
      user_okta_id: 00u_alice
  authorization_servers:
    - id: default
      name: default
      audiences: [api://default]
  oauth_clients:
    - client_id: okta-test-client
      client_secret: okta-test-secret
      name: Sample OIDC Client
      redirect_uris:
        - http://localhost:3000/callback
      auth_server_id: default
  apps:
    - okta_id: 0oa_portal
      name: portal_saml
      label: Portal
      sign_on_mode: SAML_2_0
      external_key: exkportal
      settings:
        signOn:
          ssoAcsUrl: http://localhost:3000/saml/acs
          audience: https://portal.example.com
          subjectNameIdFormat: urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress
  app_assignments:
    - app_okta_id: 0oa_portal
      user_okta_id: 00u_alice
```

## OAuth 2.0 / OIDC

The authorize endpoint shows a user picker instead of a password form. Pick a seeded user and the emulator redirects back with a code, in the request's `response_mode` (`query` or `form_post`).

```bash
# Discovery and keys
curl $OKTA_URL/oauth2/default/.well-known/openid-configuration
curl $OKTA_URL/oauth2/default/v1/keys

# 1. Open in a browser and pick a user:
#    $OKTA_URL/oauth2/default/v1/authorize?client_id=okta-test-client&redirect_uri=http://localhost:3000/callback&response_type=code&scope=openid+profile+email&state=abc

# 2. Exchange the code
curl -X POST $OKTA_URL/oauth2/default/v1/token \
  -d grant_type=authorization_code -d code=$CODE \
  -d client_id=okta-test-client -d client_secret=okta-test-secret \
  -d redirect_uri=http://localhost:3000/callback

# 3. Read the user
curl $OKTA_URL/oauth2/default/v1/userinfo -H "Authorization: Bearer $ACCESS_TOKEN"
```

PKCE (`code_challenge` with `S256`), refresh tokens, client credentials, `/v1/introspect`, `/v1/revoke`, and `/v1/logout` are supported on both the org server (`/oauth2/v1/...`) and custom servers (`/oauth2/{authServerId}/v1/...`).

Only `ACTIVE` users can sign in. When an app's `credentials.oauthClient.client_id` names an OIDC client, only users assigned to that app can sign in through it; others are sent back with `error=access_denied`.

## SAML 2.0 Apps

An app with `sign_on_mode: SAML_2_0` is a SAML identity provider for a service provider. Point the service provider at the app's metadata, or copy the SSO URL, issuer, and certificate from it:

```bash
# Metadata (entity ID, SSO URL for both bindings, signing certificate)
curl $OKTA_URL/app/exkportal/sso/saml/metadata
curl $OKTA_URL/api/v1/apps/0oa_portal/sso/saml/metadata -H "Authorization: SSWS test-api-token"
```

- SSO URL: `$OKTA_URL/app/{appName}/{externalKey}/sso/saml`, for the HTTP-Redirect (`GET`) and HTTP-POST (`POST`) bindings. Opening it without a `SAMLRequest` starts IdP-initiated sign-in at `defaultRelayState`.
- Issuer: `http://www.okta.com/{externalKey}`.
- `settings.signOn` sets `ssoAcsUrl`, `audience`, `recipient`, `destination`, `subjectNameIdFormat`, `responseSigned`, `assertionSigned`, `signatureAlgorithm`, `digestAlgorithm`, `authnContextClassRef`, `defaultRelayState`, and `attributeStatements`.
- An `EXPRESSION` attribute statement value like `user.email` reads the user's profile; a `GROUP` statement sends the user's groups that match `filterType` and `filterValue`.
- Users who are not `ACTIVE`, users not assigned to the app (the `403` App Not Assigned page), and deactivated apps get no assertion.

The signing key is generated once per process. Pin it with `saml_signing_key` (`private_key` and `certificate` in PEM) so the service provider keeps trusting the same certificate across restarts.

## Management API

```bash
# Users and lifecycle
curl $OKTA_URL/api/v1/users -H "Authorization: SSWS test-api-token"
curl -X POST $OKTA_URL/api/v1/users/00u_alice/lifecycle/suspend -H "Authorization: SSWS test-api-token"
curl -X DELETE "$OKTA_URL/api/v1/users/00u_alice/sessions?oauthTokens=true" -H "Authorization: SSWS test-api-token"

# Groups
curl -X PUT $OKTA_URL/api/v1/groups/00g_eng/users/00u_alice -H "Authorization: SSWS test-api-token"

# Apps and assignments
curl $OKTA_URL/api/v1/apps -H "Authorization: SSWS test-api-token"
curl -X PUT $OKTA_URL/api/v1/apps/0oa_portal/users/00u_alice -H "Authorization: SSWS test-api-token"
curl -X POST $OKTA_URL/api/v1/apps/0oa_portal/lifecycle/deactivate -H "Authorization: SSWS test-api-token"

# Authorization servers
curl $OKTA_URL/api/v1/authorizationServers -H "Authorization: SSWS test-api-token"
```

Errors use Okta's shape: `errorCode` (for example `E0000007` for a missing resource), `errorSummary`, `errorLink`, `errorId`, and `errorCauses`.

## Custom emulators alongside built-ins

Use `npx emulate init --custom inventory` to scaffold a third-party API emulator and test. Register it in `emulate.config.ts` with `defineConfig` from `emulate`, alongside built-in entries such as `{ emulator: "okta" }`. Run `npx emulate start --watch` to reload imports and inspect custom state at the printed `/_emulate` URL. Successful reloads reset the run to seed. Existing flat seed configs still work; `--config` selects an explicit file. For authoring and testing third-party API emulators, see https://emulate.dev/docs/custom-emulators.
