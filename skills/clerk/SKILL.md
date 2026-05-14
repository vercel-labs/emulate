---
name: clerk
description: Emulated Clerk authentication and user management API for local development and testing. Use when the user needs to test Clerk sign-in locally, emulate Clerk OIDC discovery/JWKS, manage users/email addresses/organizations/memberships/invitations/sessions, or point Clerk-style auth flows at a local API. Triggers include "Clerk API", "emulate Clerk", "test Clerk login", "Clerk OIDC", "Clerk users", "CLERK_EMULATOR_URL", or any task requiring a local Clerk API.
allowed-tools: Bash(npx emulate:*), Bash(emulate:*), Bash(curl:*)
---

# Clerk Emulator

Clerk authentication and user management emulation with OIDC, users, email addresses, organizations, memberships, invitations, and sessions.

## Start

```bash
# Clerk only
npx emulate --service clerk

# Default port when run alone
# http://localhost:4000
```

Or programmatically:

```typescript
import { createEmulator } from 'emulate'

const clerk = await createEmulator({ service: 'clerk', port: 4011 })
// clerk.url === 'http://localhost:4011'
```

## Pointing Your App at the Emulator

```bash
CLERK_EMULATOR_URL=http://localhost:4011
```

Use the emulator URL as the issuer/base URL for OIDC flows and backend API calls.

```bash
curl http://localhost:4011/v1/users \
  -H "Authorization: Bearer sk_test_emulate"
```

## Seed Config

```yaml
clerk:
  users:
    - first_name: Test
      last_name: User
      email_addresses: [test@example.com]
      password: clerk_test_password
  organizations:
    - name: My Company
      slug: my-company
      members:
        - email: test@example.com
          role: admin
  oauth_applications:
    - client_id: clerk_emulate_client
      client_secret: clerk_emulate_secret
      name: Emulate App
      redirect_uris:
        - http://localhost:3000/api/auth/callback/clerk
```

## OAuth / OIDC Endpoints

- `GET /.well-known/openid-configuration`
- `GET /v1/jwks`
- `GET /oauth/authorize`
- `POST /oauth/token`
- `GET /oauth/userinfo`

## Backend API Endpoints

- `/v1/users`
- `/v1/users/count`
- `/v1/email_addresses`
- `/v1/organizations`
- `/v1/organizations/:orgId/memberships`
- `/v1/organizations/:orgId/invitations`
- `/v1/sessions`

## Auth Notes

Backend API routes accept Clerk-style secret keys and shared bearer tokens. OAuth routes render a local user picker from the seeded users and issue RS256 ID tokens from the emulator issuer.
