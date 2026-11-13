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
- Issue selections include numeric `priority` and the derived `priorityLabel`.
- Mutations for issues, comments, labels, webhooks, and agent sessions and activities.
- Agent sessions and activities with Linear's `AgentActivityCreateInput`, the `AgentActivityContent` union, activity-driven session `status`, plans, external links, and `AgentSessionEvent` `created` and `prompted` webhooks, compatible with `@linear/sdk`.
- OAuth authorize, token, refresh, revoke, PKCE, client credentials, and app actor tokens.
- Personal API key and OAuth bearer token auth.
- Linear-shaped webhook delivery with `Linear-Delivery`, `Linear-Event`, `Linear-Signature`, and `Linear-Timestamp` headers, issue `state` payloads, and `updatedFrom` limited to the changed properties.
- Local inspector at `/`.

OAuth app `actor` config is authoritative. Apps configured with `actor: user` use authorization code flows. Apps configured with `actor: app` use the app install flow and can request client credentials tokens.

This is not a complete Linear clone. Unsupported GraphQL fields return GraphQL errors.
