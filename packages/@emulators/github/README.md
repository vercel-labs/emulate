# @emulators/github

Fully stateful GitHub API emulation. Creates, updates, and deletes persist in memory and affect related entities.

Part of [emulate](https://github.com/vercel-labs/emulate) — local drop-in replacement services for CI and no-network sandboxes.

## Install

```bash
npm install @emulators/github
```

## Endpoints

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
- Send `Accept: application/vnd.github.raw` or `application/vnd.github.raw+json` to file Contents and README requests to receive raw bytes; directory and submodule responses remain JSON
- `GET /:owner/:repo/raw/:ref/:path` — download file content from advertised raw URLs; this is separate from Accept negotiation
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

Updating only a pull request's `base` branch emits `pull_request.edited` with the new base ref and SHA.

### Comments
- Issue comments: full CRUD on `/repos/:owner/:repo/issues/:number/comments`
- Review comments: full CRUD on `/repos/:owner/:repo/pulls/:number/comments`
- Commit comments: full CRUD on `/repos/:owner/:repo/commits/:sha/comments`
- Repo-wide listings for each type

### Reviews
- `GET /repos/:owner/:repo/pulls/:number/reviews` — list
- `POST /repos/:owner/:repo/pulls/:number/reviews` — create (with inline comments)
- `GET/PUT /repos/:owner/:repo/pulls/:number/reviews/:id` — get/update
- `DELETE /repos/:owner/:repo/pulls/:number/reviews/:id` — discard a pending review and its comments
- `POST /repos/:owner/:repo/pulls/:number/reviews/:id/events` — submit
- `PUT /repos/:owner/:repo/pulls/:number/reviews/:id/dismissals` — dismiss

Omit `event` when creating a review to keep it pending. Each reviewer can have one pending review per pull request; review listings and review-specific reads expose it only to its author. Individual comment reads and repository-wide comment listings also hide pending review comments from other users and anonymous readers. Inline comments are validated before a review is stored. Pending edits emit no public webhooks, while submission and submitted-summary edits emit review events.

### GraphQL collaboration

The `POST /graphql` endpoint supports a collaboration subset backed by the same pull requests and comments as REST:

- `repository.pullRequest` with paginated `reviewThreads`, comment identities, and resolution state
- `addPullRequestReviewThread` to add an inline comment to an existing pending review using its `pullRequestReviewId`
- `convertPullRequestToDraft` and `markPullRequestReadyForReview`
- `resolveReviewThread` and `unresolveReviewThread`

Draft/ready transitions and public thread resolution changes emit the corresponding webhooks. This is not a complete GitHub GraphQL schema; diff-validation limitations also apply to GraphQL comments.

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
- Check runs: create, update, get, annotations, rerequest, list by ref/suite. Ref based lookups accept branch and tag refs containing slashes.
- Check suites: create, get, preferences, rerequest, list by ref. Ref based lookups accept branch and tag refs containing slashes.
- Automatic suite status rollup from check run results

### Misc
- `GET /_emulate/installation-tokens` — inspect secret-free GitHub App installation-token metadata
- `GET /rate_limit` — rate limit status
- `GET /meta` — server metadata
- `GET /octocat` — ASCII art
- `GET /emojis` — emoji URLs
- `GET /zen` — random zen phrase
- `GET /versions` — API versions

## Auth

Public repo endpoints work without auth. Private repos and write operations require a valid token. Pagination uses `page`/`per_page` with `Link` headers.

Installation access tokens act as the configured GitHub App bot for repository writes. Repository ownership, selected repository access, and requested App permissions remain enforced. Pull request merges require `contents: write` on the base repository. Pull request branch updates require `pull_requests: write` on the pull request repository and `contents: write` on the head repository.

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
      members:
        - login: octocat
          role: admin
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

Organization `members` are optional. Each entry references a seeded user by `login`; `role` defaults to `member`, while `admin` creates an organization administrator. Unknown users are ignored. Memberships are backed by the synthetic `members` team, so they also appear through team membership endpoints and grant access to private organization repositories.

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

The Next.js and Nuxt adapters also materialize omitted keys. Their returned server handlers expose `generatedSecrets()`, and persistence restores the same identity across cold starts. Keep persisted snapshots private because they contain the signing key. A custom persistence backend must implement atomic `initialize()` semantics when generated identities are used.

```bash
npx emulate start --service github --seed emulate.config.yaml \
  --generated-secrets-file .emulate-secrets.json
```

The destination must not exist. emulate removes inherited ACLs, verifies effective owner-only access, and publishes complete JSON before opening listeners or configuring portless. Handled startup failures remove the invocation-owned artifact. A hard termination can leave a complete artifact that must be removed manually after confirming no invocation is using it. Explicit keys are excluded from the artifact. Linux requires `setfacl` and `getfacl` from the `acl` package. The flag fails closed when access controls cannot be verified and is not supported on Windows. Without `--generated-secrets-file`, CLI seed files continue requiring `private_key`.

## Links

- [Full documentation](https://emulate.dev/github)
- [GitHub](https://github.com/vercel-labs/emulate)
