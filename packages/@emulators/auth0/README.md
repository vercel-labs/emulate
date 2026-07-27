# @emulators/auth0

Auth0 emulator for `emulate`.

## Supported surface

- OIDC discovery at `/.well-known/openid-configuration`
- JWKS at `/.well-known/jwks.json`
- Authorization Code with PKCE at `/authorize`
- Universal Login pages at `/u/login`
- Token exchange at `/oauth/token`
- Userinfo at `/userinfo`
- Logout at `/v2/logout`
- Management API CRUD for users, roles, applications, organizations, and connections

## Seed config

```yaml
auth0:
  tenant: my-tenant
  applications:
    - client_id: my-app
      client_secret: secret
      name: My App
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

Tenant URLs are advertised as `<tenant>.auth0.localhost` when the emulator runs on localhost. Clients that cannot use subdomain routing can call discovery with `?tenant=<tenant>` and the advertised endpoints will carry that query parameter.
