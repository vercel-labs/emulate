---
name: linear
description: Emulated Linear GraphQL API for local development and testing. Use when the user needs to test Linear integrations locally, emulate Linear issues, comments, teams, workflow states, OAuth apps, webhooks, agent sessions, or work with the Linear API without hitting the real Linear service. Triggers include "Linear API", "emulate Linear", "mock Linear", "test Linear OAuth", "Linear webhook", "Linear agent", "local Linear", or any task requiring a local Linear API.
allowed-tools: Bash(npx emulate:*)
---

# Linear API Emulator

Stateful Linear GraphQL API emulation with organizations, users, teams, workflow states, issues, comments, labels, projects, cycles, OAuth apps, tokens, webhooks, and agent sessions.

## Start

Local listeners bind to `127.0.0.1` by default. For access from containers or other machines, pass `--host 0.0.0.0` to the CLI or `hostname: '0.0.0.0'` to `createEmulator`. Configure `--base-url` or `baseUrl` for advertised URLs reachable by those clients.

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
- `agentSessions`, `agentSession`, `agentActivities`, `agentActivity`

Supported mutations:

- `issueCreate`, `issueUpdate`, `issueDelete`, `issueArchive`, `issueUnarchive`
- `commentCreate`, `commentUpdate`, `commentDelete`
- `issueLabelCreate`, `issueLabelUpdate`, `issueLabelDelete`
- `issueAddLabel`, `issueRemoveLabel`
- `webhookCreate`, `webhookDelete`
- `agentSessionCreateOnIssue`, `agentSessionCreateOnComment`, `agentSessionUpdate`, `agentSessionUpdateExternalUrl`
- `agentActivityCreate`

Connections use Relay-style cursors with `nodes`, `edges`, and `pageInfo`.

Issue selections expose both numeric `priority` and Linear's derived `priorityLabel` values: `No priority`, `Urgent`, `High`, `Medium`, and `Low`.

## OAuth

- `GET /oauth/authorize` - authorization endpoint with local user picker
- `POST /oauth/authorize/callback` - local user picker callback
- `POST /oauth/token` - authorization code, refresh token, and client credentials grants
- `POST /oauth/revoke` - revoke access or refresh tokens

OAuth apps can use `actor: user` or `actor: app`. The configured actor is authoritative. User actor apps use authorization code flows. App actor apps use the app install flow and can request client credentials tokens.

## Webhooks

Create local webhook subscriptions through `webhookCreate` or seed config. Supported writes dispatch Linear-shaped payloads with `Linear-Delivery`, `Linear-Event`, and `Linear-Timestamp` headers, plus `Linear-Signature` when a secret is configured. Issue payloads include the workflow `state` (`id`, `name`, `type`, `color`), and `updatedFrom` on updates lists only the previous values of the properties that changed.

## Agent Sessions

Agents call the API with an app actor token: a token for an OAuth app configured with `actor: app`. The app's user owns the sessions it works in. A session is created with status `pending` when an issue is delegated to the app user, when a comment mentions it, or when the agent calls `agentSessionCreateOnIssue` or `agentSessionCreateOnComment`.

```yaml
linear:
  oauth_apps:
    - client_id: agent_client
      client_secret: agent_secret
      name: Emulate Agent
      redirect_uris:
        - http://localhost:3000/callback
      actor: app
      mentionable: true
  tokens:
    - token: lin_agent
      type: oauth_access
      app: agent_client
  webhooks:
    - url: http://localhost:3000/api/linear/webhook
      resource_types: [AgentSessionEvent]
      secret: local-secret
```

`agentActivityCreate` takes Linear's `AgentActivityCreateInput`, so `@linear/sdk`'s `createAgentActivity` works against the emulator:

- `content` is `thought`, `elicitation`, `response`, or `error` with a Markdown `body` (errors also take a `reasonCode`), or `action` with `action`, `parameter`, and an optional `result`.
- `ephemeral` is allowed only on thought and action activities.
- `signal` is `continue` on a response, or `auth` (with `signalMetadata.url`) or `select` (with 1 to 100 `signalMetadata.options`) on an elicitation.
- `id` optionally sets the activity's UUID.

Invalid shapes are rejected, as are prompts and the `stop` signal from an agent token and activities on another agent's session. `AgentActivity.content` is the `AgentActivityContent` union, so select its fields with inline fragments.

The session's `status` follows the latest activity: a thought or action makes it `active`, an elicitation `awaitingInput`, a response `complete` (or keeps it `active` with `continue`), and an error `error`, which also clears the plan. `startedAt` and `endedAt` track the latest turn.

`agentSessionUpdate` sets the `plan` (1 to 100 `{ content, status }` entries, returned as `{ entries, updatedAt }`), the `summary`, and the links through `externalLink`, `externalUrls`, `addedExternalUrls`, and `removedExternalUrls`. `agentSessionUpdateExternalUrl` changes only the links. Any update other than a summary moves a `pending` session to `active`. As in Linear, JSON fields such as `plan`, `externalUrls`, and `signalMetadata` are returned as JSON-encoded strings, which `@linear/sdk` parses.

`agentActivities`, `agentActivity`, and `AgentSession.activities` read activities, filtered by `agentSessionId`, `id`, or `type` and ordered by `createdAt` or `updatedAt`.

In Linear, prompts come from users writing in the app. To simulate one, call `agentActivityCreate` with a human token such as `lin_test_admin` and `content: { type: "prompt", body }`. The prompt starts a new turn and makes the session `active`, or `stopping` with `signal: stop`.

Webhooks subscribed to `AgentSessionEvent` receive Linear's `AgentSessionEventWebhookPayload`: `agentSession` (with its issue, comment, and creator), `appUserId`, `oauthClientId`, and `organizationId`. A `created` event adds `promptContext`, built from the issue, its team, labels, and project, the comment that started the session, and the issue's other comments. A `prompted` event adds the prompt as `agentActivity`.

The emulator's earlier agent inputs still work: `agentActivityCreate` with `{ sessionId, type, body }`, which also accepts `type: prompt` from a human token, `agentUserId`, string `plan`, and `externalUrl` on session inputs, and `state` on `agentSessionUpdate`. Sessions keep their `state`, `externalUrl`, and `agentUser` fields, and activities keep `type`, `body`, and `session`.



Open `GET /` in the Linear emulator to inspect issues, teams, users, projects, agent sessions, OAuth apps, tokens, webhook subscriptions, and webhook deliveries.

## Current Limits

Full Linear schema coverage, exact production rate limiting, notification inbox behavior, rich document APIs, customer APIs, initiative APIs, exact search relevance, archiving agent sessions and activities, session dismissal by users, agent guidance, repository suggestions, and routing `AgentSessionEvent` webhooks to the owning app alone are not implemented.

## Custom emulators alongside built-ins

Use `npx emulate init --custom inventory` to scaffold a third-party API emulator and test. Register it in `emulate.config.ts` with `defineConfig` from `emulate`, alongside built-in entries such as `{ emulator: "linear" }`. Run `npx emulate start --watch` to reload imports and inspect custom state at the printed `/_emulate` URL. Successful reloads reset the run to seed. Existing flat seed configs still work; `--config` selects an explicit file. For authoring and testing third-party API emulators, see https://emulate.dev/docs/custom-emulators.
