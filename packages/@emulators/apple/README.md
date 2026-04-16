# @emulators/apple

Sign in with Apple emulation with authorization code flow, PKCE support, RS256 ID tokens, and OIDC discovery.

Part of [emulate](https://github.com/vercel-labs/emulate) — local drop-in replacement services for CI and no-network sandboxes.

## Install

```bash
npm install @emulators/apple
```

## Endpoints

- `GET /.well-known/openid-configuration` — OIDC discovery document
- `GET /auth/keys` — JSON Web Key Set (JWKS)
- `GET /auth/authorize` — authorization endpoint (shows user picker)
- `POST /auth/token` — token exchange (authorization code and refresh token grants)
- `POST /auth/revoke` — token revocation

## Auth

OIDC authorization code flow with RS256 ID tokens. On first auth per user/client pair, a `user` JSON blob is included.

## Seed Configuration

```yaml
apple:
  users:
    - email: testuser@icloud.com
      name: Test User
  oauth_clients:
    - client_id: com.example.app
      team_id: TEAM001
      name: My Apple App
      redirect_uris:
        - http://localhost:3000/api/auth/callback/apple
```

## Links

- [Full documentation](https://emulate.dev/apple)
- [GitHub](https://github.com/vercel-labs/emulate)
