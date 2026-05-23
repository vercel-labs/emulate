# emulate

Local drop-in replacement services for CI and no-network sandboxes. Fully stateful, production-fidelity API emulation. Not mocks.

## Quick Start

```bash
npx emulate
```

The npm CLI launches the native Go engine. All services start on one local server with sensible defaults. No config file needed:

```
http://localhost:4000
```

## CLI

```bash
# Start all services (zero-config)
npx emulate

# Start specific services
npx emulate --service vercel,github

# Custom port
npx emulate --port 3000

# Use a seed config file
npx emulate --seed config.yaml

# Generate a starter config
npx emulate init

# Generate config for a specific service
npx emulate init --service vercel

# Scaffold a Vercel Go Function preview route
npx emulate vercel init

# List available services
npx emulate list
```

### Options

| Flag | Default | Description |
|------|---------|-------------|
| `-p, --port` | `4000` | Port for the native server |
| `-s, --service` | all | Comma-separated services to enable |
| `--seed` | auto-detect | Path to seed config (YAML or JSON) |
| `--base-url` | none | Override advertised base URL |
| `--portless` | off | Serve over HTTPS via portless (auto-registers aliases) |
| `--allow-local-lambda` | off | Allow direct localhost AWS Lambda Node.js ZipFile code execution |

The port can also be set via `EMULATE_PORT` or `PORT` environment variables.

The `emulate` npm package installs a small JavaScript launcher plus an optional native binary package for your OS and CPU. Supported native packages cover macOS, Linux, and Windows on x64 and arm64.

## HTTPS with portless

[portless](https://github.com/vercel-labs/portless) gives emulators trusted HTTPS URLs with auto-generated certs and no browser warnings.

```bash
# Start the portless proxy (first time only)
portless proxy start

# Start emulate with portless integration
npx emulate start --portless
```

Each service registers as a portless alias and gets a named HTTPS URL:

```
github  https://github.emulate.localhost
google  https://google.emulate.localhost
slack   https://slack.emulate.localhost
```

If portless is not installed, install it with `npm i -g portless`.

The `--portless` flag overwrites any existing portless aliases matching `*.emulate`. Aliases are removed automatically when emulate shuts down.

For a custom base URL without portless (any reverse proxy), use `--base-url` or the `EMULATE_BASE_URL` env var:

```bash
npx emulate start --base-url "https://emulate.myproxy.test"
```

The `PORTLESS_URL` env var is automatically set by the `portless` CLI wrapper when running a command through it. When no explicit `baseUrl` is provided, it is used as a fallback. `{service}` templates are supported when exactly one service is enabled; use `--portless` for per-service aliases.

Per-service overrides are also supported in the seed config (these take highest priority over all other base URL sources):

```yaml
github:
  baseUrl: https://github.emulate.localhost
```

## Programmatic API

```bash
npm install emulate
```

Each call to `createEmulator` starts a native Go process for a single service:

```typescript
import { createEmulator } from 'emulate'

const github = await createEmulator({ service: 'github', port: 4001 })
const vercel = await createEmulator({ service: 'vercel', port: 4002 })

github.url   // 'http://localhost:4001'
vercel.url   // 'http://localhost:4002'

await github.close()
await vercel.close()
```

### Vitest / Jest setup

```typescript
// vitest.setup.ts
import { createEmulator, type Emulator } from 'emulate'

let github: Emulator
let vercel: Emulator

beforeAll(async () => {
  ;[github, vercel] = await Promise.all([
    createEmulator({ service: 'github', port: 4001 }),
    createEmulator({ service: 'vercel', port: 4002 }),
  ])
  process.env.GITHUB_EMULATOR_URL = github.url
  process.env.VERCEL_EMULATOR_URL = vercel.url
})

afterEach(() => Promise.all([github.reset(), vercel.reset()]))
afterAll(() => Promise.all([github.close(), vercel.close()]))
```

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `service` | *(required)* | Service name: `'vercel'`, `'github'`, `'google'`, `'slack'`, `'apple'`, `'microsoft'`, `'okta'`, `'aws'`, `'resend'`, `'stripe'`, `'mongoatlas'`, or `'clerk'` |
| `port` | `4000` | Port for the HTTP server |
| `seed` | none | Inline seed data (same shape as YAML config) |
| `baseUrl` | none | Override advertised base URL. Per-service `baseUrl` in seed config takes highest priority, then this option, then `EMULATE_BASE_URL` env var (supports `{service}`), then `PORTLESS_URL` (supports `{service}`, automatically set by the `portless` CLI wrapper), then `http://localhost:<port>`. |
| `allowLocalLambda` | `false` | Allow AWS Lambda Node.js ZipFile code execution for direct localhost invokes signed by a known AWS access key |

### Instance methods

| Method | Description |
|--------|-------------|
| `url` | Base URL of the running server |
| `reset()` | Restart the native process and replay seed data, returns a Promise |
| `close()` | Shut down the HTTP server, returns a Promise |

## Configuration

Configuration is optional. The CLI auto-detects config files in this order: `emulate.config.yaml` / `.yml`, `emulate.config.json`, `service-emulator.config.yaml` / `.yml`, `service-emulator.config.json`. Or pass `--seed <file>` explicitly. Run `npx emulate init` to generate a starter file.

```yaml
tokens:
  my_token:
    login: admin
    scopes: [repo, user]

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

github:
  users:
    - login: octocat
      name: The Octocat
      email: octocat@github.com
  orgs:
    - login: my-org
      name: My Organization
  repos:
    - owner: octocat
      name: hello-world
      language: JavaScript
      auto_init: true

google:
  users:
    - email: testuser@example.com
      name: Test User
    - email: admin@acme.com
      name: Admin
      hd: acme.com
  oauth_clients:
    - client_id: my-client-id.apps.googleusercontent.com
      client_secret: GOCSPX-secret
      redirect_uris:
        - http://localhost:3000/api/auth/callback/google
  labels:
    - id: Label_ops
      user_email: testuser@example.com
      name: Ops/Review
      color_background: "#DDEEFF"
      color_text: "#111111"
  messages:
    - id: msg_welcome
      user_email: testuser@example.com
      from: welcome@example.com
      to: testuser@example.com
      subject: Welcome to the Gmail emulator
      body_text: You can now test Gmail, Calendar, and Drive flows locally.
      label_ids: [INBOX, UNREAD, CATEGORY_UPDATES]
  calendars:
    - id: primary
      user_email: testuser@example.com
      summary: testuser@example.com
      primary: true
      selected: true
      time_zone: UTC
  calendar_events:
    - id: evt_kickoff
      user_email: testuser@example.com
      calendar_id: primary
      summary: Project Kickoff
      start_date_time: 2025-01-10T09:00:00.000Z
      end_date_time: 2025-01-10T09:30:00.000Z
  drive_items:
    - id: drv_docs
      user_email: testuser@example.com
      name: Docs
      mime_type: application/vnd.google-apps.folder
      parent_ids: [root]

slack:
  team:
    name: My Workspace
    domain: my-workspace
  users:
    - name: developer
      real_name: Developer
      email: dev@example.com
  channels:
    - name: general
      topic: General discussion
    - name: random
      topic: Random stuff
  bots:
    - name: my-bot
  oauth_apps:
    - client_id: "12345.67890"
      client_secret: example_client_secret
      name: My Slack App
      redirect_uris:
        - http://localhost:3000/api/auth/callback/slack

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

aws:
  region: us-east-1
  s3:
    buckets:
      - name: my-app-bucket
      - name: my-app-uploads
  sqs:
    queues:
      - name: my-app-events
      - name: my-app-dlq
  secretsmanager:
    secrets:
      - name: my-app/database-url
        secret_string: postgres://localhost:5432/app
        tags:
          env: local
  ssm:
    parameters:
      - name: /my-app/database-url
        type: SecureString
        value: postgres://localhost:5432/app
        key_id: alias/my-app
        tags:
          env: local
  kms:
    keys:
      - description: My app KMS key
        aliases:
          - alias/my-app
  lambda:
    functions:
      - function_name: my-app-handler
        runtime: nodejs22.x
        role: arn:aws:iam::123456789012:role/lambda-execution-role
        handler: index.handler
        invoke_payload: '{"ok":true}'
        # Optional base64 Lambda zip for local Node.js handler execution.
        code_zip_base64: ""
        environment:
          NODE_ENV: local
  iam:
    users:
      - user_name: developer
        create_access_key: true
    roles:
      - role_name: lambda-execution-role
        description: Role for Lambda function execution
        max_session_duration: 7200
```

## OAuth & Integrations

The emulator supports configurable OAuth apps and integrations with strict client validation.

### Vercel Integrations

```yaml
vercel:
  integrations:
    - client_id: "oac_abc123"
      client_secret: "secret_abc123"
      name: "My Vercel App"
      redirect_uris:
        - "http://localhost:3000/api/auth/callback/vercel"
```

### GitHub OAuth Apps

```yaml
github:
  oauth_apps:
    - client_id: "Iv1.abc123"
      client_secret: "secret_abc123"
      name: "My Web App"
      redirect_uris:
        - "http://localhost:3000/api/auth/callback/github"
```

If no `oauth_apps` are configured, the emulator accepts any `client_id` (backward-compatible). With apps configured, strict validation is enforced.

### GitHub Apps

Full GitHub App support with JWT authentication and installation access tokens:

```yaml
github:
  apps:
    - app_id: 12345
      slug: "my-github-app"
      name: "My GitHub App"
      private_key: |
        -----BEGIN RSA PRIVATE KEY-----
        ...your PEM key...
        -----END RSA PRIVATE KEY-----
      permissions:
        contents: read
        issues: write
      events: [push, pull_request]
      webhook_url: "http://localhost:3000/webhooks/github"
      webhook_secret: "my-secret"
      installations:
        - installation_id: 100
          account: my-org
          repository_selection: all
```

JWT authentication: sign a JWT with `{ iss: "<app_id>" }` using the app's private key (RS256). The emulator verifies the signature and resolves the app.

**App webhook delivery**: When events occur on repos where a GitHub App is installed, the emulator mirrors real GitHub behavior:
- All webhook payloads (including repo and org hooks) include an `installation` field with `{ id, node_id }`.
- If the app has a `webhook_url`, the emulator delivers the event there with the `installation` field and (if configured) an `X-Hub-Signature-256` header signed with `webhook_secret`.

### Slack OAuth Apps

```yaml
slack:
  oauth_apps:
    - client_id: "12345.67890"
      client_secret: "example_client_secret"
      name: "My Slack App"
      redirect_uris:
        - "http://localhost:3000/api/auth/callback/slack"
```

### Apple OAuth Clients

```yaml
apple:
  oauth_clients:
    - client_id: "com.example.app"
      team_id: "TEAM001"
      name: "My Apple App"
      redirect_uris:
        - "http://localhost:3000/api/auth/callback/apple"
```

### Microsoft OAuth Clients

```yaml
microsoft:
  oauth_clients:
    - client_id: "example-client-id"
      client_secret: "example-client-secret"
      name: "My Microsoft App"
      redirect_uris:
        - "http://localhost:3000/api/auth/callback/microsoft-entra-id"
```

## Vercel API

Every endpoint below is fully stateful with Vercel-style JSON responses and cursor-based pagination. The native Go runtime implements this same Vercel REST surface for local CLI runs and Vercel Go Function previews.

### User & Teams
- `GET /v2/user` - authenticated user
- `PATCH /v2/user` - update user
- `GET /v2/teams` - list teams (cursor paginated)
- `GET /v2/teams/:teamId` - get team (by ID or slug)
- `POST /v2/teams` - create team
- `PATCH /v2/teams/:teamId` - update team
- `GET /v2/teams/:teamId/members` - list members
- `POST /v2/teams/:teamId/members` - add member

### Projects
- `POST /v11/projects` - create project (with optional env vars and git integration)
- `GET /v10/projects` - list projects (search, cursor pagination)
- `GET /v9/projects/:idOrName` - get project (includes env vars)
- `PATCH /v9/projects/:idOrName` - update project
- `DELETE /v9/projects/:idOrName` - delete project (cascades)
- `GET /v1/projects/:projectId/promote/aliases` - promote aliases status
- `PATCH /v1/projects/:idOrName/protection-bypass` - manage bypass secrets

### Deployments
- `POST /v13/deployments` - create deployment (auto-transitions to READY)
- `GET /v13/deployments/:idOrUrl` - get deployment (by ID or URL)
- `GET /v6/deployments` - list deployments (filter by project, target, state)
- `DELETE /v13/deployments/:id` - delete deployment (cascades)
- `PATCH /v12/deployments/:id/cancel` - cancel building deployment
- `GET /v2/deployments/:id/aliases` - list deployment aliases
- `GET /v3/deployments/:idOrUrl/events` - get build events/logs
- `GET /v6/deployments/:id/files` - list deployment files
- `POST /v2/files` - upload file (by SHA digest)

### Domains
- `POST /v10/projects/:idOrName/domains` - add domain (with verification challenge)
- `GET /v9/projects/:idOrName/domains` - list domains
- `GET /v9/projects/:idOrName/domains/:domain` - get domain
- `PATCH /v9/projects/:idOrName/domains/:domain` - update domain
- `DELETE /v9/projects/:idOrName/domains/:domain` - remove domain
- `POST /v9/projects/:idOrName/domains/:domain/verify` - verify domain

### Environment Variables
- `GET /v10/projects/:idOrName/env` - list env vars (with decrypt option)
- `POST /v10/projects/:idOrName/env` - create env vars (single, batch, upsert)
- `GET /v10/projects/:idOrName/env/:id` - get env var
- `PATCH /v9/projects/:idOrName/env/:id` - update env var
- `DELETE /v9/projects/:idOrName/env/:id` - delete env var

## GitHub API

Every endpoint below is fully stateful. Creates, updates, and deletes persist in memory and affect related entities.

The native Go runtime implements the GitHub service engine for local CLI runs, the programmatic API, and Vercel Go Function previews: users, orgs, seeded repositories, repository CRUD, topics, languages, branches, refs, issues, issue comments, pull requests, OAuth authorize/token flows, rate limit, and metadata. The `@emulators/github` package remains importable as npm metadata, but it no longer contains a Node.js service implementation.

### Users
- `GET /user` - authenticated user
- `PATCH /user` - update profile
- `GET /users/:username` - get user
- `GET /users` - list users
- `GET /users/:username/repos` - list user repos
- `GET /users/:username/orgs` - list user orgs
- `GET /users/:username/followers` - list followers
- `GET /users/:username/following` - list following

### Repositories
- `GET /repos/:owner/:repo` - get repo
- `POST /user/repos` - create user repo
- `POST /orgs/:org/repos` - create org repo
- `PATCH /repos/:owner/:repo` - update repo
- `DELETE /repos/:owner/:repo` - delete repo (cascades)
- `GET/PUT /repos/:owner/:repo/topics` - get/replace topics
- `GET /repos/:owner/:repo/languages` - languages
- `GET /repos/:owner/:repo/contributors` - contributors
- `GET /repos/:owner/:repo/forks` - list forks
- `POST /repos/:owner/:repo/forks` - create fork
- `GET/PUT/DELETE /repos/:owner/:repo/collaborators/:username` - collaborators
- `GET /repos/:owner/:repo/collaborators/:username/permission`
- `POST /repos/:owner/:repo/transfer` - transfer repo
- `GET /repos/:owner/:repo/tags` - list tags

### Issues
- `GET /repos/:owner/:repo/issues` - list (filter by state, labels, assignee, milestone, creator, since)
- `POST /repos/:owner/:repo/issues` - create
- `GET /repos/:owner/:repo/issues/:number` - get
- `PATCH /repos/:owner/:repo/issues/:number` - update (state transitions, events)
- `PUT/DELETE /repos/:owner/:repo/issues/:number/lock` - lock/unlock
- `GET /repos/:owner/:repo/issues/:number/timeline` - timeline events
- `GET /repos/:owner/:repo/issues/:number/events` - events
- `POST/DELETE /repos/:owner/:repo/issues/:number/assignees` - manage assignees

### Pull Requests
- `GET /repos/:owner/:repo/pulls` - list (filter by state, head, base)
- `POST /repos/:owner/:repo/pulls` - create
- `GET /repos/:owner/:repo/pulls/:number` - get
- `PATCH /repos/:owner/:repo/pulls/:number` - update
- `PUT /repos/:owner/:repo/pulls/:number/merge` - merge (with branch protection enforcement)
- `GET /repos/:owner/:repo/pulls/:number/commits` - list commits
- `GET /repos/:owner/:repo/pulls/:number/files` - list files
- `POST/DELETE /repos/:owner/:repo/pulls/:number/requested_reviewers` - manage reviewers
- `PUT /repos/:owner/:repo/pulls/:number/update-branch` - update branch

### Comments
- Issue comments: full CRUD on `/repos/:owner/:repo/issues/:number/comments`
- Review comments: full CRUD on `/repos/:owner/:repo/pulls/:number/comments`
- Commit comments: full CRUD on `/repos/:owner/:repo/commits/:sha/comments`
- Repo-wide listings for each type

### Reviews
- `GET /repos/:owner/:repo/pulls/:number/reviews` - list
- `POST /repos/:owner/:repo/pulls/:number/reviews` - create (with inline comments)
- `GET/PUT /repos/:owner/:repo/pulls/:number/reviews/:id` - get/update
- `POST /repos/:owner/:repo/pulls/:number/reviews/:id/events` - submit
- `PUT /repos/:owner/:repo/pulls/:number/reviews/:id/dismissals` - dismiss

### Labels & Milestones
- Labels: full CRUD, add/remove from issues, replace all
- Milestones: full CRUD, state transitions, issue counts

### Branches & Git Data
- Branches: list, get, protection CRUD (status checks, PR reviews, enforce admins)
- Refs: get, match, create, update, delete
- Commits: get, create
- Trees: get (with recursive), create (with inline content)
- Blobs: get, create
- Tags: get, create

### Organizations & Teams
- Orgs: get, update, list
- Org members: list, check, remove, get/set membership
- Teams: full CRUD, members, repos

### Releases
- Releases: full CRUD, latest, by tag
- Release assets: full CRUD, upload
- Generate release notes

### Webhooks
- Repo webhooks: full CRUD, ping, test, deliveries
- Org webhooks: full CRUD, ping
- Real HTTP delivery to registered URLs on all state changes

### Search
- `GET /search/repositories` - full query syntax (user, org, language, topic, stars, forks, etc.)
- `GET /search/issues` - issues + PRs (repo, is, author, label, milestone, state, etc.)
- `GET /search/users` - users + orgs
- `GET /search/code` - blob content search
- `GET /search/commits` - commit message search
- `GET /search/topics` - topic search
- `GET /search/labels` - label search

### Actions
- Workflows: list, get, enable/disable, dispatch
- Workflow runs: list, get, cancel, rerun, delete, logs
- Jobs: list, get, logs
- Artifacts: list, get, delete
- Secrets: repo + org CRUD

### Checks
- Check runs: create, update, get, annotations, rerequest, list by ref/suite
- Check suites: create, get, preferences, rerequest, list by ref
- Automatic suite status rollup from check run results

### Misc
- `GET /rate_limit` - rate limit status
- `GET /meta` - server metadata
- `GET /octocat` - ASCII art
- `GET /emojis` - emoji URLs
- `GET /zen` - random zen phrase
- `GET /versions` - API versions

## Google OAuth + Gmail, Calendar, and Drive APIs

OAuth 2.0, OpenID Connect, and mutable Google Workspace-style surfaces for local inbox, calendar, and drive flows.

The native Go runtime implements the OAuth/OIDC flow with RS256 ID tokens and JWKS, plus Gmail messages, drafts, threads, labels, history, settings filters, Calendar list/events/freebusy, and Drive file list/upload/download routes for local CLI runs and Vercel Go Function previews. To expose Google on a Vercel preview without separate infrastructure, run `npx emulate vercel init --service google`. The generated route serves Google at `/emulate/google/*`.

When more than one of Apple, Google, Microsoft, Okta, and Clerk is enabled on one native Go server, use the service specific discovery paths, for example `/google/.well-known/openid-configuration` or `/okta/.well-known/openid-configuration`, because those providers all use the root OIDC discovery path when run alone.

- `GET /o/oauth2/v2/auth` - authorization endpoint
- `POST /oauth2/token` - token exchange
- `GET /oauth2/v2/userinfo` - get user info
- `GET /.well-known/openid-configuration` - OIDC discovery document
- `GET /oauth2/v3/certs` - JSON Web Key Set (JWKS)
- `GET /gmail/v1/users/:userId/messages` - list messages with `q`, `labelIds`, `maxResults`, and `pageToken`
- `GET /gmail/v1/users/:userId/messages/:id` - fetch a Gmail-style message payload in `full`, `metadata`, `minimal`, or `raw` formats
- `GET /gmail/v1/users/:userId/messages/:messageId/attachments/:id` - fetch attachment bodies
- `POST /gmail/v1/users/:userId/messages/send` - create sent mail from `raw` MIME or structured fields
- `POST /gmail/v1/users/:userId/messages/import` - import inbox mail
- `POST /gmail/v1/users/:userId/messages` - insert a message directly
- `POST /gmail/v1/users/:userId/messages/:id/modify` - add/remove labels on one message
- `POST /gmail/v1/users/:userId/messages/batchModify` - add/remove labels across many messages
- `POST /gmail/v1/users/:userId/messages/:id/trash` and `POST /gmail/v1/users/:userId/messages/:id/untrash`
- `GET /gmail/v1/users/:userId/drafts`, `POST /gmail/v1/users/:userId/drafts`, `GET /gmail/v1/users/:userId/drafts/:id`, `PUT /gmail/v1/users/:userId/drafts/:id`, `POST /gmail/v1/users/:userId/drafts/:id/send`, `DELETE /gmail/v1/users/:userId/drafts/:id`
- `POST /gmail/v1/users/:userId/threads/:id/modify` - add/remove labels across a thread
- `GET /gmail/v1/users/:userId/threads` and `GET /gmail/v1/users/:userId/threads/:id`
- `GET /gmail/v1/users/:userId/labels`, `POST /gmail/v1/users/:userId/labels`, `PATCH /gmail/v1/users/:userId/labels/:id`, `DELETE /gmail/v1/users/:userId/labels/:id`
- `GET /gmail/v1/users/:userId/history`, `POST /gmail/v1/users/:userId/watch`, `POST /gmail/v1/users/:userId/stop`
- `GET /gmail/v1/users/:userId/settings/filters`, `POST /gmail/v1/users/:userId/settings/filters`, `DELETE /gmail/v1/users/:userId/settings/filters/:id`
- `GET /gmail/v1/users/:userId/settings/forwardingAddresses`, `GET /gmail/v1/users/:userId/settings/sendAs`
- `GET /calendar/v3/users/:userId/calendarList`, `GET /calendar/v3/calendars/:calendarId/events`, `POST /calendar/v3/calendars/:calendarId/events`, `DELETE /calendar/v3/calendars/:calendarId/events/:eventId`, `POST /calendar/v3/freeBusy`
- `GET /drive/v3/files`, `GET /drive/v3/files/:fileId`, `POST /drive/v3/files`, `PATCH /drive/v3/files/:fileId`, `PUT /drive/v3/files/:fileId`, `POST /upload/drive/v3/files`

## Slack API

Fully stateful Slack Web API emulation with channels, messages, threads, reactions, OAuth v2, and incoming webhooks.

The native Go runtime implements the Slack Web API, OAuth v2, incoming webhook, seed config, and message inspector foundation for local CLI runs and Vercel Go Function previews. In native CLI runs with multiple services enabled, open `/slack` for the message inspector. When only Slack is enabled, and in Vercel Go Function previews, the inspector is available at the service root. To expose Slack on a Vercel preview without separate infrastructure, run `npx emulate vercel init --service slack`. The generated route serves Slack at `/emulate/slack/*`.

### Auth & Chat
- `POST /api/auth.test` - test authentication
- `POST /api/chat.postMessage` - post message (supports threads via `thread_ts`)
- `POST /api/chat.update` - update message
- `POST /api/chat.delete` - delete message
- `POST /api/chat.meMessage` - /me message

### Conversations
- `POST /api/conversations.list` - list channels (cursor pagination)
- `POST /api/conversations.info` - get channel info
- `POST /api/conversations.create` - create channel
- `POST /api/conversations.history` - channel history
- `POST /api/conversations.replies` - thread replies
- `POST /api/conversations.join` / `conversations.leave` - join/leave
- `POST /api/conversations.members` - list members

### Users & Reactions
- `POST /api/users.list` - list users (cursor pagination)
- `POST /api/users.info` - get user info
- `POST /api/users.lookupByEmail` - lookup by email
- `POST /api/reactions.add` / `reactions.remove` / `reactions.get` - manage reactions

### Team, Bots & Webhooks
- `POST /api/team.info` - workspace info
- `POST /api/bots.info` - bot info
- `POST /services/:teamId/:botId/:webhookId` - incoming webhook

### OAuth
- `GET /oauth/v2/authorize` - authorization (shows user picker)
- `POST /api/oauth.v2.access` - token exchange

## Apple Sign In

Sign in with Apple emulation with authorization code flow, PKCE support, RS256 ID tokens, and OIDC discovery.

The native Go runtime implements the Apple OIDC flow below for local CLI runs and Vercel Go Function previews. To expose Apple on a Vercel preview without separate infrastructure, run `npx emulate vercel init --service apple`. The generated route serves Apple at `/emulate/apple/*`.

PKCE is supported with `code_challenge` and `code_challenge_method` on authorization, then `code_verifier` on token exchange.

Private email users receive the generated relay email in both the `id_token` and first authorization `user` JSON.

- `GET /.well-known/openid-configuration` - OIDC discovery document
- `GET /auth/keys` - JSON Web Key Set (JWKS)
- `GET /auth/authorize` - authorization endpoint (shows user picker)
- `POST /auth/token` - token exchange (authorization code and refresh token grants)
- `POST /auth/revoke` - token revocation

## Microsoft Entra ID

Microsoft Entra ID (Azure AD) v2.0 OAuth 2.0 and OpenID Connect emulation with authorization code flow, PKCE, client credentials, RS256 ID tokens, and OIDC discovery.

The native Go runtime implements the Microsoft OIDC, token, and Graph profile routes below for local CLI runs and Vercel Go Function previews. To expose Microsoft on a Vercel preview without separate infrastructure, run `npx emulate vercel init --service microsoft`. The generated route serves Microsoft at `/emulate/microsoft/*`.

- `GET /.well-known/openid-configuration` - OIDC discovery document
- `GET /:tenant/v2.0/.well-known/openid-configuration` - tenant-scoped OIDC discovery
- `GET /discovery/v2.0/keys` - JSON Web Key Set (JWKS)
- `GET /oauth2/v2.0/authorize` - authorization endpoint (shows user picker)
- `POST /oauth2/v2.0/token` - token exchange (authorization code, refresh token, client credentials)
- `POST /:tenant/oauth2/token` - v1 token endpoint with `resource` to `.default` scope translation
- `GET /oidc/userinfo` - OpenID Connect user info
- `GET /v1.0/me` - Microsoft Graph user profile
- `GET /v1.0/users/:id` - Microsoft Graph user by ID
- `GET /oauth2/v2.0/logout` - end session / logout
- `POST /oauth2/v2.0/revoke` - token revocation

## Okta

Okta OAuth 2.0, OpenID Connect, users, groups, apps, and authorization server emulation with authorization code, refresh token, client credentials, PKCE, RS256 ID tokens, JWKS, userinfo, introspection, revocation, and management APIs.

The native Go runtime implements the Okta OIDC and management API routes below for local CLI runs and Vercel Go Function previews. To expose Okta on a Vercel preview without separate infrastructure, run `npx emulate vercel init --service okta`. The generated route serves Okta at `/emulate/okta/*`.

- `GET /.well-known/openid-configuration` - org OIDC discovery document
- `GET /oauth2/:authServerId/.well-known/openid-configuration` - custom authorization server discovery
- `GET /oauth2/v1/keys`, `GET /oauth2/:authServerId/v1/keys` - JSON Web Key Set (JWKS)
- `GET /oauth2/v1/authorize`, `GET /oauth2/:authServerId/v1/authorize` - authorization endpoint (shows user picker)
- `POST /oauth2/v1/token`, `POST /oauth2/:authServerId/v1/token` - token exchange
- `GET /oauth2/v1/userinfo`, `GET /oauth2/:authServerId/v1/userinfo` - OpenID Connect user info
- `POST /oauth2/v1/revoke`, `POST /oauth2/:authServerId/v1/revoke` - token revocation
- `POST /oauth2/v1/introspect`, `POST /oauth2/:authServerId/v1/introspect` - token introspection
- `GET /oauth2/v1/logout`, `GET /oauth2/:authServerId/v1/logout` - end session
- `GET`, `POST`, `PUT`, `DELETE` under `/api/v1/users`, `/api/v1/groups`, `/api/v1/apps`, and `/api/v1/authorizationServers`

## Clerk

Clerk authentication and user management emulation with OAuth 2.0 / OIDC, RS256 ID tokens, JWKS, users, email addresses, organizations, memberships, invitations, and sessions.

The native Go runtime implements the Clerk OIDC and management API routes below for local CLI runs and Vercel Go Function previews. To expose Clerk on a Vercel preview without separate infrastructure, run `npx emulate vercel init --service clerk`. The generated route serves Clerk at `/emulate/clerk/*`.

- `GET /.well-known/openid-configuration` - OIDC discovery document
- `GET /v1/jwks` - JSON Web Key Set (JWKS)
- `GET /oauth/authorize` - authorization endpoint (shows user picker)
- `POST /oauth/token` - token exchange
- `GET /oauth/userinfo` - OpenID Connect user info
- `GET`, `POST`, `PATCH`, `DELETE` under `/v1/users`, `/v1/email_addresses`, `/v1/organizations`, `/v1/organizations/:orgId/memberships`, `/v1/organizations/:orgId/invitations`, and `/v1/sessions`

## AWS

S3, SQS, SNS, EventBridge, API Gateway v2, DynamoDB, CloudWatch Logs, Secrets Manager, SSM Parameter Store, KMS, Lambda, IAM, and STS emulation with AWS SDK-compatible S3 paths, AWS JSON RPC endpoints for SQS, EventBridge, DynamoDB, CloudWatch Logs, Secrets Manager, SSM, and KMS, REST JSON endpoints for API Gateway v2 and Lambda, and AWS Query endpoints for SNS/SQS/IAM/STS. Query and REST XML operations return AWS-compatible XML. The native Go runtime is verified against current AWS SDK v3 clients for SQS, SNS, EventBridge, API Gateway v2, DynamoDB, CloudWatch Logs, Secrets Manager, SSM, KMS, Lambda, IAM, and STS; SQS, EventBridge, DynamoDB, CloudWatch Logs, Secrets Manager, SSM, and KMS use JSON target requests, API Gateway v2 and Lambda use REST JSON, and SNS/IAM/STS use AWS Query XML.

To expose the native AWS emulator in a Vercel preview without separate infrastructure, run `npx emulate vercel init --service aws`. The generated route serves AWS at `/emulate/aws/*`.

### S3

S3 routes use root paths matching the real AWS S3 wire format, so the official AWS SDK works out of the box with `forcePathStyle: true`. Legacy `/s3/` prefixed paths are also supported for backward compatibility.

- `GET /` - list all buckets
- `PUT /:bucket` - create bucket
- `DELETE /:bucket` - delete bucket
- `HEAD /:bucket` - check existence
- `GET /:bucket?location` - get bucket region
- `GET /:bucket` - list objects (prefix, delimiter, max-keys, continuation-token, start-after)
- `POST /:bucket` - presigned POST upload (browser-style multipart form with policy validation)
- `PUT /:bucket/:key` - put object (supports copy via `x-amz-copy-source`)
- `GET /:bucket/:key` - get object (supports `Range`, `If-Match`, `If-None-Match`, `If-Modified-Since`, and `If-Unmodified-Since`)
- `HEAD /:bucket/:key` - head object (supports range and conditional metadata headers)
- `DELETE /:bucket/:key` - delete object

### SQS
Manual SQS requests can use `POST /sqs/` with an `Action` form parameter. In the native Go runtime, `@aws-sdk/client-sqs` v3 can use the `/sqs/` endpoint directly; the SDK sends `X-Amz-Target: AmazonSQS.<Action>` JSON requests and receives JSON responses.

- `CreateQueue`, `ListQueues`, `GetQueueUrl`, `GetQueueAttributes`, `SetQueueAttributes`
- `SendMessage`, `SendMessageBatch`, `ReceiveMessage`, `DeleteMessage`, `DeleteMessageBatch`
- `ChangeMessageVisibility`, `ChangeMessageVisibilityBatch`
- `TagQueue`, `UntagQueue`, `ListQueueTags`
- `PurgeQueue`, `DeleteQueue`

### SNS
In the native Go runtime, `@aws-sdk/client-sns` v3 can use the `/sns/` endpoint directly. SNS uses AWS Query XML and can deliver published notifications to SQS subscriptions.

- `CreateTopic`, `DeleteTopic`, `ListTopics`, `GetTopicAttributes`, `SetTopicAttributes`
- `Subscribe`, `Unsubscribe`, `ListSubscriptions`, `ListSubscriptionsByTopic`, `ConfirmSubscription`
- `Publish` with SQS subscription delivery
- `TagResource`, `UntagResource`, `ListTagsForResource`
- `AddPermission`, `RemovePermission`

### EventBridge
In the native Go runtime, `@aws-sdk/client-eventbridge` v3 can use the `/events/` endpoint directly. The SDK sends `X-Amz-Target: AWSEvents.<Action>` JSON requests and receives JSON responses. Matching events can be delivered to SQS queues, SNS topics, and Lambda functions. Lambda targets create CloudWatch Logs entries; zipped Node.js handlers run only when `npx emulate` is started with `--allow-local-lambda` and the EventBridge request uses a direct localhost endpoint signed by a known AWS access key.

- `CreateEventBus`, `DeleteEventBus`, `ListEventBuses`
- `PutRule`, `DescribeRule`, `ListRules`, `DeleteRule`, `EnableRule`, `DisableRule`
- `PutTargets`, `ListTargetsByRule`, `RemoveTargets` for SQS, SNS, and Lambda targets
- `PutEvents` with rule pattern matching and target delivery
- `TagResource`, `UntagResource`, `ListTagsForResource`

### API Gateway v2
In the native Go runtime, `@aws-sdk/client-apigatewayv2` v3 can use the `/apigatewayv2/` endpoint directly. The SDK sends REST JSON requests under `/v2/apis` and receives JSON responses. `CreateApi` returns an `ApiEndpoint` such as `http://localhost:4000/_aws/apigatewayv2/<api-id>` for local HTTP API route invokes backed by Lambda proxy integrations using payload format version `2.0`. Local Node.js Lambda handlers run only when `npx emulate` is started with `--allow-local-lambda` and the route invoke uses a direct localhost endpoint signed by a known AWS access key; otherwise the Lambda deterministic stub payload path is used.

- `CreateApi`, `GetApi`, `GetApis`, `DeleteApi` for HTTP API metadata
- `CreateIntegration`, `GetIntegration`, `GetIntegrations`, `DeleteIntegration` for `AWS_PROXY` Lambda integrations with payload format version `2.0`
- `CreateRoute`, `GetRoute`, `GetRoutes`, `DeleteRoute` for exact HTTP routes, path parameter routes, `ANY` routes, greedy proxy routes, and `$default`
- `CreateStage`, `GetStage`, `GetStages`, `DeleteStage` for local stages, including `$default`
- `GET`, `POST`, `PUT`, `PATCH`, `DELETE` under `/_aws/apigatewayv2/<api-id>/...` for local Lambda proxy route invokes

### DynamoDB
In the native Go runtime, `@aws-sdk/client-dynamodb` v3 can use the `/dynamodb/` endpoint directly. The SDK sends `X-Amz-Target: DynamoDB_20120810.<Action>` JSON requests and receives JSON responses.

- `CreateTable`, `DescribeTable`, `ListTables`, `UpdateTable`, `DeleteTable`
- `PutItem`, `GetItem`, `DeleteItem`, `Scan`, `Query`
- `BatchGetItem`, `BatchWriteItem`
- `TagResource`, `UntagResource`, `ListTagsOfResource`

### CloudWatch Logs
In the native Go runtime, `@aws-sdk/client-cloudwatch-logs` v3 can use the `/logs/` endpoint directly. The SDK sends `X-Amz-Target: Logs_20140328.<Action>` JSON requests and receives JSON responses.

- `CreateLogGroup`, `DeleteLogGroup`, `DescribeLogGroups`
- `CreateLogStream`, `DeleteLogStream`, `DescribeLogStreams`
- `PutLogEvents`, `GetLogEvents`, `FilterLogEvents`
- `PutRetentionPolicy`, `DeleteRetentionPolicy`
- `TagResource`, `UntagResource`, `ListTagsForResource`

### Secrets Manager
In the native Go runtime, `@aws-sdk/client-secrets-manager` v3 can use the `/secretsmanager/` endpoint directly. The SDK sends `X-Amz-Target: secretsmanager.<Action>` JSON requests and receives JSON responses.

- `CreateSecret`, `GetSecretValue`, `PutSecretValue`, `UpdateSecret`
- `DeleteSecret`, `RestoreSecret`, `ListSecrets`, `DescribeSecret`
- `TagResource`, `UntagResource`, `ListSecretVersionIds`
- String and binary secret values, version ids, staging labels, deletion recovery metadata, and KMS key id metadata

### SSM Parameter Store
In the native Go runtime, `@aws-sdk/client-ssm` v3 can use the `/ssm/` endpoint directly. The SDK sends `X-Amz-Target: AmazonSSM.<Action>` JSON requests and receives JSON responses.

- `PutParameter`, `GetParameter`, `GetParameters`, `GetParametersByPath`
- `DeleteParameter`, `DeleteParameters`, `DescribeParameters`
- `AddTagsToResource`, `RemoveTagsFromResource`, `ListTagsForResource`
- `String`, `StringList`, and `SecureString` values with local plaintext storage, version history, hierarchical paths, and KMS key id metadata

### KMS
In the native Go runtime, `@aws-sdk/client-kms` v3 can use the `/kms/` endpoint directly. The SDK sends `X-Amz-Target: TrentService.<Action>` JSON requests and receives JSON responses.

- `CreateKey`, `DescribeKey`, `ListKeys`
- `CreateAlias`, `ListAliases`
- `Encrypt`, `Decrypt`, `GenerateDataKey`
- `GenerateDataKey` accepts `NumberOfBytes` from 1 to 1024.
- Key and alias metadata plus reversible local ciphertext blobs for tests. This is not real cryptography.
- S3 `PutObject` and `HeadObject` preserve SSE-KMS metadata headers for local reference tests.

### Lambda

In the native Go runtime, `@aws-sdk/client-lambda` v3 can use the AWS emulator root endpoint directly. Lambda uses AWS REST JSON paths such as `/2015-03-31/functions` and returns JSON responses. The control plane works without Docker. Valid inline `ZipFile` packages for `nodejs*` runtimes run locally with the installed `node` executable when `npx emulate` is started with `--allow-local-lambda` and the invoke request uses a direct localhost endpoint (`localhost`, `127.0.0.1`, or `::1`) signed by a known AWS access key. Custom proxy, tunnel, and portless hosts keep the deterministic stub response path.

- `CreateFunction` / `GetFunction` / `GetFunctionConfiguration` / `ListFunctions` / `DeleteFunction` - function lifecycle and discovery
- `UpdateFunctionConfiguration` / `UpdateFunctionCode` - local metadata, code-hash updates, and inline zip storage for local invocation
- `Invoke` - runs valid zipped Node.js handlers for request-response invokes when local Lambda execution is enabled. Seeded `invoke_payload` is returned when no local runner applies, otherwise `{}` is returned. `InvocationType: Event` and `DryRun` return accepted/no-content responses.
- `PublishVersion` / `ListVersionsByFunction` - local version metadata, including stored inline code for published versions
- `CreateAlias` / `GetAlias` / `ListAliases` / `UpdateAlias` / `DeleteAlias` - alias metadata
- `TagResource` / `UntagResource` / `ListTags` - function tags
- `AddPermission` / `GetPolicy` / `RemovePermission` - stored resource policy statements
- Creating or invoking a function creates local CloudWatch Logs metadata under `/aws/lambda/<function-name>`. Local Node.js handler console output is written to those logs and returned through `LogType: Tail`.
- Seed functions with `lambda.functions[].invoke_payload` for deterministic stubs or `lambda.functions[].code_zip_base64` for a base64 Lambda zip used by the local Node.js runner.

### IAM
Manual IAM requests can use `POST /iam/` with an `Action` form parameter. In the native Go runtime, `@aws-sdk/client-iam` v3 can use the `/iam/` endpoint directly.

- `CreateUser`, `GetUser`, `ListUsers`, `DeleteUser`
- `CreateAccessKey`, `ListAccessKeys`, `DeleteAccessKey`
- `CreateRole`, `GetRole`, `ListRoles`, `DeleteRole`
- `PutUserPolicy`, `GetUserPolicy`, `ListUserPolicies`, `DeleteUserPolicy`
- `PutRolePolicy`, `GetRolePolicy`, `ListRolePolicies`, `DeleteRolePolicy`
- `CreatePolicy`, `GetPolicy`, `GetPolicyVersion`, `ListPolicies`, `DeletePolicy`
- `AttachUserPolicy`, `DetachUserPolicy`, `ListAttachedUserPolicies` for local managed policies and AWS managed policy ARNs
- `AttachRolePolicy`, `DetachRolePolicy`, `ListAttachedRolePolicies` for local managed policies and AWS managed policy ARNs
- Delete users and roles after deleting inline policies and detaching managed policies.

### STS
Manual STS requests can use `POST /sts/` with an `Action` form parameter. In the native Go runtime, `@aws-sdk/client-sts` v3 can use the `/sts/` endpoint directly.

- `GetCallerIdentity`, `AssumeRole` with duration and session tag metadata. `DurationSeconds` must be from 900 seconds up to the role `MaxSessionDuration`; roles default to 3600 seconds and role chaining is capped at 3600 seconds.

## Resend

Resend email API emulation with local capture for sent emails, domains, API keys, audiences, contacts, and an inbox UI. Set `RESEND_BASE_URL` before importing the official Resend Node.js SDK and the SDK will send to the emulator.

The native Go runtime serves the same current Resend routes, supports YAML and JSON seed configs for Resend through `--seed`, and is verified against the official `resend` SDK for emails, batch email sends, domains, API keys, and legacy audience contacts.

To expose the native Resend emulator in a Vercel preview without separate infrastructure, run `npx emulate vercel init --service resend`. The generated route serves Resend at `/emulate/resend/*`.

- `POST /emails`, `POST /emails/batch`, `GET /emails`, `GET /emails/:id`, `POST /emails/:id/cancel`
- `POST /domains`, `GET /domains`, `GET /domains/:id`, `DELETE /domains/:id`, `POST /domains/:id/verify`
- `POST /api-keys`, `GET /api-keys`, `DELETE /api-keys/:id`
- `POST /audiences`, `GET /audiences`, `DELETE /audiences/:id`
- `POST /audiences/:audience_id/contacts`, `GET /audiences/:audience_id/contacts`, `DELETE /audiences/:audience_id/contacts/:id`
- `GET /inbox`, `GET /inbox/:id`

## Stripe

Stripe API emulation with customers, products, prices, checkout sessions, payment intents, charges, payment methods, customer sessions, and a hosted checkout page.

The native Go runtime implements the current high-value Stripe API and checkout routes for local CLI runs, the programmatic API, and Vercel Go Function previews. Native Stripe stores payment state and serves checkout pages. To expose Stripe on a Vercel preview without separate infrastructure, run `npx emulate vercel init --service stripe`. The generated route serves Stripe at `/emulate/stripe/*`.

- `POST /v1/customers`, `GET /v1/customers`, `GET /v1/customers/:id`, `POST /v1/customers/:id`, `DELETE /v1/customers/:id`
- `GET /v1/payment_methods`, `POST /v1/customer_sessions`
- `POST /v1/payment_intents`, `GET /v1/payment_intents`, `GET /v1/payment_intents/:id`, `POST /v1/payment_intents/:id`, `POST /v1/payment_intents/:id/confirm`, `POST /v1/payment_intents/:id/cancel`
- `GET /v1/charges`, `GET /v1/charges/:id`
- `POST /v1/products`, `GET /v1/products`, `GET /v1/products/:id`
- `POST /v1/prices`, `GET /v1/prices`, `GET /v1/prices/:id`
- `POST /v1/checkout/sessions`, `GET /v1/checkout/sessions`, `GET /v1/checkout/sessions/:id`, `POST /v1/checkout/sessions/:id/expire`
- `GET /checkout/:id`, `POST /checkout/:id/complete`

## MongoDB Atlas

MongoDB Atlas emulation with Atlas Admin API v2 and Atlas Data API v1. The native Go runtime stores projects, clusters, database users, databases, collections, and documents in memory for local CLI runs and Vercel Go Function previews. To expose MongoDB Atlas on a Vercel preview without separate infrastructure, run `npx emulate vercel init --service mongoatlas`. The generated route serves MongoDB Atlas at `/emulate/mongoatlas/*`.

- `GET /api/atlas/v2/groups`, `GET /api/atlas/v2/groups/:groupId`, `POST /api/atlas/v2/groups`, `DELETE /api/atlas/v2/groups/:groupId`
- `GET /api/atlas/v2/groups/:groupId/clusters`, `GET /api/atlas/v2/groups/:groupId/clusters/:clusterName`, `POST /api/atlas/v2/groups/:groupId/clusters`, `PATCH /api/atlas/v2/groups/:groupId/clusters/:clusterName`, `DELETE /api/atlas/v2/groups/:groupId/clusters/:clusterName`
- `GET /api/atlas/v2/groups/:groupId/databaseUsers`, `GET /api/atlas/v2/groups/:groupId/databaseUsers/admin/:username`, `POST /api/atlas/v2/groups/:groupId/databaseUsers`, `DELETE /api/atlas/v2/groups/:groupId/databaseUsers/admin/:username`
- `GET /api/atlas/v2/groups/:groupId/clusters/:clusterName/databases`, `GET /api/atlas/v2/groups/:groupId/clusters/:clusterName/databases/:databaseName/collections`
- `POST /app/data-api/v1/action/findOne`, `POST /app/data-api/v1/action/find`, `POST /app/data-api/v1/action/insertOne`, `POST /app/data-api/v1/action/insertMany`
- `POST /app/data-api/v1/action/updateOne`, `POST /app/data-api/v1/action/updateMany`, `POST /app/data-api/v1/action/deleteOne`, `POST /app/data-api/v1/action/deleteMany`, `POST /app/data-api/v1/action/aggregate`

## Next.js Integration

Use `@emulators/adapter-next` to proxy native emulator routes through the same origin as your Next.js app. For zero-infra Vercel previews, use the generated Go Function scaffold.

### Vercel Go Function preview

For zero infra Vercel preview deployments with the native Go runtime, scaffold a Go Function and rewrite:

```bash
npx emulate vercel init
```

This creates:

- `api/emulate.go`, a Vercel Go Function using `github.com/vercel-labs/emulate/vercel`
- `vercel.json`, with `/emulate/:path*` rewritten to `/api/emulate?path=:path*`
- `go.mod`, pinned to the installed `emulate` package version

The scaffold currently enables the native `apple`, `aws`, `clerk`, `github`, `google`, `microsoft`, `mongoatlas`, `okta`, `resend`, `slack`, `stripe`, and `vercel` handlers. Use `npx emulate vercel init --service github` to limit the function to one service.

State uses warm memory by default: cold starts reset to a fresh store, warm invocations reuse mutations, and concurrent function instances can diverge. For snapshots across cold starts, implement `vercel.Persistence` in `api/emulate.go` and pass it to `emulate.NewHandler`.

### Install

```bash
npm install @emulators/adapter-next
```

### Native runtime proxy

Use `createEmulateProxy` when a native runtime is running separately and the Next.js route should forward requests to it:

```typescript
// app/emulate/[...path]/route.ts
import { createEmulateProxy } from '@emulators/adapter-next'

export const { GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS } = createEmulateProxy({
  targets: {
    resend: 'http://127.0.0.1:4018',
    aws: 'http://127.0.0.1:4020',
  },
})
```

With `targets`, the first path segment selects the service and is stripped before forwarding. `/emulate/resend/emails` forwards to `http://127.0.0.1:4018/emails`, while response `Location` headers and HTML links are rewritten back to `/emulate/resend/*`.

If multiple services share one native runtime URL, keep using `targets` and point each service at that runtime when the runtime expects service-local paths:

```typescript
export const { GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS } = createEmulateProxy({
  targets: {
    resend: 'http://127.0.0.1:4000',
    aws: 'http://127.0.0.1:4000',
  },
})
```

Use single `target` only when the upstream expects every path segment after the public route prefix:

```typescript
export const { GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS } = createEmulateProxy({
  routePrefix: '/emulate',
  target: 'http://127.0.0.1:4020',
})
```

Single target mode preserves every path segment. `/emulate/aws/sqs` forwards to `http://127.0.0.1:4020/aws/sqs`. For deployed previews, the target URL must be reachable from the Next.js serverless function.

### Auth.js / NextAuth configuration

Point your provider at the emulator paths on the same origin:

```typescript
import GitHub from 'next-auth/providers/github'

const baseUrl = process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}`
  : 'http://localhost:3000'

GitHub({
  clientId: 'any-value',
  clientSecret: 'any-value',
  authorization: { url: `${baseUrl}/emulate/github/login/oauth/authorize` },
  token: { url: `${baseUrl}/emulate/github/login/oauth/access_token` },
  userinfo: { url: `${baseUrl}/emulate/github/user` },
})
```

No `oauth_apps` need to be seeded. When none are configured, the emulator skips `client_id`, `client_secret`, and `redirect_uri` validation.

`createEmulateHandler` remains as a compatibility facade for existing App Router routes. It accepts the old `services` config shape, starts the native runtime on first local request, and proxies each service path to that runtime. The legacy `persistence` option is rejected because state lives in the native runtime. For deployed Vercel previews, prefer `npx emulate vercel init`; alternatively set `EMULATE_<SERVICE>_URL` to a reachable native target. New code should use `createEmulateProxy` for explicit local proxying.

## Architecture

```
packages/
  emulate/          # npm CLI shim and native process programmatic API
  @emulators/
    core/           # compatibility helpers and native proxy facade
    adapter-next/   # Next.js App Router proxy integration
    vercel/         # Vercel API metadata and compatibility package
    github/         # GitHub API metadata and compatibility package
    google/         # Google metadata and compatibility package
    slack/          # Slack metadata and compatibility package
    apple/          # Apple metadata and compatibility package
    microsoft/      # Microsoft metadata and compatibility package
    aws/            # AWS metadata, compatibility package, and SDK conformance tests
apps/
  web/              # Documentation site (Next.js)
```

The native Go runtime is the service engine and is distributed through npm as platform-specific optional binary packages. The TypeScript packages remain available for npm package names, the native process programmatic API, framework proxy adapters, and SDK conformance tests.

## Auth

Tokens are configured in the seed config and map to users. Pass them as `Authorization: Bearer <token>` or `Authorization: token <token>`.

**Vercel**: All endpoints accept `teamId` or `slug` query params for team scoping. Pagination uses cursor-based `limit`/`since`/`until` with `pagination` response objects.

**GitHub**: Public repo endpoints work without auth. Private repos and write operations require a valid token. Pagination uses `page`/`per_page` with `Link` headers.

**Google**: Standard OAuth 2.0 authorization code flow. Configure clients in the seed config.

**Slack**: All Web API endpoints require `Authorization: Bearer <token>`. OAuth v2 flow with user picker UI.

**Apple**: OIDC authorization code flow with RS256 ID tokens. On first auth per user/client pair, a `user` JSON blob is included.

**Microsoft**: OIDC authorization code flow with PKCE support. Also supports client credentials grants. Microsoft Graph `/v1.0/me` available.

**AWS**: Bearer tokens or IAM access key credentials. Scoped permissions use `s3:*`, `sqs:*`, `sns:*`, `events:*`, `apigatewayv2:*`, `execute-api:*`, `dynamodb:*`, `logs:*`, `secretsmanager:*`, `ssm:*`, `kms:*`, `lambda:*`, `iam:*`, `sts:*` patterns. Default key pair always seeded: `AKIAIOSFODNN7EXAMPLE` / `wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY`.
