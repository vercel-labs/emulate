# @emulators/vercel

Fully stateful Vercel API emulation with Vercel-style JSON responses and cursor-based pagination.

Part of [emulate](https://github.com/vercel-labs/emulate) — local drop-in replacement services for CI and no-network sandboxes.

## Install

```bash
npm install @emulators/vercel
```

## Endpoints

### User & Teams
- `GET /v2/user` — authenticated user
- `PATCH /v2/user` — update user
- `GET /v2/teams` — list teams (cursor paginated)
- `GET /v2/teams/:teamId` — get team (by ID or slug)
- `POST /v2/teams` — create team
- `PATCH /v2/teams/:teamId` — update team
- `GET /v2/teams/:teamId/members` — list members
- `POST /v2/teams/:teamId/members` — add member

### Projects
- `POST /v11/projects` — create project (with optional env vars and git integration)
- `GET /v10/projects` — list projects (search, cursor pagination)
- `GET /v9/projects/:idOrName` — get project (includes env vars)
- `PATCH /v9/projects/:idOrName` — update project
- `DELETE /v9/projects/:idOrName` — delete project (cascades)
- `GET /v1/projects/:projectId/promote/aliases` — promote aliases status
- `PATCH /v1/projects/:idOrName/protection-bypass` — manage bypass secrets

### Deployments
- `POST /v13/deployments` — create deployment (auto-transitions to READY)
- `GET /v13/deployments/:idOrUrl` — get deployment (by ID or URL)
- `GET /v6/deployments` — list deployments (filter by project, target, state)
- `DELETE /v13/deployments/:id` — delete deployment (cascades)
- `PATCH /v12/deployments/:id/cancel` — cancel building deployment
- `GET /v2/deployments/:id/aliases` — list deployment aliases
- `GET /v3/deployments/:idOrUrl/events` — get build events/logs
- `GET /v6/deployments/:id/files` — list deployment files
- `POST /v2/files` — upload file (by SHA digest)

### Domains
- `POST /v10/projects/:idOrName/domains` — add domain (with verification challenge)
- `GET /v9/projects/:idOrName/domains` — list domains
- `GET /v9/projects/:idOrName/domains/:domain` — get domain
- `PATCH /v9/projects/:idOrName/domains/:domain` — update domain
- `DELETE /v9/projects/:idOrName/domains/:domain` — remove domain
- `POST /v9/projects/:idOrName/domains/:domain/verify` — verify domain

### Environment Variables
- `GET /v10/projects/:idOrName/env` — list env vars (with decrypt option)
- `POST /v10/projects/:idOrName/env` — create env vars (single, batch, upsert)
- `GET /v10/projects/:idOrName/env/:id` — get env var
- `PATCH /v9/projects/:idOrName/env/:id` — update env var
- `DELETE /v9/projects/:idOrName/env/:id` — delete env var

## Auth

All endpoints accept `teamId` or `slug` query params for team scoping. Pagination uses cursor-based `limit`/`since`/`until` with `pagination` response objects.

## Seed Configuration

```yaml
vercel:
  users:
    - username: developer
      name: Developer
      email: dev@example.com
  teams:
    - slug: my-team
      name: My Team
  projects:
    - name: my-app
      team: my-team
      framework: nextjs
  integrations:
    - client_id: "oac_abc123"
      client_secret: "secret_abc123"
      name: "My Vercel App"
      redirect_uris:
        - "http://localhost:3000/api/auth/callback/vercel"
```

## Links

- [Full documentation](https://emulate.dev/vercel)
- [GitHub](https://github.com/vercel-labs/emulate)
