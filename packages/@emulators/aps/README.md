# @emulators/aps

Autodesk Platform Services (APS) authentication v2 emulation with the 3-legged authorization code flow, PKCE, the 2-legged client credentials flow, rotating single-use refresh tokens, RS256 access tokens, token introspection and revocation, and OIDC discovery.

Part of [emulate](https://github.com/vercel-labs/emulate) — local drop-in replacement services for CI and no-network sandboxes.

## Install

```bash
npm install @emulators/aps
```

## Endpoints

- `GET /.well-known/openid-configuration` — OIDC discovery document
- `GET /authentication/v2/keys` — JSON Web Key Set (JWKS)
- `GET /authentication/v2/authorize` — authorization endpoint (shows user picker)
- `POST /authentication/v2/token` — token exchange (authorization code, refresh token, client credentials)
- `POST /authentication/v2/revoke` — token revocation
- `POST /authentication/v2/introspect` — token introspection
- `GET /authentication/v2/logout` — end session / logout
- `GET /userinfo` — user profile

## URL Mapping

Real APS paths map 1:1 onto the emulator:

| Real APS URL                                               | Emulator URL                              |
| ---------------------------------------------------------- | ----------------------------------------- |
| `https://developer.api.autodesk.com/authentication/v2/...` | `$APS_EMULATOR_URL/authentication/v2/...` |
| `https://api.userprofile.autodesk.com/userinfo`            | `$APS_EMULATOR_URL/userinfo`              |

## Behavior

Access tokens are RS256 JWTs verifiable against the JWKS endpoint and expire after one hour (`expires_in` 3599). Authorization codes are single use and expire after 5 minutes. Refresh tokens live for 15 days and are single use: every refresh returns a new refresh token, and replaying an already-used refresh token invalidates the whole grant family, matching real APS behavior. PKCE supports `S256` only and is required for public clients.

With no config, the emulator seeds a confidential client `aps-test-client` / `aps-test-secret`, a public client `aps-test-app`, and a user `testuser@autodesk.local`.

## Seed Configuration

```yaml
aps:
  users:
    - email: testuser@autodesk.local
      name: Test User
  clients:
    - client_id: aps-test-client
      client_secret: aps-test-secret
      name: My APS App
      redirect_uris:
        - http://localhost:3000/api/auth/callback/aps
        - http://localhost:3000/api/auth/oauth2/callback/aps
    - client_id: aps-test-app
      type: public
      redirect_uris:
        - http://localhost:3000/callback
```

Client `type` is inferred when omitted: confidential when a `client_secret` is present, public otherwise.

## Links

- [Full documentation](https://emulate.dev)
- [GitHub](https://github.com/vercel-labs/emulate)
