# @emulators/linear

Stateful Linear GraphQL API emulator for local development and CI.

Part of [emulate](https://github.com/vercel-labs/emulate), local drop-in replacement services for CI and no-network sandboxes.

## Install

```sh
npm install @emulators/linear
```

Most users should run it through the main CLI:

```sh
npx emulate --service linear
```

## Supported Surface

- `POST /graphql` for a focused Linear GraphQL subset.
- Queries for viewer, organization, users, teams, workflow states, issues, comments, labels, projects, cycles, webhooks, and agent sessions.
- Mutations for issues, comments, labels, webhooks, and production-shaped agent sessions and activities (nested activity content, plans, externalUrls, signals, ephemeral replacement, queued prompts, session status lifecycle, AgentSessionEvent webhooks, and local human prompt simulation).
- Agent activity connections support archive visibility, filters, ordering, and Relay pagination. Created-session webhooks include escaped prompt context for modeled issue metadata and directive comments.
- OAuth authorize, token, refresh, revoke, PKCE, client credentials, and app actor tokens.
- Personal API key and OAuth bearer token auth.
- Linear-shaped webhook delivery with `Linear-Delivery`, `Linear-Event`, and `Linear-Signature` headers.
- Local inspector at `/`.

OAuth app `actor` config is authoritative. Apps configured with `actor: user` use authorization code flows. Apps configured with `actor: app` use the app install flow and can request client credentials tokens.

The default seeds provide `lin_test_admin` for human operations and `lin_test_agent` for Agent Interaction mutations. Human prompt simulation through `agentActivityCreatePrompt` requires the human token.

This is not a complete Linear clone. Unsupported GraphQL fields return GraphQL errors.
