---
name: clerk
description: Emulated Clerk authentication, OIDC, users, organizations, invitations, sessions, and session JWTs for local development, testing, and native Vercel preview functions. Use when the user needs to test Clerk OAuth/OIDC locally, manage Clerk users or organizations without network calls, scaffold Clerk through npx emulate vercel init, or point Clerk SDK-style requests at a local API. Triggers include "Clerk", "emulate Clerk", "Clerk OIDC", "Clerk user", "Clerk organization", "session token", "sk_test", or any task requiring local Clerk service emulation.
allowed-tools: Bash(npx emulate:*)
---

# Clerk Emulator

The native Go runtime implements Clerk OIDC discovery, JWKS, authorization code flow, token exchange, userinfo, users, email addresses, organizations, memberships, invitations, sessions, and session JWTs.

## Start

```bash
npx emulate --service clerk
```

Default URL: `http://localhost:4000` when started alone.

## Vercel Go Function Preview

```bash
npx emulate vercel init --service clerk
```

Deploy the generated app to expose Clerk at `/emulate/clerk/*`.

## OIDC

- Discovery: `GET /.well-known/openid-configuration`
- JWKS: `GET /v1/jwks`
- Authorize: `GET /oauth/authorize`
- Token: `POST /oauth/token`
- Userinfo: `GET /oauth/userinfo`

When more than one of Apple, Google, Microsoft, Okta, and Clerk is enabled on one native Go server, use `/clerk/.well-known/openid-configuration` to avoid the shared root discovery path.

## Management API

Management routes accept Clerk-style secret keys:

```bash
curl http://localhost:4000/v1/users \
  -H "Authorization: Bearer sk_test_emulate"
```

Core routes:

- `GET /v1/users`, `POST /v1/users`, `GET /v1/users/:userId`, `PATCH /v1/users/:userId`, `DELETE /v1/users/:userId`
- `GET /v1/email_addresses/:emailId`, `POST /v1/email_addresses`, `PATCH /v1/email_addresses/:emailId`, `DELETE /v1/email_addresses/:emailId`
- `GET /v1/organizations`, `POST /v1/organizations`, `GET /v1/organizations/:orgId`, `PATCH /v1/organizations/:orgId`, `DELETE /v1/organizations/:orgId`
- `GET /v1/organizations/:orgId/memberships`, `POST /v1/organizations/:orgId/memberships`, `PATCH /v1/organizations/:orgId/memberships/:userId`, `DELETE /v1/organizations/:orgId/memberships/:userId`
- `GET /v1/organizations/:orgId/invitations`, `POST /v1/organizations/:orgId/invitations`, `POST /v1/organizations/:orgId/invitations/bulk`, `POST /v1/organizations/:orgId/invitations/:invitationId/revoke`
- `GET /v1/sessions`, `POST /v1/sessions`, `POST /v1/sessions/:sessionId/revoke`, `POST /v1/sessions/:sessionId/tokens`

## Seed Config

```yaml
clerk:
  users:
    - email_addresses: ["test@example.com"]
      first_name: Test
      last_name: User
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
