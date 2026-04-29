---
name: linear
description: Emulated Linear GraphQL API for local development and testing. Use when the user needs to test Linear API integrations locally, query issues or projects, validate GraphQL clients, or avoid hitting the real Linear API.
allowed-tools: Bash(npx emulate:*), Bash(curl:*)
---

# Linear API Emulator

Phase 1 provides a read only Linear GraphQL emulator.

Included now:

- `POST /graphql`
- GraphQL schema introspection
- PAT authentication with `Authorization: <api_key>`
- Query resolvers for `Issue`, `Project`, `Team`, `User`, `Organization`, `Label`, and `WorkflowState`
- Relay style pagination with `edges`, `nodes`, and `pageInfo`

Follow up PRs will add mutations, webhooks, OAuth 2.0, and an inspector UI.

## Start

```bash
npx emulate --service linear
```

Default URL:

```text
http://localhost:4012
```

## Auth

Use a seeded Linear API key as the raw `Authorization` header value.

```bash
curl http://localhost:4012/graphql \
  -H "Authorization: lin_api_test" \
  -H "Content-Type: application/json" \
  -d '{"query":"{ viewer { id name email } }"}'
```

## Query Example

```bash
curl http://localhost:4012/graphql \
  -H "Authorization: lin_api_test" \
  -H "Content-Type: application/json" \
  -d '{"query":"{ issues(first: 10) { nodes { id identifier title state { name } team { key } } pageInfo { hasNextPage endCursor } } }"}'
```

## Seed Config

```yaml
linear:
  api_keys: [lin_api_test]
  organizations:
    - id: org-1
      name: My Org
  teams:
    - id: team-1
      name: Engineering
      key: ENG
      organization: org-1
  workflow_states:
    - id: ws-1
      name: Todo
      type: unstarted
      team: team-1
  users:
    - id: user-1
      name: Developer
      email: dev@example.com
      organization: org-1
  issues:
    - id: issue-1
      title: First issue
      team: team-1
      state: ws-1
      assignee: user-1
```
