---
name: emulate
description: Local drop-in API emulator for Vercel, GitHub, Google, Slack, Apple, Microsoft, Okta, Clerk, AWS, MongoDB Atlas, Resend, and Stripe. Use when the user needs to start emulated services, configure seed data, write tests against local APIs, set up CI without network access, scaffold Vercel Go Function previews, or work with the emulate CLI or programmatic API. Triggers include "start the emulator", "emulate services", "mock API locally", "create emulator config", "test against local API", "npx emulate", "npx emulate vercel init", or any task requiring local service emulation.
allowed-tools: Bash(npx emulate:*)
---

# Service Emulation with emulate

Local drop-in replacement services for CI and no-network sandboxes. Fully stateful, production-fidelity API emulation, not mocks.

## Quick Start

```bash
npx emulate
```

The npm CLI launches the native Go engine. All services start on one local server with sensible defaults:

```bash
http://localhost:4000
```

## CLI

```bash
# Start all services (zero-config)
npx emulate

# Start specific services
npx emulate --service vercel,github

# Custom native server port
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
| `--base-url` | none | Override advertised base URL (supports `{service}` template) |
| `--portless` | off | Serve over HTTPS via portless (auto-registers aliases) |
| `--allow-local-lambda` | off | Allow localhost AWS Lambda Node.js ZipFile code execution |

The port can also be set via `EMULATE_PORT` or `PORT` environment variables.

The advertised base URL can be overridden via `--base-url`, the `EMULATE_BASE_URL` env var, or per-service `baseUrl` in the seed config. `{service}` templates require exactly one selected service in native single-server mode; use `--portless` for per-service aliases.

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

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `service` | *(required)* | `'vercel'`, `'github'`, `'google'`, `'slack'`, `'apple'`, `'microsoft'`, `'okta'`, `'aws'`, `'resend'`, `'stripe'`, `'mongoatlas'`, or `'clerk'` |
| `port` | `4000` | Port for the HTTP server |
| `seed` | none | Inline seed data (same shape as YAML config) |
| `baseUrl` | none | Override advertised base URL. Per-service `baseUrl` in seed config takes highest priority, then this option, then `EMULATE_BASE_URL` env var (supports `{service}`), then `PORTLESS_URL` (supports `{service}`, automatically set by the `portless` CLI wrapper), then `http://localhost:<port>`. |
| `allowLocalLambda` | `false` | Allow AWS Lambda Node.js ZipFile code execution for localhost invokes signed by a known AWS access key |

### Instance Methods

| Method | Description |
|--------|-------------|
| `url` | Base URL of the running server |
| `reset()` | Restart the native process and replay seed data, returns a Promise |
| `close()` | Shut down the HTTP server, returns a Promise |

## Vitest / Jest Setup

```typescript
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

## Configuration

Configuration is optional. The CLI auto-detects config files in this order:

1. `emulate.config.yaml` / `.yml`
2. `emulate.config.json`
3. `service-emulator.config.yaml` / `.yml`
4. `service-emulator.config.json`

Or pass `--seed <file>` explicitly. Run `npx emulate init` to generate a starter file.

### Config Structure

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
  integrations:
    - client_id: oac_abc123
      client_secret: secret_abc123
      name: My Vercel App
      redirect_uris:
        - http://localhost:3000/api/auth/callback/vercel

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
  oauth_apps:
    - client_id: Iv1.abc123
      client_secret: secret_abc123
      name: My Web App
      redirect_uris:
        - http://localhost:3000/api/auth/callback/github

google:
  users:
    - email: testuser@example.com
      name: Test User
  oauth_clients:
    - client_id: my-client-id.apps.googleusercontent.com
      client_secret: GOCSPX-secret
      redirect_uris:
        - http://localhost:3000/api/auth/callback/google

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
  sqs:
    queues:
      - name: my-app-events
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
```

### Auth

Tokens map to users. Pass them as `Authorization: Bearer <token>` or `Authorization: token <token>`. When no tokens are configured, a default `test_token_admin` is created for the `admin` user.

Each service also has a fallback user. If no token is provided, requests authenticate as the first seeded user.

## HTTPS with portless

[portless](https://github.com/vercel-labs/portless) gives emulators trusted HTTPS URLs with auto-generated certs. Use the `--portless` flag to auto-register each service as a portless alias:

```bash
npx emulate start --portless
# github  https://github.emulate.localhost
# google  https://google.emulate.localhost
# ...
```

This requires the portless proxy to be running (`portless proxy start`). If portless is not installed, install it with `npm i -g portless`.

The `--portless` flag overwrites any existing portless aliases matching `*.emulate`. Aliases are removed automatically when emulate shuts down.

For a single service behind portless:

```bash
portless github.emulate emulate start --service github
```

For a custom base URL without portless (any reverse proxy):

```bash
npx emulate start --service github --base-url "https://github.myproxy.test"
# or
EMULATE_BASE_URL="https://github.myproxy.test" npx emulate start --service github
```

The `PORTLESS_URL` env var is automatically set by the `portless` CLI wrapper when running a command through it. `{service}` interpolation is supported when exactly one service is enabled. When no explicit `baseUrl` is provided, it is used as a fallback.

Per-service overrides in the seed config (these take highest priority over all other base URL sources):

```yaml
github:
  baseUrl: https://github.emulate.localhost
google:
  baseUrl: https://google.emulate.localhost
```

## Pointing Your App at the Emulator

Set environment variables to override real service URLs:

```bash
VERCEL_EMULATOR_URL=http://localhost:4000
GITHUB_EMULATOR_URL=http://localhost:4000
GOOGLE_EMULATOR_URL=http://localhost:4000
SLACK_EMULATOR_URL=http://localhost:4000
APPLE_EMULATOR_URL=http://localhost:4000
MICROSOFT_EMULATOR_URL=http://localhost:4000
OKTA_EMULATOR_URL=http://localhost:4000
AWS_EMULATOR_URL=http://localhost:4000
RESEND_EMULATOR_URL=http://localhost:4000
STRIPE_EMULATOR_URL=http://localhost:4000
MONGOATLAS_EMULATOR_URL=http://localhost:4000
```

Then use these in your app to construct API and OAuth URLs. See each service's skill for SDK-specific override instructions.

## Next.js Integration

The `@emulators/adapter-next` package proxies native runtime routes on the same Next.js origin. For native Go `apple`, `aws`, `clerk`, `github`, `google`, `microsoft`, `mongoatlas`, `okta`, `resend`, `slack`, `stripe`, and `vercel` previews on Vercel, run `npx emulate vercel init` to generate `api/emulate.go`, `vercel.json`, and `go.mod`. See the **next** skill (`skills/next/SKILL.md`) for setup, Auth.js configuration, Vercel Go Function state behavior, and `createEmulateProxy` details.

## Persistence

By default, all local CLI and programmatic API state is in-memory. Vercel Go Function previews use warm in-memory state by default. For snapshots across cold starts, implement `vercel.Persistence` in `api/emulate.go` and pass it to `emulate.NewHandler`.

## Architecture

```
packages/
  emulate/           # npm CLI shim + native process programmatic API
  @emulators/
    core/            # compatibility helpers and native proxy facade
    adapter-next/    # Next.js App Router proxy integration
    vercel/          # Vercel API metadata and compatibility package
    github/          # GitHub API metadata and compatibility package
    google/          # Google metadata and compatibility package
    slack/           # Slack metadata and compatibility package
    apple/           # Apple metadata and compatibility package
    microsoft/       # Microsoft metadata and compatibility package
    aws/             # AWS metadata, compatibility package, and SDK conformance tests
```

Service routing, state, UI, and protocol behavior live in Go under `internal/`.
