import { createHmac, generateKeyPair } from "crypto";
import type { Hono } from "@emulators/core";
import type { ServicePlugin, Store, WebhookDispatcher, TokenMap, AppEnv, RouteContext } from "@emulators/core";
import { getGitHubStore } from "./store.js";
import type { GitHubStore } from "./store.js";
import type { GitHubAppInstallation, GitHubIssue } from "./entities.js";
import { generateNodeId } from "./helpers.js";
import { usersRoutes } from "./routes/users.js";
import { reposRoutes } from "./routes/repos.js";
import { issuesRoutes } from "./routes/issues.js";
import { issueRelationshipsRoutes } from "./routes/issue-relationships.js";
import { pullsRoutes } from "./routes/pulls.js";
import { commentsRoutes } from "./routes/comments.js";
import { reviewsRoutes } from "./routes/reviews.js";
import { labelsAndMilestonesRoutes } from "./routes/labels.js";
import { branchesAndGitRoutes } from "./routes/branches.js";
import { contentsRoutes } from "./routes/contents.js";
import { commitsRoutes } from "./routes/commits.js";
import { orgsAndTeamsRoutes } from "./routes/orgs.js";
import { releasesRoutes } from "./routes/releases.js";
import { webhooksRoutes } from "./routes/webhooks.js";
import { searchRoutes } from "./routes/search.js";
import { actionsRoutes } from "./routes/actions.js";
import { checksRoutes } from "./routes/checks.js";
import { rateLimitRoutes } from "./routes/rate-limit.js";
import { graphqlRoutes } from "./routes/graphql.js";
import { metaRoutes } from "./routes/meta.js";
import { oauthRoutes } from "./routes/oauth.js";
import { appsRoutes } from "./routes/apps.js";
import { findOrCreateBlob, findOrCreateCommit, findOrCreateTree } from "./git-helpers.js";

export { getGitHubStore, type GitHubStore } from "./store.js";
export * from "./entities.js";
export * from "./issue-relationships.js";

export interface GitHubSeedConfig {
  port?: number;
  users?: Array<{
    login: string;
    name?: string;
    email?: string;
    bio?: string;
    company?: string;
    location?: string;
    blog?: string;
    twitter_username?: string;
    site_admin?: boolean;
  }>;
  orgs?: Array<{
    login: string;
    name?: string;
    description?: string;
    email?: string;
  }>;
  tokens?: Record<string, { login: string; scopes?: string[] }>;
  repos?: Array<{
    owner: string;
    name: string;
    description?: string;
    private?: boolean;
    language?: string;
    topics?: string[];
    default_branch?: string;
    auto_init?: boolean;
    labels?: Array<{
      key: string;
      name?: string;
      description?: string;
      color?: string;
      default?: boolean;
    }>;
    issues?: Array<GitHubSeedIssue>;
  }>;
  labels?: Array<GitHubSeedLabel>;
  issues?: Array<GitHubSeedIssue>;
  comments?: Array<GitHubSeedComment>;
  sub_issues?: Array<{ parent: string; child: string; position?: number }>;
  dependencies?: Array<{ blocked: string; blocking: string }>;
  oauth_apps?: Array<{
    client_id: string;
    client_secret: string;
    name: string;
    redirect_uris: string[];
  }>;
  apps?: Array<{
    app_id: number;
    slug: string;
    name: string;
    private_key?: string;
    permissions?: Record<string, string>;
    events?: string[];
    webhook_url?: string;
    webhook_secret?: string;
    description?: string;
    installations?: Array<{
      installation_id: number;
      account: string;
      repository_selection?: "all" | "selected";
      repositories?: string[];
      permissions?: Record<string, string>;
      events?: string[];
    }>;
  }>;
}

export interface GitHubSeedLabel {
  key: string;
  repo: string;
  name?: string;
  description?: string;
  color?: string;
  default?: boolean;
}

export interface GitHubSeedIssue {
  key: string;
  repo?: string;
  number?: number;
  title: string;
  body?: string;
  state?: "open" | "closed";
  state_reason?: GitHubIssue["state_reason"];
  duplicate_of?: string;
  labels?: string[];
  author?: string;
  comments?: Array<{ key: string; body: string; author?: string }>;
}

export interface GitHubSeedComment {
  key: string;
  repo: string;
  issue: string | number;
  body: string;
  author?: string;
}

export interface GeneratedGitHubAppPrivateKey {
  app_id: number;
  slug: string;
  name: string;
  private_key: string;
}

export interface MaterializedGitHubSeedConfig {
  config: GitHubSeedConfig;
  generatedPrivateKeys: GeneratedGitHubAppPrivateKey[];
}

function generateAppPrivateKey(): Promise<string> {
  return new Promise((resolve, reject) => {
    generateKeyPair(
      "rsa",
      {
        modulusLength: 2048,
        privateKeyEncoding: { type: "pkcs1", format: "pem" },
        publicKeyEncoding: { type: "pkcs1", format: "pem" },
      },
      (error, _publicKey, privateKey) => {
        if (error) reject(error);
        else resolve(privateKey);
      },
    );
  });
}

export async function materializeGitHubSeedConfig(config: GitHubSeedConfig): Promise<MaterializedGitHubSeedConfig> {
  const appIds = new Set<number>();
  const slugs = new Set<string>();
  for (const app of config.apps ?? []) {
    if (app.private_key === "") {
      throw new Error(`GitHub App "${app.slug}" private_key must not be empty`);
    }
    if (appIds.has(app.app_id)) {
      throw new Error(`Duplicate GitHub App app_id: ${app.app_id}`);
    }
    if (slugs.has(app.slug)) {
      throw new Error(`Duplicate GitHub App slug: "${app.slug}"`);
    }
    appIds.add(app.app_id);
    slugs.add(app.slug);
  }

  const generatedPrivateKeys: GeneratedGitHubAppPrivateKey[] = [];
  const apps = [];
  for (const app of config.apps ?? []) {
    if (app.private_key !== undefined) {
      apps.push({ ...app });
      continue;
    }

    const privateKey = await generateAppPrivateKey();
    generatedPrivateKeys.push({
      app_id: app.app_id,
      slug: app.slug,
      name: app.name,
      private_key: privateKey,
    });
    apps.push({ ...app, private_key: privateKey });
  }

  return {
    config: config.apps ? { ...config, apps } : { ...config },
    generatedPrivateKeys,
  };
}

function seedDefaults(store: Store, baseUrl: string): void {
  const gh = getGitHubStore(store);

  const ghost = gh.users.insert({
    login: "ghost",
    node_id: "",
    avatar_url: `${baseUrl}/avatars/u/ghost`,
    gravatar_id: "",
    type: "User",
    site_admin: false,
    name: "Ghost",
    company: null,
    blog: "",
    location: null,
    email: null,
    hireable: null,
    bio: null,
    twitter_username: null,
    public_repos: 0,
    public_gists: 0,
    followers: 0,
    following: 0,
  });
  gh.users.update(ghost.id, { node_id: generateNodeId("User", ghost.id) });

  const admin = gh.users.insert({
    login: "admin",
    node_id: "",
    avatar_url: `${baseUrl}/avatars/u/admin`,
    gravatar_id: "",
    type: "User",
    site_admin: true,
    name: "Admin",
    company: null,
    blog: "",
    location: null,
    email: "admin@localhost",
    hireable: null,
    bio: "Default admin user",
    twitter_username: null,
    public_repos: 0,
    public_gists: 0,
    followers: 0,
    following: 0,
  });
  gh.users.update(admin.id, { node_id: generateNodeId("User", admin.id) });
}

function seedIssueGraph(store: Store, baseUrl: string, config: GitHubSeedConfig): void {
  const gh = getGitHubStore(store);
  const nestedIssues = (config.repos ?? []).flatMap((repo) =>
    (repo.issues ?? []).map((issue) => ({ ...issue, repo: `${repo.owner}/${repo.name}` })),
  );
  const issueSpecs = [...(config.issues ?? []), ...nestedIssues];
  const issueByKey = new Map<string, GitHubIssue>();
  const labelByKey = new Map<string, ReturnType<typeof gh.labels.insert>>();
  const numbersByRepo = new Map<number, Set<number>>();
  const resolveRepo = (name: string | undefined) => {
    const repo = name ? gh.repos.findOneBy("full_name", name) : undefined;
    if (!repo) throw new Error(`GitHub seed references missing repository: ${name ?? "<missing>"}`);
    return repo;
  };
  const author = (login?: string) => {
    const user = gh.users.findOneBy("login", login ?? "ghost");
    if (!user) throw new Error(`GitHub seed references missing user: ${login}`);
    return user;
  };

  for (const spec of [
    ...(config.labels ?? []),
    ...(config.repos ?? []).flatMap((r) =>
      (r.labels ?? []).map((label) => ({ ...label, repo: `${r.owner}/${r.name}` })),
    ),
  ]) {
    const repo = resolveRepo(spec.repo);
    const key = `${repo.full_name}:${spec.key}`;
    if (labelByKey.has(key)) throw new Error(`Duplicate GitHub seed label key: ${spec.key}`);
    labelByKey.set(key, { id: -1 } as ReturnType<typeof gh.labels.insert>);
  }
  for (const spec of issueSpecs) {
    if (!spec.repo) throw new Error(`GitHub seed issue "${spec.key}" requires repo`);
    const repo = resolveRepo(spec.repo);
    if (issueByKey.has(spec.key)) throw new Error(`Duplicate GitHub seed issue key: ${spec.key}`);
    if (spec.number !== undefined && gh.issues.findOneBy("repo_id", repo.id)?.number === spec.number) {
      throw new Error(`Duplicate GitHub seed issue number: ${repo.full_name}#${spec.number}`);
    }
    const duplicateNumber =
      spec.number !== undefined && gh.issues.findBy("repo_id", repo.id).some((i) => i.number === spec.number);
    if (duplicateNumber) throw new Error(`Duplicate GitHub seed issue number: ${repo.full_name}#${spec.number}`);
    if (spec.number !== undefined) {
      const numbers = numbersByRepo.get(repo.id) ?? new Set<number>();
      if (numbers.has(spec.number))
        throw new Error(`Duplicate GitHub seed issue number: ${repo.full_name}#${spec.number}`);
      numbers.add(spec.number);
      numbersByRepo.set(repo.id, numbers);
    }
    issueByKey.set(spec.key, { id: -1 } as GitHubIssue);
  }
  const issueSpecByKey = new Map(issueSpecs.map((spec) => [spec.key, spec]));
  const commentSpecs = [
    ...(config.comments ?? []),
    ...issueSpecs.flatMap((issue) =>
      (issue.comments ?? []).map((comment) => ({ ...comment, repo: issue.repo!, issue: issue.key })),
    ),
  ];
  const commentKeys = new Set<string>();
  for (const spec of commentSpecs) {
    if (commentKeys.has(spec.key)) throw new Error(`Duplicate GitHub seed comment key: ${spec.key}`);
    commentKeys.add(spec.key);
    resolveRepo(spec.repo);
    if (typeof spec.issue === "string" && !issueSpecByKey.has(spec.issue)) {
      throw new Error(`Seed comment "${spec.key}" references missing issue`);
    }
    if (spec.author && !gh.users.findOneBy("login", spec.author)) {
      throw new Error(`GitHub seed references missing user: ${spec.author}`);
    }
  }
  for (const spec of issueSpecs) {
    if (spec.author && !gh.users.findOneBy("login", spec.author)) {
      throw new Error(`GitHub seed references missing user: ${spec.author}`);
    }
    if (spec.duplicate_of) {
      const canonical = issueSpecByKey.get(spec.duplicate_of);
      if (!canonical || canonical.key === spec.key || canonical.state_reason === "duplicate") {
        throw new Error(`Invalid canonical duplicate target for seed issue "${spec.key}"`);
      }
    }
    if (spec.state_reason === "duplicate" && !spec.duplicate_of) {
      throw new Error(`Duplicate seed issue "${spec.key}" requires duplicate_of`);
    }
    if (spec.state_reason !== "duplicate" && spec.duplicate_of) {
      throw new Error(`Seed issue "${spec.key}" has duplicate_of without duplicate state_reason`);
    }
    for (const labelKey of spec.labels ?? []) {
      const repo = resolveRepo(spec.repo);
      if (!labelByKey.has(`${repo.full_name}:${labelKey}`)) {
        throw new Error(`Seed issue "${spec.key}" references missing label: ${labelKey}`);
      }
    }
  }
  for (const edge of config.sub_issues ?? []) {
    if (!issueSpecByKey.has(edge.parent) || !issueSpecByKey.has(edge.child) || edge.parent === edge.child) {
      throw new Error(`Invalid seed parent-child edge: ${edge.parent} -> ${edge.child}`);
    }
  }
  const parentByChild = new Map<string, string>();
  for (const edge of config.sub_issues ?? []) {
    if (parentByChild.has(edge.child)) throw new Error(`Seed child issue already has a parent: ${edge.child}`);
    parentByChild.set(edge.child, edge.parent);
    const seen = new Set<string>([edge.child]);
    let cursor: string | undefined = edge.parent;
    while (cursor) {
      if (seen.has(cursor)) throw new Error(`Cyclic seed parent-child graph at issue: ${cursor}`);
      seen.add(cursor);
      cursor = parentByChild.get(cursor);
    }
  }
  for (const edge of config.dependencies ?? []) {
    if (!issueSpecByKey.has(edge.blocked) || !issueSpecByKey.has(edge.blocking) || edge.blocked === edge.blocking) {
      throw new Error(`Invalid seed dependency: ${edge.blocked} -> ${edge.blocking}`);
    }
  }
  const dependencyKeys = new Set<string>();
  for (const edge of config.dependencies ?? []) {
    const key = `${edge.blocked}:${edge.blocking}`;
    if (dependencyKeys.has(key)) throw new Error(`Duplicate seed dependency: ${key}`);
    dependencyKeys.add(key);
  }
  for (const spec of [
    ...(config.labels ?? []),
    ...(config.repos ?? []).flatMap((r) =>
      (r.labels ?? []).map((label) => ({ ...label, repo: `${r.owner}/${r.name}` })),
    ),
  ]) {
    const repo = resolveRepo(spec.repo);
    const inserted = gh.labels.insert({
      node_id: "",
      repo_id: repo.id,
      name: spec.name ?? spec.key,
      description: spec.description ?? null,
      color: spec.color ?? "ededed",
      default: spec.default ?? false,
    });
    gh.labels.update(inserted.id, { node_id: generateNodeId("Label", inserted.id) });
    labelByKey.set(`${repo.full_name}:${spec.key}`, inserted);
  }
  for (const spec of issueSpecs) {
    const repo = resolveRepo(spec.repo);
    const state = spec.state ?? (spec.state_reason && spec.state_reason !== "reopened" ? "closed" : "open");
    const reason = spec.state_reason ?? (state === "closed" ? "completed" : null);
    if (reason === "duplicate" && !spec.duplicate_of)
      throw new Error(`Duplicate seed issue "${spec.key}" requires duplicate_of`);
    if (reason !== "duplicate" && spec.duplicate_of)
      throw new Error(`Seed issue "${spec.key}" has duplicate_of without duplicate state_reason`);
    const number =
      spec.number ??
      Math.max(
        0,
        ...gh.issues.findBy("repo_id", repo.id).map((i) => i.number),
        ...issueSpecs.filter((i) => i.repo === repo.full_name && i.number !== undefined).map((i) => i.number!),
      ) + 1;
    const created = new Date(0).toISOString();
    const inserted = gh.issues.insert({
      node_id: "",
      number,
      repo_id: repo.id,
      title: spec.title,
      body: spec.body ?? null,
      state,
      state_reason: reason,
      duplicate_issue_id: null,
      locked: false,
      active_lock_reason: null,
      user_id: author(spec.author).id,
      assignee_ids: [],
      label_ids: [],
      milestone_id: null,
      comments: 0,
      closed_at: state === "closed" ? created : null,
      closed_by_id: state === "closed" ? author(spec.author).id : null,
      is_pull_request: false,
    });
    gh.issues.update(inserted.id, { node_id: generateNodeId("Issue", inserted.id) });
    issueByKey.set(spec.key, inserted);
  }
  for (const spec of issueSpecs) {
    const issue = issueByKey.get(spec.key)!;
    const repo = gh.repos.get(issue.repo_id)!;
    const labelIds: number[] = [];
    if (spec.duplicate_of) {
      const canonical = issueByKey.get(spec.duplicate_of);
      if (!canonical || canonical.id === issue.id || canonical.duplicate_issue_id !== null)
        throw new Error(`Invalid canonical duplicate target for seed issue "${spec.key}"`);
      issue.duplicate_issue_id = canonical.id;
      gh.issues.update(issue.id, { duplicate_issue_id: canonical.id });
    }
    for (const labelKey of spec.labels ?? []) {
      const label = labelByKey.get(`${repo.full_name}:${labelKey}`);
      if (!label || label.id === -1) throw new Error(`Seed issue "${spec.key}" references missing label: ${labelKey}`);
      labelIds.push(label.id);
    }
    if (labelIds.length > 0) gh.issues.update(issue.id, { label_ids: labelIds });
  }
  for (const spec of commentSpecs) {
    const repo = resolveRepo(spec.repo);
    const issue =
      typeof spec.issue === "string"
        ? issueByKey.get(spec.issue)
        : gh.issues.findBy("repo_id", repo.id).find((candidate) => candidate.number === spec.issue);
    if (!issue || issue.repo_id !== repo.id) throw new Error(`Seed comment "${spec.key}" references missing issue`);
    const row = gh.comments.insert({
      node_id: "",
      repo_id: repo.id,
      issue_number: issue.number,
      pull_number: null,
      commit_sha: null,
      body: spec.body,
      user_id: author(spec.author).id,
      in_reply_to_id: null,
      path: null,
      position: null,
      line: null,
      side: null,
      subject_type: null,
      comment_type: "issue",
      review_id: null,
    });
    gh.comments.update(row.id, { node_id: generateNodeId("IssueComment", row.id) });
    gh.issues.update(issue.id, { comments: issue.comments + 1 });
  }
  for (const edge of config.sub_issues ?? []) {
    const parent = issueByKey.get(edge.parent);
    const child = issueByKey.get(edge.child);
    if (!parent || !child || parent.id === child.id)
      throw new Error(`Invalid seed parent-child edge: ${edge.parent} -> ${edge.child}`);
    if (gh.issueSubIssues.findOneBy("child_issue_id", child.id))
      throw new Error(`Seed child issue already has a parent: ${edge.child}`);
    gh.issueSubIssues.insert({ parent_issue_id: parent.id, child_issue_id: child.id, position: edge.position ?? 0 });
  }
  for (const edge of config.dependencies ?? []) {
    const blocked = issueByKey.get(edge.blocked);
    const blocking = issueByKey.get(edge.blocking);
    if (!blocked || !blocking || blocked.id === blocking.id)
      throw new Error(`Invalid seed dependency: ${edge.blocked} -> ${edge.blocking}`);
    if (
      gh.issueDependencies.findOneBy("blocked_issue_id", blocked.id) &&
      gh.issueDependencies.findOneBy("blocking_issue_id", blocking.id)
    )
      throw new Error("Duplicate seed dependency");
    gh.issueDependencies.insert({ blocked_issue_id: blocked.id, blocking_issue_id: blocking.id });
  }
}

function seedFromConfigUnsafe(store: Store, baseUrl: string, config: GitHubSeedConfig): void {
  for (const app of config.apps ?? []) {
    if (!app.private_key) {
      throw new Error(
        `GitHub App "${app.slug}" requires private_key when seedFromConfig is called directly; use createEmulator to generate one`,
      );
    }
  }

  const gh = getGitHubStore(store);

  if (config.users) {
    for (const u of config.users) {
      const existing = gh.users.findOneBy("login", u.login);
      if (existing) continue;
      const user = gh.users.insert({
        login: u.login,
        node_id: "",
        avatar_url: `${baseUrl}/avatars/u/${u.login}`,
        gravatar_id: "",
        type: "User",
        site_admin: u.site_admin ?? false,
        name: u.name ?? null,
        company: u.company ?? null,
        blog: u.blog ?? "",
        location: u.location ?? null,
        email: u.email ?? null,
        hireable: null,
        bio: u.bio ?? null,
        twitter_username: u.twitter_username ?? null,
        public_repos: 0,
        public_gists: 0,
        followers: 0,
        following: 0,
      });
      gh.users.update(user.id, { node_id: generateNodeId("User", user.id) });
    }
  }

  if (config.orgs) {
    for (const o of config.orgs) {
      const existing = gh.orgs.findOneBy("login", o.login);
      if (existing) continue;
      const org = gh.orgs.insert({
        login: o.login,
        node_id: "",
        description: o.description ?? null,
        name: o.name ?? null,
        company: null,
        blog: "",
        location: null,
        email: o.email ?? null,
        twitter_username: null,
        is_verified: false,
        has_organization_projects: true,
        has_repository_projects: true,
        public_repos: 0,
        public_gists: 0,
        followers: 0,
        following: 0,
        members_can_create_repositories: true,
        default_repository_permission: "read",
        billing_email: null,
      });
      gh.orgs.update(org.id, { node_id: generateNodeId("Org", org.id) });
    }
  }

  if (config.repos) {
    for (const r of config.repos) {
      const ownerUser = gh.users.findOneBy("login", r.owner);
      const owner = ownerUser ?? gh.orgs.findOneBy("login", r.owner);
      if (!owner) continue;

      const fullName = `${r.owner}/${r.name}`;
      const existing = gh.repos.findOneBy("full_name", fullName);
      if (existing) continue;

      const ownerType = ownerUser ? "User" : "Organization";
      const defaultBranch = r.default_branch ?? "main";

      const repo = gh.repos.insert({
        node_id: "",
        name: r.name,
        full_name: fullName,
        owner_id: owner.id,
        owner_type: ownerType,
        private: r.private ?? false,
        description: r.description ?? null,
        fork: false,
        forked_from_id: null,
        homepage: null,
        language: r.language ?? null,
        languages: r.language ? { [r.language]: 10000 } : {},
        forks_count: 0,
        stargazers_count: 0,
        watchers_count: 0,
        size: 0,
        default_branch: defaultBranch,
        open_issues_count: 0,
        topics: r.topics ?? [],
        has_issues: true,
        has_projects: true,
        has_wiki: true,
        has_pages: false,
        has_downloads: true,
        has_discussions: false,
        archived: false,
        disabled: false,
        visibility: r.private ? "private" : "public",
        pushed_at: null,
        allow_rebase_merge: true,
        allow_squash_merge: true,
        allow_merge_commit: true,
        allow_auto_merge: false,
        delete_branch_on_merge: false,
        allow_forking: true,
        is_template: false,
        license: null,
      });
      gh.repos.update(repo.id, { node_id: generateNodeId("Repository", repo.id) });

      if (r.auto_init !== false) {
        const readme = `# ${r.name}\n${r.description ? `\n${r.description}\n` : ""}`;
        const readmeSize = Buffer.byteLength(readme, "utf8");
        const blob = findOrCreateBlob(gh, repo.id, Buffer.from(readme, "utf8"));
        const tree = findOrCreateTree(gh, repo.id, [
          { path: "README.md", mode: "100644", type: "blob", sha: blob.sha, size: readmeSize },
        ]);

        const commit = findOrCreateCommit(gh, repo.id, {
          message: "Initial commit",
          author_name: r.owner,
          author_email: `${r.owner}@localhost`,
          author_date: repo.created_at,
          committer_name: r.owner,
          committer_email: `${r.owner}@localhost`,
          committer_date: repo.created_at,
          tree_sha: tree.sha,
          parent_shas: [],
          user_id: owner.id,
        });

        gh.branches.insert({
          repo_id: repo.id,
          name: defaultBranch,
          sha: commit.sha,
          protected: false,
        });

        const refRow = gh.refs.insert({
          repo_id: repo.id,
          ref: `refs/heads/${defaultBranch}`,
          sha: commit.sha,
          node_id: "",
        });
        gh.refs.update(refRow.id, { node_id: generateNodeId("Ref", refRow.id) });

        gh.repos.update(repo.id, { pushed_at: repo.created_at, size: 1 });
      }

      if (ownerType === "User") {
        const user = gh.users.findOneBy("login", r.owner);
        if (user && !r.private) {
          gh.users.update(user.id, { public_repos: user.public_repos + 1 });
        }
      } else {
        const org = gh.orgs.findOneBy("login", r.owner);
        if (org && !r.private) {
          gh.orgs.update(org.id, { public_repos: org.public_repos + 1 });
        }
      }
    }
  }

  seedIssueGraph(store, baseUrl, config);

  if (config.oauth_apps) {
    for (const oa of config.oauth_apps) {
      const existing = gh.oauthApps.findOneBy("client_id", oa.client_id);
      if (existing) continue;
      gh.oauthApps.insert({
        client_id: oa.client_id,
        client_secret: oa.client_secret,
        name: oa.name,
        redirect_uris: oa.redirect_uris,
      });
    }
  }

  if (config.apps) {
    for (const a of config.apps) {
      const existingApp = gh.apps.findOneBy("slug", a.slug);
      if (existingApp) continue;
      const privateKey = a.private_key;
      if (!privateKey) {
        throw new Error(`GitHub App "${a.slug}" requires private_key`);
      }

      gh.apps.insert({
        app_id: a.app_id,
        slug: a.slug,
        name: a.name,
        private_key: privateKey,
        permissions: a.permissions ?? {},
        events: a.events ?? [],
        webhook_url: a.webhook_url ?? null,
        webhook_secret: a.webhook_secret ?? null,
        description: a.description ?? null,
      });

      if (a.installations) {
        for (const inst of a.installations) {
          const account = gh.users.findOneBy("login", inst.account) ?? gh.orgs.findOneBy("login", inst.account);
          if (!account) continue;

          const accountType = gh.users.findOneBy("login", inst.account) ? ("User" as const) : ("Organization" as const);

          const repoIds: number[] = [];
          if (inst.repositories) {
            for (const repoFullName of inst.repositories) {
              const fullName = repoFullName.includes("/") ? repoFullName : `${inst.account}/${repoFullName}`;
              const repo = gh.repos.findOneBy("full_name", fullName);
              if (repo) repoIds.push(repo.id);
            }
          }

          gh.appInstallations.insert({
            installation_id: inst.installation_id,
            app_id: a.app_id,
            account_type: accountType,
            account_id: account.id,
            account_login: inst.account,
            repository_selection: inst.repository_selection ?? "all",
            repository_ids: repoIds,
            permissions: inst.permissions ?? a.permissions ?? {},
            events: inst.events ?? a.events ?? [],
            suspended_at: null,
          });
        }
      }
    }
  }
}

/** Apply a seed as one transaction so failed validation cannot leak partial entities. */
export function seedFromConfig(store: Store, baseUrl: string, config: GitHubSeedConfig): void {
  const snapshot = store.snapshot();
  try {
    seedFromConfigUnsafe(store, baseUrl, config);
  } catch (error) {
    store.restore(snapshot);
    throw error;
  }
}

function findInstallationsForRepo(
  gh: GitHubStore,
  ownerLogin: string,
  repoName: string | undefined,
  event: string,
): GitHubAppInstallation[] {
  const repoEntity = repoName ? gh.repos.findOneBy("full_name", `${ownerLogin}/${repoName}`) : null;
  const ownerUser = gh.users.findOneBy("login", ownerLogin);
  const ownerOrg = gh.orgs.findOneBy("login", ownerLogin);
  const ownerId = repoEntity?.owner_id ?? ownerUser?.id ?? ownerOrg?.id;
  const ownerType = repoEntity?.owner_type ?? (ownerUser ? "User" : ownerOrg ? "Organization" : undefined);
  if (ownerId === undefined || ownerType === undefined) return [];

  const results: GitHubAppInstallation[] = [];
  for (const inst of gh.appInstallations.all()) {
    if (inst.account_id !== ownerId || inst.account_type !== ownerType) continue;
    if (inst.suspended_at) continue;

    const ghApp = gh.apps.all().find((a) => a.app_id === inst.app_id);
    if (!ghApp) continue;
    if (!ghApp.events.includes(event) && !ghApp.events.includes("*")) continue;

    if (repoEntity && inst.repository_selection === "selected") {
      if (!inst.repository_ids.includes(repoEntity.id)) continue;
    }

    results.push(inst);
  }
  return results;
}

function enrichPayloadWithInstallation(payload: unknown, installation: GitHubAppInstallation): unknown {
  if (!payload || typeof payload !== "object") return payload;
  return {
    ...(payload as Record<string, unknown>),
    installation: {
      id: installation.installation_id,
      node_id: generateNodeId("Installation", installation.installation_id),
    },
  };
}

async function deliverToAppWebhookUrls(
  gh: GitHubStore,
  event: string,
  action: string | undefined,
  payload: unknown,
  ownerLogin: string,
  repoName: string | undefined,
): Promise<void> {
  const installations = findInstallationsForRepo(gh, ownerLogin, repoName, event);

  for (const inst of installations) {
    const ghApp = gh.apps.all().find((a) => a.app_id === inst.app_id);
    if (!ghApp?.webhook_url) continue;

    const enriched = enrichPayloadWithInstallation(payload, inst);
    const body = JSON.stringify(enriched);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-GitHub-Event": event,
      "X-GitHub-Delivery": String(Date.now()),
    };
    if (ghApp.webhook_secret) {
      const hmac = createHmac("sha256", ghApp.webhook_secret).update(body).digest("hex");
      headers["X-Hub-Signature-256"] = `sha256=${hmac}`;
    }

    try {
      await fetch(ghApp.webhook_url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      // Best-effort delivery
    }
  }
}

export const githubPlugin: ServicePlugin = {
  name: "github",
  register(app: Hono<AppEnv>, store: Store, webhooks: WebhookDispatcher, baseUrl: string, tokenMap?: TokenMap): void {
    const gh = getGitHubStore(store);

    const originalDispatch = webhooks.dispatch.bind(webhooks);
    webhooks.dispatch = async (
      event: string,
      action: string | undefined,
      payload: unknown,
      owner: string,
      repo?: string,
    ): Promise<void> => {
      const installations = findInstallationsForRepo(gh, owner, repo, event);

      const enrichedPayload =
        installations.length > 0 ? enrichPayloadWithInstallation(payload, installations[0]) : payload;

      await originalDispatch(event, action, enrichedPayload, owner, repo);
      await deliverToAppWebhookUrls(gh, event, action, payload, owner, repo);
    };

    const ctx: RouteContext = { app, store, webhooks, baseUrl, tokenMap };
    usersRoutes(ctx);
    reposRoutes(ctx);
    issueRelationshipsRoutes(ctx);
    issuesRoutes(ctx);
    pullsRoutes(ctx);
    commentsRoutes(ctx);
    reviewsRoutes(ctx);
    labelsAndMilestonesRoutes(ctx);
    branchesAndGitRoutes(ctx);
    orgsAndTeamsRoutes(ctx);
    releasesRoutes(ctx);
    webhooksRoutes(ctx);
    searchRoutes(ctx);
    actionsRoutes(ctx);
    checksRoutes(ctx);
    rateLimitRoutes(ctx);
    graphqlRoutes(ctx);
    metaRoutes(ctx);
    oauthRoutes(ctx);
    appsRoutes(ctx);
    contentsRoutes(ctx);
    // Registered last: the catch-all /commits/:ref{.+} route must not shadow
    // /commits/:sha/comments (comments.ts) or /commits/:ref/check-* (checks.ts).
    commitsRoutes(ctx);
  },
  seed(store: Store, baseUrl: string): void {
    seedDefaults(store, baseUrl);
  },
};

export default githubPlugin;
