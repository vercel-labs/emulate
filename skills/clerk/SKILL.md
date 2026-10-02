---
name: clerk
description: Emulated Clerk API for local development and testing. Use when the user needs to manage users and organizations locally, test Clerk auth flows, implement OAuth/OIDC sign-in, manage sessions and JWTs, test invitation workflows, or work with the Clerk Backend API without hitting the real Clerk API. Triggers include "Clerk API", "emulate Clerk", "Clerk auth", "Clerk OAuth", "Clerk users", "CLERK_API_URL", or any task requiring a local auth/identity API.
allowed-tools: Bash(npx emulate:*), Bash(emulate:*), Bash(curl:*)
---

# Clerk API Emulator

Fully stateful Clerk Backend API emulation with users, email addresses, organizations, memberships, invitations, sessions, and OAuth/OIDC. Includes a complete OAuth 2.0 authorization server with PKCE support and RS256 JWT signing.

## Start

```bash
# Clerk only
npx emulate --service clerk

# Default port (when run alone)
# http://localhost:4000
```

Or programmatically:

```typescript
import { createEmulator } from 'emulate'

const clerk = await createEmulator({ service: 'clerk', port: 4000 })
// clerk.url === 'http://localhost:4000'
```

## Auth

All Backend API endpoints require a secret key passed as `Authorization: Bearer <token>`. Any `sk_test_*` prefixed token is accepted.

```bash
curl http://localhost:4000/v1/users \
  -H "Authorization: Bearer sk_test_emulate"
```

## Pointing Your App at the Emulator

### Clerk SDK

Override the API URL in the Clerk backend client:

```typescript
import { createClerkClient } from '@clerk/backend'

const clerk = createClerkClient({
  secretKey: 'sk_test_emulate',
  apiUrl: 'http://localhost:4000',
})
```

### Environment Variable

```bash
CLERK_API_URL=http://localhost:4000
CLERK_SECRET_KEY=sk_test_emulate
```

### Embedded in Next.js (adapter-next)

```typescript
// next.config.ts
import { withEmulate } from '@emulators/adapter-next'

export default withEmulate({
  env: {
    CLERK_API_URL: `http://localhost:${process.env.PORT ?? '3000'}/emulate/clerk`,
    CLERK_SECRET_KEY: 'sk_test_emulate',
  },
})
```

```typescript
// app/emulate/[...path]/route.ts
import { createEmulateHandler } from '@emulators/adapter-next'
import * as clerk from '@emulators/clerk'

export const { GET, POST, PUT, PATCH, DELETE } = createEmulateHandler({
  services: {
    clerk: {
      emulator: clerk,
      seed: {
        users: [
          {
            email_addresses: ['admin@example.com'],
            first_name: 'Admin',
            last_name: 'User',
          },
        ],
        organizations: [
          {
            name: 'Acme Corp',
            slug: 'acme',
            members: [{ email: 'admin@example.com', role: 'org:admin' }],
          },
        ],
      },
    },
  },
})
```

## Seed Config

```yaml
clerk:
  users:
    - email_addresses:
        - admin@example.com
      first_name: Admin
      last_name: User
      username: admin
      password: test123
    - email_addresses:
        - dev@example.com
      first_name: Developer
      last_name: One
  organizations:
    - name: Acme Corp
      slug: acme
      members:
        - email: admin@example.com
          role: org:admin
        - email: dev@example.com
          role: org:member
  oauth_applications:
    - client_id: emu_clerk_client_id
      client_secret: emu_clerk_client_secret
      name: My App
      redirect_uris:
        - http://localhost:3000/api/auth/callback/clerk
```

Without seed config, the emulator creates a default admin user and organization.

## API Endpoints

### Users

```bash
TOKEN="sk_test_emulate"
BASE="http://localhost:4000"

# Create user
curl -X POST $BASE/v1/users \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"email_address": ["user@example.com"], "first_name": "Jane", "last_name": "Doe"}'

# List users (supports ?query=, ?order_by=, ?email_address[]=)
curl "$BASE/v1/users?query=jane" \
  -H "Authorization: Bearer $TOKEN"

# Get user count
curl $BASE/v1/users/count \
  -H "Authorization: Bearer $TOKEN"

# Get user by ID
curl $BASE/v1/users/<userId> \
  -H "Authorization: Bearer $TOKEN"

# Update user
curl -X PATCH $BASE/v1/users/<userId> \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"first_name": "Updated"}'

# Delete user
curl -X DELETE $BASE/v1/users/<userId> \
  -H "Authorization: Bearer $TOKEN"

# Ban / Unban / Lock / Unlock
curl -X POST $BASE/v1/users/<userId>/ban -H "Authorization: Bearer $TOKEN"
curl -X POST $BASE/v1/users/<userId>/unban -H "Authorization: Bearer $TOKEN"
curl -X POST $BASE/v1/users/<userId>/lock -H "Authorization: Bearer $TOKEN"
curl -X POST $BASE/v1/users/<userId>/unlock -H "Authorization: Bearer $TOKEN"

# Update metadata
curl -X PATCH $BASE/v1/users/<userId>/metadata \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"public_metadata": {"role": "admin"}}'

# Verify password
curl -X POST $BASE/v1/users/<userId>/verify_password \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"password": "test123"}'
```

### Email Addresses

```bash
# Get email address
curl $BASE/v1/email_addresses/<emailId> \
  -H "Authorization: Bearer $TOKEN"

# Create email address for user
curl -X POST $BASE/v1/email_addresses \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"user_id": "user_xxx", "email_address": "alt@example.com", "verified": true}'

# Update email address
curl -X PATCH $BASE/v1/email_addresses/<emailId> \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"verified": true}'

# Delete email address
curl -X DELETE $BASE/v1/email_addresses/<emailId> \
  -H "Authorization: Bearer $TOKEN"
```

### Organizations

```bash
# Create organization
curl -X POST $BASE/v1/organizations \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "New Org", "slug": "new-org", "created_by": "user_xxx"}'

# List organizations (supports ?query=)
curl "$BASE/v1/organizations?query=acme" \
  -H "Authorization: Bearer $TOKEN"

# Get organization
curl $BASE/v1/organizations/<orgId> \
  -H "Authorization: Bearer $TOKEN"

# Update organization
curl -X PATCH $BASE/v1/organizations/<orgId> \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "Updated Org"}'

# Delete organization
curl -X DELETE $BASE/v1/organizations/<orgId> \
  -H "Authorization: Bearer $TOKEN"

# Update organization metadata
curl -X PATCH $BASE/v1/organizations/<orgId>/metadata \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"public_metadata": {"plan": "enterprise"}}'
```

### Organization Memberships

Memberships have roles (`org:admin`, `org:member`) with associated permissions.

```bash
# List memberships
curl $BASE/v1/organizations/<orgId>/memberships \
  -H "Authorization: Bearer $TOKEN"

# Add member
curl -X POST $BASE/v1/organizations/<orgId>/memberships \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"user_id": "user_xxx", "role": "org:member"}'

# Update member role
curl -X PATCH $BASE/v1/organizations/<orgId>/memberships/<userId> \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"role": "org:admin"}'

# Remove member
curl -X DELETE $BASE/v1/organizations/<orgId>/memberships/<userId> \
  -H "Authorization: Bearer $TOKEN"

# Update membership metadata
curl -X PATCH $BASE/v1/organizations/<orgId>/memberships/<userId>/metadata \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"public_metadata": {"team": "engineering"}}'
```

Admin role permissions: `org:sys_profile:manage`, `org:sys_profile:delete`, `org:sys_memberships:read`, `org:sys_memberships:manage`, `org:sys_domains:read`, `org:sys_domains:manage`. Member role: `org:sys_memberships:read`.

### Organization Invitations

```bash
# List invitations (supports ?status=pending)
curl "$BASE/v1/organizations/<orgId>/invitations?status=pending" \
  -H "Authorization: Bearer $TOKEN"

# Get invitation
curl $BASE/v1/organizations/<orgId>/invitations/<invitationId> \
  -H "Authorization: Bearer $TOKEN"

# Create invitation
curl -X POST $BASE/v1/organizations/<orgId>/invitations \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"email_address": "invite@example.com", "role": "org:member"}'

# Bulk create invitations
curl -X POST $BASE/v1/organizations/<orgId>/invitations/bulk \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"email_addresses": ["a@example.com", "b@example.com"], "role": "org:member"}'

# Revoke invitation
curl -X POST $BASE/v1/organizations/<orgId>/invitations/<invitationId>/revoke \
  -H "Authorization: Bearer $TOKEN"
```

### Sessions

```bash
# List sessions (supports ?user_id=)
curl "$BASE/v1/sessions?user_id=user_xxx" \
  -H "Authorization: Bearer $TOKEN"

# Get session
curl $BASE/v1/sessions/<sessionId> \
  -H "Authorization: Bearer $TOKEN"

# Create session
curl -X POST $BASE/v1/sessions \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"user_id": "user_xxx"}'

# Revoke session
curl -X POST $BASE/v1/sessions/<sessionId>/revoke \
  -H "Authorization: Bearer $TOKEN"

# Generate session token (JWT)
curl -X POST $BASE/v1/sessions/<sessionId>/tokens \
  -H "Authorization: Bearer $TOKEN"

# Generate token from template
curl -X POST $BASE/v1/sessions/<sessionId>/tokens/<template> \
  -H "Authorization: Bearer $TOKEN"
```

Session tokens are RS256-signed JWTs containing standard OIDC claims (sub, iss, aud, exp, iat, azp, sid).

### OAuth / OIDC

The emulator implements a full OAuth 2.0 authorization server with OIDC support.

```bash
# OpenID Configuration
curl $BASE/.well-known/openid-configuration

# JSON Web Key Set
curl $BASE/v1/jwks

# Authorization (browser flow)
# GET $BASE/oauth/authorize?client_id=xxx&redirect_uri=xxx&response_type=code&scope=openid+profile+email

# Token exchange
curl -X POST $BASE/oauth/token \
  -d "grant_type=authorization_code" \
  -d "code=xxx" \
  -d "redirect_uri=http://localhost:3000/callback" \
  -d "client_id=xxx" \
  -d "client_secret=xxx"

# User info
curl $BASE/oauth/userinfo \
  -H "Authorization: Bearer <access_token>"
```

Supports authorization_code grant with PKCE (S256 code_challenge_method). The authorize endpoint renders a user selection UI where you pick which seeded user to sign in as.

## Common Patterns

### Create User and Add to Organization

```typescript
import { createEmulator } from 'emulate'
import { createClerkClient } from '@clerk/backend'

const emu = await createEmulator({ service: 'clerk', port: 4000 })

const clerk = createClerkClient({
  secretKey: 'sk_test_emulate',
  apiUrl: emu.url,
})

const user = await clerk.users.createUser({
  emailAddress: ['jane@example.com'],
  firstName: 'Jane',
})

const org = await clerk.organizations.createOrganization({
  name: 'Engineering',
  createdBy: user.id,
})

await clerk.organizations.createOrganizationMembership({
  organizationId: org.id,
  userId: user.id,
  role: 'org:admin',
})
```

### OAuth PKCE Flow

```bash
BASE="http://localhost:4000"

# 1. Generate PKCE challenge
CODE_VERIFIER=$(openssl rand -base64 32 | tr -d '=/+' | head -c 43)
CODE_CHALLENGE=$(echo -n "$CODE_VERIFIER" | openssl dgst -sha256 -binary | base64 | tr -d '=' | tr '/+' '_-')

# 2. Start authorization (opens browser for user selection)
open "$BASE/oauth/authorize?client_id=emu_clerk_client_id&redirect_uri=http://localhost:3000/callback&response_type=code&scope=openid+profile+email&code_challenge=$CODE_CHALLENGE&code_challenge_method=S256"

# 3. After user selects, exchange code for tokens
curl -X POST $BASE/oauth/token \
  -d "grant_type=authorization_code" \
  -d "code=<code_from_redirect>" \
  -d "redirect_uri=http://localhost:3000/callback" \
  -d "client_id=emu_clerk_client_id" \
  -d "code_verifier=$CODE_VERIFIER"
```
