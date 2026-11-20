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
- `GET /v7/deployments` — list deployments (filter by project, target, state, commit SHA)
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

### Board

The message board behind `@vercel/board` and its `vb` CLI, under `/v1/messageboard`. It keeps boards, channels, threads, messages, reactions, labels, changes, and grants, and answers the same error codes as Vercel's API.

- `GET /v1/messageboard/boards`: the boards these credentials may use, and the default board's ID
- `POST /v1/messageboard/boards/default`: make the team's default board
- `POST /v1/messageboard/boards/ensure`: find or make a named board
- `GET /v1/messageboard/boards/:board`: one board
- `GET /v1/messageboard/boards/:board/me`: who these credentials are and what they may do there
- `GET /v1/messageboard/boards/:board/channels`: channels by name, prefix, or page
- `POST /v1/messageboard/boards/:board/channels`: make a channel
- `GET /v1/messageboard/boards/:board/actors`: authors the board has seen
- `GET /v1/messageboard/boards/:board/threads`: a channel's threads, with `include=messages`
- `POST /v1/messageboard/boards/:board/threads`: start a thread
- `GET /v1/messageboard/boards/:board/threads/:thread/messages`: a thread's messages
- `POST /v1/messageboard/boards/:board/threads/:thread/messages`: reply
- `PATCH /v1/messageboard/boards/:board/threads/:thread/messages/:n`: edit a message
- `POST /v1/messageboard/boards/:board/threads/:thread/messages/:n/delete`: delete a message
- `GET /v1/messageboard/boards/:board/threads/:thread/messages/:n/reactions`: a message's reactions
- `POST /v1/messageboard/boards/:board/threads/:thread/messages/:n/reactions`: react, or remove one
- `POST /v1/messageboard/boards/:board/threads/:thread/messages/:n/labels`: set or remove labels, with `if`
- `GET /v1/messageboard/boards/:board/messages`: a channel's messages, from a cursor
- `GET /v1/messageboard/boards/:board/messages/:id`: one message and its thread
- `GET /v1/messageboard/boards/:board/changes`: a channel's feed, long-polled with `wait`
- `GET /v1/messageboard/boards/:board/grants`: the board's grants
- `POST /v1/messageboard/boards/:board/grants`: make a grant
- `POST /v1/messageboard/boards/:board/grants/batch`: make several grants at once
- `GET /v1/messageboard/boards/:board/grants/explain`: which grant decides a channel
- `PATCH /v1/messageboard/boards/:board/grants/:grant`: add or remove principals, or replace `can`
- `POST /v1/messageboard/boards/:board/grants/:grant/revoke`: revoke a grant

Every board starts with Vercel's three default grants: everyone on the team may do everything, every project may read, post, react, label, and sync, and every app may read, post, react, and label. A board's grants are checked on every read and write, and what a caller cannot read answers 404 as it does in Vercel's API.

Point the SDK at the emulator through its `fetch` hook, which is how requests reach Vercel's API. Set `BOARD_TOKEN` to a token the emulator knows, such as `test_token_admin`:

```ts
import { board } from '@vercel/board'

const team = board({
  fetch: (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.toString())
    url.protocol = 'http:'
    url.host = 'localhost:4000'
    const headers = new Headers(init.headers)
    headers.set('authorization', `Bearer ${process.env.BOARD_TOKEN ?? ''}`)
    return fetch(url, { ...init, headers })
  },
})

await team.post('general', 'hello from the emulator')
```

Board's bearer token picks the principal. A token registered in the emulator's `tokens` config acts as that user. `project:<project>:<environment>` acts as a project's deployment, `app:<client-id-or-name>` as an app, and `user:<username>` as a person. Profiles (`x-board-profile`) and narrowed callers (`x-board-can`) work as they do on Vercel.

The real `vb` commands run on a board handle with `vb` from `@vercel/board/cli`, so `post`, `reply`, `read`, `react`, `label`, `wait`, `tail`, and `grants` print and fail exactly as the CLI does.

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
  boards:
    - name: General
      team: my-team
      default: true
      channels: [general, deploys]
      threads:
        - channel: deploys
          by: developer
          text: www@a1b2c3 is live
          labels:
            kind: deploy
          reactions:
            - emoji: tada
              by: developer
          replies:
            - text: checking it now
              by: developer
              reactions:
                - emoji: eyes
                  by: developer
      grants:
        - principals:
            - kind: user
              email: dev@example.com
          can:
            deploys: [read, post, react, label]
```

A board's `threads` seed its messages, `replies` their replies, `reactions` each message's reactors, and `grants` add to the board's default grants. `by` is a seeded username, user ID, or email.

## Links

- [Full documentation](https://emulate.dev/vercel)
- [GitHub](https://github.com/vercel-labs/emulate)
