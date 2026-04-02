---
name: heygen
description: Emulated HeyGen OAuth 2.0 for local development and testing. Use when the user needs to test HeyGen sign-in locally, emulate HeyGen token exchange, configure HeyGen OAuth clients, work with HeyGen user/me endpoint without hitting real HeyGen APIs, or test PKCE flows against a local HeyGen auth server. Triggers include "HeyGen OAuth", "emulate HeyGen", "mock HeyGen login", "test HeyGen sign-in", "HeyGen PKCE", "local HeyGen auth", or any task requiring a local HeyGen auth API.
allowed-tools: Bash(npx emulate:*), Bash(emulate:*), Bash(curl:*)
---

# HeyGen OAuth 2.0 Emulator

OAuth 2.0 authorization code flow with mandatory PKCE (S256). Matches HeyGen's production API shape including the `{ code: 100, data, message }` response wrapper on `/v1/user/me`.

## Start

```bash
# HeyGen only
npx emulate --service heygen

# Default port
# http://localhost:4007
```

Or programmatically:

```typescript
import { createEmulator } from 'emulate'

const heygen = await createEmulator({ service: 'heygen', port: 4007 })
// heygen.url === 'http://localhost:4007'
```

## Pointing Your App at the Emulator

### Environment Variables

Set these to override the default HeyGen OAuth endpoints:

```bash
HEYGEN_OAUTH_AUTHORIZE_URL=http://localhost:4007/oauth/authorize
HEYGEN_OAUTH_TOKEN_URL=http://localhost:4007/v1/oauth/token
HEYGEN_OAUTH_REFRESH_URL=http://localhost:4007/v1/oauth/refresh_token
HEYGEN_USER_ME_URL=http://localhost:4007/v1/user/me
HEYGEN_OAUTH_CLIENT_ID=dev_client_id
```

### OAuth URL Mapping

| Real HeyGen URL | Emulator URL |
|-----------------|-------------|
| `https://app.heygen.com/oauth/authorize` | `http://localhost:4007/oauth/authorize` |
| `https://api2.heygen.com/v1/oauth/token` | `http://localhost:4007/v1/oauth/token` |
| `https://api2.heygen.com/v1/oauth/refresh_token` | `http://localhost:4007/v1/oauth/refresh_token` |
| `https://api2.heygen.com/v1/user/me` | `http://localhost:4007/v1/user/me` |

## Flow

The emulator implements HeyGen's OAuth 2.0 authorization code flow with PKCE:

1. Your app redirects to `/oauth/authorize` with `client_id`, `redirect_uri`, `code_challenge`, `code_challenge_method=S256`, and `state`
2. A user-picker page is shown listing all seeded users
3. The user clicks their account; the emulator redirects to your `redirect_uri` with a `code` and `state`
4. Your app POSTs to `/v1/oauth/token` with `code`, `code_verifier`, `client_id`, `grant_type=authorization_code`, and `redirect_uri`
5. The emulator returns `access_token` and `refresh_token` (expires_in: 864000)
6. Your app GETs `/v1/user/me` with `Authorization: Bearer <access_token>`

## User Response

```json
{
  "code": 100,
  "data": {
    "user": {
      "user_id": "heygen_a1b2c3d4",
      "email": "testuser@heygen.com",
      "username": "Test User",
      "email_verified": true
    }
  },
  "message": "Success"
}
```

## Seed Config

```yaml
heygen:
  users:
    - email: alice@example.com
      name: Alice
      picture: https://example.com/alice.jpg
    - email: bob@example.com
      name: Bob
  oauth_clients:
    - client_id: my_client_id
      client_secret: my_client_secret
      name: My App (dev)
      redirect_uris:
        - http://localhost:3000/api/auth/callback
```

If no `oauth_clients` are configured, any `client_id` is accepted. If clients are configured, only registered `client_id` values are validated (no `client_secret` required — HeyGen uses public PKCE clients).

## API Reference

### GET /oauth/authorize

Renders the user-picker UI. Parameters: `client_id`, `redirect_uri`, `response_type=code`, `state`, `code_challenge`, `code_challenge_method`.

### POST /oauth/authorize/callback

Form submission from the user-picker. Stores the pending code and redirects to `redirect_uri` with `?code=...&state=...`.

### POST /v1/oauth/token

Exchanges an authorization code for tokens. Validates PKCE. Accepts `application/x-www-form-urlencoded` or `application/json`.

**Request fields:** `grant_type=authorization_code`, `code`, `code_verifier`, `client_id`, `redirect_uri`

**Response:**
```json
{
  "token_type": "Bearer",
  "access_token": "heygen_...",
  "expires_in": 864000,
  "refresh_token": "heygen_refresh_..."
}
```

### POST /v1/oauth/refresh_token

Exchanges a refresh token for a new access token. Rotates the refresh token.

**Request fields:** `grant_type=refresh_token`, `client_id`, `refresh_token`

**Response:** Same shape as token exchange.

### GET /v1/user/me

Returns the authenticated user's profile in HeyGen's `{ code, data, message }` wrapper. Requires `Authorization: Bearer <access_token>`.
