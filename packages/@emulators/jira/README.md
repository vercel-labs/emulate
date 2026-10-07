# @emulators/jira

Stateful Jira Cloud REST API emulator for local development and CI.

Part of [emulate](https://github.com/vercel-labs/emulate), local drop-in replacement services for CI and no-network sandboxes.

## Install

```sh
npm install @emulators/jira
```

Most users should run it through the main CLI:

```sh
npx emulate --service jira
```

## Supported Surface

- Jira platform REST API v3 and v2 under `/rest/api/3` and `/rest/api/2`. v3 bodies use Atlassian Document Format and v2 bodies use plain strings.
- Issues: create, bulk create, read with `fields` and `expand`, edit with `fields` and `update` operations, delete, assign, transitions, changelog, create and edit metadata.
- Comments, watchers, worklogs, and issue links.
- JQL search through `/search/jql` (with `nextPageToken`), `/search/approximate-count`, the legacy `/search`, and the issue picker. The JQL engine supports boolean logic, list and empty operators, text search, date math, `ORDER BY`, and common functions such as `currentUser()`, `openSprints()`, and `linkedIssues()`.
- Projects, components, versions, users, issue types, statuses, priorities, resolutions, fields, labels, and permissions.
- Jira Software Agile API under `/rest/agile/1.0` and `/rest/software/1.0`: boards, backlog, sprints and the sprint lifecycle, epics.
- Admin webhooks (`/rest/webhooks/1.0/webhook`) with JQL filters and `X-Hub-Signature` signing, plus dynamic webhooks for OAuth apps.
- Atlassian OAuth 2.0 (3LO): consent screen, authorization code and rotating refresh tokens, accessible resources, `/me`, and the `/ex/jira/{cloudId}` gateway path.
- Basic auth with `email:api_token`, and bearer API or OAuth tokens.
- Jira shaped errors: `{ "errorMessages": [], "errors": {} }`.
- Local inspector at `/` and issue pages at `/browse/{issueKey}`.

Default credentials: `admin@jira.local` / `jira_test_token`.

Conformance is checked against [jira.js](https://github.com/MrRefactoring/jira.js) with response schema validation enabled.

This is not a complete Jira clone. Attachments, filters, dashboards, workflow and permission scheme administration, groups, and Jira Service Management are not implemented.
