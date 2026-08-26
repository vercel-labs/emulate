# @emulators/github

Fully stateful GitHub API emulation. Creates, updates, and deletes persist in memory and affect related entities.

Part of [emulate](https://github.com/vercel-labs/emulate) — local drop-in replacement services for CI and no-network sandboxes.

## Install

```bash
npm install @emulators/github
```

## Endpoints

### GraphQL
- `POST /graphql` — execute GitHub GraphQL queries with JSON `query`, `variables`, and `operationName` fields.
- `repository(owner:, name:)` resolves repositories and issue details.
- `node(id:)` resolves REST node IDs for repositories, issues, labels, and issue comments. Inaccessible records return `null`.
- `Issue.comments` supports Relay-style `first`, `after`, `last`, and `before` arguments with opaque cursors.
- Mutations support `createIssue`, `closeIssue`, `reopenIssue`, `addComment`, `createLabel`, and `deleteLabel`; each accepts a typed input and echoes `clientMutationId` exactly.
- Requests require authentication and use the GraphQL rate-limit bucket exposed by `rateLimit` and `/rate_limit`.
- Issue relationships include `parent`, cursor-paginated `subIssues` and `blockedBy`, plus `addSubIssue` and `addBlockedBy` mutations with exact `clientMutationId` echoes.

### Users
- `GET /user` — authenticated user
- `PATCH /user` — update profile
- `GET /users/:username` — get user
- `GET /users` — list users
- `GET /users/:username/repos` — list user repos
- `GET /users/:username/orgs` — list user orgs
- `GET /users/:username/followers` — list followers
- `GET /users/:username/following` — list following

### Repositories
- `GET /repos/:owner/:repo` — get repo
- `GET /repositories/:id` — get repo by numeric ID
- `POST /user/repos` — create user repo
- `POST /orgs/:org/repos` — create org repo
- `PATCH /repos/:owner/:repo` — update repo
- `DELETE /repos/:owner/:repo` — delete repo (cascades)
- `GET/PUT /repos/:owner/:repo/topics` — get/replace topics
- `GET /repos/:owner/:repo/languages` — languages
- `GET /repos/:owner/:repo/contributors` — contributors
- `GET /repos/:owner/:repo/forks` — list forks
- `POST /repos/:owner/:repo/forks` — create fork
- `GET/PUT/DELETE /repos/:owner/:repo/collaborators/:username` — collaborators
- `GET /repos/:owner/:repo/collaborators/:username/permission`
- `POST /repos/:owner/:repo/transfer` — transfer repo
- `GET /repos/:owner/:repo/tags` — list tags

### Contents & Commit History
- `GET /repos/:owner/:repo/readme` — get the repository README
- `GET /repos/:owner/:repo/contents/:path` — get a file or list a directory at a ref
- `GET /:owner/:repo/raw/:ref/:path` — download file content from advertised raw URLs
- `PUT/DELETE /repos/:owner/:repo/contents/:path` — create, update, or delete a file and commit the change
- `GET /repos/:owner/:repo/commits` — list commits with ref, path, author, and date filters
- `GET /repos/:owner/:repo/commits/:ref` — get a commit with file diffs and stats
- `GET /repos/:owner/:repo/compare/:base...:head` — compare two refs

### Issues
- `GET /repos/:owner/:repo/issues` — list (filter by state, labels, assignee, milestone, creator, since)
- `POST /repos/:owner/:repo/issues` — create
- `GET /repos/:owner/:repo/issues/:number` — get
- `PATCH /repos/:owner/:repo/issues/:number` — update (state transitions, events)
- `PUT/DELETE /repos/:owner/:repo/issues/:number/lock` — lock/unlock
- `GET /repos/:owner/:repo/issues/:number/timeline` — timeline events
- `GET /repos/:owner/:repo/issues/:number/events` — events
- `POST/DELETE /repos/:owner/:repo/issues/:number/assignees` — manage assignees

Issue updates accept `state_reason: duplicate` with `duplicate_issue_id`, a visible issue database ID. GraphQL exposes `DUPLICATE` and `duplicateOf`; reopening clears the canonical reference.

### Issue relationships
- `GET /repos/:owner/:repo/issues/:number/parent` — get the parent issue
- `GET/POST /repos/:owner/:repo/issues/:number/sub_issues` — list or add ordered sub-issues
- `DELETE /repos/:owner/:repo/issues/:number/sub_issue` — remove a sub-issue with `{ "sub_issue_id": <database id> }`
- `PATCH /repos/:owner/:repo/issues/:number/sub_issues/priority` — move a child with `{ "sub_issue_id": <database id>, "after_id": <sibling id> }` or `before_id`
- `GET/POST /repos/:owner/:repo/issues/:number/dependencies/blocked_by` — list or add blocking issues, using `{ "issue_id": <database id> }` for writes
- `GET /repos/:owner/:repo/issues/:number/dependencies/blocking` — list issues blocked by this issue
- `DELETE /repos/:owner/:repo/issues/:number/dependencies/blocked_by/:issue_id` — remove a dependency

Relationship lists accept `page` and `per_page`, cap `per_page` at 100, and return `Link` headers when more pages are available. Sub-issues have one parent and explicit sibling order; `replace_parent: true` moves a child atomically. Hierarchy and dependency edges are separate, and self-references, duplicates, and cycles are rejected without changing state. Sub-issues must be in repositories owned by the same account. Dependency targets may be cross-repository when the caller can read both repositories. Writes require issue write access on the route repository and issue read access on every referenced repository.

### Pull Requests
- `GET /repos/:owner/:repo/pulls` — list (filter by state, head, base)
- `POST /repos/:owner/:repo/pulls` — create
- `GET /repos/:owner/:repo/pulls/:number` — get
- `PATCH /repos/:owner/:repo/pulls/:number` — update
- `PUT /repos/:owner/:repo/pulls/:number/merge` — merge (with branch protection enforcement)
- `GET /repos/:owner/:repo/pulls/:number/commits` — list commits
- `GET /repos/:owner/:repo/pulls/:number/files` — list files
- `POST/DELETE /repos/:owner/:repo/pulls/:number/requested_reviewers` — manage reviewers
- `PUT /repos/:owner/:repo/pulls/:number/update-branch` — update branch

### Comments
- Issue comments: full CRUD on `/repos/:owner/:repo/issues/:number/comments`
- Review comments: full CRUD on `/repos/:owner/:repo/pulls/:number/comments`
- Commit comments: full CRUD on `/repos/:owner/:repo/commits/:sha/comments`
- Repo-wide listings for each type

### Reviews
- `GET /repos/:owner/:repo/pulls/:number/reviews` — list
- `POST /repos/:owner/:repo/pulls/:number/reviews` — create (with inline comments)
- `GET/PUT /repos/:owner/:repo/pulls/:number/reviews/:id` — get/update
- `POST /repos/:owner/:repo/pulls/:number/reviews/:id/events` — submit
- `PUT /repos/:owner/:repo/pulls/:number/reviews/:id/dismissals` — dismiss

### Labels & Milestones
- Labels: full CRUD, add/remove from issues, replace all
- Milestones: full CRUD, state transitions, issue counts

### Branches & Git Data
- Branches: list, get, protection CRUD (status checks, PR reviews, enforce admins)
- Refs: get, match, create, update, delete
- Commits: get, create
- Trees: get (with recursive), create (with inline content)
- Blobs: get, create
- Tags: get, create

### Organizations & Teams
- Orgs: get, update, list
- Org members: list, check, remove, get/set membership
- Teams: full CRUD, members, repos

### Releases
- Releases: full CRUD, latest, by tag
- Release assets: full CRUD, upload
- Generate release notes

### Webhooks
- Repo webhooks: full CRUD, ping, test, deliveries
- Org webhooks: full CRUD, ping
- Real HTTP delivery to registered URLs on all state changes

### Search
- `GET /search/repositories` — full query syntax (user, org, language, topic, stars, forks, etc.)
- `GET /search/issues` — issues + PRs (repo, is, author, label, milestone, state, etc.)
- `GET /search/users` — users + orgs
- `GET /search/code` — blob content search
- `GET /search/commits` — commit message search
- `GET /search/topics` — topic search
- `GET /search/labels` — label search

### Actions
- Workflows: list, get, enable/disable, dispatch
- Workflow runs: list, get, cancel, rerun, delete, logs
- Jobs: list, get, logs
- Artifacts: list, get, delete
- Secrets: repo + org CRUD

### Checks
- Check runs: create, update, get, annotations, rerequest, list by ref/suite
- Check suites: create, get, preferences, rerequest, list by ref
- Automatic suite status rollup from check run results

### Misc
- `GET /rate_limit` — rate limit status
- `GET /meta` — server metadata
- `GET /octocat` — ASCII art
- `GET /emojis` — emoji URLs
- `GET /zen` — random zen phrase
- `GET /versions` — API versions

## Auth

Public repo endpoints work without auth. Private repos and write operations require a valid token. Pagination uses `page`/`per_page` with `Link` headers.

## Seed Configuration

```yaml
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
    - client_id: "Iv1.abc123"
      client_secret: "secret_abc123"
      name: "My Web App"
      redirect_uris:
        - "http://localhost:3000/api/auth/callback/github"
  apps:
    - app_id: 12345
      slug: "my-github-app"
      name: "My GitHub App"
      private_key: |
        -----BEGIN RSA PRIVATE KEY-----
        ...your PEM key...
        -----END RSA PRIVATE KEY-----
      permissions:
        contents: read
        issues: write
      events: [push, pull_request]
      installations:
        - installation_id: 100
          account: my-org
          repository_selection: all
```

The `private_key` field is required when calling `seedFromConfig` directly. To generate omitted keys before seeding, use `materializeGitHubSeedConfig` and retain the returned key material:

```typescript
import { materializeGitHubSeedConfig, seedFromConfig } from '@emulators/github'

const materialized = await materializeGitHubSeedConfig({
  apps: [{ app_id: 12345, slug: 'my-github-app', name: 'My GitHub App' }],
})

seedFromConfig(store, baseUrl, materialized.config)
const privateKey = materialized.generatedPrivateKeys[0]?.private_key
```

The `emulate` package performs this materialization automatically in `createEmulator` and exposes generated keys through `generatedSecrets`. The CLI can do the same when a private delivery file is requested:

```bash
npx emulate start --service github --seed emulate.config.yaml \
  --generated-secrets-file .emulate-secrets.json
```

The destination must not exist. emulate removes inherited ACLs, verifies effective owner-only access, and publishes complete JSON before opening listeners or configuring portless. Handled startup failures remove the invocation-owned artifact. A hard termination can leave a complete artifact that must be removed manually after confirming no invocation is using it. Explicit keys are excluded from the artifact. Linux requires `setfacl` and `getfacl` from the `acl` package. The flag fails closed when access controls cannot be verified and is not supported on Windows. Without `--generated-secrets-file`, CLI seed files continue requiring `private_key`.

## Links

- [Full documentation](https://emulate.dev/github)
- [GitHub](https://github.com/vercel-labs/emulate)
