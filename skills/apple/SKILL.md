---
name: apple
description: Emulated Sign in with Apple / Apple OIDC for local development and testing. Use when the user needs to test Apple sign-in locally, emulate Apple OIDC discovery, handle Apple token exchange, configure Apple OAuth clients, or work with Apple userinfo without hitting real Apple APIs. Triggers include "Apple OAuth", "emulate Apple", "mock Apple login", "test Apple sign-in", "Sign in with Apple", "Apple OIDC", "local Apple auth", or any task requiring a local Apple OAuth/OIDC provider.
allowed-tools: Bash(npx emulate:*), Bash(emulate:*), Bash(curl:*)
---

# Apple Sign In Emulator

Sign in with Apple emulation with authorization code flow, PKCE support, RS256 ID tokens, and OIDC discovery.

## Start

```bash
# Apple only
npx emulate --service apple

# Default port (when run alone)
# http://localhost:4000
```

Or programmatically:

```typescript
import { createEmulator } from 'emulate'

const apple = await createEmulator({ service: 'apple', port: 4004 })
// apple.url === 'http://localhost:4004'
```

## Pointing Your App at the Emulator

### Environment Variable

```bash
APPLE_EMULATOR_URL=http://localhost:4004
```

### OAuth URL Mapping

| Real Apple URL | Emulator URL |
|----------------|-------------|
| `https://appleid.apple.com/.well-known/openid-configuration` | `$APPLE_EMULATOR_URL/.well-known/openid-configuration` |
| `https://appleid.apple.com/auth/authorize` | `$APPLE_EMULATOR_URL/auth/authorize` |
| `https://appleid.apple.com/auth/token` | `$APPLE_EMULATOR_URL/auth/token` |
| `https://appleid.apple.com/auth/keys` | `$APPLE_EMULATOR_URL/auth/keys` |
| `https://appleid.apple.com/auth/revoke` | `$APPLE_EMULATOR_URL/auth/revoke` |

### Auth.js / NextAuth.js

```typescript
import Apple from '@auth/core/providers/apple'

Apple({
  clientId: process.env.APPLE_CLIENT_ID,
  clientSecret: process.env.APPLE_CLIENT_SECRET,
  authorization: {
    url: `${process.env.APPLE_EMULATOR_URL}/auth/authorize`,
    params: { scope: 'openid email name', response_mode: 'form_post' },
  },
  token: {
    url: `${process.env.APPLE_EMULATOR_URL}/auth/token`,
  },
  jwks_endpoint: `${process.env.APPLE_EMULATOR_URL}/auth/keys`,
})
```

### Passport.js

```typescript
import { Strategy as AppleStrategy } from 'passport-apple'

const APPLE_URL = process.env.APPLE_EMULATOR_URL ?? 'https://appleid.apple.com'

new AppleStrategy({
  clientID: process.env.APPLE_CLIENT_ID,
  teamID: process.env.APPLE_TEAM_ID,
  keyID: process.env.APPLE_KEY_ID,
  callbackURL: 'http://localhost:3000/api/auth/callback/apple',
  authorizationURL: `${APPLE_URL}/auth/authorize`,
  tokenURL: `${APPLE_URL}/auth/token`,
}, verifyCallback)
```

## Seed Config

```yaml
apple:
  users:
    - email: testuser@icloud.com
      name: Test User
      given_name: Test
      family_name: User
    - email: private@example.com
      name: Private User
      is_private_email: true
  oauth_clients:
    - client_id: com.example.app
      team_id: TEAM001
      name: My Apple App
      redirect_uris:
        - http://localhost:3000/api/auth/callback/apple
```

When no OAuth clients are configured, the emulator accepts any `client_id`. With clients configured, strict validation is enforced for `client_id` and `redirect_uri`.

Users with `is_private_email: true` get a generated `@privaterelay.appleid.com` email in the `id_token` instead of their real email.

## API Endpoints

### OIDC Discovery

```bash
curl http://localhost:4004/.well-known/openid-configuration
```

Returns the standard OIDC discovery document with all endpoints pointing to the emulator:

```json
{
  "issuer": "http://localhost:4004",
  "authorization_endpoint": "http://localhost:4004/auth/authorize",
  "token_endpoint": "http://localhost:4004/auth/token",
  "jwks_uri": "http://localhost:4004/auth/keys",
  "revocation_endpoint": "http://localhost:4004/auth/revoke",
  "response_types_supported": ["code"],
  "subject_types_supported": ["pairwise"],
  "id_token_signing_alg_values_supported": ["RS256"],
  "scopes_supported": ["openid", "email", "name"],
  "token_endpoint_auth_methods_supported": ["client_secret_post"],
  "response_modes_supported": ["query", "fragment", "form_post"]
}
```

### JWKS

```bash
curl http://localhost:4004/auth/keys
```

Returns an RSA public key (`kid`: `emulate-apple-1`) for verifying `id_token` signatures.

### Authorization

```bash
# Browser flow: redirects to a user picker page
curl -v "http://localhost:4004/auth/authorize?\
client_id=com.example.app&\
redirect_uri=http://localhost:3000/api/auth/callback/apple&\
scope=openid+email+name&\
response_type=code&\
state=random-state&\
nonce=random-nonce&\
response_mode=form_post"
```

Query parameters:

| Param | Description |
|-------|-------------|
| `client_id` | OAuth client ID (Apple Services ID) |
| `redirect_uri` | Callback URL |
| `scope` | Space-separated scopes (`openid email name`) |
| `state` | Opaque state for CSRF protection |
| `nonce` | Nonce for ID token (optional) |
| `response_mode` | `query` (default), `form_post`, or `fragment` |

The emulator renders an HTML page where you select a seeded user. After selection, it redirects (or auto-submits a form for `form_post`) to `redirect_uri` with `code` and `state`. On the **first** authorization per user/client pair, a `user` JSON blob is also included (matching Apple's real behavior).

### Token Exchange

```bash
curl -X POST http://localhost:4004/auth/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "code=<authorization_code>&\
client_id=com.example.app&\
client_secret=<client_secret>&\
grant_type=authorization_code"
```

Returns:

```json
{
  "access_token": "apple_...",
  "refresh_token": "r_apple_...",
  "id_token": "<jwt>",
  "token_type": "Bearer",
  "expires_in": 3600
}
```

The `id_token` is an RS256 JWT containing `sub`, `email`, `email_verified` (string), `is_private_email` (string), `real_user_status`, `auth_time`, and optional `nonce`.

### Refresh Token

```bash
curl -X POST http://localhost:4004/auth/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "refresh_token=r_apple_...&\
client_id=com.example.app&\
grant_type=refresh_token"
```

Returns a new `access_token` and `id_token`. No new `refresh_token` is issued on refresh (matching Apple's behavior).

### Token Revocation

```bash
curl -X POST http://localhost:4004/auth/revoke \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "token=apple_..."
```

Returns `200 OK`. The token is removed from the emulator's token map.

## Common Patterns

### Full Authorization Code Flow

```bash
APPLE_URL="http://localhost:4004"
CLIENT_ID="com.example.app"
REDIRECT_URI="http://localhost:3000/api/auth/callback/apple"

# 1. Open in browser (user picks a seeded account)
#    $APPLE_URL/auth/authorize?client_id=$CLIENT_ID&redirect_uri=$REDIRECT_URI&scope=openid+email+name&response_type=code&state=abc&response_mode=form_post

# 2. After user selection, emulator posts to:
#    $REDIRECT_URI with code=<code>&state=abc (and user JSON on first auth)

# 3. Exchange code for tokens
curl -X POST $APPLE_URL/auth/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "code=<code>&client_id=$CLIENT_ID&grant_type=authorization_code"

# 4. Decode the id_token JWT to get user info
```

### Private Relay Email

When a user has `is_private_email: true` in the seed config, the `id_token` will contain a generated `@privaterelay.appleid.com` email instead of the user's real email. This matches Apple's Hide My Email behavior.
