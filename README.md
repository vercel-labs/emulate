# emulate

<p>
  <a href="https://vercel.com/labs#active-experiments"><img alt="Vercel Labs Experiment" src="https://img.shields.io/badge/LABS-EXPERIMENT-0a0a0a.svg?style=for-the-badge&amp;logo=Vercel&amp;labelColor=000000" height="28"></a>
  <a href="https://www.npmjs.com/package/emulate"><img alt="npm version: emulate" src="https://img.shields.io/npm/v/emulate.svg?style=for-the-badge&amp;labelColor=000000" height="28"></a>
  <a href="https://github.com/vercel-labs/emulate/blob/main/LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/github/license/vercel-labs/emulate.svg?style=for-the-badge&amp;labelColor=000000" height="28"></a>
  <a href="https://www.npmjs.com/package/emulate"><img alt="npm downloads per month: emulate" src="https://img.shields.io/npm/dm/emulate.svg?style=for-the-badge&amp;labelColor=000000&amp;label=npm%20downloads" height="28"></a>
</p>

Local drop-in replacement services for CI and no-network sandboxes. Fully stateful, production-fidelity API emulation. Not mocks.

## Quick Start

```bash
npx emulate
```

All services listen on IPv4 loopback (`127.0.0.1`) by default. No config file needed:

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

Stripe webhooks configured with a secret include a `Stripe-Signature` header signed over the timestamp and raw request body.

Slack event callbacks use `X-Slack-Request-Timestamp` and `X-Slack-Signature` when `slack.signing_secret` is configured. The signature is an HMAC-SHA256 over `v0:<timestamp>:<raw-body>`; configure the receiver with the same secret and verify against the unparsed request body. Existing event subscriptions remain unsigned when the secret is absent or empty.

Resend `POST /emails` and `POST /emails/batch` support 24-hour `Idempotency-Key` replay, returning the original email IDs without duplicate emails or webhooks. Optional `resend.allowlist` restrictions let tests reject recipients while `resend.send_attempts` records accepted and rejected sends.

## Custom emulators

Build and share emulators for the third-party HTTP APIs your app uses. Define a provider's behavior in TypeScript, run it alongside built-in services, and reuse it in tests and framework adapters. emulate provides seeds, resets, persistence, and request/state inspection.

Start from a working scaffold and adapt its routes and state to your provider:

```bash
npm install -D emulate
npx emulate init --custom inventory
npx emulate start --watch
```

The scaffold implements reservations, stock changes, cancellation, and out-of-stock errors. It creates a runnable Node test and adds the service to a discovered YAML, JSON, TypeScript, or JavaScript config. For an unusual executable config, it prints the import and service entry to add manually. `init` prints the test command and directs you to the service URL and Inspector link printed by `start`; the port depends on the config. Watch mode retries when a missing local import is created, including outside the config directory. Use the inspector to view requests and state or reset to the initial seed. Structured inspection redacts token and secret fields such as `access_token`, `refresh_token`, and `client_secret`.

```typescript
import { defineEmulator, createEmulator } from 'emulate'

const acme = defineEmulator({
  name: 'acme',
  state: () => ({ anvils: 100 }),
  setup({ app, state }) {
    app.get('/inventory', (c) => c.json(state))
    app.post('/orders', (c) => {
      if (!state.anvils) return c.json({ error: 'sold_out' }, 409)
      state.anvils -= 1
      return c.json({ shipped: 'anvil', to: 'coyote' }, 201)
    })
  },
})

const api = await createEmulator({ service: acme, listen: false })
try {
  await api.request('/orders', { method: 'POST' })
  const checkpoint = api.snapshot()
  await api.reset()
  await api.restore(checkpoint)
} finally {
  await api.close()
}
```

Use `defineConfig({ services: { acme: { emulator: acme }, github: { emulator: 'github' } } })` in `emulate.config.ts`. YAML/JSON entries accept local module paths and installed packages. `--config` selects a config explicitly; legacy flat configs and `--seed` remain supported. Node loads local TypeScript with path aliases and source locations without additional runtime dependencies. Node 26 supports erasable TypeScript only; compile enums and parameter properties to JavaScript before loading them. Node 24 also supports native TypeScript transforms.

Custom state uses your own record shapes and IDs. Seeds replace the complete initial state. Reset restores the captured seed; successful watch reloads create a new baseline and reset the run. With config auto-discovery, watch mode also detects recognized config files created after startup. Instances are independent. Persistence is opt-in, with versioned snapshots and no cross-process locking. Use `port: 0` for HTTP tests, or `listen: false` to test without opening a port. Custom reset and close are awaitable. Framework adapters keep root-relative custom redirects under the service mount while preserving custom HTML bodies.

Streamed responses persist state changes when their bodies finish or are canceled. Reset and close cancel active streams before running cleanup. `c.header('Set-Cookie', value, { append: true })` retains cookies already set on the response. In a Next.js route, export `OPTIONS` from `createEmulateHandler` to forward preflight requests and custom OPTIONS handlers.

See the [custom emulator guide](https://emulate.dev/docs/custom-emulators) and [complete inventory example](examples/custom-api) for validation, middleware, persistence, adapters, package sharing, and troubleshooting.

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

# Generate omitted service secrets into a private file
npx emulate start --seed config.yaml --generated-secrets-file .emulate-secrets.json

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
| `--host` | `127.0.0.1` | Listening address; use `0.0.0.0` to allow network access |
| `-s, --service` | all | Comma-separated services to enable |
| `--seed` | auto-detect | Path to seed config (YAML or JSON) |
| `--base-url` | none | Override advertised base URL (supports `{service}` template) |
| `--portless` | off | Serve over HTTPS via portless (auto-registers aliases) |
| `--generated-secrets-file` | none | Generate omitted service secrets and write them to a new owner-only JSON file |

The port can also be set via `EMULATE_PORT` or `PORT` environment variables.

For access from a container or another machine, use `npx emulate start --host 0.0.0.0`. Set `--base-url` to a URL reachable by those clients when using OAuth redirects or other advertised URLs.

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

When a GitHub App omits `private_key`, `createEmulator` generates an RSA-2048 PKCS#1 key for that emulator instance:

```typescript
const github = await createEmulator({
  service: 'github',
  seed: {
    github: {
      users: [{ login: 'octocat' }],
      apps: [{
        app_id: 12345,
        slug: 'my-github-app',
        name: 'My GitHub App',
        installations: [{ installation_id: 100, account: 'octocat' }],
      }],
    },
  },
})

const privateKey = github.generatedSecrets.find(
  secret => secret.kind === 'github.app_private_key' && secret.id === '12345',
)?.value
```

Generated keys remain stable across `reset()` calls and appear only in `generatedSecrets`. Explicitly configured keys are never returned there. A new `createEmulator` call generates a new key.

The CLI can also generate omitted GitHub App keys when a delivery file is requested:

```bash
npx emulate start --service github --seed config.yaml \
  --generated-secrets-file .emulate-secrets.json
```

The destination must not exist. emulate removes inherited ACLs, verifies effective owner-only access, and publishes complete JSON before opening listeners or configuring portless. Handled startup failures remove the invocation-owned artifact so the command can be retried immediately. A hard termination such as `SIGKILL` can leave a complete published artifact that must be removed manually after confirming no invocation is using it. Only generated secrets are included. Explicitly configured keys are never copied into the artifact. Linux requires `setfacl` and `getfacl` from the `acl` package. The flag fails closed when access controls cannot be verified and is not supported on Windows. Without `--generated-secrets-file`, CLI seed files keep requiring `private_key`.

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
| `hostname` | `127.0.0.1` | Listening address for built-in and custom emulators |
| `seed` | none | Inline seed data (same shape as YAML config) |
| `baseUrl` | none | Override advertised base URL. Per-service `baseUrl` in seed config takes highest priority, then this option, then `EMULATE_BASE_URL` env var (supports `{service}`), then `PORTLESS_URL` (supports `{service}`, automatically set by the `portless` CLI wrapper), then `http://localhost:<port>`. |

Use `hostname: '0.0.0.0'` to allow connections from containers or other machines, and `baseUrl` to advertise a URL reachable by those clients.

### Instance methods

| Method | Description |
|--------|-------------|
| `url` | Base URL of the running server |
| `generatedSecrets` | Readonly secrets generated while preparing seed data |
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
      members:
        - login: octocat
          role: admin
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
    - name: Feature
      color: "#2563eb"
      team: ENG
  issues:
    - team: ENG
      title: Fix local checkout test
      description: Reproduce and fix the checkout failure.
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
      actor: user
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

okta:
  users:
    - login: testuser@okta.local
      email: testuser@okta.local
      first_name: Test
      last_name: User
  groups:
    - name: Everyone
      description: All users
      type: BUILT_IN
      okta_id: 00g_everyone
  authorization_servers:
    - id: default
      name: default
      audiences: [api://default]
  oauth_clients:
    - client_id: okta-test-client
      client_secret: okta-test-secret
      name: Sample OIDC Client
      redirect_uris:
        - http://localhost:3000/callback
      auth_server_id: default

resend:
  domains:
    - name: example.com
      region: us-east-1
  contacts:
    - email: test@example.com
      first_name: Test
      last_name: User

stripe:
  customers:
    - email: test@example.com
      name: Test Customer
  products:
    - name: Pro Plan
      description: Monthly pro subscription
  prices:
    - product_name: Pro Plan
      currency: usd
      unit_amount: 2000

mongoatlas:
  projects:
    - name: Project0
  clusters:
    - name: Cluster0
      project: Project0
  database_users:
    - username: admin
      project: Project0
  databases:
    - cluster: Cluster0
      name: test
      collections: [items]

clerk:
  users:
    - first_name: Test
      last_name: User
      email_addresses: [test@example.com]
      password: clerk_test_password
  organizations:
    - name: My Company
      slug: my-company
      members:
        - email: test@example.com
          role: admin
  oauth_applications:
    - client_id: clerk_emulate_client
      client_secret: clerk_emulate_secret
      name: Emulate App
      redirect_uris:
        - http://localhost:3000/api/auth/callback/clerk

twilio:
  account:
    sid: AC00000000000000000000000000000000
    auth_token: twilio_test_auth_token
    friendly_name: Local Twilio Account
  api_keys:
    - sid: SK00000000000000000000000000000000
      secret: twilio_test_api_secret
      friendly_name: Local API Key
  phone_numbers:
    - phone_number: "+15551234567"
      friendly_name: Local SMS and Voice Number
      sms_url: http://localhost:3000/api/twilio/sms
      voice_url: http://localhost:3000/api/twilio/voice
  messaging_services:
    - friendly_name: Local Messaging Service
      phone_numbers: ["+15551234567"]
  verify_services:
    - friendly_name: Local Verify Service
      code: "123456"
      default_channel: sms
  conversations:
    services:
      - friendly_name: Local Conversations
```

GitHub organization `members` are optional. Each entry references a seeded user by `login`; `role` defaults to `member`, while `admin` creates an organization administrator. Unknown users are ignored. Seeded memberships use the synthetic `members` team and grant private organization repository access.

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

JWT authentication: sign a JWT with `{ iss: "<app_id>" }` using the app's private key (RS256). The emulator verifies the signature and resolves the app. For programmatic `createEmulator` calls, omit `private_key` and read the generated RSA key from `generatedSecrets`. The CLI generates an omitted key only when `--generated-secrets-file <path>` is provided; otherwise it requires an explicit, valid private key. Do not replace the omitted field with a fake PEM placeholder.

Installation access tokens act as the configured GitHub App bot for repository writes. Repository ownership, selected repository access, and requested App permissions remain enforced. Pull request merges require `contents: write` on the base repository. Pull request branch updates require `pull_requests: write` on the pull request repository and `contents: write` on the head repository.

Inspect secret-free metadata for minted installation tokens at `GET /_emulate/installation-tokens`.

**App webhook delivery**: When events occur on repos where a GitHub App is installed, the emulator mirrors real GitHub behavior:
- All webhook payloads (including repo and org hooks) include an `installation` field with `{ id, node_id }`.
- If the app has a `webhook_url`, the emulator delivers the event there with the `installation` field and (if configured) an `X-Hub-Signature-256` header signed with `webhook_secret`.

### Slack OAuth Apps

```yaml
slack:
  signing_secret: "my_signing_secret"
  oauth_apps:
    - client_id: "12345.67890"
      client_secret: "example_client_secret"
      name: "My Slack App"
      redirect_uris:
        - "http://localhost:3000/api/auth/callback/slack"
```

The signing secret applies to every outbound Slack event subscription callback. Each signed callback includes `X-Slack-Request-Timestamp` and `X-Slack-Signature`, calculated as `v0=<HMAC-SHA256(secret, "v0:<timestamp>:<raw-body>")>`. Configure the receiver with the same secret and verify the unparsed request body. If the secret is absent or empty, callbacks are unsigned.

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
- `GET /v7/deployments` - list deployments (filter by project, target, state, commit SHA)
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
Implements the Vercel Blob API used by the `@vercel/blob` SDK (`put`, `head`, `list`, `del`, `copy`) and browser client uploads (`upload()` with `handleUpload()`).

- `PUT /api/blob?pathname=<path>` - upload a blob (honors `x-add-random-suffix`, `x-allow-overwrite`, `x-content-type`, `x-cache-control-max-age`, `x-if-match` headers)
- `PUT /api/blob?pathname=<path>&fromUrl=<url>` - copy a blob (`copy()`); `x-if-match` is compared with the source blob's ETag, and an existing destination is always replaced
- `GET /api/blob?url=<urlOrPathname>` - blob metadata (`head()`)
- `GET /api/blob?prefix=&limit=&cursor=&mode=` - list blobs (`list()`, including folded mode, where folders and root blobs share one sorted page and cursor)
- `POST /api/blob/delete` - delete blobs (`del()`)
- `POST /api/blob/mpu` with `x-mpu-action: create` - start a multipart upload (`createMultipartUpload()`), returning `{ key, uploadId }`
- `GET /blob/:storeId/<pathname>` - serve blob content (public, no auth; `?download=1` adds an attachment disposition)

Upload and deletion rules:

- A single leading slash is removed from the pathname, so `/docs/readme.txt` is stored as `docs/readme.txt`. As in the real service, `//` is otherwise accepted over HTTP, so `//a.txt` is stored as `/a.txt` (the `@vercel/blob` SDK rejects `//` before sending a request). This also applies to copy destinations and multipart uploads.
- The content type is taken from `x-content-type`, then the pathname extension when it is a known type, then the request `Content-Type` header, then `application/octet-stream`.
- `x-cache-control-max-age` has a minimum of 60 seconds (`0` is stored as `public, max-age=60`). Absent or invalid values default to 30 days.
- Deleting with a missing or empty `urls` array returns 400 `Missing urls in request body`. Malformed JSON returns 400 `Cannot delete more than 1,000 urls at once or body is malformed`, more than 1,000 urls returns 400 `Cannot delete more than 1,000 urls at once`, and any non-string entry returns 400 `Some urls are malformed`. Nothing is deleted in any of these cases.

Point the SDK at the emulator with two environment variables:

```bash
VERCEL_BLOB_API_URL=http://localhost:4000/api/blob
BLOB_READ_WRITE_TOKEN=vercel_blob_rw_mystore_secret
```

Any token of the form `vercel_blob_rw_<storeId>_<secret>` works without setup. The first time the emulator sees a store id it registers the store with that exact token, and from then on only that token is accepted for the store (another secret returns 403 `Token mismatch`). This auto-registration is an emulator convenience; the real service only accepts tokens issued for an existing store.

Authentication rules:

- Read-write (`vercel_blob_rw_`) and client (`vercel_blob_client_`) tokens carry their store id, so `x-vercel-blob-store-id` is ignored for them.
- Any other bearer token is treated as an OIDC token for the store named by `x-vercel-blob-store-id` (403 `Missing store id` without it). OIDC tokens cannot be verified offline, so the emulator accepts the literal `local-oidc-token` and any JWT-shaped token (three base64url segments) without checking it, and rejects anything else with 403 `Invalid token`. OIDC stores do not need to be registered first.
- Client tokens can only upload (single PUT and multipart create, upload and complete); any other operation returns 403 `client_token_not_allowed`. A client token for an unregistered store returns 404 `store_not_found`, a malformed one 400 `Invalid client token`, an expired one 403 `Token expired`, and one not signed by the store's read-write token 403 `Token mismatch`.
- Requests without a bearer token return 403. Blob content under `/blob/...` stays public and unauthenticated.

Browser uploads work with `upload()` from `@vercel/blob/client` and `handleUpload()` on your server. Set `NEXT_PUBLIC_VERCEL_BLOB_API_URL` so the browser SDK talks to the emulator too. The options signed into the client token (`addRandomSuffix`, `cacheControlMaxAge`, `allowOverwrite`, `ifMatch`) replace the matching request headers, and the upload is rejected with 403 when its pathname (before any random suffix), content type (`allowedContentTypes`, including `type/*` wildcards) or body size (`maximumSizeInBytes`) does not match the token.

After a successful client upload, the emulator POSTs a `blob.upload-completed` event with the uploaded blob and the token's `tokenPayload` to the token's `callbackUrl`. The body is signed with HMAC-SHA256 keyed by the store's read-write token (`x-vercel-signature`, with `x-vercel-signature-type: rw_token`), so `handleUpload()` verifies it and runs `onUploadCompleted`. The callback is sent in the background to the URL exactly as given, so local `http://` URLs work, and a failing callback never fails the upload.

```typescript
// Server route that issues client tokens and receives the completion callback
import { handleUpload } from '@vercel/blob/client'

export async function POST(request: Request) {
  const result = await handleUpload({
    request,
    body: await request.json(),
    onBeforeGenerateToken: async () => ({ allowedContentTypes: ['image/*'], maximumSizeInBytes: 1_000_000 }),
    onUploadCompleted: async ({ blob, tokenPayload }) => {
      // runs when the emulator delivers blob.upload-completed
    },
  })
  return Response.json(result)
}

// Browser
import { upload } from '@vercel/blob/client'

const blob = await upload('avatars/user.png', file, { access: 'public', handleUploadUrl: '/api/upload' })
```

Multipart uploads can be created, but uploading parts and completing the upload are not supported yet and return 400.

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
- `GET /repositories/:id` - get repo by numeric ID
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

### Contents & Commit History
- `GET /repos/:owner/:repo/readme` - get the repository README
- `GET /repos/:owner/:repo/contents/:path` - get a file or list a directory at a ref
- Send `Accept: application/vnd.github.raw` or `application/vnd.github.raw+json` to file Contents and README requests to receive raw bytes; directory and submodule responses remain JSON
- `GET /:owner/:repo/raw/:ref/:path` - download file content from advertised raw URLs; this is separate from Accept negotiation
- `PUT/DELETE /repos/:owner/:repo/contents/:path` - create, update, or delete a file and commit the change
- `GET /repos/:owner/:repo/commits` - list commits with ref, path, author, and date filters
- `GET /repos/:owner/:repo/commits/:ref` - get a commit with file diffs and stats
- `GET /repos/:owner/:repo/compare/:base...:head` - compare two refs

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
- Check runs: create, update, get, annotations, rerequest, list by ref/suite. Ref based lookups accept branch and tag refs containing slashes.
- Check suites: create, get, preferences, rerequest, list by ref. Ref based lookups accept branch and tag refs containing slashes.
- Automatic suite status rollup from check run results

Check-run lists by ref and suite support `page` and `per_page` (default 30, maximum 100) with pagination `Link` headers. Ref lists apply `check_name`, `status`, and `filter` before pagination; `total_count` reports the full filtered count.

Checks created with installation tokens include their GitHub App in API responses and webhooks. Suites are separated by App and commit, and `filter=latest` keeps the newest run for each App and check name. User-token checks return `app: null`; request-body `app_id` cannot set or change attribution.

### Misc
- `GET /rate_limit` - rate limit status
- `GET /meta` - server metadata
- `GET /octocat` - ASCII art
- `GET /emojis` - emoji URLs
- `GET /zen` - random zen phrase
- `GET /versions` - API versions

## Google OAuth + Gmail, Calendar, and Drive APIs

OAuth 2.0, OpenID Connect, and mutable Google Workspace-style surfaces for local inbox, calendar, and drive flows.

Google ID tokens are RS256-signed JWTs. The discovery document advertises RS256, and `/oauth2/v3/certs` returns the matching RSA public key used to verify issued tokens.

Google authentication is permissive by default for local bearer-token workflows. Set `google.strict_scopes: true` in seed config to require emulator-issued, unexpired access tokens on Gmail, Calendar, Drive, and userinfo routes. Invalid credentials return `401 UNAUTHENTICATED`; missing method scopes return `403` with `insufficientPermissions`. Strict mode distinguishes read, write, send, settings, and metadata scopes, and userinfo includes only granted identity claims. Revoking an access or refresh token invalidates the linked access and refresh credentials. Discovery, signing keys, and the sign-in page remain public. This mode checks method scopes; resource-specific grants such as `drive.file` and Gmail add-on scopes are not modeled.

- `GET /o/oauth2/v2/auth` - authorization endpoint
- `POST /oauth2/token` - token exchange
- `GET /oauth2/v2/userinfo` - get user info
- `GET /.well-known/openid-configuration` - OIDC discovery document
- `GET /oauth2/v3/certs` - JSON Web Key Set (JWKS) with the RSA public key for ID token verification
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
- `GET /discovery/v1/apis/calendar/v3/rest` — public Calendar v3 REST discovery document
- `GET /calendar/v3/users/:userId/calendarList`, `GET /calendar/v3/calendars/:calendarId/events`, `POST /calendar/v3/calendars/:calendarId/events`, `DELETE /calendar/v3/calendars/:calendarId/events/:eventId`, `POST /calendar/v3/freeBusy`
- `GET /drive/v3/files`, `GET /drive/v3/files/:fileId`, `POST /drive/v3/files`, `PATCH /drive/v3/files/:fileId`, `PUT /drive/v3/files/:fileId`, `POST /upload/drive/v3/files`

## Slack API

Fully stateful Slack Web API emulation with channels, messages, threads, reactions, user profiles, presence, modern file uploads, pins, bookmarks, views, OAuth v2, and incoming webhooks. Chat writes preserve common rich message fields such as `blocks`, `attachments`, `metadata`, formatting flags, unfurl flags, and client message ids. Conversation writes update archive state, names, topics, purposes, membership, DMs, MPIMs, and read cursors. User writes update profile fields, status, custom fields, and deterministic active or away presence. File writes support the current external upload flow with local upload URLs, file share messages, reads, lists, downloads, and deletes. Pin and bookmark writes support channel message pins and link bookmarks. View writes support App Home publishing and modal stacks. Seeded OAuth apps and OAuth installs create bot users and installation records. OAuth exchanges and explicit token seeds create scoped token records. Supported write state changes dispatch Slack `event_callback` payloads to configured webhook URLs.

Set `slack.signing_secret` in seed config to sign every outbound event subscription callback. The emulator sends `X-Slack-Request-Timestamp` and `X-Slack-Signature`, where the signature is `v0=<HMAC-SHA256(secret, "v0:<timestamp>:<raw-body>")>`. Configure the receiver with the same secret and verify the unparsed request body. Without a secret, callbacks are unsigned.

Slack message text is limited to 40,000 Unicode characters across chat writes, incoming webhooks, and file upload initial comments. Longer text is truncated at a Unicode code point boundary before it is stored or dispatched. Successful Web API responses include `warning: "message_truncated"` and `response_metadata` with the matching warning and explanatory message. Rich fields such as `blocks` and `attachments` are preserved unchanged.

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

Modal opens and pushes accept `trigger_id` or `interactivity_pointer` from an interaction payload or `/api/views.generateTriggerId`. Generate push values with an existing `view_id`. Triggers expire after 3 seconds by default; set `slack.view_trigger_ttl_seconds` to a positive number to allow more time in local tests.

### Team, Bots & Webhooks
- `POST /api/team.info` - workspace info
- `POST /api/bots.info` - bot info
- `POST /services/:teamId/:botId/:webhookId` - incoming webhook with text or rich payload fields

### Channel privacy conversions

`POST /api/admin.conversations.convertToPrivate` and `POST /api/admin.conversations.convertToPublic` accept `channel_id`. Use a user token belonging to a seeded admin; bot and test tokens return `not_allowed_token_type`, and non-admin users return `missing_scope`. With `slack.strict_scopes: true`, the token also needs `admin.conversations:write`. For example:

```yaml
slack:
  tokens:
    - token: local-admin-user
      type: user
      user: admin
      scopes: [admin.conversations:write, channels:read, groups:read]
```

Conversions preserve the channel ID, members, and history, update visibility in conversation and file reads, and append a `message` with subtype `channel_convert_to_private` or `channel_convert_to_public`. Event callbacks include the acting user and the new `channel_type` (`group` or `channel`). Admins need not belong to the channel. DMs, MPIMs, and repeated conversions are rejected; `#general` cannot become private.

These methods operate on the emulated workspace without Slack's Enterprise plan or organization-wide installation requirements. Enterprise roles, channel-management policies, and MPIM conversion are not simulated.

### Slack Connect fixtures

Seed a user with a different `team_id` to test messages from another workspace. `users.info` and `users.list` return that user's workspace and `is_stranger` flag. Omitted user teams default to the emulated workspace. `is_stranger` defaults to `false` and can be seeded to model a user outside the app's visible shared channels.

```yaml
slack:
  users:
    - name: partner
      team_id: T_PARTNER
      is_stranger: false
  tokens:
    - token: xoxp-partner
      type: user
      user: partner
      scopes: [chat:write]
```

Use the seeded user token to act as the external user. Invite the user and your app's bot to a channel with `conversations.invite`, then post a message mentioning the bot. The app-mention event includes the author's `user_team` and `source_team`; the outer `team_id` identifies the receiving installation workspace selected by the token, which defaults to the emulated workspace. Ordinary message callbacks retain the author user ID, which can be resolved with `users.info`.

A channel with external members returns `is_ext_shared: true` and `is_shared: true`; its event callbacks include `is_ext_shared_channel: true`. Seed `channels[].is_ext_shared: true` to model an already shared channel. Sharing remains set after the last external member leaves or is removed, including across saved state. Slack Connect invitation and approval flows, workspace disconnection, and per-workspace channel settings are not simulated.

### Event retries

Use `POST /_slack/simulate/event-retry` with an authenticated emulator token and JSON `{ "event_id": "Ev...", "reason": "http_timeout" }` to test event deduplication. Get the event ID from a received callback or the inspector's Events tab. The simulator resends the latest recorded delivery for that event to its original subscription, preserving the entire payload and event ID. If several subscribers received it, only the latest recipient is retried.

Each attempt gets an increasing `X-Slack-Retry-Num`, starting at `1`, and `X-Slack-Retry-Reason` (default `http_timeout`). Reasons also accept `http_error`, `connection_failed`, `ssl_error`, `too_many_redirects`, and `unknown_error`. When `slack.signing_secret` is configured, the retry gets a fresh request timestamp and signature. The response includes `delivery_id`, `retry_num`, `success`, and `status_code`; a failed callback is recorded and still consumes a retry number.

Retries are explicit, with no automatic scheduling or three-attempt limit. Only the latest 1,000 event deliveries are retained in memory, so retries are unavailable after their history is evicted or the emulator restarts. Unknown events return `event_not_found`, and an inactive subscription returns `subscription_inactive`.

### Interactivity

Buttons and modal submissions can invoke your app's Interactivity Request URL. Configure `interactivity_url` on a seeded `slack.oauth_apps` entry and set `slack.signing_secret` to the same secret used by your receiver:

```yaml
slack:
  signing_secret: local-signing-secret
  oauth_apps:
    - app_id: A_MY_APP
      client_id: my-client
      client_secret: my-secret
      name: My App
      redirect_uris: []
      interactivity_url: http://localhost:3000/slack/interactions
```

- `POST /_slack/simulate/block-actions` accepts `channel`, `message_ts`, and a button selector (`action_id`, exact `text`, or `url`), plus the acting `user` ID or name. It supports buttons in actions blocks and section accessories, including ephemeral messages visible to that user. The simulator requires an authenticated emulator token and the acting user must belong to the conversation.
- `POST /_slack/simulate/view-submission` accepts `view_id`, optional `user`, and `values` keyed by input block ID. Text inputs take strings; static selects and radio buttons take an option value; multi-selects and checkboxes take arrays of option values. Omitted values retain previous input or initial values. Other input elements return `unsupported_element`.

Callbacks are `application/x-www-form-urlencoded` with one `payload` JSON field, signed over the exact encoded request body. Button payloads include an app-bound, single-use `trigger_id` that can open a modal for the acting user. App ownership is preserved for messages posted with an app's bot or user token. Simulators return the payload and `delivery_id`; attempts and delivery results are saved in `slack.interaction_deliveries`.

A button payload's `response_url` accepts JSON without a bearer token, up to five times within 30 minutes. It posts an ephemeral reply by default, or a public reply with `response_type: "in_channel"`. Use `replace_original: true` or `delete_original: true` to modify the source message. Replacement retains the source message's visibility. Rich blocks and thread replies are supported.

A modal receiver must acknowledge within three seconds. An empty HTTP 200 closes the submitted view, while `response_action: "clear"` closes its stack. `errors` retains the view and returns block errors; `update` replaces its contents; `push` adds a new view subject to the three-view limit. Delivery failures and invalid acknowledgements leave the modal open. Shortcuts, slash commands, non-button actions, `view_closed`, and `block_suggestion` are not simulated.

### OAuth
- `GET /oauth/v2/authorize` - authorization (shows user picker)
- `POST /oauth/v2/authorize/callback` - local user picker callback that creates the auth code
- `POST /api/oauth.v2.access` - token exchange
- `POST /api/apps.uninstall` - uninstall an app and revoke its workspace tokens

`POST /api/apps.uninstall` accepts `client_id`, `client_secret`, and an installation's user token in the Authorization header or POST `token` field. It removes that app's installation in the token's workspace and revokes all associated OAuth bot and user tokens, including earlier grants. Revoked credentials return `token_revoked` on Web API calls even with permissive authentication. Other apps and workspaces keep their credentials. Granular bot tokens cannot uninstall an app and return `no_permission`; configured development tokens without an app binding may uninstall a local installation. No method scope is required.

Uninstall dispatches `app_uninstalled` and `tokens_revoked` to matching event subscriptions with the removed app's `api_app_id`. `tokens_revoked.tokens.oauth` and `.bot` contain deduplicated user IDs, never token strings. Credentials are invalid before callbacks are delivered. Handlers should accept either event order. The app definition remains available for a new OAuth installation; reinstalling issues fresh tokens without reactivating revoked ones.

### Inspector
- `GET /` - tabbed local inspector for conversations, messages, files, views, auth records, incoming webhooks, event subscriptions, and event deliveries

When a supported Slack write emits an `event_callback`, the payload contains the inner `event` plus outer `team_id`, `event_id`, and `event_time`. The team comes from the presented Slack token's installation; development tokens without a stored Slack record fall back to the affected channel, user, or file's team, then the seeded workspace team (or `T000000001`). Incoming webhook posts use their webhook record's team, or the target channel's team when no record matches. `event_time` is an integer Unix timestamp in seconds. Each logical event gets a new `event_id`, shared across deliveries to multiple subscribers.

To test bot handlers, invite an installed app's `bot_user_id` with `conversations.invite`, subscribe to `app_mention`, then post text containing `<@BOT_USER_ID>` with `chat.postMessage`. Channel mentions produce one callback per mentioned app, with outer `api_app_id`, inner `event_ts`, and the original message and thread identity. DMs and MPIMs use `message` events.

Slack scope checks are relaxed by default so local tests can use simple bearer tokens. Set `slack.strict_scopes: true` in seed config to make supported Web API methods return Slack-style `missing_scope` errors with `needed` and `provided` fields. Strict mode checks `chat:write`, `channels:read`, `channels:history`, `channels:join`, `channels:manage`, `channels:write`, `groups:read`, `groups:history`, `groups:write`, `im:read`, `im:history`, `im:write`, `mpim:read`, `mpim:history`, `mpim:write`, `users:read`, `users:read.email`, `users.profile:read`, `users.profile:write`, `users:write`, `files:read`, `files:write`, `pins:read`, `pins:write`, `bookmarks:read`, `bookmarks:write`, `reactions:read`, `reactions:write`, `team:read`, and `admin.conversations:write`. Slack lists no method-specific scopes for `views.publish`, `views.open`, `views.update`, or `views.push`, so the emulator requires auth but does not add strict-scope checks for those methods.

Current Slack limits: Slack Connect invitation and approval flows, per-workspace channel settings, other Enterprise Grid admin APIs, Audit Logs API, SCIM, Legal Holds, Socket Mode, slash commands, shortcuts, and interaction types other than button actions and modal submissions, user groups, reminders, stars, calls, canvases, lists, functions, workflows, chat streaming, legacy `files.upload`, exact rate limiting, and paid-plan behavior are not implemented.

## Resend API

### Recipient restrictions and send attempts

Set `resend.allowlist` in seed config to test recipient rejection:

```yaml
resend:
  allowlist:
    - allowed@example.com
    - copy@example.com
```

Omitting `allowlist` accepts every recipient; `allowlist: []` rejects every recipient. Every address in `to`, `cc`, and `bcc` must be listed. Matching ignores surrounding whitespace and letter case; entries are individual addresses, with no wildcard or domain matching. This is a local testing control, independent of Resend's domain verification and account restrictions.

A rejected send returns `403 validation_error` naming the rejected addresses and configured allowlist. No email ID, email record, idempotency record, or webhook is created. A batch is rejected as a whole if any recipient is disallowed. Retrying a rejected request, even with the same idempotency key, creates a new attempt. Replaying an accepted idempotent request returns its original response even if the allowlist has since changed.

Validated sends append one record per email to the `resend.send_attempts` store collection, including emails in a rejected batch. Each record contains `from`, `to`, `cc`, `bcc`, `subject`, `idempotency_key` (or `null`), and the store's `id`, `created_at`, and `updated_at`. Message bodies are not copied into attempts. Malformed requests, invalid or conflicting idempotency keys, and idempotency replays do not append attempts.

Read attempts with `getResendStore(store).sendAttempts.all()` from `@emulators/resend`, or inspect the persisted state. Shared adapter snapshots use the key `resend:resend.send_attempts`. Attempts and recipient restrictions survive saved-state restoration, including rejected sends. There is no additional Resend API endpoint for attempts. A rejected send has an attempt without an email; a send that never happened has neither.

## Linear API

Stateful Linear GraphQL API emulation with seeded organizations, users, teams, workflow states, issues, comments, labels, projects, cycles, OAuth apps, tokens, webhooks, and basic agent sessions. GraphQL reads and writes mutate in-memory state and use Relay-style connections with opaque cursors. OAuth supports authorization code, PKCE, refresh token, revoke, client credentials, and `actor=app` tokens for local app-actor tests. Supported writes dispatch Linear-shaped webhook payloads with `Linear-Delivery`, `Linear-Event`, and `Linear-Signature` headers when webhooks are configured.

### GraphQL

- `POST /graphql` - GraphQL endpoint for queries and mutations
- `GET /graphql` - query-string GraphQL endpoint for tooling
- Queries: `viewer`, `organization`, `users`, `user`, `teams`, `team`, `workflowStates`, `workflowState`, `issues`, `issue`, `comments`, `comment`, `issueLabels`, `issueLabel`, `projects`, `project`, `cycles`, `cycle`, `webhooks`, `webhook`, `agentSessions`, `agentSession`
- Mutations: `issueCreate`, `issueUpdate`, `issueDelete`, `issueArchive`, `issueUnarchive`, `commentCreate`, `commentUpdate`, `commentDelete`, `issueLabelCreate`, `issueLabelUpdate`, `issueLabelDelete`, `issueAddLabel`, `issueRemoveLabel`, `webhookCreate`, `webhookDelete`, `agentSessionCreateOnIssue`, `agentSessionCreateOnComment`, `agentSessionUpdate`, `agentActivityCreate`

Issue selections expose both numeric `priority` and Linear's derived `priorityLabel` values: `No priority`, `Urgent`, `High`, `Medium`, and `Low`.

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

Microsoft Entra ID (Azure AD) v2.0 OAuth 2.0 and OpenID Connect emulation with authorization code flow, PKCE, client credentials, client-bound refresh tokens, RS256 ID tokens, and OIDC discovery.

- `GET /.well-known/openid-configuration` - OIDC discovery document
- `GET /:tenant/v2.0/.well-known/openid-configuration` - tenant-scoped OIDC discovery
- `GET /discovery/v2.0/keys` - JSON Web Key Set (JWKS)
- `GET /oauth2/v2.0/authorize` - authorization endpoint (shows user picker)
- `POST /oauth2/v2.0/token` - token exchange (authorization code, refresh token, client credentials)
- `GET /oidc/userinfo` - OpenID Connect user info
- `GET /v1.0/me` - Microsoft Graph user profile
- `GET /oauth2/v2.0/logout` - end session / logout
- `POST /oauth2/v2.0/revoke` - token revocation

Refresh token requests must include the `client_id` and `client_secret` of the client that received the token. Refresh tokens rotate after successful use. Legacy refresh records without a stored client binding remain supported.

```bash
curl -X POST http://localhost:4005/oauth2/v2.0/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "refresh_token=r_microsoft_...&\
client_id=example-client-id&\
client_secret=example-client-secret&\
grant_type=refresh_token"
```

## AWS

S3, SQS, IAM, and STS emulation with AWS SDK-compatible S3 paths. S3 uploads and downloads preserve arbitrary binary payloads, including raw byte lengths and ETags. SQS supports AWS JSON 1.0 and XML Query protocols; IAM and STS use XML Query.

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

Current AWS SDK clients work with the `/sqs` endpoint:

```typescript
import { SQSClient, ListQueuesCommand } from "@aws-sdk/client-sqs";

const sqs = new SQSClient({
  endpoint: "http://localhost:4007/sqs",
  region: "us-east-1",
  credentials: {
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  },
});

await sqs.send(new ListQueuesCommand({}));
```

SQS accepts AWS JSON 1.0 requests at `POST /sqs/` with `Content-Type: application/x-amz-json-1.0` and `X-Amz-Target: AmazonSQS.<Action>`, returning JSON results and errors. XML Query requests with an `Action` form parameter remain supported. Queue operations also accept the returned `QueueUrl` as the endpoint.

Supported operations:

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

GitHub App seeds may omit `private_key`. Retain the handler to call server-only `generatedSecrets()`; explicit keys are excluded. Persisted snapshots contain generated keys, so keep the backend private.

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

The persistence adapter loads on cold start and saves after mutations. Generated identities also require atomic create-or-read `initialize`; see `@emulators/core`.

## Nuxt Integration

Embed emulators directly in your Nuxt app so they run on the same origin. This gives OAuth flows stable callback URLs in local and preview deployments.

### Install

```bash
npm install @emulators/adapter-nuxt @emulators/github @emulators/google
```

Only install the emulators you need. Each `@emulators/*` package is published independently.

### Server route

Create a named catch-all route that serves emulator traffic:

```typescript
// server/routes/emulate/[...path].ts
import { createEmulateHandler } from '@emulators/adapter-nuxt'
import * as github from '@emulators/github'
import * as google from '@emulators/google'

export default defineEventHandler(createEmulateHandler({
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
}))
```

GitHub App seeds may omit `private_key`. Retain the handler to call server-only `generatedSecrets()`; explicit keys are excluded. Persisted snapshots contain generated keys, so keep the backend private.

### Nuxt config

Emulator UI pages use bundled fonts. Wrap your Nuxt config so Nitro traces the core package assets into production builds:

```typescript
// nuxt.config.ts
import { withEmulate } from '@emulators/adapter-nuxt'

export default defineNuxtConfig(withEmulate({
  // your normal Nuxt config
}))
```

### OAuth configuration

Point your OAuth provider at the emulator paths on the same origin:

```typescript
const baseUrl = process.env.NUXT_PUBLIC_SITE_URL ?? 'http://localhost:3000'

export const githubOAuth = {
  clientId: 'any-value',
  clientSecret: 'any-value',
  authorizationUrl: `${baseUrl}/emulate/github/login/oauth/authorize`,
  tokenUrl: `${baseUrl}/emulate/github/login/oauth/access_token`,
  userInfoUrl: `${baseUrl}/emulate/github/user`,
}
```

No `oauth_apps` need to be seeded. When none are configured, the emulator skips `client_id`, `client_secret`, and `redirect_uri` validation.

### Persistence

By default, emulator state is in-memory and resets on every cold start. To persist state across restarts, pass a `persistence` adapter:

```typescript
import { createEmulateHandler } from '@emulators/adapter-nuxt'
import * as github from '@emulators/github'

const storageAdapter = {
  async load() { return await useStorage('emulate').getItem<string>('state') },
  async save(data: string) { await useStorage('emulate').setItem('state', data) },
}

export default defineEventHandler(createEmulateHandler({
  services: { github: { emulator: github } },
  persistence: storageAdapter,
}))
```

The persistence adapter loads on cold start and saves after mutations. Generated identities also require atomic create-or-read `initialize`; see `@emulators/core`.

## Architecture

```
packages/
  emulate/          # CLI entry point (commander)
  @emulators/
    core/           # HTTP server, in-memory store, plugin interface, middleware
    adapter-next/   # Next.js App Router integration
    adapter-nuxt/   # Nuxt server route integration
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

## Acknowledgments

The internal HTTP layer builds on [Hono](https://hono.dev)'s API and design. Thank you to Yusuke Wada and the Hono contributors for their work. Hono's copyright and MIT license notice are included in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and distributed with the npm packages.

## Auth

Tokens are configured in the seed config and map to users. Pass them as `Authorization: Bearer <token>` or `Authorization: token <token>`.

**Vercel**: All endpoints accept `teamId` or `slug` query params for team scoping. Pagination uses cursor-based `limit`/`since`/`until` with `pagination` response objects.

**GitHub**: Public repo endpoints work without auth. Private repos and write operations require a valid token. Pagination uses `page`/`per_page` with `Link` headers.

**Google**: Standard OAuth 2.0 authorization code flow with RS256-signed OIDC ID tokens. The discovery document advertises RS256 and `/oauth2/v3/certs` returns the RSA public key used to verify issued tokens. Configure clients in the seed config.

**Slack**: All Web API endpoints require `Authorization: Bearer <token>`. Seeded OAuth apps create local installation records, and OAuth v2 flow with user picker UI creates scoped bot tokens. Optional strict scope mode returns `missing_scope` when a token lacks a required method scope.

**Linear**: GraphQL accepts `Authorization: Bearer <token>` or a bare personal API key value. Seeded Linear tokens map to users or app actors, OAuth apps support local authorization code and client credentials flows, and optional strict scope mode checks supported GraphQL operations.

**Twilio**: HTTP Basic auth accepts the seeded Account SID/Auth Token pair or API Key/API Secret pair. Product-host APIs are exposed under local prefixes such as `/messaging/v1` and `/verify/v2`; the 2010 API lives at `/2010-04-01`.

**Apple**: OIDC authorization code flow with RS256 ID tokens. On first auth per user/client pair, a `user` JSON blob is included.

**Microsoft**: OIDC authorization code flow with PKCE support. Also supports client credentials grants. Microsoft Graph `/v1.0/me` available.

**AWS**: Bearer tokens or IAM access key credentials. Default key pair always seeded: `AKIAIOSFODNN7EXAMPLE` / `wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY`.
