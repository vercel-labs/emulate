---
name: auth0
description: Emulated Auth0 Authentication API, Management API v2, and OIDC for local development and testing. Use when the user needs to test Auth0 login locally, emulate Auth0 token exchange, create or manage Auth0 users, test email verification flows, configure Auth0 OAuth clients, work with Auth0 Management API, handle Auth0 log events, or work with Auth0 OIDC discovery without hitting real Auth0 tenants. Triggers include "Auth0 OAuth", "emulate Auth0", "mock Auth0", "test Auth0 login", "Auth0 Management API", "Auth0 OIDC", "local Auth0", "Auth0 user registration", "Auth0 password-realm", "Auth0 log stream", or any task requiring a local Auth0 identity provider.
allowed-tools: Bash(npx emulate:*), Bash(emulate:*), Bash(curl:*)
---

# Auth0 Emulator

Auth0 Authentication API, Management API v2, and OIDC emulation with user lifecycle, email verification, and log event streaming.

## Start

```bash
# Auth0 only
npx emulate --service auth0

# Default port
# http://localhost:4007
```

Or programmatically:

```typescript
import { createEmulator } from 'emulate'

const auth0 = await createEmulator({ service: 'auth0', port: 4007 })
// auth0.url === 'http://localhost:4007'
```

## Pointing Your App at the Emulator

### Environment Variable

```bash
AUTH0_EMULATOR_URL=http://localhost:4007
```

### URL Mapping

| Real Auth0 URL | Emulator URL |
|----------------|-------------|
| `https://{tenant}.auth0.com/oauth/token` | `$AUTH0_EMULATOR_URL/oauth/token` |
| `https://{tenant}.auth0.com/userinfo` | `$AUTH0_EMULATOR_URL/userinfo` |
| `https://{tenant}.auth0.com/oauth/revoke` | `$AUTH0_EMULATOR_URL/oauth/revoke` |
| `https://{tenant}.auth0.com/api/v2/users` | `$AUTH0_EMULATOR_URL/api/v2/users` |
| `https://{tenant}.auth0.com/api/v2/users-by-email` | `$AUTH0_EMULATOR_URL/api/v2/users-by-email` |
| `https://{tenant}.auth0.com/api/v2/tickets/email-verification` | `$AUTH0_EMULATOR_URL/api/v2/tickets/email-verification` |
| `https://{tenant}.auth0.com/.well-known/openid-configuration` | `$AUTH0_EMULATOR_URL/.well-known/openid-configuration` |
| `https://{tenant}.auth0.com/.well-known/jwks.json` | `$AUTH0_EMULATOR_URL/.well-known/jwks.json` |

### auth0-java SDK

Override the domain to point at the emulator:

```java
// application.conf or local.conf
auth0 {
  domain = "http://localhost:4007"
  clientId = "my-m2m-client"
  clientSecret = "my-secret"
  connection = "Username-Password-Authentication"
}
```

### auth0 Node.js SDK (npm: `auth0`)

```typescript
import { ManagementClient, AuthenticationClient } from 'auth0'

const management = new ManagementClient({
  domain: 'localhost:4007',
  clientId: 'my-m2m-client',
  clientSecret: 'my-secret',
})
```

### @auth0/nextjs-auth0

```bash
AUTH0_DOMAIN=localhost:4007
AUTH0_CLIENT_ID=my-app-client
AUTH0_CLIENT_SECRET=my-app-secret
AUTH0_SECRET=a-long-random-secret
APP_BASE_URL=http://localhost:3000
```

### Auth.js / NextAuth.js

```typescript
import Auth0Provider from '@auth/core/providers/auth0'

Auth0Provider({
  clientId: process.env.AUTH0_CLIENT_ID,
  clientSecret: process.env.AUTH0_CLIENT_SECRET,
  issuer: process.env.AUTH0_EMULATOR_URL,
})
```

### openid-client

```typescript
import { Issuer } from 'openid-client'

const auth0Issuer = await Issuer.discover(
  process.env.AUTH0_EMULATOR_URL ?? 'https://my-tenant.auth0.com'
)

const client = new auth0Issuer.Client({
  client_id: process.env.AUTH0_CLIENT_ID,
  client_secret: process.env.AUTH0_CLIENT_SECRET,
  redirect_uris: ['http://localhost:3000/api/auth/callback/auth0'],
})
```

## Seed Config

```yaml
auth0:
  connections:
    - name: Username-Password-Authentication
  users:
    - email: admin@example.com
      password: Admin1234!
      email_verified: true
      given_name: Admin
      family_name: User
      app_metadata:
        role: ADMIN
        securitiesLimit: 100
    - email: test@example.com
      password: Test1234!
      email_verified: false
      app_metadata:
        role: USER
  oauth_clients:
    - client_id: my-m2m-client
      client_secret: my-secret
      name: Backend Service
      grant_types: [client_credentials]
      audience: https://api.example.com
    - client_id: my-app-client
      client_secret: my-app-secret
      name: Web App
      grant_types: [authorization_code, refresh_token, "http://auth0.com/oauth/grant-type/password-realm"]
  log_streams:
    - url: http://localhost:9000/auth0-events
```

## Authentication API

### Get Management API Token

```bash
curl -X POST http://localhost:4007/oauth/token \
  -H "Content-Type: application/json" \
  -d '{
    "grant_type": "client_credentials",
    "client_id": "my-m2m-client",
    "client_secret": "my-secret",
    "audience": "http://localhost:4007/api/v2/"
  }'
```

Returns:

```json
{
  "access_token": "auth0_m2m_...",
  "token_type": "Bearer",
  "expires_in": 86400,
  "scope": ""
}
```

### Login User (password-realm)

Auth0's Resource Owner Password extension. The `grant_type` is `http://auth0.com/oauth/grant-type/password-realm`.

```bash
curl -X POST http://localhost:4007/oauth/token \
  -H "Content-Type: application/json" \
  -d '{
    "grant_type": "http://auth0.com/oauth/grant-type/password-realm",
    "client_id": "my-app-client",
    "client_secret": "my-app-secret",
    "username": "admin@example.com",
    "password": "Admin1234!",
    "realm": "Username-Password-Authentication",
    "scope": "openid profile email offline_access"
  }'
```

Returns:

```json
{
  "access_token": "auth0_at_...",
  "refresh_token": "auth0_rt_...",
  "id_token": "<jwt>",
  "token_type": "Bearer",
  "expires_in": 86400,
  "scope": "openid profile email offline_access"
}
```

The `id_token` is an RS256 JWT with claims: `sub`, `name`, `given_name`, `family_name`, `nickname`, `email`, `email_verified`, `picture`.

Error responses use OAuth2 format:

```json
{
  "error": "invalid_grant",
  "error_description": "Wrong email or password."
}
```

### Refresh Token

```bash
curl -X POST http://localhost:4007/oauth/token \
  -H "Content-Type: application/json" \
  -d '{
    "grant_type": "refresh_token",
    "client_id": "my-app-client",
    "client_secret": "my-app-secret",
    "refresh_token": "auth0_rt_..."
  }'
```

### Userinfo

```bash
curl http://localhost:4007/userinfo \
  -H "Authorization: Bearer auth0_at_..."
```

### Revoke Token

```bash
curl -X POST http://localhost:4007/oauth/revoke \
  -H "Content-Type: application/json" \
  -d '{"token": "auth0_rt_..."}'
```

## Management API v2

All Management API endpoints require a Bearer token obtained via client_credentials grant.

### Create User

```bash
TOKEN="auth0_m2m_..."

curl -X POST http://localhost:4007/api/v2/users \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "newuser@example.com",
    "password": "SecurePass1!",
    "connection": "Username-Password-Authentication",
    "verify_email": false,
    "app_metadata": {
      "userId": 12345,
      "role": "USER",
      "securitiesLimit": 100
    }
  }'
```

Returns `201` with the user object including `user_id` in `auth0|{id}` format.

Error responses use Management API format:

```json
{
  "statusCode": 409,
  "error": "Conflict",
  "message": "The user already exists.",
  "errorCode": "Conflict"
}
```

### Get User

```bash
curl http://localhost:4007/api/v2/users/auth0%7C100001 \
  -H "Authorization: Bearer $TOKEN"
```

### Search Users by Email

```bash
curl "http://localhost:4007/api/v2/users-by-email?email=admin@example.com" \
  -H "Authorization: Bearer $TOKEN"
```

Returns an array of matching users.

### Update User

```bash
curl -X PATCH http://localhost:4007/api/v2/users/auth0%7C100001 \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "app_metadata": { "securitiesLimit": 200 },
    "email_verified": true
  }'
```

`app_metadata` is merged with existing metadata, not replaced.

### Email Verification Ticket

```bash
curl -X POST http://localhost:4007/api/v2/tickets/email-verification \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "user_id": "auth0|100001",
    "result_url": "https://example.com/email-verified"
  }'
```

Returns `{ "ticket": "http://localhost:4007/tickets/email-verification?ticket=..." }`.

Visit the ticket URL to mark the user's email as verified.

## OIDC Discovery

```bash
# OpenID Configuration
curl http://localhost:4007/.well-known/openid-configuration

# JWKS (RS256 public key)
curl http://localhost:4007/.well-known/jwks.json

# Public key in PEM format (for static JWT validation)
curl http://localhost:4007/_emulate/public-key.pem
```

## Deterministic Signing Key

By default, a random RS256 key pair is generated on first request. To use a known key pair for static JWT validation:

```yaml
auth0:
  signing_key:
    private_key_pem: |
      -----BEGIN PRIVATE KEY-----
      ...
      -----END PRIVATE KEY-----
    public_key_pem: |
      -----BEGIN PUBLIC KEY-----
      ...
      -----END PUBLIC KEY-----
    kid: my-custom-kid
```

When configured, all ID tokens and the JWKS endpoint use the provided key. The `kid` defaults to `emulate-auth0-1` if omitted.

## Log Event Streaming

The emulator dispatches Auth0 log events via webhook when state changes:

| Type | Event | Trigger |
|------|-------|---------|
| `ss` | Successful Signup | User created via Management API |
| `fs` | Failed Signup | Create user failed (duplicate, invalid email, weak password) |
| `sv` | Email Verified | Verification ticket consumed |
| `scp` | Password Changed | User password updated via PATCH |

Events follow the Auth0 log schema:

```json
{
  "log_id": "a1b2c3d4e5f6",
  "date": "2025-01-15T10:30:00.000Z",
  "type": "ss",
  "user_id": "auth0|100001",
  "user_name": "newuser@example.com",
  "client_id": "my-m2m-client",
  "client_name": "Backend Service",
  "connection": "Username-Password-Authentication",
  "strategy": "auth0",
  "strategy_type": "database",
  "description": "Successful signup"
}
```

Configure subscribers in the seed config via `log_streams`. Events are also visible in the inspector UI at `GET /` under the Log Events tab.

## Inspector UI

Browse to `http://localhost:4007/` to see a tabbed dashboard:

- **Users** tab shows all users with email, user_id, connection, verified/blocked status, and app_metadata
- **Log Events** tab shows dispatched events with type badges and timestamps
- **OAuth Clients** tab shows configured clients with grant types and audiences
- **Connections** tab shows database connections and strategies

## Common Patterns

### Full Registration Flow

```bash
AUTH0="http://localhost:4007"

# 1. Get management token
TOKEN=$(curl -s -X POST $AUTH0/oauth/token \
  -H "Content-Type: application/json" \
  -d '{"grant_type":"client_credentials","client_id":"my-m2m-client","client_secret":"my-secret","audience":"'$AUTH0'/api/v2/"}' \
  | jq -r '.access_token')

# 2. Create user
USER=$(curl -s -X POST $AUTH0/api/v2/users \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"email":"new@example.com","password":"Secure1!","connection":"Username-Password-Authentication","app_metadata":{"userId":42}}')
echo $USER | jq .

# 3. Send verification email
USER_ID=$(echo $USER | jq -r '.user_id')
curl -s -X POST $AUTH0/api/v2/tickets/email-verification \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"user_id":"'$USER_ID'","result_url":"https://example.com/verified"}' | jq .

# 4. Login
curl -s -X POST $AUTH0/oauth/token \
  -H "Content-Type: application/json" \
  -d '{"grant_type":"http://auth0.com/oauth/grant-type/password-realm","client_id":"my-app-client","client_secret":"my-app-secret","username":"new@example.com","password":"Secure1!","realm":"Username-Password-Authentication","scope":"openid profile email offline_access"}' \
  | jq .
```

### Error Handling Fidelity

Error strings match Auth0's actual API responses so SDK error handling works unchanged:

| Scenario | Emulator response |
|----------|------------------|
| Duplicate user | `{ "message": "The user already exists." }` |
| Weak password | `{ "message": "PasswordStrengthError: Password is too weak" }` |
| Invalid email | `{ "message": "Object didn't pass validation for format email: ..." }` |
| Wrong credentials | `{ "error": "invalid_grant", "error_description": "Wrong email or password." }` |
| Blocked user | `{ "error": "unauthorized", "error_description": "user is blocked" }` |
| Invalid refresh token | `{ "error": "invalid_grant", "error_description": "Unknown or invalid refresh token." }` |
| User not found | `{ "message": "The user does not exist." }` |
