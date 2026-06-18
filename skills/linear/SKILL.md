---
name: linear
description: Emulated Linear GraphQL API for local development and testing. Use when the user needs to test Linear integrations locally, emulate Linear issues, comments, teams, workflow states, OAuth apps, webhooks, agent sessions, or work with the Linear API without hitting the real Linear service. Triggers include "Linear API", "emulate Linear", "mock Linear", "test Linear OAuth", "Linear webhook", "Linear agent", "local Linear", or any task requiring a local Linear API.
allowed-tools: Bash(npx emulate:*)
---

# Linear API Emulator

Stateful Linear GraphQL API emulation with organizations, users, teams, workflow states, issues, comments, labels, projects, cycles, OAuth apps, tokens, webhooks, and basic agent sessions.

## Start

```bash
# Linear only
npx emulate --service linear
```

Default URL: `http://localhost:4012` when all services are started, or `http://localhost:4000` when Linear is the only service.

## URL Mapping

| Real Linear URL | Emulator URL |
|-----------------|--------------|
| `https://api.linear.app/graphql` | `$LINEAR_EMULATOR_URL/graphql` |
| `https://linear.app/oauth/authorize` | `$LINEAR_EMULATOR_URL/oauth/authorize` |
| `https://api.linear.app/oauth/token` | `$LINEAR_EMULATOR_URL/oauth/token` |
| `https://api.linear.app/oauth/revoke` | `$LINEAR_EMULATOR_URL/oauth/revoke` |

## Auth

GraphQL accepts a bearer token or bare personal API key:

```bash
curl "$LINEAR_EMULATOR_URL/graphql" \
  -H "Authorization: Bearer lin_test_admin" \
  -H "Content-Type: application/json" \
  -d '{"query":"{ viewer { id email } }"}'
```

Scope checks are relaxed by default. Set `linear.strict_scopes: true` in seed config to require supported operation scopes such as `read`, `write`, `issues:create`, `comments:create`, and `admin`.

## Seed Config

```yaml
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
  issues:
    - team: ENG
      title: Fix local checkout test
      state: Todo
      assignee: dev@example.com
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
```

## GraphQL Surface

Supported queries:

- `viewer`
- `organization`
- `users`, `user`
- `teams`, `team`
- `workflowStates`, `workflowState`
- `issues`, `issue`
- `comments`, `comment`
- `issueLabels`, `issueLabel`
- `projects`, `project`
- `cycles`, `cycle`
- `webhooks`, `webhook`
- `agentSessions`, `agentSession`

Supported mutations:

- `issueCreate`, `issueUpdate`, `issueDelete`, `issueArchive`, `issueUnarchive`
- `commentCreate`, `commentUpdate`, `commentDelete`
- `issueLabelCreate`, `issueLabelUpdate`, `issueLabelDelete`
- `issueAddLabel`, `issueRemoveLabel`
- `webhookCreate`, `webhookDelete`
- `agentSessionCreateOnIssue`, `agentSessionCreateOnComment`, `agentSessionUpdate`
- `agentActivityCreate`

Connections use Relay-style cursors with `nodes`, `edges`, and `pageInfo`.

## OAuth

- `GET /oauth/authorize` - authorization endpoint with local user picker
- `POST /oauth/authorize/callback` - local user picker callback
- `POST /oauth/token` - authorization code, refresh token, and client credentials grants
- `POST /oauth/revoke` - revoke access or refresh tokens

OAuth apps can use `actor: user` or `actor: app`. The configured actor is authoritative. User actor apps use authorization code flows. App actor apps use the app install flow and can request client credentials tokens. App actor support is sufficient for local agent and service-account tests, but it is not full production Linear agent behavior.

## Webhooks

Create local webhook subscriptions through `webhookCreate` or seed config. Supported writes dispatch Linear-shaped payloads with `Linear-Delivery`, `Linear-Event`, and `Linear-Signature` headers when a secret is configured.

## Inspector

Open `GET /` in the Linear emulator to inspect issues, teams, users, projects, agent sessions, OAuth apps, tokens, webhook subscriptions, and webhook deliveries.

## Current Limits

Full Linear schema coverage, exact production rate limiting, notification inbox behavior, rich document APIs, customer APIs, initiative APIs, exact search relevance, and full production agent behavior are not implemented.
