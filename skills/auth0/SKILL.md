# Auth0 Emulator

Use this skill when testing applications that integrate with Auth0 OAuth, OIDC, Universal Login, Userinfo, or the Auth0 Management API.

## Start

```bash
npx emulate --service auth0
```

Auth0 uses default port `4012` when all services are started. The service name is `auth0`.

## Default Seed

The emulator starts with:

- Tenant `dev-tenant`
- Application `auth0-test-client`
- Client secret `auth0-test-secret`
- Callback `http://localhost:3000/callback`
- User `dev@example.com`
- Connection `Username-Password-Authentication`

## OIDC Endpoints

- Discovery: `http://localhost:4012/.well-known/openid-configuration`
- JWKS: `http://localhost:4012/.well-known/jwks.json`
- Authorize: `http://localhost:4012/authorize`
- Token: `http://localhost:4012/oauth/token`
- Userinfo: `http://localhost:4012/userinfo`
- Logout: `http://localhost:4012/v2/logout`

Use `?tenant=<tenant>` on discovery when your test runner cannot route `auth0.localhost` subdomains.

## Seed Example

```yaml
auth0:
  tenant: my-tenant
  applications:
    - client_id: my-app
      client_secret: secret
      callbacks:
        - http://localhost:3000/api/auth/callback
      grant_types:
        - authorization_code
        - refresh_token
        - client_credentials
  users:
    - email: dev@example.com
      name: Developer
      password: pass
  roles:
    - name: admin
  connections:
    - name: Username-Password-Authentication
      strategy: auth0
  apis:
    - audience: https://api.example.test/
      name: Example API
```

## Notes

- Use Authorization Code with PKCE for browser and framework SDK tests.
- Use `/api/v2/users`, `/api/v2/roles`, `/api/v2/applications`, `/api/v2/organizations`, and `/api/v2/connections` for Management API tests.
- Refresh token rotation is enabled. Every successful refresh returns a new refresh token and invalidates the previous one.
