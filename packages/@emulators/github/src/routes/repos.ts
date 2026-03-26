import type { RouteContext } from "@emulators/core";
import {
  ApiError,
  forbidden,
  parseJsonBody,
  parsePagination,
  setLinkHeader,
} from "@emulators/core";
import { getGitHubStore } from "../store.js";
import {
  assertAuthenticatedUser,
  assertRepoRead,
  hasRepoAdmin,
  isOrgMember,
  notFoundResponse,
  ownerLoginOf,
} from "../route-helpers.js";
import type { GitHubStore } from "../store.js";
import type {
  GitHubBlob,
  GitHubBranch,
  GitHubCollaborator,
  GitHubCommit,
  GitHubRef,
  GitHubRepo,
  GitHubTag,
  GitHubTree,
  GitHubUser,
} from "../entities.js";
import type { Collection, Entity } from "@emulators/core";
import {
  formatRepo,
  formatUser,
  generateNodeId,
  generateSha,
  lookupOwner,
  lookupRepo,
  timestamp,
} from "../helpers.js";

const LICENSE_TEMPLATES: Record<string, { key: string; name: string; spdx_id: string }> = {
  mit: { key: "mit", name: "MIT License", spdx_id: "MIT" },
  "apache-2.0": { key: "apache-2.0", name: "Apache License 2.0", spdx_id: "Apache-2.0" },
  "gpl-3.0": { key: "gpl-3.0", name: "GNU General Public License v3.0", spdx_id: "GPL-3.0" },
  "bsd-3-clause": {
    key: "bsd-3-clause",
    name: 'BSD 3-Clause "New" or "Revised" License',
    spdx_id: "BSD-3-Clause",
  },
  unlicense: { key: "unlicense", name: "The Unlicense", spdx_id: "Unlicense" },
};

function resolveLicenseTemplate(template: string) {
  const key = template.trim().toLowerCase();
  return LICENSE_TEMPLATES[key] ?? null;
}

function validateRepoName(name: unknown): string {
  if (typeof name !== "string" || !name.trim()) {
    throw new ApiError(422, "Invalid repository name");
  }
  const trimmed = name.trim();
  if (trimmed.length > 100 || !/^[a-zA-Z0-9._-]+$/.test(trimmed)) {
    throw new ApiError(422, "Invalid repository name");
  }
  return trimmed;
}

function seedInitialGit(
  gh: GitHubStore,
  repo: GitHubRepo,
  actor: GitHubUser | null,
  readmeTitle?: string
) {
  const repoId = repo.id;
  const readme = `# ${readmeTitle ?? repo.name}\n`;
  const size = Buffer.byteLength(readme, "utf8");

  const blob = gh.blobs.insert({
    repo_id: repoId,
    sha: generateSha(),
    node_id: "",
    content: readme,
    encoding: "utf-8",
    size,
  } as Omit<GitHubBlob, "id" | "created_at" | "updated_at">);
  gh.blobs.update(blob.id, { node_id: generateNodeId("Blob", blob.id) });

  const tree = gh.trees.insert({
    repo_id: repoId,
    sha: generateSha(),
    node_id: "",
    tree: [{ path: "README.md", mode: "100644", type: "blob", sha: blob.sha }],
    truncated: false,
  } as Omit<GitHubTree, "id" | "created_at" | "updated_at">);
  gh.trees.update(tree.id, { node_id: generateNodeId("Tree", tree.id) });

  const authorName = actor?.name ?? actor?.login ?? "User";
  const login = actor?.login ?? "user";
  const email = actor?.email ?? `${login}@users.noreply.github.com`;
  const now = timestamp();

  const commit = gh.commits.insert({
    repo_id: repoId,
    sha: generateSha(),
    node_id: "",
    message: "Initial commit",
    author_name: authorName,
    author_email: email,
    author_date: now,
    committer_name: authorName,
    committer_email: email,
    committer_date: now,
    tree_sha: tree.sha,
    parent_shas: [],
    user_id: actor?.id ?? null,
  } as Omit<GitHubCommit, "id" | "created_at" | "updated_at">);
  gh.commits.update(commit.id, { node_id: generateNodeId("Commit", commit.id) });

  gh.branches.insert({
    repo_id: repoId,
    name: repo.default_branch,
    sha: commit.sha,
    protected: false,
  } as Omit<GitHubBranch, "id" | "created_at" | "updated_at">);

  const ref = gh.refs.insert({
    repo_id: repoId,
    ref: `refs/heads/${repo.default_branch}`,
    sha: commit.sha,
    node_id: "",
  } as Omit<GitHubRef, "id" | "created_at" | "updated_at">);
  gh.refs.update(ref.id, { node_id: generateNodeId("Ref", ref.id) });

  gh.repos.update(repo.id, {
    size,
    pushed_at: now,
    language: "Markdown",
    languages: { Markdown: size },
  });
}

function bumpPublicRepos(gh: GitHubStore, ownerId: number, ownerType: "User" | "Organization", delta: number) {
  if (delta === 0) return;
  if (ownerType === "User") {
    const u = gh.users.get(ownerId);
    if (u) gh.users.update(ownerId, { public_repos: Math.max(0, u.public_repos + delta) });
  } else {
    const o = gh.orgs.get(ownerId);
    if (o) gh.orgs.update(ownerId, { public_repos: Math.max(0, o.public_repos + delta) });
  }
}

type CreateRepoRecordParams = {
  name: unknown;
  description: string | null;
  private: boolean;
  homepage: string | null;
  has_issues: boolean;
  has_wiki: boolean;
  has_projects: boolean;
  auto_init: boolean;
  license_template: string | null | undefined;
  gitignore_template: string | null | undefined;
  owner_id: number;
  owner_type: "User" | "Organization";
  owner_login: string;
  default_branch: string;
  baseUrl: string;
  allow_rebase_merge?: boolean;
  allow_squash_merge?: boolean;
  allow_merge_commit?: boolean;
  delete_branch_on_merge?: boolean;
};

function createRepoRecord(
  gh: GitHubStore,
  params: CreateRepoRecordParams,
  actor: GitHubUser
): GitHubRepo {
  const name = validateRepoName(params.name);
  const fullName = `${params.owner_login}/${name}`;
  if (gh.repos.findOneBy("full_name", fullName)) {
    throw new ApiError(422, "Repository already exists");
  }

  const isPrivate = params.private;
  const visibility = isPrivate
    ? "private"
    : ("public" as GitHubRepo["visibility"]);

  const license =
    typeof params.license_template === "string"
      ? resolveLicenseTemplate(params.license_template)
      : null;

  const repo = gh.repos.insert({
    node_id: "",
    name,
    full_name: fullName,
    owner_id: params.owner_id,
    owner_type: params.owner_type,
    private: isPrivate,
    description: params.description,
    fork: false,
    forked_from_id: null,
    homepage: params.homepage,
    language: null,
    languages: {},
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    size: 0,
    default_branch: params.default_branch,
    open_issues_count: 0,
    topics: [],
    has_issues: params.has_issues,
    has_projects: params.has_projects,
    has_wiki: params.has_wiki,
    has_pages: false,
    has_downloads: true,
    has_discussions: false,
    archived: false,
    disabled: false,
    visibility,
    pushed_at: null,
    allow_rebase_merge: params.allow_rebase_merge ?? true,
    allow_squash_merge: params.allow_squash_merge ?? true,
    allow_merge_commit: params.allow_merge_commit ?? true,
    allow_auto_merge: false,
    delete_branch_on_merge: params.delete_branch_on_merge ?? false,
    allow_forking: true,
    is_template: false,
    license,
  } as Omit<GitHubRepo, "id" | "created_at" | "updated_at">);

  gh.repos.update(repo.id, { node_id: generateNodeId("Repository", repo.id) });

  if (!isPrivate) {
    bumpPublicRepos(gh, params.owner_id, params.owner_type, 1);
  }

  const updated = gh.repos.get(repo.id)!;
  if (params.auto_init) {
    seedInitialGit(gh, updated, actor);
  }

  return gh.repos.get(repo.id)!;
}

function deleteRepoCascade(gh: GitHubStore, repo: GitHubRepo) {
  const repoId = repo.id;
  const wasPublic = !repo.private;

  const delByRepo = <T extends Entity>(col: Collection<T>) => {
    for (const item of col.findBy("repo_id" as keyof T, repoId as T[keyof T])) {
      col.delete(item.id);
    }
  };

  delByRepo(gh.collaborators);
  delByRepo(gh.issues);
  delByRepo(gh.pullRequests);
  delByRepo(gh.labels);
  delByRepo(gh.milestones);
  delByRepo(gh.comments);
  delByRepo(gh.reviews);
  delByRepo(gh.issueEvents);
  delByRepo(gh.branches);
  delByRepo(gh.branchProtections);
  delByRepo(gh.refs);
  delByRepo(gh.commits);
  delByRepo(gh.trees);
  delByRepo(gh.blobs);
  delByRepo(gh.tags);

  for (const rel of gh.releases.findBy("repo_id", repoId)) {
    for (const a of gh.releaseAssets.findBy("release_id", rel.id)) {
      gh.releaseAssets.delete(a.id);
    }
    gh.releases.delete(rel.id);
  }

  delByRepo(gh.webhooks);
  delByRepo(gh.workflows);
  for (const run of gh.workflowRuns.findBy("repo_id", repoId)) {
    for (const j of gh.jobs.findBy("run_id", run.id)) {
      gh.jobs.delete(j.id);
    }
    for (const a of gh.artifacts.findBy("run_id", run.id)) {
      gh.artifacts.delete(a.id);
    }
    gh.workflowRuns.delete(run.id);
  }

  delByRepo(gh.secrets);
  delByRepo(gh.checkRuns);
  delByRepo(gh.checkSuites);

  gh.repos.delete(repoId);

  if (wasPublic) {
    bumpPublicRepos(gh, repo.owner_id, repo.owner_type, -1);
  }

  if (repo.forked_from_id) {
    const parent = gh.repos.get(repo.forked_from_id);
    if (parent && parent.forks_count > 0) {
      gh.repos.update(parent.id, { forks_count: parent.forks_count - 1 });
    }
  }
}

function formatTagItem(tag: GitHubTag, repo: GitHubRepo, baseUrl: string) {
  const repoUrl = `${baseUrl}/repos/${repo.full_name}`;
  return {
    name: tag.tag,
    zipball_url: `${repoUrl}/zipball/${encodeURIComponent(tag.tag)}`,
    tarball_url: `${repoUrl}/tarball/${encodeURIComponent(tag.tag)}`,
    commit: {
      sha: tag.sha,
      url: `${repoUrl}/commits/${tag.sha}`,
    },
    node_id: tag.node_id,
  };
}

function parsePermission(
  raw: unknown
): "pull" | "triage" | "push" | "maintain" | "admin" | undefined {
  if (raw === undefined) return undefined;
  if (
    raw === "pull" ||
    raw === "triage" ||
    raw === "push" ||
    raw === "maintain" ||
    raw === "admin"
  ) {
    return raw;
  }
  return undefined;
}

export function reposRoutes({ app, store, webhooks, baseUrl }: RouteContext): void {
  const gh = getGitHubStore(store);

  app.get("/repos/:owner/:repo", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoRead(gh, c.get("authUser"), repo);
    return c.json(formatRepo(repo, gh, baseUrl));
  });

  app.post("/user/repos", async (c) => {
    const authUser = c.get("authUser");
    const user = assertAuthenticatedUser(gh, authUser);
    const body = await parseJsonBody(c);

    const finalRepo = createRepoRecord(
      gh,
      {
        name: body.name,
        description: typeof body.description === "string" ? body.description : null,
        private: typeof body.private === "boolean" ? body.private : false,
        homepage: typeof body.homepage === "string" ? body.homepage : null,
        has_issues: typeof body.has_issues === "boolean" ? body.has_issues : true,
        has_projects: typeof body.has_projects === "boolean" ? body.has_projects : true,
        has_wiki: typeof body.has_wiki === "boolean" ? body.has_wiki : true,
        auto_init: body.auto_init === true,
        license_template:
          typeof body.license_template === "string" ? body.license_template : undefined,
        gitignore_template:
          typeof body.gitignore_template === "string" ? body.gitignore_template : undefined,
        owner_id: user.id,
        owner_type: "User",
        owner_login: user.login,
        default_branch: "main",
        baseUrl,
        allow_rebase_merge:
          typeof body.allow_rebase_merge === "boolean" ? body.allow_rebase_merge : undefined,
        allow_squash_merge:
          typeof body.allow_squash_merge === "boolean" ? body.allow_squash_merge : undefined,
        allow_merge_commit:
          typeof body.allow_merge_commit === "boolean" ? body.allow_merge_commit : undefined,
        delete_branch_on_merge:
          typeof body.delete_branch_on_merge === "boolean" ? body.delete_branch_on_merge : undefined,
      },
      user
    );

    webhooks.dispatch(
      "repository",
      "created",
      { action: "created", repository: formatRepo(finalRepo, gh, baseUrl), sender: formatUser(user, baseUrl) },
      user.login,
      finalRepo.name
    );

    return c.json(formatRepo(finalRepo, gh, baseUrl), 201);
  });

  app.post("/orgs/:org/repos", async (c) => {
    const authUser = c.get("authUser");
    const user = assertAuthenticatedUser(gh, authUser);
    const orgLogin = c.req.param("org")!;
    const org = gh.orgs.findOneBy("login", orgLogin);
    if (!org) throw notFoundResponse();

    if (!isOrgMember(gh, user.id, org.id)) {
      throw forbidden();
    }

    const body = await parseJsonBody(c);

    const finalRepo = createRepoRecord(
      gh,
      {
        name: body.name,
        description: typeof body.description === "string" ? body.description : null,
        private: typeof body.private === "boolean" ? body.private : false,
        homepage: typeof body.homepage === "string" ? body.homepage : null,
        has_issues: typeof body.has_issues === "boolean" ? body.has_issues : true,
        has_projects: typeof body.has_projects === "boolean" ? body.has_projects : true,
        has_wiki: typeof body.has_wiki === "boolean" ? body.has_wiki : true,
        auto_init: body.auto_init === true,
        license_template:
          typeof body.license_template === "string" ? body.license_template : undefined,
        gitignore_template:
          typeof body.gitignore_template === "string" ? body.gitignore_template : undefined,
        owner_id: org.id,
        owner_type: "Organization",
        owner_login: org.login,
        default_branch: "main",
        baseUrl,
        allow_rebase_merge:
          typeof body.allow_rebase_merge === "boolean" ? body.allow_rebase_merge : undefined,
        allow_squash_merge:
          typeof body.allow_squash_merge === "boolean" ? body.allow_squash_merge : undefined,
        allow_merge_commit:
          typeof body.allow_merge_commit === "boolean" ? body.allow_merge_commit : undefined,
        delete_branch_on_merge:
          typeof body.delete_branch_on_merge === "boolean" ? body.delete_branch_on_merge : undefined,
      },
      user
    );

    webhooks.dispatch(
      "repository",
      "created",
      { action: "created", repository: formatRepo(finalRepo, gh, baseUrl), sender: formatUser(user, baseUrl) },
      org.login,
      finalRepo.name
    );

    return c.json(formatRepo(finalRepo, gh, baseUrl), 201);
  });

  app.patch("/repos/:owner/:repo", async (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoRead(gh, c.get("authUser"), repo);
    const authUser = c.get("authUser");
    const user = assertAuthenticatedUser(gh, authUser);
    if (!hasRepoAdmin(gh, user, repo)) throw forbidden();

    const body = await parseJsonBody(c);
    const patch: Partial<GitHubRepo> = {};

    if (typeof body.name === "string") {
      const newName = validateRepoName(body.name);
      const login = ownerLoginOf(gh, repo);
      const newFull = `${login}/${newName}`;
      if (newFull !== repo.full_name && gh.repos.findOneBy("full_name", newFull)) {
        throw new ApiError(422, "Repository already exists");
      }
      patch.name = newName;
      patch.full_name = newFull;
    }

    if ("description" in body) {
      patch.description = body.description === null ? null : String(body.description);
    }
    if ("homepage" in body && (typeof body.homepage === "string" || body.homepage === null)) {
      patch.homepage = body.homepage;
    }
    if (typeof body.private === "boolean") {
      patch.private = body.private;
      patch.visibility = body.private ? "private" : "public";
    }
    if (typeof body.has_issues === "boolean") patch.has_issues = body.has_issues;
    if (typeof body.has_projects === "boolean") patch.has_projects = body.has_projects;
    if (typeof body.has_wiki === "boolean") patch.has_wiki = body.has_wiki;
    if (typeof body.has_pages === "boolean") patch.has_pages = body.has_pages;
    if (typeof body.has_downloads === "boolean") patch.has_downloads = body.has_downloads;
    if (typeof body.has_discussions === "boolean") patch.has_discussions = body.has_discussions;
    if (typeof body.archived === "boolean") patch.archived = body.archived;
    if (typeof body.disabled === "boolean") patch.disabled = body.disabled;
    if (typeof body.default_branch === "string") patch.default_branch = body.default_branch;

    if (Array.isArray(body.topics)) {
      patch.topics = body.topics.filter((t): t is string => typeof t === "string");
    }

    if (typeof body.visibility === "string") {
      const v = body.visibility;
      if (v === "public" || v === "private" || v === "internal") {
        patch.visibility = v;
        patch.private = v !== "public";
      }
    }

    if ("license" in body) {
      if (body.license === null) patch.license = null;
      else if (typeof body.license === "object" && body.license !== null) {
        const L = body.license as Record<string, unknown>;
        if (
          typeof L.key === "string" &&
          typeof L.name === "string" &&
          typeof L.spdx_id === "string"
        ) {
          patch.license = { key: L.key, name: L.name, spdx_id: L.spdx_id };
        }
      }
    }

    if (typeof body.allow_rebase_merge === "boolean") patch.allow_rebase_merge = body.allow_rebase_merge;
    if (typeof body.allow_squash_merge === "boolean") patch.allow_squash_merge = body.allow_squash_merge;
    if (typeof body.allow_merge_commit === "boolean") patch.allow_merge_commit = body.allow_merge_commit;
    if (typeof body.allow_auto_merge === "boolean") patch.allow_auto_merge = body.allow_auto_merge;
    if (typeof body.delete_branch_on_merge === "boolean") {
      patch.delete_branch_on_merge = body.delete_branch_on_merge;
    }
    if (typeof body.allow_forking === "boolean") patch.allow_forking = body.allow_forking;
    if (typeof body.is_template === "boolean") patch.is_template = body.is_template;

    const oldPrivate = repo.private;
    const updated = gh.repos.update(repo.id, patch);
    if (!updated) throw notFoundResponse();

    if (oldPrivate !== updated.private) {
      const delta = updated.private ? -1 : 1;
      bumpPublicRepos(gh, updated.owner_id, updated.owner_type, delta);
    }

    webhooks.dispatch(
      "repository",
      "edited",
      { action: "edited", repository: formatRepo(updated, gh, baseUrl), sender: formatUser(user, baseUrl) },
      ownerLoginOf(gh, updated),
      updated.name
    );

    return c.json(formatRepo(updated, gh, baseUrl));
  });

  app.delete("/repos/:owner/:repo", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    const authUser = c.get("authUser");
    const user = assertAuthenticatedUser(gh, authUser);
    if (!hasRepoAdmin(gh, user, repo)) throw forbidden();

    webhooks.dispatch(
      "repository",
      "deleted",
      { action: "deleted", repository: formatRepo(repo, gh, baseUrl), sender: formatUser(user, baseUrl) },
      owner,
      repoName
    );

    deleteRepoCascade(gh, repo);
    return c.body(null, 204);
  });

  app.get("/repos/:owner/:repo/topics", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoRead(gh, c.get("authUser"), repo);
    return c.json({ names: repo.topics });
  });

  app.put("/repos/:owner/:repo/topics", async (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    const authUser = c.get("authUser");
    const user = assertAuthenticatedUser(gh, authUser);
    if (!hasRepoAdmin(gh, user, repo)) throw forbidden();

    const body = await parseJsonBody(c) as { names?: unknown };
    const names = Array.isArray(body.names)
      ? body.names.filter((n): n is string => typeof n === "string")
      : [];
    const updated = gh.repos.update(repo.id, { topics: names });
    if (!updated) throw notFoundResponse();
    return c.json({ names: updated.topics });
  });

  app.get("/repos/:owner/:repo/languages", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoRead(gh, c.get("authUser"), repo);
    return c.json(repo.languages);
  });

  app.get("/repos/:owner/:repo/contributors", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoRead(gh, c.get("authUser"), repo);

    const collabUsers = gh.collaborators
      .findBy("repo_id", repo.id)
      .map((col) => gh.users.get(col.user_id))
      .filter((u): u is GitHubUser => Boolean(u));

    const ownerUser =
      repo.owner_type === "User" ? gh.users.get(repo.owner_id) : undefined;

    const map = new Map<number, GitHubUser>();
    if (ownerUser) map.set(ownerUser.id, ownerUser);
    for (const u of collabUsers) map.set(u.id, u);

    const all = [...map.values()].sort((a, b) => a.login.localeCompare(b.login));
    const { page, per_page } = parsePagination(c);
    const total = all.length;
    const start = (page - 1) * per_page;
    const slice = all.slice(start, start + per_page);

    setLinkHeader(c, total, page, per_page);
    return c.json(
      slice.map((u) => ({
        ...formatUser(u, baseUrl),
        contributions: 1,
      }))
    );
  });

  app.get("/repos/:owner/:repo/forks", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoRead(gh, c.get("authUser"), repo);

    const forks = gh.repos
      .all()
      .filter((r) => r.forked_from_id === repo.id)
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));

    const { page, per_page } = parsePagination(c);
    const total = forks.length;
    const start = (page - 1) * per_page;
    const slice = forks.slice(start, start + per_page);

    setLinkHeader(c, total, page, per_page);
    return c.json(slice.map((r) => formatRepo(r, gh, baseUrl)));
  });

  app.post("/repos/:owner/:repo/forks", async (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const parent = lookupRepo(gh, owner, repoName);
    if (!parent) throw notFoundResponse();

    const authUser = c.get("authUser");
    const user = assertAuthenticatedUser(gh, authUser);
    assertRepoRead(gh, authUser, parent);

    const body = await parseJsonBody(c) as {
      organization?: unknown;
      name?: unknown;
    };

    let ownerType: "User" | "Organization" = "User";
    let ownerId = user.id;
    let fullName = "";
    let forkName =
      typeof body.name === "string" && body.name.trim()
        ? validateRepoName(body.name)
        : parent.name;

    if (typeof body.organization === "string" && body.organization.trim()) {
      const org = gh.orgs.findOneBy("login", body.organization.trim());
      if (!org) throw notFoundResponse();
      if (!isOrgMember(gh, user.id, org.id)) throw forbidden();
      ownerType = "Organization";
      ownerId = org.id;
      fullName = `${org.login}/${forkName}`;
    } else {
      fullName = `${user.login}/${forkName}`;
    }

    if (gh.repos.findOneBy("full_name", fullName)) {
      throw new ApiError(422, "Repository already exists");
    }

    const isPrivate = parent.private;
    const visibility = isPrivate ? "private" : "public";

    const repo = gh.repos.insert({
      node_id: "",
      name: forkName,
      full_name: fullName,
      owner_id: ownerId,
      owner_type: ownerType,
      private: isPrivate,
      description: parent.description,
      fork: true,
      forked_from_id: parent.id,
      homepage: parent.homepage,
      language: parent.language,
      languages: { ...parent.languages },
      forks_count: 0,
      stargazers_count: 0,
      watchers_count: 0,
      size: parent.size,
      default_branch: parent.default_branch,
      open_issues_count: 0,
      topics: [...parent.topics],
      has_issues: parent.has_issues,
      has_projects: parent.has_projects,
      has_wiki: parent.has_wiki,
      has_pages: parent.has_pages,
      has_downloads: parent.has_downloads,
      has_discussions: parent.has_discussions,
      archived: false,
      disabled: false,
      visibility: visibility as GitHubRepo["visibility"],
      pushed_at: parent.pushed_at,
      allow_rebase_merge: parent.allow_rebase_merge,
      allow_squash_merge: parent.allow_squash_merge,
      allow_merge_commit: parent.allow_merge_commit,
      allow_auto_merge: parent.allow_auto_merge,
      delete_branch_on_merge: parent.delete_branch_on_merge,
      allow_forking: parent.allow_forking,
      is_template: false,
      license: parent.license,
    } as Omit<GitHubRepo, "id" | "created_at" | "updated_at">);

    gh.repos.update(repo.id, { node_id: generateNodeId("Repository", repo.id) });

    if (!isPrivate) {
      bumpPublicRepos(gh, ownerId, ownerType, 1);
    }

    gh.repos.update(parent.id, { forks_count: parent.forks_count + 1 });

    seedInitialGit(gh, gh.repos.get(repo.id)!, user, parent.full_name);

    const finalRepo = gh.repos.get(repo.id)!;
    const ownerLogin = ownerLoginOf(gh, finalRepo);
    webhooks.dispatch(
      "fork",
      "created",
      { action: "created", repository: formatRepo(finalRepo, gh, baseUrl), sender: formatUser(user, baseUrl) },
      ownerLogin,
      finalRepo.name
    );

    return c.json(formatRepo(finalRepo, gh, baseUrl), 202);
  });

  app.get("/repos/:owner/:repo/collaborators", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoRead(gh, c.get("authUser"), repo);

    const collabs = gh.collaborators.findBy("repo_id", repo.id);
    const users = collabs
      .map((col) => {
        const u = gh.users.get(col.user_id);
        if (!u) return null;
        return { user: u, permission: col.permission };
      })
      .filter((x): x is { user: GitHubUser; permission: GitHubCollaborator["permission"] } =>
        Boolean(x)
      )
      .sort((a, b) => a.user.login.localeCompare(b.user.login));

    const { page, per_page } = parsePagination(c);
    const total = users.length;
    const start = (page - 1) * per_page;
    const slice = users.slice(start, start + per_page);

    setLinkHeader(c, total, page, per_page);
    return c.json(slice.map((x) => formatUser(x.user, baseUrl)));
  });

  app.put("/repos/:owner/:repo/collaborators/:username", async (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const username = c.req.param("username")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    const authUser = c.get("authUser");
    const actor = assertAuthenticatedUser(gh, authUser);
    if (!hasRepoAdmin(gh, actor, repo)) throw forbidden();

    const target = gh.users.findOneBy("login", username);
    if (!target) throw notFoundResponse();

    const body = await parseJsonBody(c) as { permission?: unknown };
    const permission = parsePermission(body.permission) ?? "push";

    const existing = gh.collaborators
      .findBy("repo_id", repo.id)
      .find((c) => c.user_id === target.id);
    if (existing) {
      gh.collaborators.update(existing.id, { permission });
    } else {
      gh.collaborators.insert({
        repo_id: repo.id,
        user_id: target.id,
        permission,
      } as Omit<GitHubCollaborator, "id" | "created_at" | "updated_at">);
    }

    return c.json({ permission }, 201);
  });

  app.delete("/repos/:owner/:repo/collaborators/:username", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const username = c.req.param("username")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    const authUser = c.get("authUser");
    const actor = assertAuthenticatedUser(gh, authUser);
    if (!hasRepoAdmin(gh, actor, repo)) throw forbidden();

    const target = gh.users.findOneBy("login", username);
    if (!target) throw notFoundResponse();

    const existing = gh.collaborators
      .findBy("repo_id", repo.id)
      .find((col) => col.user_id === target.id);
    if (existing) {
      gh.collaborators.delete(existing.id);
    }

    return c.body(null, 204);
  });

  app.get("/repos/:owner/:repo/collaborators/:username/permission", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const username = c.req.param("username")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoRead(gh, c.get("authUser"), repo);

    const target = gh.users.findOneBy("login", username);
    if (!target) throw notFoundResponse();

    if (repo.owner_type === "User" && repo.owner_id === target.id) {
      return c.json({
        permission: "admin",
        role_name: "admin",
        user: formatUser(target, baseUrl),
      });
    }

    if (repo.owner_type === "Organization" && isOrgMember(gh, target.id, repo.owner_id)) {
      return c.json({
        permission: "admin",
        role_name: "admin",
        user: formatUser(target, baseUrl),
      });
    }

    const collab = gh.collaborators
      .findBy("repo_id", repo.id)
      .find((col) => col.user_id === target.id);
    if (!collab) throw notFoundResponse();

    const roleName =
      collab.permission === "admin"
        ? "admin"
        : collab.permission === "maintain"
          ? "maintain"
          : collab.permission === "push"
            ? "write"
            : collab.permission === "triage"
              ? "triage"
              : "read";

    return c.json({
      permission: collab.permission,
      role_name: roleName,
      user: formatUser(target, baseUrl),
    });
  });

  app.post("/repos/:owner/:repo/transfer", async (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    const authUser = c.get("authUser");
    const actor = assertAuthenticatedUser(gh, authUser);
    if (!hasRepoAdmin(gh, actor, repo)) throw forbidden();

    const body = await parseJsonBody(c) as { new_owner?: unknown };
    if (typeof body.new_owner !== "string" || !body.new_owner.trim()) {
      throw new ApiError(422, "new_owner is required");
    }

    const newOwner = lookupOwner(gh, body.new_owner.trim());
    if (!newOwner) throw notFoundResponse();

    const newFull = `${newOwner.login}/${repo.name}`;
    if (newFull !== repo.full_name && gh.repos.findOneBy("full_name", newFull)) {
      throw new ApiError(422, "Repository already exists");
    }

    const updated = gh.repos.update(repo.id, {
      owner_id: newOwner.id,
      owner_type: newOwner.type === "User" ? "User" : "Organization",
      full_name: newFull,
    });
    if (!updated) throw notFoundResponse();

    webhooks.dispatch(
      "repository",
      "transferred",
      { action: "transferred", repository: formatRepo(updated, gh, baseUrl), sender: formatUser(actor, baseUrl) },
      newOwner.login,
      updated.name
    );

    return c.json(formatRepo(updated, gh, baseUrl));
  });

  app.get("/repos/:owner/:repo/tags", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoRead(gh, c.get("authUser"), repo);

    const tags = [...gh.tags.findBy("repo_id", repo.id)].sort((a, b) =>
      a.tag.localeCompare(b.tag)
    );

    const { page, per_page } = parsePagination(c);
    const total = tags.length;
    const start = (page - 1) * per_page;
    const slice = tags.slice(start, start + per_page);

    setLinkHeader(c, total, page, per_page);
    return c.json(slice.map((t) => formatTagItem(t, repo, baseUrl)));
  });
}
