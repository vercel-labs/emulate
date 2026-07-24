# @emulators/clerk

Clerk emulation with users, email addresses, sessions and session tokens,
organizations, memberships, invitations, and an OAuth 2.0 / OIDC provider.

Part of [emulate](https://github.com/vercel-labs/emulate) — local drop-in replacement services for CI and no-network sandboxes.

## Install

```bash
npm install @emulators/clerk
```

## Endpoints

### Users
- `GET /v1/users` — list users
- `GET /v1/users/count` — count users
- `GET /v1/users/:userId` — retrieve user
- `POST /v1/users` — create user
- `PATCH /v1/users/:userId` — update user
- `DELETE /v1/users/:userId` — delete user
- `POST /v1/users/:userId/ban` — ban user
- `POST /v1/users/:userId/unban` — unban user
- `POST /v1/users/:userId/lock` — lock user
- `POST /v1/users/:userId/unlock` — unlock user
- `PATCH /v1/users/:userId/metadata` — merge user metadata
- `POST /v1/users/:userId/verify_password` — verify a password

### Email Addresses
- `GET /v1/email_addresses/:emailId` — retrieve
- `POST /v1/email_addresses` — create
- `PATCH /v1/email_addresses/:emailId` — update
- `DELETE /v1/email_addresses/:emailId` — delete

### Sessions
- `GET /v1/sessions` — list sessions
- `GET /v1/sessions/:sessionId` — retrieve session
- `POST /v1/sessions` — create session
- `POST /v1/sessions/:sessionId/revoke` — revoke session
- `POST /v1/sessions/:sessionId/tokens` — mint a session token
- `POST /v1/sessions/:sessionId/tokens/:template` — mint a token from a JWT template

### Organizations
- `GET /v1/organizations` — list organizations
- `GET /v1/organizations/:orgId` — retrieve organization
- `POST /v1/organizations` — create organization
- `PATCH /v1/organizations/:orgId` — update organization
- `DELETE /v1/organizations/:orgId` — delete organization
- `PATCH /v1/organizations/:orgId/metadata` — merge organization metadata

### Memberships
- `GET /v1/organizations/:orgId/memberships` — list members
- `POST /v1/organizations/:orgId/memberships` — add member
- `PATCH /v1/organizations/:orgId/memberships/:userId` — update role
- `DELETE /v1/organizations/:orgId/memberships/:userId` — remove member
- `PATCH /v1/organizations/:orgId/memberships/:userId/metadata` — merge membership metadata

### Invitations
- `GET /v1/organizations/:orgId/invitations` — list invitations
- `GET /v1/organizations/:orgId/invitations/:invitationId` — retrieve invitation
- `POST /v1/organizations/:orgId/invitations` — create invitation
- `POST /v1/organizations/:orgId/invitations/bulk` — create invitations in bulk
- `POST /v1/organizations/:orgId/invitations/:invitationId/revoke` — revoke invitation

### OAuth / OIDC
- `GET /.well-known/openid-configuration` — discovery document
- `GET /v1/jwks` — signing keys
- `GET /oauth/authorize` — authorization endpoint
- `POST /oauth/authorize/callback` — authorization callback
- `POST /oauth/token` — token exchange
- `GET /oauth/userinfo` — userinfo

## Default seed

With no configuration, one user is created: `Test User`, primary email
`test@example.com` (verified), password `test_password`.

## Seed Configuration

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

Seed config is not validated, so these fail silently:

- `email_addresses` is a required **array of strings**. A user seeded with
  `email:` instead ends up with no email address.
- There is no `name` field — use `first_name` and `last_name`.
- `organizations[].members[].email` must match a seeded user's email, or the
  membership is skipped.

## Links

- [Full documentation](https://emulate.dev/docs/clerk)
- [GitHub](https://github.com/vercel-labs/emulate)
