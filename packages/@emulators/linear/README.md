# @emulators/linear

Linear GraphQL API emulator for local development and CI.

This package is Phase 1. It includes `POST /graphql`, schema introspection, PAT authentication, read only query resolvers, and Relay style pagination for issues, projects, teams, users, organizations, labels, and workflow states.

Mutations, webhooks, OAuth 2.0, and an inspector UI are follow up PRs.

## Install

```bash
npm install @emulators/linear
```

## Start

```bash
npx emulate --service linear
```

Default port: `4012`.

## Auth

Use the raw Linear PAT header:

```bash
curl http://localhost:4012/graphql \
  -H "Authorization: lin_api_test" \
  -H "Content-Type: application/json" \
  -d '{"query":"{ issues { nodes { id title } } }"}'
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
