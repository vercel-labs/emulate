# @emulators/microsoft

Microsoft Entra ID (Azure AD) v2.0 OAuth 2.0 and OpenID Connect emulation with authorization code flow, PKCE, client credentials, RS256 ID tokens, and OIDC discovery.

Part of [emulate](https://github.com/vercel-labs/emulate) — local drop-in replacement services for CI and no-network sandboxes.

## Install

```bash
npm install @emulators/microsoft
```

## Endpoints

- `GET /.well-known/openid-configuration` — OIDC discovery document
- `GET /:tenant/v2.0/.well-known/openid-configuration` — tenant-scoped OIDC discovery
- `GET /:tenant/discovery/v2.0/keys` — tenant-scoped JSON Web Key Set (JWKS)
- `GET /:tenant/oauth2/v2.0/authorize` — tenant-scoped authorization endpoint (shows user picker)
- `POST /:tenant/oauth2/v2.0/token` — tenant-scoped token exchange (authorization code, refresh token, client credentials)
- `GET /oidc/userinfo` — OpenID Connect user info
- `GET /v1.0/me` — Microsoft Graph user profile
- `GET /v1.0/users/:id` — Microsoft Graph user by ID
- `GET /:tenant/oauth2/v2.0/logout` — tenant-scoped end session / logout
- `POST /:tenant/oauth2/v2.0/revoke` — tenant-scoped token revocation

Root-scoped aliases remain available for compatibility.

## Auth

OIDC authorization code flow with PKCE support. Also supports client credentials grants. Microsoft Graph `/v1.0/me` available.

## Seed Configuration

```yaml
microsoft:
  users:
    - email: testuser@outlook.com
      name: Test User
  oauth_clients:
    - client_id: example-client-id
      client_secret: example-client-secret
      name: My Microsoft App
      redirect_uris:
        - http://localhost:3000/api/auth/callback/microsoft-entra-id
```

## Links

- [Full documentation](https://emulate.dev/microsoft)
- [GitHub](https://github.com/vercel-labs/emulate)
