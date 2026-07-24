---
name: clerk
description: Emulated Clerk user management and OAuth 2.0 / OIDC API for local development and testing. Use when the user needs to test Clerk integrations locally, emulate Clerk users, email addresses, sessions and session tokens, organizations, memberships, invitations, or Clerk OAuth/OIDC flows without hitting the real Clerk service. Triggers include "Clerk API", "emulate Clerk", "mock Clerk", "test Clerk auth", "Clerk organizations", "Clerk sessions", "local Clerk", or any task requiring a local Clerk API.
allowed-tools: Bash(npx emulate:*), Bash(curl:*)
---

# Clerk Emulator

Clerk user management and OAuth 2.0 / OIDC emulation: users, email addresses,
sessions and session tokens, organizations, memberships, and invitations. All
state is in-memory and resets when the process restarts.

## Start

```bash
# Clerk only, pinned to the port used throughout this guide
npx emulate --service clerk --port 4011

# Or run all 14 services; Clerk is the 12th, so it also lands on 4011
npx emulate
```

Ports are `--port` (default 4000) plus the service's index in the **enabled**
set, so a bare `npx emulate --service clerk` puts Clerk on 4000, not 4011. The
`--port 4011` above makes every example on this page valid in both modes. To pin
the port no matter what else runs, set `clerk.port` in the seed config.

Or programmatically:

```typescript
import { createEmulator } from 'emulate'

const clerk = await createEmulator({ service: 'clerk', port: 4011 })
// clerk.url === 'http://localhost:4011'
```

## Auth

Pass tokens as `Authorization: Bearer <token>`. Any non-empty token is accepted
and resolves to the fallback user; a request with **no** `Authorization` header
is rejected with 401.

```bash
curl http://localhost:4011/v1/users \
  -H "Authorization: Bearer test_token_admin"
```

## Default Seed

With no configuration, one user is created: `Test User`, primary email
`test@example.com` (verified), password `test_password`.

## Pointing Your App at the Emulator

Clerk's backend SDK takes an API base URL. Point it at the emulator and use any
non-empty secret key:

```bash
CLERK_API_URL=http://localhost:4011
CLERK_SECRET_KEY=sk_test_anything
```

```typescript
import { createClerkClient } from '@clerk/backend'

const clerk = createClerkClient({
  secretKey: process.env.CLERK_SECRET_KEY,
  apiUrl: process.env.CLERK_API_URL,
})

const users = await clerk.users.getUserList()
```

For OIDC, discovery is at `/.well-known/openid-configuration` and signing keys at
`/v1/jwks`.

## Seed Config

```yaml
clerk:
  users:
    - email_addresses: ["test@example.com"] # required, an array of strings
      first_name: Test
      last_name: User
      username: testuser
      password: clerk_test_password
      public_metadata:
        plan: pro
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

Seed config is never validated, so these fail silently:

- `email_addresses` is a required **array of strings**. A user seeded with
  `email:` instead ends up with no email address.
- There is no `name` field — use `first_name` and `last_name`.
- `organizations[].members[].email` must match a seeded user's email, or the
  membership is skipped.

## API Endpoints

### Users

```bash
# List users (filter by email_address, query params repeatable)
curl http://localhost:4011/v1/users \
  -H "Authorization: Bearer $TOKEN"

# Count users
curl http://localhost:4011/v1/users/count \
  -H "Authorization: Bearer $TOKEN"

# Get user
curl http://localhost:4011/v1/users/$USER_ID \
  -H "Authorization: Bearer $TOKEN"

# Create user
curl -X POST http://localhost:4011/v1/users \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"email_address":["new@example.com"],"first_name":"New","last_name":"User"}'

# Update user
curl -X PATCH http://localhost:4011/v1/users/$USER_ID \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"first_name":"Renamed"}'

# Delete user
curl -X DELETE http://localhost:4011/v1/users/$USER_ID \
  -H "Authorization: Bearer $TOKEN"

# Ban / unban / lock / unlock
curl -X POST http://localhost:4011/v1/users/$USER_ID/ban \
  -H "Authorization: Bearer $TOKEN"
curl -X POST http://localhost:4011/v1/users/$USER_ID/unban \
  -H "Authorization: Bearer $TOKEN"
curl -X POST http://localhost:4011/v1/users/$USER_ID/lock \
  -H "Authorization: Bearer $TOKEN"
curl -X POST http://localhost:4011/v1/users/$USER_ID/unlock \
  -H "Authorization: Bearer $TOKEN"

# Merge metadata
curl -X PATCH http://localhost:4011/v1/users/$USER_ID/metadata \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"public_metadata":{"plan":"pro"}}'

# Verify password
curl -X POST http://localhost:4011/v1/users/$USER_ID/verify_password \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"password":"test_password"}'
```

### Email Addresses

```bash
# Create
curl -X POST http://localhost:4011/v1/email_addresses \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"user_id":"'$USER_ID'","email_address":"second@example.com"}'

# Retrieve / update / delete
curl http://localhost:4011/v1/email_addresses/$EMAIL_ID \
  -H "Authorization: Bearer $TOKEN"
curl -X PATCH http://localhost:4011/v1/email_addresses/$EMAIL_ID \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"verified":true}'
curl -X DELETE http://localhost:4011/v1/email_addresses/$EMAIL_ID \
  -H "Authorization: Bearer $TOKEN"
```

### Sessions

```bash
# List / retrieve
curl http://localhost:4011/v1/sessions \
  -H "Authorization: Bearer $TOKEN"
curl http://localhost:4011/v1/sessions/$SESSION_ID \
  -H "Authorization: Bearer $TOKEN"

# Create session
curl -X POST http://localhost:4011/v1/sessions \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"user_id":"'$USER_ID'"}'

# Revoke
curl -X POST http://localhost:4011/v1/sessions/$SESSION_ID/revoke \
  -H "Authorization: Bearer $TOKEN"

# Mint a session token, optionally from a JWT template
curl -X POST http://localhost:4011/v1/sessions/$SESSION_ID/tokens \
  -H "Authorization: Bearer $TOKEN"
curl -X POST http://localhost:4011/v1/sessions/$SESSION_ID/tokens/my-template \
  -H "Authorization: Bearer $TOKEN"
```

### Organizations

```bash
# List / retrieve
curl http://localhost:4011/v1/organizations \
  -H "Authorization: Bearer $TOKEN"
curl http://localhost:4011/v1/organizations/$ORG_ID \
  -H "Authorization: Bearer $TOKEN"

# Create
curl -X POST http://localhost:4011/v1/organizations \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Acme","slug":"acme"}'

# Update / delete / merge metadata
curl -X PATCH http://localhost:4011/v1/organizations/$ORG_ID \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Acme Inc"}'
curl -X DELETE http://localhost:4011/v1/organizations/$ORG_ID \
  -H "Authorization: Bearer $TOKEN"
curl -X PATCH http://localhost:4011/v1/organizations/$ORG_ID/metadata \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"public_metadata":{"tier":"enterprise"}}'
```

### Memberships

```bash
# List members
curl http://localhost:4011/v1/organizations/$ORG_ID/memberships \
  -H "Authorization: Bearer $TOKEN"

# Add member
curl -X POST http://localhost:4011/v1/organizations/$ORG_ID/memberships \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"user_id":"'$USER_ID'","role":"admin"}'

# Update role / remove / merge metadata
curl -X PATCH http://localhost:4011/v1/organizations/$ORG_ID/memberships/$USER_ID \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"role":"basic_member"}'
curl -X DELETE http://localhost:4011/v1/organizations/$ORG_ID/memberships/$USER_ID \
  -H "Authorization: Bearer $TOKEN"
curl -X PATCH http://localhost:4011/v1/organizations/$ORG_ID/memberships/$USER_ID/metadata \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"public_metadata":{"seat":"paid"}}'
```

### Invitations

```bash
# List / retrieve
curl http://localhost:4011/v1/organizations/$ORG_ID/invitations \
  -H "Authorization: Bearer $TOKEN"
curl http://localhost:4011/v1/organizations/$ORG_ID/invitations/$INVITATION_ID \
  -H "Authorization: Bearer $TOKEN"

# Create one, or many at once
curl -X POST http://localhost:4011/v1/organizations/$ORG_ID/invitations \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"email_address":"invitee@example.com","role":"basic_member"}'
curl -X POST http://localhost:4011/v1/organizations/$ORG_ID/invitations/bulk \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '[{"email_address":"a@example.com","role":"basic_member"}]'

# Revoke
curl -X POST http://localhost:4011/v1/organizations/$ORG_ID/invitations/$INVITATION_ID/revoke \
  -H "Authorization: Bearer $TOKEN"
```

### OAuth / OIDC

```bash
# Discovery and signing keys
curl http://localhost:4011/.well-known/openid-configuration
curl http://localhost:4011/v1/jwks

# Authorization endpoint (browser redirect in a real flow)
curl "http://localhost:4011/oauth/authorize?client_id=clerk_emulate_client&redirect_uri=http://localhost:3000/api/auth/callback/clerk&response_type=code&scope=openid+email"

# Token exchange
curl -X POST http://localhost:4011/oauth/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=authorization_code&code=$CODE&client_id=clerk_emulate_client&client_secret=clerk_emulate_secret&redirect_uri=http://localhost:3000/api/auth/callback/clerk"

# Userinfo
curl http://localhost:4011/oauth/userinfo \
  -H "Authorization: Bearer $ACCESS_TOKEN"
```
