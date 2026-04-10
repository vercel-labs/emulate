# @emulators/auth0

Auth0 identity platform emulation with OAuth 2.0 / OIDC, Management API v2, user lifecycle, email verification, and log event streaming.

Part of [emulate](https://github.com/vercel-labs/emulate) — local drop-in replacement services for CI and no-network sandboxes.

## Install

```bash
npm install @emulators/auth0
```

## Endpoints

### Authentication API

- `POST /oauth/token` — token endpoint (client_credentials, password-realm, refresh_token)
- `GET /userinfo` — user profile from access token
- `POST /oauth/revoke` — revoke refresh token

### Management API v2

- `POST /api/v2/users` — create user
- `GET /api/v2/users/:id` — get user by ID
- `GET /api/v2/users-by-email` — search users by email
- `PATCH /api/v2/users/:id` — update user
- `POST /api/v2/tickets/email-verification` — create email verification ticket

### OIDC Discovery

- `GET /.well-known/openid-configuration` — OpenID Connect discovery
- `GET /.well-known/jwks.json` — JSON Web Key Set (RS256)
- `GET /_emulate/public-key.pem` — RSA public key in PEM format

### Inspector

- `GET /` — tabbed UI showing users, log events, OAuth clients, and connections

## Grant Types

| Grant type | Use |
|---|---|
| `client_credentials` | Machine-to-machine tokens (Management API access) |
| `http://auth0.com/oauth/grant-type/password-realm` | User login with email + password + connection |
| `refresh_token` | Exchange refresh token for new tokens |

## Log Event Streaming

The emulator dispatches Auth0 log events via webhook when state changes occur:

| Type | Event | Trigger |
|---|---|---|
| `ss` | Successful Signup | User created |
| `fs` | Failed Signup | Create user failed |
| `sv` | Email Verified | Verification ticket consumed |
| `scp` | Password Changed | User password updated |

Configure webhook subscribers in the seed config via `log_streams`.

## Error Fidelity

Error responses match Auth0's actual format so SDK error handling works unchanged:

- Authentication API errors use OAuth2 format: `{ error, error_description }`
- Management API errors use Auth0 format: `{ statusCode, error, message, errorCode }`

## Seed Configuration

```yaml
auth0:
  connections:
    - name: Username-Password-Authentication
  users:
    - email: admin@example.com
      password: Admin1234!
      email_verified: true
      app_metadata:
        role: ADMIN
  oauth_clients:
    - client_id: my-m2m-client
      client_secret: my-secret
      name: Backend Service
      grant_types: [client_credentials]
      audience: https://api.example.com
  log_streams:
    - url: http://localhost:9000/auth0-events
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

When `signing_key` is omitted, a random RS256 key pair is generated on first request. When provided, all ID tokens and the JWKS endpoint use the configured key, enabling static JWT validation in your backend.

## Links

- [Full documentation](https://emulate.dev)
- [GitHub](https://github.com/vercel-labs/emulate)
