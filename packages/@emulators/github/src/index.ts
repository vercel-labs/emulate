import { createHmac } from "crypto";
import type { Hono } from "hono";
import type { ServicePlugin, Store, WebhookDispatcher, TokenMap, AppEnv, RouteContext } from "@emulators/core";
import { getGitHubStore } from "./store.js";
import type { GitHubStore } from "./store.js";
import type { GitHubAppInstallation } from "./entities.js";
import { generateNodeId, generateSha } from "./helpers.js";
import { usersRoutes } from "./routes/users.js";
import { reposRoutes } from "./routes/repos.js";
import { issuesRoutes } from "./routes/issues.js";
import { pullsRoutes } from "./routes/pulls.js";
import { commentsRoutes } from "./routes/comments.js";
import { reviewsRoutes } from "./routes/reviews.js";
import { labelsAndMilestonesRoutes } from "./routes/labels.js";
import { branchesAndGitRoutes } from "./routes/branches.js";
import { orgsAndTeamsRoutes } from "./routes/orgs.js";
import { releasesRoutes } from "./routes/releases.js";
import { webhooksRoutes } from "./routes/webhooks.js";
import { searchRoutes } from "./routes/search.js";
import { actionsRoutes } from "./routes/actions.js";
import { checksRoutes } from "./routes/checks.js";
import { rateLimitRoutes } from "./routes/rate-limit.js";
import { metaRoutes } from "./routes/meta.js";
import { oauthRoutes } from "./routes/oauth.js";
import { appsRoutes } from "./routes/apps.js";

export { getGitHubStore, type GitHubStore } from "./store.js";
export * from "./entities.js";

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
  }>;
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
    private_key: string;
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

export function seedFromConfig(store: Store, baseUrl: string, config: GitHubSeedConfig): void {
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
        const sha = generateSha();
        const treeSha = generateSha();

        const commit = gh.commits.insert({
          repo_id: repo.id,
          sha,
          node_id: "",
          message: "Initial commit",
          author_name: r.owner,
          author_email: `${r.owner}@localhost`,
          author_date: repo.created_at,
          committer_name: r.owner,
          committer_email: `${r.owner}@localhost`,
          committer_date: repo.created_at,
          tree_sha: treeSha,
          parent_shas: [],
          user_id: owner.id,
        });
        gh.commits.update(commit.id, { node_id: generateNodeId("Commit", commit.id) });

        const tree = gh.trees.insert({
          repo_id: repo.id,
          sha: treeSha,
          node_id: "",
          tree: [{ path: "README.md", mode: "100644", type: "blob", sha: generateSha(), size: 20 }],
          truncated: false,
        });
        gh.trees.update(tree.id, { node_id: generateNodeId("Tree", tree.id) });

        gh.branches.insert({
          repo_id: repo.id,
          name: defaultBranch,
          sha,
          protected: false,
        });

        const refRow = gh.refs.insert({
          repo_id: repo.id,
          ref: `refs/heads/${defaultBranch}`,
          sha,
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

      gh.apps.insert({
        app_id: a.app_id,
        slug: a.slug,
        name: a.name,
        private_key: a.private_key,
        permissions: a.permissions ?? {},
        events: a.events ?? [],
        webhook_url: a.webhook_url ?? null,
        webhook_secret: a.webhook_secret ?? null,
        description: a.description ?? null,
      });

      if (a.installations) {
        for (const inst of a.installations) {
          const account =
            gh.users.findOneBy("login", inst.account) ??
            gh.orgs.findOneBy("login", inst.account);
          if (!account) continue;

          const accountType = gh.users.findOneBy("login", inst.account)
            ? "User" as const
            : "Organization" as const;

          const repoIds: number[] = [];
          if (inst.repositories) {
            for (const repoFullName of inst.repositories) {
              const fullName = repoFullName.includes("/")
                ? repoFullName
                : `${inst.account}/${repoFullName}`;
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

function findInstallationsForRepo(
  gh: GitHubStore,
  ownerLogin: string,
  repoName: string | undefined,
  event: string,
): GitHubAppInstallation[] {
  const ownerEntity =
    gh.users.findOneBy("login", ownerLogin) ?? gh.orgs.findOneBy("login", ownerLogin);
  if (!ownerEntity) return [];

  const repoEntity = repoName
    ? gh.repos.findOneBy("full_name", `${ownerLogin}/${repoName}`)
    : null;

  const results: GitHubAppInstallation[] = [];
  for (const inst of gh.appInstallations.all()) {
    if (inst.account_id !== ownerEntity.id) continue;
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

function enrichPayloadWithInstallation(
  payload: unknown,
  installation: GitHubAppInstallation,
): unknown {
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

      const enrichedPayload = installations.length > 0
        ? enrichPayloadWithInstallation(payload, installations[0])
        : payload;

      await originalDispatch(event, action, enrichedPayload, owner, repo);
      await deliverToAppWebhookUrls(gh, event, action, payload, owner, repo);
    };

    const ctx: RouteContext = { app, store, webhooks, baseUrl, tokenMap };
    usersRoutes(ctx);
    reposRoutes(ctx);
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
    metaRoutes(ctx);
    oauthRoutes(ctx);
    appsRoutes(ctx);
  },
  seed(store: Store, baseUrl: string): void {
    seedDefaults(store, baseUrl);
  },
};

export default githubPlugin;
