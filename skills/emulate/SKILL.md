---
name: emulate
description: Local drop-in API emulator for Vercel, GitHub, Google, Slack, Apple, Microsoft, and AWS. Use when the user needs to start emulated services, configure seed data, write tests against local APIs, set up CI without network access, or work with the emulate CLI or programmatic API. Triggers include "start the emulator", "emulate services", "mock API locally", "create emulator config", "test against local API", "npx emulate", or any task requiring local service emulation.
allowed-tools: Bash(npx emulate:*), Bash(emulate:*)
---

# Service Emulation with emulate

Local drop-in replacement services for CI and no-network sandboxes. Fully stateful, production-fidelity API emulation, not mocks.

## Quick Start

```bash
npx emulate
```

All services start with sensible defaults:

| Service   | Default Port |
|-----------|-------------|
| Vercel    | 4000        |
| GitHub    | 4001        |
| Google    | 4002        |
| Slack     | 4003        |
| Apple     | 4004        |
| Microsoft | 4005        |
| AWS       | 4006        |

## CLI

```bash
# Start all services (zero-config)
emulate

# Start specific services
emulate --service vercel,github

# Custom base port (auto-increments per service)
emulate --port 3000

# Use a seed config file
emulate --seed config.yaml

# Generate a starter config
emulate init

# Generate config for a specific service
emulate init --service vercel

# List available services
emulate list
```

### Options

| Flag | Default | Description |
|------|---------|-------------|
| `-p, --port` | `4000` | Base port (auto-increments per service) |
| `-s, --service` | all | Comma-separated services to enable |
| `--seed` | auto-detect | Path to seed config (YAML or JSON) |

The port can also be set via `EMULATE_PORT` or `PORT` environment variables.

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
| `service` | *(required)* | `'vercel'`, `'github'`, `'google'`, `'slack'`, `'apple'`, `'microsoft'`, or `'aws'` |
| `port` | `4000` | Port for the HTTP server |
| `seed` | none | Inline seed data (same shape as YAML config) |

### Instance Methods

| Method | Description |
|--------|-------------|
| `url` | Base URL of the running server |
| `reset()` | Wipe the store and replay seed data |
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

afterEach(() => { github.reset(); vercel.reset() })
afterAll(() => Promise.all([github.close(), vercel.close()]))
```

## Configuration

Configuration is optional. The CLI auto-detects config files in this order:

1. `emulate.config.yaml` / `.yml`
2. `emulate.config.json`
3. `service-emulator.config.yaml` / `.yml`
4. `service-emulator.config.json`

Or pass `--seed <file>` explicitly. Run `emulate init` to generate a starter file.

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

## Pointing Your App at the Emulator

Set environment variables to override real service URLs:

```bash
VERCEL_EMULATOR_URL=http://localhost:4000
GITHUB_EMULATOR_URL=http://localhost:4001
GOOGLE_EMULATOR_URL=http://localhost:4002
SLACK_EMULATOR_URL=http://localhost:4003
APPLE_EMULATOR_URL=http://localhost:4004
MICROSOFT_EMULATOR_URL=http://localhost:4005
AWS_EMULATOR_URL=http://localhost:4006
```

Then use these in your app to construct API and OAuth URLs. See each service's skill for SDK-specific override instructions.

## Next.js Integration (Embedded Mode)

The `@emulators/adapter-next` package embeds emulators directly into a Next.js app on the same origin. See the **next** skill (`skills/next/SKILL.md`) for full setup, Auth.js configuration, persistence, and font tracing details.

## Persistence

By default, all emulator state is in-memory. For persistence across process restarts and serverless cold starts, use a `PersistenceAdapter`.

### Built-in file persistence

```typescript
import { filePersistence } from '@emulators/core'

// CLI or local dev: persists to a JSON file
const adapter = filePersistence('.emulate/state.json')
```

### Custom adapters

```typescript
import type { PersistenceAdapter } from '@emulators/core'

const kvAdapter: PersistenceAdapter = {
  async load() { return await kv.get('emulate-state') },
  async save(data) { await kv.set('emulate-state', data) },
}
```

State is loaded on cold start and saved after every mutating request (POST, PUT, PATCH, DELETE). Saves are serialized to prevent race conditions.

## Architecture

```
packages/
  emulate/           # CLI entry point + programmatic API
  @emulators/
    core/            # HTTP server (Hono), Store, plugin interface, middleware
    adapter-next/    # Next.js App Router integration
    vercel/          # Vercel API service plugin
    github/          # GitHub API service plugin
    google/          # Google OAuth 2.0 / OIDC plugin
    slack/           # Slack Web API, OAuth, incoming webhooks plugin
    apple/           # Sign in with Apple / OIDC plugin
    microsoft/       # Microsoft Entra ID OAuth 2.0 / OIDC plugin
    aws/             # AWS S3, SQS, IAM, STS plugin
```

The core provides a generic `Store` with typed `Collection<T>` instances supporting CRUD, indexing, filtering, and pagination. Each service plugin registers routes on the shared Hono app and uses the store for state.
