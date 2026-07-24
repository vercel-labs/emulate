# @emulators/okta

Okta identity provider emulation with OAuth 2.0 / OIDC, user management, groups, apps, and authorization servers.

Part of [emulate](https://github.com/vercel-labs/emulate) — local drop-in replacement services for CI and no-network sandboxes.

## Install

```bash
npm install @emulators/okta
```

## Endpoints

### OAuth / OIDC

Default org server and custom authorization server paths (`/oauth2/:authServerId/...`):

- `GET /.well-known/openid-configuration` — OIDC discovery (default)
- `GET /oauth2/:authServerId/.well-known/openid-configuration` — per-server discovery
- `GET /oauth2/v1/keys` — JSON Web Key Set (JWKS)
- `GET /oauth2/v1/authorize` — authorization endpoint
- `POST /oauth2/v1/token` — token endpoint
- `GET /oauth2/v1/userinfo` — user info
- `POST /oauth2/v1/revoke` — token revocation
- `POST /oauth2/v1/introspect` — token introspection
- `GET /oauth2/v1/logout` — end session

### Users
- `GET /api/v1/users` — list users
- `POST /api/v1/users` — create user
- `GET /api/v1/users/me` — current user (from token)
- `GET /api/v1/users/:userId` — get user
- `PUT /api/v1/users/:userId` — replace user
- `POST /api/v1/users/:userId` — partial update
- `DELETE /api/v1/users/:userId` — delete user
- `GET /api/v1/users/:userId/groups` — list user groups
- `POST /api/v1/users/:userId/lifecycle/activate` — activate
- `POST /api/v1/users/:userId/lifecycle/deactivate` — deactivate
- `POST /api/v1/users/:userId/lifecycle/suspend` — suspend
- `POST /api/v1/users/:userId/lifecycle/unsuspend` — unsuspend
- `POST /api/v1/users/:userId/lifecycle/reactivate` — reactivate

### Groups
- `GET /api/v1/groups` — list groups
- `POST /api/v1/groups` — create group
- `GET /api/v1/groups/:groupId` — get group
- `PUT /api/v1/groups/:groupId` — update group
- `DELETE /api/v1/groups/:groupId` — delete group
- `GET /api/v1/groups/:groupId/users` — list group members
- `PUT /api/v1/groups/:groupId/users/:userId` — add user to group
- `DELETE /api/v1/groups/:groupId/users/:userId` — remove user from group

### Apps
- `GET /api/v1/apps` — list apps
- `POST /api/v1/apps` — create app
- `GET /api/v1/apps/:appId` — get app
- `PUT /api/v1/apps/:appId` — update app
- `DELETE /api/v1/apps/:appId` — delete app
- `GET /api/v1/apps/:appId/users` — list assigned users
- `PUT /api/v1/apps/:appId/users/:userId` — assign user
- `DELETE /api/v1/apps/:appId/users/:userId` — unassign user
- `POST /api/v1/apps/:appId/lifecycle/activate` — activate app
- `POST /api/v1/apps/:appId/lifecycle/deactivate` — deactivate app

### Authorization Servers
- `GET /api/v1/authorizationServers` — list
- `POST /api/v1/authorizationServers` — create
- `GET /api/v1/authorizationServers/:authServerId` — get
- `PUT /api/v1/authorizationServers/:authServerId` — update
- `DELETE /api/v1/authorizationServers/:authServerId` — delete
- `POST /api/v1/authorizationServers/:authServerId/lifecycle/activate` — activate
- `POST /api/v1/authorizationServers/:authServerId/lifecycle/deactivate` — deactivate

## Seed Configuration

```yaml
okta:
  users:
    - login: testuser@example.com
      email: testuser@example.com
      first_name: Test # snake_case, not firstName
      last_name: User
  groups:
    - name: Everyone
      description: All users
  apps:
    - name: My App
      label: My App
  oauth_clients:
    - client_id: okta_example_client
      client_secret: okta_example_secret
      name: My App
      redirect_uris: ["http://localhost:3000/api/auth/callback/okta"]
  authorization_servers:
    - id: default # required — this is the primary key used in /oauth2/:id/... paths
      name: default
      audiences: ["api://default"]
```

Seed config is not validated, so both of these fail silently:

- **User fields are snake_case.** `first_name` / `last_name`, not `firstName` /
  `lastName`. A camelCase key is ignored and the user is seeded with the default
  name `Test User`.
- **`authorization_servers[].id` is required.** It becomes the server's
  `server_id`, which is what `/oauth2/:authServerId/v1/token` and the other OAuth
  routes look up. Omit it and the server is created but unreachable. The
  emulator always creates a server with `id: default` on startup, so you only
  need this block to add more.

## Links

- [Full documentation](https://emulate.dev/docs/okta)
- [GitHub](https://github.com/vercel-labs/emulate)
