---
name: aps
description: Emulated Autodesk Platform Services (APS) OAuth 2.0 for local development and testing. Use when the user needs to test Autodesk sign-in locally, emulate APS authentication v2, handle APS token exchange, configure APS OAuth clients, or work with Autodesk userinfo without hitting real Autodesk APIs. Triggers include "APS OAuth", "Autodesk Platform Services", "Forge OAuth", "Autodesk Forge", "emulate Autodesk login", "test APS 3-legged flow", "APS 2-legged token", "APS client credentials", "APS refresh token", "Autodesk userinfo", "mock Autodesk sign-in", or any task requiring a local APS authentication API.
allowed-tools: Bash(npx emulate:*), Bash(emulate:*), Bash(curl:*)
---

# Autodesk Platform Services (APS) OAuth Emulator

APS authentication v2 emulation with the 3-legged authorization code flow, PKCE support, the 2-legged client credentials flow, rotating single-use refresh tokens, RS256 access tokens, token introspection and revocation, and OIDC discovery.

## Start

```bash
# APS only
npx emulate --service aps

# Default port when all services run
# http://localhost:4014
```

Or programmatically:

```typescript
import { createEmulator } from "emulate";

const aps = await createEmulator({ service: "aps", port: 4014 });
// aps.url === 'http://localhost:4014'
```

## Pointing Your App at the Emulator

### Environment Variable

```bash
APS_EMULATOR_URL=http://localhost:4014
```

### OAuth URL Mapping

Real APS paths map 1:1 onto the emulator:

| Real APS URL                                                          | Emulator URL                                         |
| --------------------------------------------------------------------- | ---------------------------------------------------- |
| `https://developer.api.autodesk.com/authentication/v2/authorize`      | `$APS_EMULATOR_URL/authentication/v2/authorize`      |
| `https://developer.api.autodesk.com/authentication/v2/token`          | `$APS_EMULATOR_URL/authentication/v2/token`          |
| `https://developer.api.autodesk.com/authentication/v2/revoke`         | `$APS_EMULATOR_URL/authentication/v2/revoke`         |
| `https://developer.api.autodesk.com/authentication/v2/introspect`     | `$APS_EMULATOR_URL/authentication/v2/introspect`     |
| `https://developer.api.autodesk.com/authentication/v2/keys`           | `$APS_EMULATOR_URL/authentication/v2/keys`           |
| `https://developer.api.autodesk.com/authentication/v2/logout`         | `$APS_EMULATOR_URL/authentication/v2/logout`         |
| `https://developer.api.autodesk.com/.well-known/openid-configuration` | `$APS_EMULATOR_URL/.well-known/openid-configuration` |
| `https://api.userprofile.autodesk.com/userinfo`                       | `$APS_EMULATOR_URL/userinfo`                         |

## Seed Config

```yaml
aps:
  users:
    - email: testuser@autodesk.local
      name: Test User
  clients:
    - client_id: aps-test-client
      client_secret: aps-test-secret
      name: My APS App
      redirect_uris:
        - http://localhost:3000/api/auth/callback/aps
    - client_id: aps-test-app
      type: public
      redirect_uris:
        - http://localhost:3000/callback
```

Client `type` is inferred when omitted: confidential when a `client_secret` is present, public otherwise. With no config, the emulator seeds a confidential client `aps-test-client` / `aps-test-secret`, a public client `aps-test-app`, and a user `testuser@autodesk.local`.

## 3-Legged Authorization Code Flow

```bash
APS_URL="http://localhost:4014"
CLIENT_ID="aps-test-client"
CLIENT_SECRET="aps-test-secret"
REDIRECT_URI="http://localhost:3000/api/auth/callback/aps"

# 1. Open in browser (user picks a seeded Autodesk account)
#    $APS_URL/authentication/v2/authorize?client_id=$CLIENT_ID&redirect_uri=$REDIRECT_URI&response_type=code&scope=data:read&state=abc

# 2. After user selection, emulator redirects to:
#    $REDIRECT_URI?code=<code>&state=abc

# 3. Exchange code for tokens
curl -X POST $APS_URL/authentication/v2/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=authorization_code&code=<code>&client_id=$CLIENT_ID&client_secret=$CLIENT_SECRET&redirect_uri=$REDIRECT_URI"
```

Client credentials can also be sent as an HTTP Basic `Authorization` header instead of body parameters. Do not send `client_id` in the body when an `Authorization` header is present; the emulator rejects that, matching real APS. Returns:

```json
{
  "access_token": "<jwt>",
  "token_type": "Bearer",
  "expires_in": 3599,
  "refresh_token": "..."
}
```

When the requested scope includes `openid`, the response also contains an `id_token`. Authorization codes are single use and expire after 5 minutes.

### PKCE

The authorize endpoint accepts `code_challenge` with `code_challenge_method=S256` (`S256` only). PKCE is required for public clients, which omit `client_secret`:

```bash
# Verifier/challenge pair
CODE_VERIFIER="test-code-verifier-string"
CODE_CHALLENGE=$(printf %s "$CODE_VERIFIER" | openssl dgst -sha256 -binary | openssl base64 -A | tr '+/' '-_' | tr -d '=')

# 1. Authorize with code_challenge=$CODE_CHALLENGE&code_challenge_method=S256

# 2. Exchange with the verifier (public client, no secret)
curl -X POST $APS_URL/authentication/v2/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=authorization_code&code=<code>&client_id=aps-test-app&redirect_uri=http://localhost:3000/callback&code_verifier=$CODE_VERIFIER"
```

## 2-Legged Client Credentials Flow

Confidential clients only. `scope` is required:

```bash
curl -X POST $APS_URL/authentication/v2/token \
  -u "$CLIENT_ID:$CLIENT_SECRET" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials&scope=data:read data:write"
```

Returns an `access_token` without a `refresh_token` or `id_token`.

## Refresh Token Flow

```bash
curl -X POST $APS_URL/authentication/v2/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=refresh_token&refresh_token=<refresh_token>&client_id=$CLIENT_ID&client_secret=$CLIENT_SECRET"
```

Refresh tokens live for 15 days and are single use. Every refresh returns a new `refresh_token`; always store the latest one. Replaying an already-used refresh token invalidates the whole grant family (all access and refresh tokens descended from the original authorization), matching real APS behavior. An optional `scope` parameter may downscope the grant but never widen it.

## Other Endpoints

### User Info

```bash
curl $APS_URL/userinfo \
  -H "Authorization: Bearer <access_token>"
```

Requires a 3-legged token; 2-legged tokens carry no user context and return a 401 `AUTH-006` error.

### Introspection

```bash
curl -X POST $APS_URL/authentication/v2/introspect \
  -u "$CLIENT_ID:$CLIENT_SECRET" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "token=<access_or_refresh_token>"
```

### Revocation

```bash
curl -X POST $APS_URL/authentication/v2/revoke \
  -u "$CLIENT_ID:$CLIENT_SECRET" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "token=<access_or_refresh_token>"
```

### OIDC Discovery and Logout

```bash
curl $APS_URL/.well-known/openid-configuration
curl "$APS_URL/authentication/v2/logout?post_logout_redirect_uri=http://localhost:3000/"
```

The logout redirect is only followed when the target host matches a registered client redirect URI.

## Verifying Access Tokens

Access tokens are RS256 JWTs signed with the emulator's key pair and expire after one hour (`expires_in` 3599). Verify them against the JWKS endpoint:

```bash
curl $APS_URL/authentication/v2/keys
```

```typescript
import { createRemoteJWKSet, jwtVerify } from "jose";

const jwks = createRemoteJWKSet(new URL(`${process.env.APS_EMULATOR_URL}/authentication/v2/keys`));
const { payload } = await jwtVerify(accessToken, jwks, {
  issuer: "https://developer.api.autodesk.com",
  audience: "https://autodesk.com",
});
// payload.scope, payload.client_id, payload.userid (3-legged only)
```

## Current Limits

Only authentication v2 and the user profile endpoint are emulated. Data APIs such as Data Management, Model Derivative, ACC/BIM 360, and APS webhooks are not included yet.
