# emulate

Local drop-in replacement services for CI and no-network sandboxes. Fully stateful, production-fidelity API emulation. Not mocks.

## Quick Start

```bash
npx emulate
```

All services start with sensible defaults. No config file needed:

- **Vercel** on `http://localhost:4000`
- **GitHub** on `http://localhost:4001`
- **Google** on `http://localhost:4002`
- **Slack** on `http://localhost:4003`
- **Apple** on `http://localhost:4004`
- **Microsoft** on `http://localhost:4005`
- **Okta** on `http://localhost:4006`
- **AWS** on `http://localhost:4007`
- **Resend** on `http://localhost:4008`
- **Stripe** on `http://localhost:4009`
- **MongoDB Atlas** on `http://localhost:4010`
- **Clerk** on `http://localhost:4011`
- **Linear** on `http://localhost:4012`
- **Twilio** on `http://localhost:4013`

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

# List available services
npx emulate list
```

### Options

| Flag | Default | Description |
|------|---------|-------------|
| `-p, --port` | `4000` | Base port (auto-increments per service) |
| `-s, --service` | all | Comma-separated services to enable |
| `--seed` | auto-detect | Path to seed config (YAML or JSON) |
| `--base-url` | none | Override advertised base URL (supports `{service}` template) |
| `--portless` | off | Serve over HTTPS via portless (auto-registers aliases) |

The port can also be set via `EMULATE_PORT` or `PORT` environment variables.

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

If portless is not installed, emulate will prompt to install it (`npm i -g portless`).

The `--portless` flag overwrites any existing portless aliases matching `*.emulate`. Aliases are removed automatically when emulate shuts down.

For a custom base URL without portless (any reverse proxy), use `--base-url` or the `EMULATE_BASE_URL` env var:

```bash
npx emulate start --base-url "https://{service}.myproxy.test"
```

The `PORTLESS_URL` env var is automatically set by the `portless` CLI wrapper when running a command through it (e.g. `portless github.emulate emulate start`), typically to a value like `https://{service}.emulate.localhost`. It supports `{service}` interpolation, just like `--base-url` and `EMULATE_BASE_URL`. When no explicit `baseUrl` is provided, it is used as a fallback.

Per-service overrides are also supported in the seed config (these take highest priority over all other base URL sources):

```yaml
github:
  baseUrl: https://github.emulate.localhost
```

## Programmatic API

```bash
npm install emulate
```

Each call to `createEmulator` starts a single service:

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

afterEach(() => { github.reset(); vercel.reset() })
afterAll(() => Promise.all([github.close(), vercel.close()]))
```

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `service` | *(required)* | Service name: `'vercel'`, `'github'`, `'google'`, `'slack'`, `'apple'`, `'microsoft'`, `'okta'`, `'aws'`, `'resend'`, `'stripe'`, `'mongoatlas'`, `'clerk'`, `'linear'`, or `'twilio'` |
| `port` | `4000` | Port for the HTTP server |
| `seed` | none | Inline seed data (same shape as YAML config) |
| `baseUrl` | none | Override advertised base URL. Per-service `baseUrl` in seed config takes highest priority, then this option, then `EMULATE_BASE_URL` env var (supports `{service}`), then `PORTLESS_URL` (supports `{service}`, automatically set by the `portless` CLI wrapper), then `http://localhost:<port>`. |

### Instance methods

| Method | Description |
|--------|-------------|
| `url` | Base URL of the running server |
| `reset()` | Wipe the store and replay seed data |
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
    - owner: octocat
      name: cloneable
      files:
        README.md: "# cloneable\n"
        src/index.js: "console.log('hi');\n"

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
      profile:
        title: Local Developer
        status_text: Testing locally
        status_emoji: ":computer:"
      presence: active
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
      app_id: A000000001
      name: My Slack App
      redirect_uris:
        - http://localhost:3000/api/auth/callback/slack
      scopes:
        - chat:write
        - channels:read
        - channels:history
        - channels:join
        - channels:manage
        - channels:write
        - groups:read
        - groups:history
        - groups:write
        - im:read
        - im:history
        - im:write
        - mpim:read
        - mpim:history
        - mpim:write
        - users:read
        - users:read.email
        - users.profile:read
        - users.profile:write
        - users:write
        - files:read
        - files:write
        - pins:read
        - pins:write
        - bookmarks:read
        - bookmarks:write
        - reactions:read
        - reactions:write
        - team:read
      user_scopes: [users:read, users.profile:read]
      bot_name: my-bot
  tokens:
    - token: xoxb-local-test
      user: developer
      scopes:
        - chat:write
        - channels:read
        - channels:history
        - channels:join
        - channels:manage
        - channels:write
        - groups:read
        - groups:history
        - groups:write
        - im:read
        - im:history
        - im:write
        - mpim:read
        - mpim:history
        - mpim:write
        - users:read
        - users:read.email
        - users.profile:read
        - users.profile:write
        - users:write
        - files:read
        - files:write
        - pins:read
        - pins:write
        - bookmarks:read
        - bookmarks:write
        - reactions:read
        - reactions:write
        - team:read
  strict_scopes: false

linear:
  organization:
    name: Acme
    url_key: acme
  users:
    - email: admin@example.com
      name: Admin User
      admin: true
    - email: dev@example.com
      name: Developer
  teams:
    - key: ENG
      name: Engineering
      states:
        - name: Backlog
          type: backlog
        - name: Todo
          type: unstarted
        - name: In Progress
          type: started
        - name: Done
          type: completed
  labels:
    - name: Bug
      color: "#d92d20"
      team: ENG
  issues:
    - team: ENG
      title: Fix local checkout test
      state: Todo
      assignee: dev@example.com
      labels: [Bug]
  oauth_apps:
    - client_id: lin_example_client_id
      client_secret: example_client_secret
      name: My Linear App
      redirect_uris:
        - http://localhost:3000/api/auth/callback/linear
      scopes: [read, write, issues:create, comments:create]
  tokens:
    - token: lin_test_admin
      user: admin@example.com
      scopes: [read, write, issues:create, comments:create, admin]
  strict_scopes: false

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
  iam:
    users:
      - user_name: developer
        create_access_key: true
    roles:
      - role_name: lambda-execution-role
        description: Role for Lambda function execution
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

### Linear OAuth Apps

```yaml
linear:
  oauth_apps:
    - client_id: "lin_example_client_id"
      client_secret: "example_client_secret"
      name: "My Linear App"
      redirect_uris:
        - "http://localhost:3000/api/auth/callback/linear"
      scopes: [read, write, issues:create, comments:create]
      actor: user
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

Every endpoint below is fully stateful with Vercel-style JSON responses and cursor-based pagination.

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

### Blob
Implements the Vercel Blob API used by the `@vercel/blob` SDK (`put`, `head`, `list`, `del`).

- `PUT /api/blob?pathname=<path>` - upload a blob (honors `x-add-random-suffix`, `x-allow-overwrite`, `x-content-type`, `x-cache-control-max-age`, `x-if-match` headers)
- `GET /api/blob?url=<urlOrPathname>` - blob metadata (`head()`)
- `GET /api/blob?prefix=&limit=&cursor=&mode=` - list blobs (`list()`, including folded mode)
- `POST /api/blob/delete` - delete blobs (`del()`)
- `GET /blob/:storeId/<pathname>` - serve blob content (public, no auth; `?download=1` adds an attachment disposition)

Point the SDK at the emulator with two environment variables:

```bash
VERCEL_BLOB_API_URL=http://localhost:4000/api/blob
BLOB_READ_WRITE_TOKEN=vercel_blob_rw_mystore_secret
```

Any token of the form `vercel_blob_rw_<storeId>_<secret>` is accepted; the store id is parsed from the token. Multipart uploads and client (browser) uploads are not supported yet.

## GitHub API

Every endpoint below is fully stateful. Creates, updates, and deletes persist in memory and affect related entities.

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

### Git over HTTP (clone)

Repos can be cloned with a real `git` client through the smart HTTP protocol:

```bash
git clone http://x-access-token:$TOKEN@localhost:4001/octocat/hello-world.git
```

- `GET /:owner/:repo/info/refs?service=git-upload-pack` - ref advertisement
- `POST /:owner/:repo/git-upload-pack` - clone and full fetch
- Seed file contents with `files` on a repo fixture (path to content map); without `files`, `auto_init` repos serve their generated README
- A presented token must be one the emulator knows: seeded through config or minted at runtime (for example by `POST /app/installations/:installation_id/access_tokens`). Unknown tokens get a 401 even where REST routes would fall back to the default user
- Public repos clone anonymously; private repos require a token with access
- Read only: push (`git-receive-pack`), shallow clones (`--depth`), and partial fetches are not supported

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

Fully stateful Slack Web API emulation with channels, messages, threads, reactions, user profiles, presence, modern file uploads, pins, bookmarks, views, OAuth v2, and incoming webhooks. Chat writes preserve common rich message fields such as `blocks`, `attachments`, `metadata`, formatting flags, unfurl flags, and client message ids. Conversation writes update archive state, names, topics, purposes, membership, DMs, MPIMs, and read cursors. User writes update profile fields, status, custom fields, and deterministic active or away presence. File writes support the current external upload flow with local upload URLs, file share messages, reads, lists, downloads, and deletes. Pin and bookmark writes support channel message pins and link bookmarks. View writes support App Home publishing and modal stacks. Seeded OAuth apps and OAuth installs create bot users and installation records. OAuth exchanges and explicit token seeds create scoped token records. Supported write state changes dispatch Slack `event_callback` payloads to configured webhook URLs.

### Auth & Chat
- `POST /api/auth.test` - test authentication
- `POST /api/chat.postMessage` - post message with text or rich payload fields (supports threads via `thread_ts` and DM user IDs)
- `POST /api/chat.postEphemeral` - post ephemeral message outside channel history
- `POST /api/chat.update` - update message text and rich payload fields
- `POST /api/chat.delete` - delete message
- `GET /api/chat.getPermalink` / `POST /api/chat.getPermalink` - get message permalink
- `POST /api/chat.scheduleMessage` - schedule pending message
- `POST /api/chat.deleteScheduledMessage` - delete pending scheduled message
- `POST /api/chat.scheduledMessages.list` - list pending scheduled messages
- `POST /api/chat.meMessage` - /me message

### Conversations
- `POST /api/conversations.list` - list conversations (cursor pagination, `types`, `exclude_archived`)
- `POST /api/conversations.info` - get channel info
- `POST /api/conversations.create` - create channel
- `POST /api/conversations.archive` / `conversations.unarchive` - archive/restore channel
- `POST /api/conversations.rename` - rename channel
- `POST /api/conversations.setTopic` / `conversations.setPurpose` - update topic/purpose
- `POST /api/conversations.history` - channel history with rich message fields
- `POST /api/conversations.replies` - thread replies with rich message fields
- `POST /api/conversations.join` / `conversations.leave` - join/leave
- `POST /api/conversations.invite` / `conversations.kick` - manage membership
- `POST /api/conversations.open` / `conversations.close` - open/close DMs and MPIMs
- `POST /api/conversations.mark` - mark read cursor
- `POST /api/conversations.members` - list members

### Users & Reactions
- `POST /api/users.list` - list users (cursor pagination)
- `POST /api/users.info` - get user info
- `POST /api/users.lookupByEmail` - lookup by email
- `GET /api/users.profile.get` / `POST /api/users.profile.get` - get user profile fields
- `POST /api/users.profile.set` - update profile fields, status, and custom fields
- `GET /api/users.getPresence` / `POST /api/users.getPresence` - get active or away presence
- `POST /api/users.setPresence` - set the authed user to away or automatic presence
- `POST /api/reactions.add` / `reactions.remove` / `reactions.get` - manage reactions

### Files
- `POST /api/files.getUploadURLExternal` - create a local external upload session
- `POST /upload/v1/:fileId` - receive raw uploaded file bytes
- `POST /api/files.completeUploadExternal` - complete uploads and optionally share file messages
- `GET /api/files.info` / `POST /api/files.info` - get file metadata
- `GET /api/files.list` / `POST /api/files.list` - list completed files
- `GET /files-pri/:fileId/:filename` - download file bytes with a bearer token that can access the file
- `POST /api/files.delete` - delete a completed file

### Pins & Bookmarks
- `POST /api/pins.add` - pin a message to a channel
- `GET /api/pins.list` / `POST /api/pins.list` - list pinned message items for a channel
- `POST /api/pins.remove` - remove a message pin from a channel
- `POST /api/bookmarks.add` - add a link bookmark to a channel
- `POST /api/bookmarks.edit` - update a link bookmark
- `POST /api/bookmarks.list` - list channel bookmarks
- `POST /api/bookmarks.remove` - remove a bookmark from a channel

### Views
- `POST /api/views.publish` - publish or update an App Home view for a user
- `POST /api/views.open` - open a modal view
- `POST /api/views.update` - update a view by `view_id` or `external_id`
- `POST /api/views.push` - push a modal view onto the current modal stack
- `POST /api/views.generateTriggerId` - local helper for tests that need a modal trigger id

Modal opens and pushes require values from `/api/views.generateTriggerId`. Pass the returned value as `trigger_id` or `interactivity_pointer`; generate push values with an existing `view_id` and use them within 3 seconds.

### Team, Bots & Webhooks
- `POST /api/team.info` - workspace info
- `POST /api/bots.info` - bot info
- `POST /services/:teamId/:botId/:webhookId` - incoming webhook with text or rich payload fields

### OAuth
- `GET /oauth/v2/authorize` - authorization (shows user picker)
- `POST /oauth/v2/authorize/callback` - local user picker callback that creates the auth code
- `POST /api/oauth.v2.access` - token exchange

### Inspector
- `GET /` - tabbed local inspector for conversations, messages, files, views, auth records, incoming webhooks, event subscriptions, and event deliveries

Slack scope checks are relaxed by default so local tests can use simple bearer tokens. Set `slack.strict_scopes: true` in seed config to make supported Web API methods return Slack-style `missing_scope` errors with `needed` and `provided` fields. Strict mode checks `chat:write`, `channels:read`, `channels:history`, `channels:join`, `channels:manage`, `channels:write`, `groups:read`, `groups:history`, `groups:write`, `im:read`, `im:history`, `im:write`, `mpim:read`, `mpim:history`, `mpim:write`, `users:read`, `users:read.email`, `users.profile:read`, `users.profile:write`, `users:write`, `files:read`, `files:write`, `pins:read`, `pins:write`, `bookmarks:read`, `bookmarks:write`, `reactions:read`, `reactions:write`, and `team:read`. Slack lists no method-specific scopes for `views.publish`, `views.open`, `views.update`, or `views.push`, so the emulator requires auth but does not add strict-scope checks for those methods.

Current Slack limits: Slack Connect, Enterprise Grid admin APIs, Audit Logs API, SCIM, Legal Holds, Socket Mode, slash command and interaction simulation, user groups, reminders, stars, calls, canvases, lists, functions, workflows, chat streaming, legacy `files.upload`, exact rate limiting, and paid-plan behavior are not implemented.

## Linear API

Stateful Linear GraphQL API emulation with seeded organizations, users, teams, workflow states, issues, comments, labels, projects, cycles, OAuth apps, tokens, webhooks, and basic agent sessions. GraphQL reads and writes mutate in-memory state and use Relay-style connections with opaque cursors. OAuth supports authorization code, PKCE, refresh token, revoke, client credentials, and `actor=app` tokens for local app-actor tests. Supported writes dispatch Linear-shaped webhook payloads with `Linear-Delivery`, `Linear-Event`, and `Linear-Signature` headers when webhooks are configured.

### GraphQL

- `POST /graphql` - GraphQL endpoint for queries and mutations
- `GET /graphql` - query-string GraphQL endpoint for tooling
- Queries: `viewer`, `organization`, `users`, `user`, `teams`, `team`, `workflowStates`, `workflowState`, `issues`, `issue`, `comments`, `comment`, `issueLabels`, `issueLabel`, `projects`, `project`, `cycles`, `cycle`, `webhooks`, `webhook`, `agentSessions`, `agentSession`
- Mutations: `issueCreate`, `issueUpdate`, `issueDelete`, `issueArchive`, `issueUnarchive`, `commentCreate`, `commentUpdate`, `commentDelete`, `issueLabelCreate`, `issueLabelUpdate`, `issueLabelDelete`, `issueAddLabel`, `issueRemoveLabel`, `webhookCreate`, `webhookDelete`, `agentSessionCreateOnIssue`, `agentSessionCreateOnComment`, `agentSessionUpdate`, `agentActivityCreate`

### OAuth

- `GET /oauth/authorize` - authorization endpoint with local user picker
- `POST /oauth/authorize/callback` - local user picker callback that creates an authorization code
- `POST /oauth/token` - authorization code, refresh token, and client credentials grants
- `POST /oauth/revoke` - revoke access or refresh tokens

OAuth app `actor` config is authoritative. Apps configured with `actor: user` use authorization code flows. Apps configured with `actor: app` use the app install flow and can request client credentials tokens.

### Webhooks And Inspector

- `webhookCreate` / `webhookDelete` manage local webhook subscriptions
- `GET /` - tabbed local inspector for issues, teams, users, projects, agents, auth records, webhook subscriptions, and deliveries

Linear scope checks are relaxed by default so local tests can use simple bearer tokens or the seeded `lin_test_admin` token. Set `linear.strict_scopes: true` in seed config to require `read`, `write`, `issues:create`, `comments:create`, or `admin` on supported GraphQL operations.

Current Linear limits: full schema coverage, exact production rate limiting, notification inbox behavior, rich document APIs, customer APIs, initiative APIs, exact search relevance, and production agent behavior are not implemented. Agent support is a focused local-test subset.

## Twilio API

Stateful Twilio REST emulation with seeded accounts, Auth Tokens, API keys, incoming phone numbers, Programmable Messaging, Messaging Services, Verify, basic Voice calls, Conversations REST resources, signed webhooks, local simulator routes, and an inspector. No real SMS, MMS, WhatsApp, email, voice, carrier, compliance, billing, or SendGrid traffic is performed.

Default local credentials:

```text
TWILIO_ACCOUNT_SID=AC00000000000000000000000000000000
TWILIO_AUTH_TOKEN=twilio_test_auth_token
TWILIO_API_KEY=SK00000000000000000000000000000000
TWILIO_API_SECRET=twilio_test_api_secret
TWILIO_PHONE_NUMBER=+15551234567
TWILIO_VERIFY_SERVICE_SID=VA00000000000000000000000000000000
```

### REST Routes

- `GET /2010-04-01/Accounts/{AccountSid}.json` - fetch account
- `GET /2010-04-01/Accounts/{AccountSid}/IncomingPhoneNumbers.json` - list phone numbers
- `POST /2010-04-01/Accounts/{AccountSid}/Messages.json` - create outbound message
- `GET /2010-04-01/Accounts/{AccountSid}/Messages.json` - list messages
- `POST /2010-04-01/Accounts/{AccountSid}/Calls.json` - create outbound call
- `POST /messaging/v1/Services` - create Messaging Service
- `POST /verify/v2/Services/{ServiceSid}/Verifications` - start verification
- `POST /verify/v2/Services/{ServiceSid}/VerificationCheck` - check verification code
- `POST /conversations/v1/Services` - create Conversation Service
- `POST /conversations/v1/Services/{ServiceSid}/Conversations` - create Conversation
- `POST /conversations/v1/Services/{ServiceSid}/Conversations/{ConversationSid}/Participants` - add participant
- `POST /conversations/v1/Services/{ServiceSid}/Conversations/{ConversationSid}/Messages` - add message

Twilio uses multiple product hosts. For local SDK tests, rewrite Twilio SDK requests to the emulator and map `messaging.twilio.com` to `/messaging`, `verify.twilio.com` to `/verify`, and `conversations.twilio.com` to `/conversations`.

### SMS And OTP Testing

For the common SMS verification loop, the seeded Verify Service uses code `123456`. Start a verification through the normal Verify API, then either submit `123456` in your app test or fetch the latest local code with the authenticated helper route:

```sh
curl -u "$TWILIO_ACCOUNT_SID:$TWILIO_AUTH_TOKEN" \
  "http://localhost:4000/_twilio/simulate/verification-code?To=%2B15550002222&ServiceSid=$TWILIO_VERIFY_SERVICE_SID"
```

The helper returns the latest local verification for that phone number, including `verification_sid`, `status`, `attempts`, and `code`. It is local-only test support and is not part of Twilio's production API. The Verify inspector also shows each attempted code.

To test inbound SMS webhooks, configure a seeded phone number `sms_url`, then call `POST /_twilio/simulate/inbound-message` with `To`, `From`, and `Body`. If the destination number is assigned to a Messaging Service with `inbound_request_url`, the simulator sends the inbound webhook there and includes `MessagingServiceSid`; otherwise it uses the phone number `sms_url`. To test outbound delivery transitions, create a message with `StatusCallback`, then call `POST /_twilio/simulate/message-status`.

### Simulator And Inspector

- `POST /_twilio/simulate/inbound-message` - create an inbound message and invoke the configured SMS webhook
- `POST /_twilio/simulate/message-status` - advance message status and send status callbacks
- `GET /_twilio/simulate/verification-code` - fetch the latest local Verify code by `VerificationSid` or `To`
- `POST /_twilio/simulate/inbound-call` - create an inbound call and invoke the configured voice webhook
- `POST /_twilio/simulate/call-status` - advance call status
- `POST /_twilio/simulate/verification-status` - force a verification state by `VerificationSid` or `To`
- `GET /` - tabbed inspector for messages, Verify, calls, Conversations, phone numbers, services, auth, and webhook deliveries

Current Twilio limits: no carrier delivery, A2P 10DLC, toll-free verification, real phone number purchasing, exact rate limits, Studio, Flex, TaskRouter, Video, Sync, Segment, SendGrid, Conversations SDK websocket behavior, or complete TwiML interpreter.

## Apple Sign In

Sign in with Apple emulation with authorization code flow, PKCE support, RS256 ID tokens, and OIDC discovery.

- `GET /.well-known/openid-configuration` - OIDC discovery document
- `GET /auth/keys` - JSON Web Key Set (JWKS)
- `GET /auth/authorize` - authorization endpoint (shows user picker)
- `POST /auth/token` - token exchange (authorization code and refresh token grants)
- `POST /auth/revoke` - token revocation

## Microsoft Entra ID

Microsoft Entra ID (Azure AD) v2.0 OAuth 2.0 and OpenID Connect emulation with authorization code flow, PKCE, client credentials, RS256 ID tokens, and OIDC discovery.

- `GET /.well-known/openid-configuration` - OIDC discovery document
- `GET /:tenant/v2.0/.well-known/openid-configuration` - tenant-scoped OIDC discovery
- `GET /discovery/v2.0/keys` - JSON Web Key Set (JWKS)
- `GET /oauth2/v2.0/authorize` - authorization endpoint (shows user picker)
- `POST /oauth2/v2.0/token` - token exchange (authorization code, refresh token, client credentials)
- `GET /oidc/userinfo` - OpenID Connect user info
- `GET /v1.0/me` - Microsoft Graph user profile
- `GET /oauth2/v2.0/logout` - end session / logout
- `POST /oauth2/v2.0/revoke` - token revocation

## AWS

S3, SQS, IAM, and STS emulation with AWS SDK-compatible S3 paths and query-style SQS/IAM/STS endpoints. All responses use AWS-compatible XML.

### S3

S3 routes use root paths matching the real AWS S3 wire format, so the official AWS SDK works out of the box with `forcePathStyle: true`. Legacy `/s3/` prefixed paths are also supported for backward compatibility.

- `GET /` - list all buckets
- `PUT /:bucket` - create bucket
- `DELETE /:bucket` - delete bucket
- `HEAD /:bucket` - check existence
- `GET /:bucket` - list objects (prefix, delimiter, max-keys, continuation-token, start-after)
- `POST /:bucket` - presigned POST upload (browser-style multipart form with policy validation)
- `PUT /:bucket/:key` - put object (supports copy via `x-amz-copy-source`)
- `GET /:bucket/:key` - get object
- `HEAD /:bucket/:key` - head object
- `DELETE /:bucket/:key` - delete object

### SQS
All operations via `POST /sqs/` with `Action` parameter:
- `CreateQueue`, `ListQueues`, `GetQueueUrl`, `GetQueueAttributes`
- `SendMessage`, `ReceiveMessage`, `DeleteMessage`
- `PurgeQueue`, `DeleteQueue`

### IAM
All operations via `POST /iam/` with `Action` parameter:
- `CreateUser`, `GetUser`, `ListUsers`, `DeleteUser`
- `CreateAccessKey`, `ListAccessKeys`, `DeleteAccessKey`
- `CreateRole`, `GetRole`, `ListRoles`, `DeleteRole`

### STS
All operations via `POST /sts/` with `Action` parameter:
- `GetCallerIdentity`, `AssumeRole`

## Next.js Integration

Embed emulators directly in your Next.js app so they run on the same origin. This solves the Vercel preview deployment problem where OAuth callback URLs change with every deployment.

### Install

```bash
npm install @emulators/adapter-next @emulators/github @emulators/google
```

Only install the emulators you need. Each `@emulators/*` package is published independently.

### Route handler

Create a catch-all route that serves emulator traffic:

```typescript
// app/emulate/[...path]/route.ts
import { createEmulateHandler } from '@emulators/adapter-next'
import * as github from '@emulators/github'
import * as google from '@emulators/google'

export const { GET, POST, PUT, PATCH, DELETE } = createEmulateHandler({
  services: {
    github: {
      emulator: github,
      seed: {
        users: [{ login: 'octocat', name: 'The Octocat' }],
        repos: [{ owner: 'octocat', name: 'hello-world', auto_init: true }],
      },
    },
    google: {
      emulator: google,
      seed: {
        users: [{ email: 'test@example.com', name: 'Test User' }],
      },
    },
  },
})
```

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

### Font files in serverless

Emulator UI pages use bundled fonts. Wrap your Next.js config to include them in the serverless trace:

```typescript
// next.config.mjs
import { withEmulate } from '@emulators/adapter-next'

export default withEmulate({
  // your normal Next.js config
})
```

If you mount the catch-all at a custom path, pass the matching prefix:

```typescript
export default withEmulate(nextConfig, { routePrefix: '/api/emulate' })
```

### Persistence

By default, emulator state is in-memory and resets on every cold start. To persist state across restarts, pass a `persistence` adapter:

```typescript
import { createEmulateHandler } from '@emulators/adapter-next'
import * as github from '@emulators/github'

const kvAdapter = {
  async load() { return await kv.get('emulate-state') },
  async save(data: string) { await kv.set('emulate-state', data) },
}

export const { GET, POST, PUT, PATCH, DELETE } = createEmulateHandler({
  services: { github: { emulator: github } },
  persistence: kvAdapter,
})
```

For local development, `@emulators/core` ships `filePersistence`:

```typescript
import { filePersistence } from '@emulators/core'

// ...
persistence: filePersistence('.emulate/state.json'),
```

The persistence adapter is called on cold start (load) and after every mutating request (save). Saves are serialized via an internal queue to prevent race conditions.

## Architecture

```
packages/
  emulate/          # CLI entry point (commander)
  @emulators/
    core/           # HTTP server, in-memory store, plugin interface, middleware
    adapter-next/   # Next.js App Router integration
    vercel/         # Vercel API service
    github/         # GitHub API service
    google/         # Google OAuth 2.0 / OIDC + Gmail, Calendar, Drive
    slack/          # Slack Web API, OAuth v2, incoming webhooks
    linear/         # Linear GraphQL API, OAuth, webhooks
    twilio/         # Twilio Messaging, Verify, Voice, webhooks
    apple/          # Apple Sign In / OIDC
    microsoft/      # Microsoft Entra ID OAuth 2.0 / OIDC + Graph /me
    aws/            # AWS S3, SQS, IAM, STS
apps/
  web/              # Documentation site (Next.js)
```

The core provides a generic `Store` with typed `Collection<T>` instances supporting CRUD, indexing, filtering, and pagination. Each service plugin registers its routes with the shared internal app and uses the store for state.

## Auth

Tokens are configured in the seed config and map to users. Pass them as `Authorization: Bearer <token>` or `Authorization: token <token>`.

**Vercel**: All endpoints accept `teamId` or `slug` query params for team scoping. Pagination uses cursor-based `limit`/`since`/`until` with `pagination` response objects.

**GitHub**: Public repo endpoints work without auth. Private repos and write operations require a valid token. Pagination uses `page`/`per_page` with `Link` headers.

**Google**: Standard OAuth 2.0 authorization code flow. Configure clients in the seed config.

**Slack**: All Web API endpoints require `Authorization: Bearer <token>`. Seeded OAuth apps create local installation records, and OAuth v2 flow with user picker UI creates scoped bot tokens. Optional strict scope mode returns `missing_scope` when a token lacks a required method scope.

**Linear**: GraphQL accepts `Authorization: Bearer <token>` or a bare personal API key value. Seeded Linear tokens map to users or app actors, OAuth apps support local authorization code and client credentials flows, and optional strict scope mode checks supported GraphQL operations.

**Twilio**: HTTP Basic auth accepts the seeded Account SID/Auth Token pair or API Key/API Secret pair. Product-host APIs are exposed under local prefixes such as `/messaging/v1` and `/verify/v2`; the 2010 API lives at `/2010-04-01`.

**Apple**: OIDC authorization code flow with RS256 ID tokens. On first auth per user/client pair, a `user` JSON blob is included.

**Microsoft**: OIDC authorization code flow with PKCE support. Also supports client credentials grants. Microsoft Graph `/v1.0/me` available.

**AWS**: Bearer tokens or IAM access key credentials. Default key pair always seeded: `AKIAIOSFODNN7EXAMPLE` / `wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY`.
