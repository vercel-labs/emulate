---
name: vercel
description: Emulated Vercel REST API for local development and testing. Use when the user needs to interact with Vercel API endpoints locally, test Vercel integrations, emulate projects/deployments/domains, set up Vercel OAuth flows, manage environment variables, create API keys, configure protection bypass, or test without hitting the real Vercel API. Triggers include "Vercel API", "emulate Vercel", "mock Vercel", "test Vercel OAuth", "Vercel integration", "local Vercel", or any task requiring a local Vercel API.
allowed-tools: Bash(npx emulate:*), Bash(emulate:*), Bash(curl:*)
---

# Vercel API Emulator

Fully stateful Vercel REST API emulation with Vercel-style JSON responses and cursor-based pagination.

## Start

```bash
# Vercel only
npx emulate --service vercel

# Default port
# http://localhost:4000
```

Or programmatically:

```typescript
import { createEmulator } from 'emulate'

const vercel = await createEmulator({ service: 'vercel', port: 4000 })
// vercel.url === 'http://localhost:4000'
```

## Auth

Pass tokens as `Authorization: Bearer <token>`. All endpoints accept `teamId` or `slug` query params for team scoping.

```bash
curl http://localhost:4000/v2/user \
  -H "Authorization: Bearer test_token_admin"
```

Team-scoped requests resolve the account from the `teamId` or `slug` query parameter. User-scoped requests resolve the account from the authenticated user.

## Pointing Your App at the Emulator

### Environment Variable

```bash
VERCEL_EMULATOR_URL=http://localhost:4000
```

### Vercel SDK / Custom Fetch

```typescript
const VERCEL_API = process.env.VERCEL_EMULATOR_URL ?? 'https://api.vercel.com'

const res = await fetch(`${VERCEL_API}/v10/projects`, {
  headers: { Authorization: `Bearer ${token}` },
})
```

### OAuth URL Mapping

| Real Vercel URL | Emulator URL |
|-----------------|-------------|
| `https://vercel.com/integrations/oauth/authorize` | `$VERCEL_EMULATOR_URL/oauth/authorize` |
| `https://api.vercel.com/login/oauth/token` | `$VERCEL_EMULATOR_URL/login/oauth/token` |
| `https://api.vercel.com/login/oauth/userinfo` | `$VERCEL_EMULATOR_URL/login/oauth/userinfo` |

### Auth.js / NextAuth.js

```typescript
{
  id: 'vercel',
  name: 'Vercel',
  type: 'oauth',
  authorization: {
    url: `${process.env.VERCEL_EMULATOR_URL}/oauth/authorize`,
  },
  token: {
    url: `${process.env.VERCEL_EMULATOR_URL}/login/oauth/token`,
  },
  userinfo: {
    url: `${process.env.VERCEL_EMULATOR_URL}/login/oauth/userinfo`,
  },
  clientId: process.env.VERCEL_CLIENT_ID,
  clientSecret: process.env.VERCEL_CLIENT_SECRET,
  profile(profile) {
    return {
      id: profile.sub,
      name: profile.name,
      email: profile.email,
      image: profile.picture,
    }
  },
}
```

## Seed Config

```yaml
tokens:
  test_token_admin:
    login: admin
    scopes: []

vercel:
  users:
    - username: developer
      name: Developer
      email: dev@example.com
  teams:
    - slug: my-team
      name: My Team
      description: Engineering team
  projects:
    - name: my-app
      team: my-team
      framework: nextjs
      buildCommand: next build
      outputDirectory: .next
      rootDirectory: null
      nodeVersion: "20.x"
      envVars:
        - key: DATABASE_URL
          value: postgres://localhost/mydb
          type: encrypted
          target: [production, preview]
  integrations:
    - client_id: oac_abc123
      client_secret: secret_abc123
      name: My Vercel App
      redirect_uris:
        - http://localhost:3000/api/auth/callback/vercel
```

## Pagination

Cursor-based pagination using `limit`, `since`, and `until` query params. Responses include a `pagination` object:

```bash
curl "http://localhost:4000/v10/projects?limit=10" \
  -H "Authorization: Bearer $TOKEN"
```

## API Endpoints

### User & Teams

```bash
# Registration check
curl http://localhost:4000/registration

# Authenticated user
curl http://localhost:4000/v2/user -H "Authorization: Bearer $TOKEN"

# Update user
curl -X PATCH http://localhost:4000/v2/user \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "New Name", "email": "new@example.com"}'

# List teams (cursor paginated)
curl http://localhost:4000/v2/teams -H "Authorization: Bearer $TOKEN"

# Get team (by ID or slug)
curl http://localhost:4000/v2/teams/my-team -H "Authorization: Bearer $TOKEN"

# Create team
curl -X POST http://localhost:4000/v2/teams \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"slug": "new-team", "name": "New Team"}'

# Update team (name, slug, description)
curl -X PATCH http://localhost:4000/v2/teams/my-team \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "Updated Team", "description": "New description"}'

# List members
curl http://localhost:4000/v2/teams/my-team/members -H "Authorization: Bearer $TOKEN"

# Add member (by uid or email, with role)
curl -X POST "http://localhost:4000/v2/teams/team_id/members" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"email": "dev@example.com", "role": "MEMBER"}'
```

Roles: `OWNER`, `MEMBER`, `DEVELOPER`, `VIEWER`.

### Projects

```bash
# Create project (with optional env vars, git, and build config)
curl -X POST http://localhost:4000/v11/projects \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "my-app", "framework": "nextjs", "buildCommand": "next build", "outputDirectory": ".next", "nodeVersion": "20.x", "environmentVariables": [{"key": "API_KEY", "value": "secret", "type": "encrypted", "target": ["production"]}]}'

# List projects (search, cursor pagination)
curl "http://localhost:4000/v10/projects?search=my-app" \
  -H "Authorization: Bearer $TOKEN"

# Get project (includes env vars)
curl http://localhost:4000/v9/projects/my-app \
  -H "Authorization: Bearer $TOKEN"

# Update project (framework, buildCommand, devCommand, installCommand,
#   outputDirectory, rootDirectory, nodeVersion, serverlessFunctionRegion,
#   publicSource, autoAssignCustomDomains, gitForkProtection,
#   commandForIgnoringBuildStep)
curl -X PATCH http://localhost:4000/v9/projects/my-app \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"framework": "remix"}'

# Delete project (cascades deployments, domains, env vars, protection bypasses)
curl -X DELETE http://localhost:4000/v9/projects/my-app \
  -H "Authorization: Bearer $TOKEN"

# Promote aliases status
curl http://localhost:4000/v1/projects/my-app/promote/aliases \
  -H "Authorization: Bearer $TOKEN"

# Protection bypass: generate, revoke, regenerate
curl -X PATCH http://localhost:4000/v1/projects/my-app/protection-bypass \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"generate": {"note": "CI preview", "scope": "deployment"}}'

# Revoke protection bypass secrets
curl -X PATCH http://localhost:4000/v1/projects/my-app/protection-bypass \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"revoke": ["secret_to_revoke"]}'

# Regenerate protection bypass secrets
curl -X PATCH http://localhost:4000/v1/projects/my-app/protection-bypass \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"regenerate": ["old_secret"]}'
```

### Deployments

```bash
# Create deployment (auto-transitions to READY)
curl -X POST http://localhost:4000/v13/deployments \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "my-app", "target": "production", "meta": {"commit": "abc123"}, "regions": ["iad1"], "gitSource": {"type": "github", "ref": "main", "sha": "abc123", "repoId": "123", "org": "my-org", "repo": "my-app", "message": "Deploy", "authorName": "dev", "commitAuthorName": "dev"}}'

# Targets: "production", "preview", "staging"

# Get deployment (by ID or URL)
curl http://localhost:4000/v13/deployments/dpl_abc123 \
  -H "Authorization: Bearer $TOKEN"

# List deployments (filter by projectId, app, target, state; cursor paginated)
curl "http://localhost:4000/v6/deployments?projectId=my-app&target=production&limit=10" \
  -H "Authorization: Bearer $TOKEN"

# Delete deployment
curl -X DELETE http://localhost:4000/v13/deployments/dpl_abc123 \
  -H "Authorization: Bearer $TOKEN"

# Cancel building deployment
curl -X PATCH http://localhost:4000/v12/deployments/dpl_abc123/cancel \
  -H "Authorization: Bearer $TOKEN"

# List deployment aliases
curl http://localhost:4000/v2/deployments/dpl_abc123/aliases \
  -H "Authorization: Bearer $TOKEN"

# Get build events/logs (supports direction, limit)
curl "http://localhost:4000/v3/deployments/dpl_abc123/events?direction=forward&limit=50" \
  -H "Authorization: Bearer $TOKEN"

# List deployment files
curl http://localhost:4000/v6/deployments/dpl_abc123/files \
  -H "Authorization: Bearer $TOKEN"

# Upload file (by SHA digest)
curl -X POST http://localhost:4000/v2/files \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/octet-stream" \
  -H "x-vercel-digest: sha256hash" \
  --data-binary @file.txt
```

### Domains

```bash
# Add domain (with optional redirect, gitBranch, customEnvironmentId)
curl -X POST http://localhost:4000/v10/projects/my-app/domains \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "example.com", "redirect": null, "redirectStatusCode": null, "gitBranch": null}'

# *.vercel.app domains are auto-verified

# List domains (cursor paginated)
curl http://localhost:4000/v9/projects/my-app/domains \
  -H "Authorization: Bearer $TOKEN"

# Get, update, remove domain
curl http://localhost:4000/v9/projects/my-app/domains/example.com \
  -H "Authorization: Bearer $TOKEN"

# Verify domain
curl -X POST http://localhost:4000/v9/projects/my-app/domains/example.com/verify \
  -H "Authorization: Bearer $TOKEN"
```

Redirect status codes: `301`, `302`, `307`, `308`.

### Environment Variables

```bash
# List env vars (with decrypt option; filter by gitBranch, customEnvironmentId)
curl "http://localhost:4000/v10/projects/my-app/env?decrypt=true" \
  -H "Authorization: Bearer $TOKEN"

# Create env vars (single, batch, or upsert)
curl -X POST "http://localhost:4000/v10/projects/my-app/env?upsert=true" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"key": "API_KEY", "value": "secret123", "type": "encrypted", "target": ["production", "preview"], "comment": "API key for service"}'

# Get env var
curl http://localhost:4000/v10/projects/my-app/env/env_abc123 \
  -H "Authorization: Bearer $TOKEN"

# Update env var
curl -X PATCH http://localhost:4000/v9/projects/my-app/env/env_abc123 \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"value": "newsecret"}'

# Delete env var
curl -X DELETE http://localhost:4000/v9/projects/my-app/env/env_abc123 \
  -H "Authorization: Bearer $TOKEN"
```

Env var types: `system`, `encrypted`, `plain`, `secret`, `sensitive`.

### API Keys

```bash
# Create API key (optional teamId scope)
curl -X POST "http://localhost:4000/v1/api-keys?teamId=team_abc123" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "CI Deploy Key"}'

# List API keys (optional teamId filter)
curl "http://localhost:4000/v1/api-keys?teamId=team_abc123" \
  -H "Authorization: Bearer $TOKEN"

# Delete API key
curl -X DELETE http://localhost:4000/v1/api-keys/ak_abc123 \
  -H "Authorization: Bearer $TOKEN"
```

Created API keys are automatically registered in the token map and can be used as Bearer tokens for all endpoints.

### OAuth / Integrations

```bash
# Authorize (browser flow, shows user picker)
# GET /oauth/authorize?client_id=...&redirect_uri=...&scope=...&state=...

# Token exchange (supports PKCE; accepts JSON or form-urlencoded)
curl -X POST http://localhost:4000/login/oauth/token \
  -H "Content-Type: application/json" \
  -d '{"client_id": "oac_abc123", "client_secret": "secret_abc123", "code": "<code>", "redirect_uri": "http://localhost:3000/api/auth/callback/vercel"}'

# User info (returns sub, email, email_verified, name, preferred_username, picture)
curl http://localhost:4000/login/oauth/userinfo \
  -H "Authorization: Bearer $TOKEN"
```

## Common Patterns

### Create Project and Deploy

```bash
TOKEN="test_token_admin"
BASE="http://localhost:4000"

# Create project
curl -X POST $BASE/v11/projects \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "my-app", "framework": "nextjs"}'

# Add env var
curl -X POST $BASE/v10/projects/my-app/env \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"key": "DATABASE_URL", "value": "postgres://...", "type": "encrypted", "target": ["production"]}'

# Create deployment
curl -X POST $BASE/v13/deployments \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "my-app", "target": "production"}'
```

### OAuth Integration Flow

1. Redirect user to `$VERCEL_EMULATOR_URL/oauth/authorize?client_id=...&redirect_uri=...&state=...`
2. User picks a seeded user on the emulator's UI
3. Emulator redirects back with `?code=...&state=...`
4. Exchange code for token via `POST /login/oauth/token`
5. Fetch user info via `GET /login/oauth/userinfo`

PKCE is supported. Pass `code_challenge` and `code_challenge_method` on authorize, then `code_verifier` on token exchange.

### Team-Scoped Requests

All endpoints accept `teamId` or `slug` query params:

```bash
curl "http://localhost:4000/v10/projects?teamId=team_abc123" \
  -H "Authorization: Bearer $TOKEN"

curl "http://localhost:4000/v10/projects?slug=my-team" \
  -H "Authorization: Bearer $TOKEN"
```
