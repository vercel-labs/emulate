# @internal/descope

Descope OAuth 2.0 and OpenID Connect emulation for local development and testing.

## Overview

This package provides a drop-in replacement for Descope's OAuth/OIDC services, allowing you to test applications that use the Descope Go SDK for authentication without making external API calls.

## Features

- **Descope Proprietary OAuth API** - Matches the Descope Go SDK's expected endpoints
- **OAuth 2.0 Authorization Code Flow** with PKCE support
- **OpenID Connect (OIDC)** discovery document
- **Dynamic project ID support** in URLs (`/oauth2/v1/apps/{projectId}/authorize`)
- **ES256 JWT signing** with public key endpoint (`/v2/keys/{projectId}`)
- **Configurable test users** and OAuth clients
- **Simple user picker UI** for local development

## Installation

This package is part of the emulate workspace and is automatically available when using the emulate CLI.

## Usage

### Starting the Descope Emulator

```bash
# Start all services (including descope)
npx emulate start

# Start only descope on default port (4003)
npx emulate start --service descope

# Start descope on custom port
npx emulate start --service descope --port 5000
```

### Configuration

Create an `emulate.config.yaml` file:

```yaml
descope:
  port: 4003
  users:
    - email: "user@example.com"
      name: "Test User"
      given_name: "Test"
      family_name: "User"
      picture: "https://example.com/avatar.jpg"
      locale: "en"
      permissions:
        - "read"
        - "write"
      roles:
        - "user"
      tenants:
        - tenantId: "tenant-1"
          tenantName: "Test Tenant"
    - email: "admin@example.com"
      name: "Admin User"
  oauth_clients:
    - client_id: "your-client-id"
      client_secret: "your-client-secret"
      name: "Your Application"
      redirect_uris:
        - "http://localhost:3000/api/auth/callback"
```

## Emulated Endpoints

### Descope Proprietary API (Go SDK)

| Endpoint | Real Descope URL | Emulated URL |
|----------|-----------------|--------------|
| OAuth Authorize | `POST /v1/auth/oauth/authorize` | `http://localhost:4003/v1/auth/oauth/authorize` |
| OAuth Exchange | `POST /v1/auth/oauth/exchange` | `http://localhost:4003/v1/auth/oauth/exchange` |
| Public Keys | `GET /v2/keys/{projectId}` | `http://localhost:4003/v2/keys/{projectId}` |

### Standard OAuth 2.0 / OIDC

| Endpoint | Real Descope URL | Emulated URL |
|----------|-----------------|--------------|
| OIDC Discovery | `/.well-known/openid-configuration` | `http://localhost:4003/.well-known/openid-configuration` |
| Authorization | `/oauth2/v1/apps/{projectId}/authorize` | `http://localhost:4003/oauth2/v1/apps/{projectId}/authorize` |
| Token | `/oauth2/v1/apps/token` | `http://localhost:4003/oauth2/v1/apps/token` |
| User Info | `/oauth2/v1/apps/userinfo` | `http://localhost:4003/oauth2/v1/apps/userinfo` |

## OAuth Flow (Descope SDK)

The Descope Go SDK uses a proprietary API that wraps OAuth:

1. **Start OAuth**: SDK POSTs to `/v1/auth/oauth/authorize` with provider and redirect URL
   - Emulator returns JSON: `{"url": "http://localhost:4003/v1/auth/oauth/authorize/picker?code=..."}`

2. **User Selection**: SDK redirects browser to the returned URL
   - Emulator displays picker UI with seeded users
   - User selects account and emulator redirects to original redirect URL with `?code=...`

3. **Exchange Token**: SDK POSTs to `/v1/auth/oauth/exchange` with the code
   - Emulator returns JWTResponse: `{"sessionJwt": "...", "refreshJwt": "...", "user": {...}}`

4. **Token Validation**: SDK fetches public key from `/v2/keys/{projectId}` to validate JWTs

## JWT Token Format

Tokens are signed with ES256 (ECDSA using P-256 and SHA-256) with the following claims:

**Session Token:**
- `drn: "DS"` - Descope Session identifier
- `sub` - User ID
- `email`, `name` - User info
- `permissions`, `roles`, `tenants` - Authorization claims

**Refresh Token:**
- `drn: "DSR"` - Descope Session Refresh identifier
- `sub` - User ID

Public keys are available at `/v2/keys/{projectId}` for JWT validation.

## Default Port

- **Port**: 4003 (follows pattern: vercel=4000, github=4001, google=4002, slack=4004)

## Testing

```bash
# Run tests
cd packages/@internal/descope
pnpm test

# Run all tests from root
pnpm test
```

## Package Structure

```
packages/@internal/descope/
├── src/
│   ├── entities.ts              # TypeScript interfaces (DescopeUser, AuthenticationInfo, etc.)
│   ├── store.ts                 # Data store interface for users and OAuth clients
│   ├── helpers.ts               # Utility functions (UID generation)
│   ├── index.ts                 # Plugin registration and exports
│   └── routes/
│       ├── descope-api.ts       # Descope proprietary API routes
│       └── oauth.ts             # Standard OAuth 2.0/OIDC routes
├── src/__tests__/
│   ├── descope-api.test.ts      # Tests for proprietary API
│   └── descope.test.ts          # Tests for standard OAuth
├── package.json
├── tsconfig.json
├── tsup.config.ts
└── vitest.config.ts
```

## License

Apache-2.0
