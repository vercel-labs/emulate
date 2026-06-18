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
- Mutations for issues, comments, labels, webhooks, and basic agent sessions and activities.
- OAuth authorize, token, refresh, revoke, PKCE, client credentials, and app actor tokens.
- Personal API key and OAuth bearer token auth.
- Linear-shaped webhook delivery with `Linear-Delivery`, `Linear-Event`, and `Linear-Signature` headers.
- Local inspector at `/`.

This is not a complete Linear clone. Unsupported GraphQL fields return GraphQL errors.
