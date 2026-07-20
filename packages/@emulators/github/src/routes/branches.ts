import type { RouteContext } from "@emulators/core";
import { ApiError, parseJsonBody, parsePagination, setLinkHeader } from "@emulators/core";
import { getGitHubStore } from "../store.js";
import type { GitHubStore } from "../store.js";
import type {
  GitHubBranch,
  GitHubBranchProtection,
  GitHubRef,
  GitHubRepo,
  GitHubTag,
  GitHubTree,
} from "../entities.js";
import {
  formatBranch,
  formatRepo,
  formatUser,
  generateNodeId,
  generateSha,
  lookupRepo,
  timestamp,
} from "../helpers.js";
import {
  assertBranchUpdateAllowed,
  assertRepoAdmin,
  assertRepoContentsRead,
  assertRepoContentsWrite,
  assertRepoPermission,
  notFoundResponse,
  ownerLoginOf,
} from "../route-helpers.js";
import {
  findOrCreateBlob,
  findOrCreateCommit,
  findOrCreateTree,
  formatGitCommit,
  resolveRefToCommit,
} from "../git-helpers.js";

function findBranchByName(gh: GitHubStore, repoId: number, name: string) {
  return gh.branches.findBy("repo_id", repoId).find((b) => b.name === name);
}

function findCommitBySha(gh: GitHubStore, repoId: number, sha: string) {
  return gh.commits.findBy("repo_id", repoId).find((c) => c.sha === sha);
}

function findTreeBySha(gh: GitHubStore, repoId: number, sha: string) {
  return gh.trees.findBy("repo_id", repoId).find((t) => t.sha === sha);
}

function findBlobBySha(gh: GitHubStore, repoId: number, sha: string) {
  return gh.blobs.findBy("repo_id", repoId).find((b) => b.sha === sha);
}

function findTagObjectBySha(gh: GitHubStore, repoId: number, sha: string) {
  return gh.tags.findBy("repo_id", repoId).find((t) => t.sha === sha);
}

function fullRefFromParam(refParam: string): string {
  return refParam.startsWith("refs/") ? refParam : `refs/${refParam}`;
}

function isDescendantOf(gh: GitHubStore, repoId: number, ancestorSha: string, descendantSha: string): boolean {
  const visiting = new Set<string>();
  const stack = [descendantSha];
  while (stack.length) {
    const sha = stack.pop()!;
    if (sha === ancestorSha) return true;
    if (visiting.has(sha)) continue;
    visiting.add(sha);
    const commit = findCommitBySha(gh, repoId, sha);
    if (!commit) continue;
    for (const p of commit.parent_shas) stack.push(p);
  }
  return false;
}

function resolveGitObjectType(gh: GitHubStore, repoId: number, sha: string): "commit" | "tag" | "blob" | "tree" {
  if (findCommitBySha(gh, repoId, sha)) return "commit";
  if (findTagObjectBySha(gh, repoId, sha)) return "tag";
  if (findTreeBySha(gh, repoId, sha)) return "tree";
  if (findBlobBySha(gh, repoId, sha)) return "blob";
  return "commit";
}

function objectApiUrl(
  repo: GitHubRepo,
  baseUrl: string,
  type: "commit" | "tag" | "blob" | "tree",
  sha: string,
): string {
  const repoUrl = `${baseUrl}/repos/${repo.full_name}`;
  switch (type) {
    case "commit":
      return `${repoUrl}/git/commits/${sha}`;
    case "tag":
      return `${repoUrl}/git/tags/${sha}`;
    case "tree":
      return `${repoUrl}/git/trees/${sha}`;
    default:
      return `${repoUrl}/git/blobs/${sha}`;
  }
}

function formatRefJson(gh: GitHubStore, repo: GitHubRepo, fullRef: string, sha: string, baseUrl: string) {
  const refRec = gh.refs.findBy("repo_id", repo.id).find((r) => r.ref === fullRef);
  const type = resolveGitObjectType(gh, repo.id, sha);
  const shortRef = fullRef.startsWith("refs/") ? fullRef.slice(5) : fullRef;
  const repoUrl = `${baseUrl}/repos/${repo.full_name}`;
  return {
    ref: fullRef,
    node_id: refRec?.node_id ?? "",
    url: `${repoUrl}/git/ref/${shortRef}`,
    object: {
      type,
      sha,
      url: objectApiUrl(repo, baseUrl, type, sha),
    },
  };
}

function syncBranchFromRef(gh: GitHubStore, repo: GitHubRepo, fullRef: string, sha: string) {
  if (!fullRef.startsWith("refs/heads/")) return;
  const name = fullRef.slice("refs/heads/".length);
  const existing = findBranchByName(gh, repo.id, name);
  if (existing) {
    gh.branches.update(existing.id, { sha });
  } else {
    gh.branches.insert({
      repo_id: repo.id,
      name,
      sha,
      protected: false,
    } as Omit<GitHubBranch, "id" | "created_at" | "updated_at">);
  }
}

function deleteBranchForHeadRef(gh: GitHubStore, repoId: number, fullRef: string) {
  if (!fullRef.startsWith("refs/heads/")) return;
  const name = fullRef.slice("refs/heads/".length);
  const b = findBranchByName(gh, repoId, name);
  if (b) gh.branches.delete(b.id);
}

function expandTreeEntries(
  gh: GitHubStore,
  repoId: number,
  entries: GitHubTree["tree"],
  recursive: boolean,
  prefix = "",
): GitHubTree["tree"] {
  const out: GitHubTree["tree"] = [];
  for (const e of entries) {
    const path = prefix ? `${prefix}/${e.path}` : e.path;
    out.push({ ...e, path });
    if (e.type === "tree" && recursive) {
      const sub = findTreeBySha(gh, repoId, e.sha);
      if (sub) {
        out.push(...expandTreeEntries(gh, repoId, sub.tree, true, path));
      }
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

type GitTreeEntry = GitHubTree["tree"][number];
type GitTreeUpdate = Omit<GitTreeEntry, "sha"> & { sha: string | null };

interface PendingGitTree {
  baseSha?: string;
  mode: string;
  files: Map<string, GitTreeEntry>;
  dirs: Map<string, PendingGitTree>;
  deletions: Set<string>;
}

function persistGitTreeHierarchy(
  gh: GitHubStore,
  repoId: number,
  baseSha: string | undefined,
  updates: GitTreeUpdate[],
): GitHubTree {
  const root: PendingGitTree = {
    baseSha,
    mode: "040000",
    files: new Map(),
    dirs: new Map(),
    deletions: new Set(),
  };

  const baseEntry = (pending: PendingGitTree, name: string) => {
    if (!pending.baseSha || pending.deletions.has(name)) return undefined;
    return findTreeBySha(gh, repoId, pending.baseSha)?.tree.find((entry) => entry.path === name);
  };

  const orderedUpdates = [...updates].sort((left, right) => left.path.split("/").length - right.path.split("/").length);
  for (const update of orderedUpdates) {
    const parts = update.path.split("/");
    let current = root;
    for (const part of parts.slice(0, -1)) {
      let child = current.dirs.get(part);
      if (!child) {
        const existing = current.files.get(part) ?? baseEntry(current, part);
        if (existing && existing.type !== "tree") {
          throw new ApiError(422, `${update.path} conflicts with an existing file`);
        }
        child = {
          baseSha: existing?.type === "tree" ? existing.sha : undefined,
          mode: existing?.mode ?? "040000",
          files: new Map(),
          dirs: new Map(),
          deletions: new Set(),
        };
        current.files.delete(part);
        current.deletions.delete(part);
        current.dirs.set(part, child);
      }
      current = child;
    }

    const name = parts.at(-1)!;
    if (update.sha === null) {
      const existing =
        current.files.get(name) ??
        (current.dirs.has(name) ? { type: "tree" as const } : undefined) ??
        baseEntry(current, name);
      if (!existing) throw new ApiError(422, `Cannot delete ${update.path} because it does not exist`);
      current.files.delete(name);
      current.dirs.delete(name);
      current.deletions.add(name);
      continue;
    }

    current.deletions.delete(name);
    if (update.type === "tree") {
      current.files.delete(name);
      current.dirs.set(name, {
        baseSha: update.sha,
        mode: update.mode,
        files: new Map(),
        dirs: new Map(),
        deletions: new Set(),
      });
    } else {
      current.dirs.delete(name);
      current.files.set(name, { ...update, path: name, sha: update.sha });
    }
  }

  const write = (pending: PendingGitTree): GitHubTree => {
    if (pending.baseSha && pending.files.size === 0 && pending.dirs.size === 0 && pending.deletions.size === 0) {
      const unchanged = findTreeBySha(gh, repoId, pending.baseSha);
      if (!unchanged) throw new ApiError(422, "Invalid tree");
      return unchanged;
    }
    const entries = new Map<string, GitTreeEntry>();
    if (pending.baseSha) {
      const base = findTreeBySha(gh, repoId, pending.baseSha);
      if (!base) throw new ApiError(422, "Invalid tree");
      for (const entry of base.tree) entries.set(entry.path, entry);
    }
    for (const [name, child] of pending.dirs) {
      const subtree = write(child);
      entries.set(name, { path: name, mode: child.mode, type: "tree", sha: subtree.sha });
    }
    for (const [name, entry] of pending.files) entries.set(name, { ...entry, path: name });
    for (const name of pending.deletions) entries.delete(name);

    return findOrCreateTree(gh, repoId, [...entries.values()]);
  };

  return write(root);
}

function protectionEntityToGitHub(gh: GitHubStore, repo: GitHubRepo, bp: GitHubBranchProtection, baseUrl: string) {
  const repoUrl = `${baseUrl}/repos/${repo.full_name}`;
  const encBranch = encodeURIComponent(bp.branch_name);
  const base = `${repoUrl}/branches/${encBranch}/protection`;
  return {
    url: base,
    required_status_checks: bp.required_status_checks
      ? {
          url: `${base}/required_status_checks`,
          strict: bp.required_status_checks.strict,
          contexts: bp.required_status_checks.contexts,
          contexts_url: `${base}/required_status_checks/contexts`,
          checks: bp.required_status_checks.contexts.map((c) => ({
            context: c,
            app_id: null,
          })),
        }
      : null,
    enforce_admins: {
      url: `${base}/enforce_admins`,
      enabled: bp.enforce_admins,
    },
    required_pull_request_reviews: bp.required_pull_request_reviews
      ? {
          url: `${base}/required_pull_request_reviews`,
          dismiss_stale_reviews: bp.required_pull_request_reviews.dismiss_stale_reviews,
          require_code_owner_reviews: bp.required_pull_request_reviews.require_code_owner_reviews,
          required_approving_review_count: bp.required_pull_request_reviews.required_approving_review_count,
        }
      : null,
    restrictions: bp.restrictions
      ? {
          url: `${base}/restrictions`,
          users_url: `${base}/restrictions/users`,
          teams_url: `${base}/restrictions/teams`,
          apps_url: `${base}/restrictions/apps`,
          users: bp.restrictions.users.map((login) => ({
            login,
            id: 0,
            node_id: "",
            avatar_url: `${baseUrl}/avatars/u/${login}`,
            gravatar_id: "",
            url: `${baseUrl}/users/${login}`,
            html_url: `${baseUrl}/${login}`,
            type: "User",
            site_admin: false,
          })),
          teams: bp.restrictions.teams.map((slug) => ({
            id: 0,
            node_id: "",
            url: `${baseUrl}/teams/0`,
            name: slug,
            slug,
          })),
          apps: [],
        }
      : null,
    required_linear_history: { enabled: bp.required_linear_history },
    allow_force_pushes: { enabled: bp.allow_force_pushes },
    allow_deletions: { enabled: bp.allow_deletions },
    required_conversation_resolution: { enabled: false },
    required_signatures: { url: `${base}/required_signatures`, enabled: bp.required_signatures },
    lock_branch: { enabled: false },
    allow_fork_syncing: { enabled: false },
  };
}

function parseProtectionPutBody(
  body: Record<string, unknown>,
): Omit<GitHubBranchProtection, "id" | "repo_id" | "branch_name" | "created_at" | "updated_at"> {
  const rsc = body.required_status_checks;
  let required_status_checks: GitHubBranchProtection["required_status_checks"] = null;
  if (rsc && typeof rsc === "object" && rsc !== null) {
    const o = rsc as Record<string, unknown>;
    required_status_checks = {
      strict: Boolean(o.strict),
      contexts: Array.isArray(o.contexts) ? o.contexts.filter((x): x is string => typeof x === "string") : [],
    };
  }

  let enforce_admins = false;
  const ea = body.enforce_admins;
  if (typeof ea === "boolean") enforce_admins = ea;
  else if (ea && typeof ea === "object" && "enabled" in ea) {
    enforce_admins = Boolean((ea as { enabled?: unknown }).enabled);
  }

  const rprr = body.required_pull_request_reviews;
  let required_pull_request_reviews: GitHubBranchProtection["required_pull_request_reviews"] = null;
  if (rprr && typeof rprr === "object" && rprr !== null) {
    const o = rprr as Record<string, unknown>;
    required_pull_request_reviews = {
      required_approving_review_count:
        typeof o.required_approving_review_count === "number" ? o.required_approving_review_count : 1,
      dismiss_stale_reviews: Boolean(o.dismiss_stale_reviews),
      require_code_owner_reviews: Boolean(o.require_code_owner_reviews),
    };
  }

  const rest = body.restrictions;
  let restrictions: GitHubBranchProtection["restrictions"] = null;
  if (rest && typeof rest === "object" && rest !== null) {
    const o = rest as Record<string, unknown>;
    restrictions = {
      users: Array.isArray(o.users)
        ? o.users
            .map((u) => (typeof u === "string" ? u : (u as { login?: string })?.login))
            .filter((x): x is string => typeof x === "string")
        : [],
      teams: Array.isArray(o.teams)
        ? o.teams
            .map((t) => (typeof t === "string" ? t : (t as { slug?: string })?.slug))
            .filter((x): x is string => typeof x === "string")
        : [],
    };
  }

  const rlh = body.required_linear_history;
  const required_linear_history =
    typeof rlh === "boolean"
      ? rlh
      : rlh && typeof rlh === "object" && rlh !== null
        ? Boolean((rlh as { enabled?: unknown }).enabled)
        : false;
  const afp = body.allow_force_pushes;
  const allow_force_pushes =
    typeof afp === "boolean"
      ? afp
      : afp && typeof afp === "object" && afp !== null
        ? Boolean((afp as { enabled?: unknown }).enabled)
        : false;
  const ad = body.allow_deletions;
  const allow_deletions =
    typeof ad === "boolean"
      ? ad
      : ad && typeof ad === "object" && ad !== null
        ? Boolean((ad as { enabled?: unknown }).enabled)
        : false;

  return {
    required_status_checks,
    enforce_admins,
    required_pull_request_reviews,
    restrictions,
    required_linear_history,
    allow_force_pushes,
    allow_deletions,
    required_signatures: Boolean(
      typeof body.required_signatures === "boolean"
        ? body.required_signatures
        : (body.required_signatures as { enabled?: boolean } | undefined)?.enabled,
    ),
  };
}

export function branchesAndGitRoutes({ app, store, webhooks, baseUrl }: RouteContext): void {
  const gh = getGitHubStore(store);

  // --- Branches: sub-routes before generic protection/branch ---

  app.get("/repos/:owner/:repo/branches/:branch{.+}/protection/required_status_checks", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const branch = c.req.param("branch")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoPermission(gh, c.get("authUser"), repo, "administration");
    const bp = gh.branchProtections.findBy("repo_id", repo.id).find((p) => p.branch_name === branch);
    if (!bp || !bp.required_status_checks) throw notFoundResponse();
    const encBranch = encodeURIComponent(branch);
    const repoUrl = `${baseUrl}/repos/${repo.full_name}`;
    const base = `${repoUrl}/branches/${encBranch}/protection/required_status_checks`;
    return c.json({
      url: base,
      strict: bp.required_status_checks.strict,
      contexts: bp.required_status_checks.contexts,
      contexts_url: `${base}/contexts`,
      checks: bp.required_status_checks.contexts.map((ctx) => ({
        context: ctx,
        app_id: null,
      })),
    });
  });

  app.patch("/repos/:owner/:repo/branches/:branch{.+}/protection/required_status_checks", async (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const branch = c.req.param("branch")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoAdmin(gh, c.get("authUser"), repo);
    const bp = gh.branchProtections.findBy("repo_id", repo.id).find((p) => p.branch_name === branch);
    if (!bp) throw notFoundResponse();
    const body = await parseJsonBody(c);
    const strict = typeof body.strict === "boolean" ? body.strict : (bp.required_status_checks?.strict ?? false);
    const contexts = Array.isArray(body.contexts)
      ? body.contexts.filter((x): x is string => typeof x === "string")
      : (bp.required_status_checks?.contexts ?? []);
    gh.branchProtections.update(bp.id, {
      required_status_checks: { strict, contexts },
    });
    const encBranch = encodeURIComponent(branch);
    const repoUrl = `${baseUrl}/repos/${repo.full_name}`;
    const url = `${repoUrl}/branches/${encBranch}/protection/required_status_checks`;
    return c.json({
      url,
      strict,
      contexts,
      contexts_url: `${url}/contexts`,
      checks: contexts.map((ctx) => ({ context: ctx, app_id: null })),
    });
  });

  app.get("/repos/:owner/:repo/branches/:branch{.+}/protection/enforce_admins", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const branch = c.req.param("branch")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoPermission(gh, c.get("authUser"), repo, "administration");
    const bp = gh.branchProtections.findBy("repo_id", repo.id).find((p) => p.branch_name === branch);
    if (!bp) throw notFoundResponse();
    const encBranch = encodeURIComponent(branch);
    const repoUrl = `${baseUrl}/repos/${repo.full_name}`;
    const url = `${repoUrl}/branches/${encBranch}/protection/enforce_admins`;
    return c.json({
      url,
      enabled: bp.enforce_admins,
    });
  });

  app.get("/repos/:owner/:repo/branches/:branch{.+}/protection/required_pull_request_reviews", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const branch = c.req.param("branch")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoPermission(gh, c.get("authUser"), repo, "administration");
    const bp = gh.branchProtections.findBy("repo_id", repo.id).find((p) => p.branch_name === branch);
    if (!bp || !bp.required_pull_request_reviews) throw notFoundResponse();
    const encBranch = encodeURIComponent(branch);
    const repoUrl = `${baseUrl}/repos/${repo.full_name}`;
    const base = `${repoUrl}/branches/${encBranch}/protection/required_pull_request_reviews`;
    const r = bp.required_pull_request_reviews;
    return c.json({
      url: base,
      dismiss_stale_reviews: r.dismiss_stale_reviews,
      require_code_owner_reviews: r.require_code_owner_reviews,
      required_approving_review_count: r.required_approving_review_count,
    });
  });

  app.patch("/repos/:owner/:repo/branches/:branch{.+}/protection/required_pull_request_reviews", async (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const branch = c.req.param("branch")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoAdmin(gh, c.get("authUser"), repo);
    const bp = gh.branchProtections.findBy("repo_id", repo.id).find((p) => p.branch_name === branch);
    if (!bp) throw notFoundResponse();
    const body = await parseJsonBody(c);
    const prev = bp.required_pull_request_reviews ?? {
      required_approving_review_count: 1,
      dismiss_stale_reviews: false,
      require_code_owner_reviews: false,
    };
    const next = {
      required_approving_review_count:
        typeof body.required_approving_review_count === "number"
          ? body.required_approving_review_count
          : prev.required_approving_review_count,
      dismiss_stale_reviews:
        typeof body.dismiss_stale_reviews === "boolean" ? body.dismiss_stale_reviews : prev.dismiss_stale_reviews,
      require_code_owner_reviews:
        typeof body.require_code_owner_reviews === "boolean"
          ? body.require_code_owner_reviews
          : prev.require_code_owner_reviews,
    };
    gh.branchProtections.update(bp.id, { required_pull_request_reviews: next });
    const encBranch = encodeURIComponent(branch);
    const repoUrl = `${baseUrl}/repos/${repo.full_name}`;
    const url = `${repoUrl}/branches/${encBranch}/protection/required_pull_request_reviews`;
    return c.json({
      url,
      ...next,
    });
  });

  app.get("/repos/:owner/:repo/branches/:branch{.+}/protection", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const branch = c.req.param("branch")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoPermission(gh, c.get("authUser"), repo, "administration");
    const bp = gh.branchProtections.findBy("repo_id", repo.id).find((p) => p.branch_name === branch);
    if (!bp) throw notFoundResponse();
    return c.json(protectionEntityToGitHub(gh, repo, bp, baseUrl));
  });

  app.put("/repos/:owner/:repo/branches/:branch{.+}/protection", async (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const branch = c.req.param("branch")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoAdmin(gh, c.get("authUser"), repo);
    const b = findBranchByName(gh, repo.id, branch);
    if (!b) throw notFoundResponse();
    const body = await parseJsonBody(c);
    const parsed = parseProtectionPutBody(body);
    const existing = gh.branchProtections.findBy("repo_id", repo.id).find((p) => p.branch_name === branch);
    if (existing) {
      gh.branchProtections.update(existing.id, { ...parsed });
    } else {
      gh.branchProtections.insert({
        repo_id: repo.id,
        branch_name: branch,
        ...parsed,
      } as Omit<GitHubBranchProtection, "id" | "created_at" | "updated_at">);
    }
    gh.branches.update(b.id, { protected: true });
    const bp = gh.branchProtections.findBy("repo_id", repo.id).find((p) => p.branch_name === branch)!;
    webhooks.dispatch(
      "branch_protection_rule",
      "edited",
      {
        action: "edited",
        rule: protectionEntityToGitHub(gh, repo, bp, baseUrl),
        repository: formatRepo(repo, gh, baseUrl),
      },
      ownerLoginOf(gh, repo),
      repo.name,
    );
    return c.json(protectionEntityToGitHub(gh, repo, bp, baseUrl));
  });

  app.delete("/repos/:owner/:repo/branches/:branch{.+}/protection", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const branch = c.req.param("branch")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoAdmin(gh, c.get("authUser"), repo);
    const bp = gh.branchProtections.findBy("repo_id", repo.id).find((p) => p.branch_name === branch);
    if (bp) gh.branchProtections.delete(bp.id);
    const b = findBranchByName(gh, repo.id, branch);
    if (b) gh.branches.update(b.id, { protected: false });
    return c.body(null, 204);
  });

  app.get("/repos/:owner/:repo/branches/:branch{.+}", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const branchName = c.req.param("branch")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoContentsRead(gh, c.get("authUser"), repo);
    const branch = findBranchByName(gh, repo.id, branchName);
    if (!branch) throw notFoundResponse();
    const commit = findCommitBySha(gh, repo.id, branch.sha);
    const base = formatBranch(branch, repo, baseUrl);
    if (!branch.protected) return c.json(base);
    const bp = gh.branchProtections.findBy("repo_id", repo.id).find((p) => p.branch_name === branchName);
    return c.json({
      ...base,
      protection: {
        enabled: true,
        required_status_checks: bp?.required_status_checks
          ? {
              enforcement_level: "everyone",
              contexts: bp.required_status_checks.contexts,
              checks: bp.required_status_checks.contexts.map((ctx) => ({ context: ctx, app_id: null })),
            }
          : { enforcement_level: "off", contexts: [], checks: [] },
      },
      protection_commit: commit
        ? {
            author: { email: commit.author_email, name: commit.author_name },
            url: `${baseUrl}/repos/${repo.full_name}/commits/${commit.sha}`,
            message: commit.message,
            html_url: `${baseUrl}/${repo.full_name}/commit/${commit.sha}`,
          }
        : null,
    });
  });

  app.get("/repos/:owner/:repo/branches", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoContentsRead(gh, c.get("authUser"), repo);
    let list = [...gh.branches.findBy("repo_id", repo.id)].sort((a, b) => a.name.localeCompare(b.name));
    const prot = c.req.query("protected");
    if (prot === "true") list = list.filter((b) => b.protected);
    else if (prot === "false") list = list.filter((b) => !b.protected);
    const { page, per_page } = parsePagination(c);
    const total = list.length;
    const start = (page - 1) * per_page;
    const slice = list.slice(start, start + per_page);
    setLinkHeader(c, total, page, per_page);
    return c.json(slice.map((b) => formatBranch(b, repo, baseUrl)));
  });

  // --- Git refs ---

  app.get("/repos/:owner/:repo/git/ref/:ref{.+}", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const refParam = c.req.param("ref")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoContentsRead(gh, c.get("authUser"), repo);
    const fullRef = fullRefFromParam(refParam);
    const r = gh.refs.findBy("repo_id", repo.id).find((x) => x.ref === fullRef);
    if (!r) throw notFoundResponse();
    return c.json(formatRefJson(gh, repo, r.ref, r.sha, baseUrl));
  });

  app.get("/repos/:owner/:repo/git/matching-refs/:ref{.+}", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const refParam = c.req.param("ref")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoContentsRead(gh, c.get("authUser"), repo);
    const prefix = fullRefFromParam(refParam);
    const matches = gh.refs
      .findBy("repo_id", repo.id)
      .filter((r) => r.ref.startsWith(prefix))
      .sort((a, b) => a.ref.localeCompare(b.ref));
    return c.json(matches.map((r) => formatRefJson(gh, repo, r.ref, r.sha, baseUrl)));
  });

  app.post("/repos/:owner/:repo/git/refs", async (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    const user = assertRepoContentsWrite(gh, c.get("authUser"), repo);
    const body = (await parseJsonBody(c)) as { ref?: unknown; sha?: unknown };
    if (typeof body.ref !== "string" || !body.ref.startsWith("refs/")) {
      throw new ApiError(422, "Invalid ref");
    }
    if (typeof body.sha !== "string") {
      throw new ApiError(422, "sha is required");
    }
    const fullRef = body.ref;
    const sha = body.sha;
    if (findCommitBySha(gh, repo.id, sha) === undefined && findTagObjectBySha(gh, repo.id, sha) === undefined) {
      throw new ApiError(422, "Invalid sha");
    }
    if (gh.refs.findBy("repo_id", repo.id).some((r) => r.ref === fullRef)) {
      throw new ApiError(422, "Reference already exists");
    }
    if (fullRef.startsWith("refs/heads/")) {
      const branchName = fullRef.slice("refs/heads/".length);
      const commit = findCommitBySha(gh, repo.id, sha);
      assertBranchUpdateAllowed(gh, user, repo, branchName, {
        parentCount: commit?.parent_shas.length,
        targetSha: commit?.sha,
      });
    }
    const refRow = gh.refs.insert({
      repo_id: repo.id,
      ref: fullRef,
      sha,
      node_id: "",
    } as Omit<GitHubRef, "id" | "created_at" | "updated_at">);
    gh.refs.update(refRow.id, { node_id: generateNodeId("Ref", refRow.id) });
    syncBranchFromRef(gh, repo, fullRef, sha);
    webhooks.dispatch(
      "create",
      undefined,
      {
        ref: fullRef,
        ref_type: fullRef.startsWith("refs/heads/") ? "branch" : "tag",
        master_branch: repo.default_branch,
        repository: formatRepo(repo, gh, baseUrl),
        sender: formatUser(user, baseUrl),
      },
      ownerLoginOf(gh, repo),
      repo.name,
    );
    const r = gh.refs.get(refRow.id)!;
    return c.json(formatRefJson(gh, repo, r.ref, r.sha, baseUrl), 201);
  });

  app.patch("/repos/:owner/:repo/git/refs/:ref{.+}", async (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const refParam = c.req.param("ref")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    const user = assertRepoContentsWrite(gh, c.get("authUser"), repo);
    const fullRef = fullRefFromParam(refParam);
    const r = gh.refs.findBy("repo_id", repo.id).find((x) => x.ref === fullRef);
    if (!r) throw notFoundResponse();
    const body = (await parseJsonBody(c)) as { sha?: unknown; force?: unknown };
    if (typeof body.sha !== "string") {
      throw new ApiError(422, "sha is required");
    }
    const newSha = body.sha;
    const force = Boolean(body.force);
    const oldSha = r.sha;
    if (findCommitBySha(gh, repo.id, newSha) === undefined && findTagObjectBySha(gh, repo.id, newSha) === undefined) {
      throw new ApiError(422, "Invalid sha");
    }
    if (!force) {
      const oldCommit = findCommitBySha(gh, repo.id, oldSha);
      const newCommit = findCommitBySha(gh, repo.id, newSha);
      if (!oldCommit || !newCommit) {
        throw new ApiError(422, "Fast-forward update requires commit objects");
      }
      if (!isDescendantOf(gh, repo.id, oldSha, newSha)) {
        throw new ApiError(422, "Update is not a fast-forward");
      }
    }
    if (fullRef.startsWith("refs/heads/")) {
      const branchName = fullRef.slice("refs/heads/".length);
      const commit = findCommitBySha(gh, repo.id, newSha);
      assertBranchUpdateAllowed(gh, user, repo, branchName, {
        force,
        parentCount: commit?.parent_shas.length,
        currentSha: oldSha,
        targetSha: commit?.sha,
      });
    }
    gh.refs.update(r.id, { sha: newSha });
    syncBranchFromRef(gh, repo, fullRef, newSha);
    webhooks.dispatch(
      "push",
      undefined,
      {
        ref: fullRef,
        before: oldSha,
        after: newSha,
        repository: formatRepo(repo, gh, baseUrl),
        sender: formatUser(user, baseUrl),
      },
      ownerLoginOf(gh, repo),
      repo.name,
    );
    const updated = gh.refs.get(r.id)!;
    return c.json(formatRefJson(gh, repo, updated.ref, updated.sha, baseUrl));
  });

  app.delete("/repos/:owner/:repo/git/refs/:ref{.+}", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const refParam = c.req.param("ref")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    const user = assertRepoContentsWrite(gh, c.get("authUser"), repo);
    const fullRef = fullRefFromParam(refParam);
    const r = gh.refs.findBy("repo_id", repo.id).find((x) => x.ref === fullRef);
    if (!r) throw notFoundResponse();
    if (fullRef.startsWith("refs/heads/")) {
      const branchName = fullRef.slice("refs/heads/".length);
      if (branchName === repo.default_branch) {
        throw new ApiError(422, "Cannot delete the default branch");
      }
      assertBranchUpdateAllowed(gh, user, repo, branchName, { deletion: true });
    }
    gh.refs.delete(r.id);
    deleteBranchForHeadRef(gh, repo.id, fullRef);
    return c.body(null, 204);
  });

  // --- Git commits ---

  app.get("/repos/:owner/:repo/git/commits/:commit_sha", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const commitSha = c.req.param("commit_sha")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoContentsRead(gh, c.get("authUser"), repo);
    const commit = findCommitBySha(gh, repo.id, commitSha);
    if (!commit) throw notFoundResponse();
    return c.json(formatGitCommit(repo, commit, baseUrl));
  });

  app.post("/repos/:owner/:repo/git/commits", async (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    const actor = assertRepoContentsWrite(gh, c.get("authUser"), repo);
    const body = await parseJsonBody(c);
    if (typeof body.message !== "string") throw new ApiError(422, "message is required");
    if (typeof body.tree !== "string") throw new ApiError(422, "tree is required");
    if (!Array.isArray(body.parents)) throw new ApiError(422, "parents must be an array");
    const parents = body.parents.filter((p): p is string => typeof p === "string");
    const treeSha = body.tree as string;
    if (!findTreeBySha(gh, repo.id, treeSha)) throw new ApiError(422, "Invalid tree");
    for (const p of parents) {
      if (!findCommitBySha(gh, repo.id, p)) throw new ApiError(422, `Invalid parent ${p}`);
    }
    let author_name: string;
    let author_email: string;
    let author_date: string;
    let committer_name: string;
    let committer_email: string;
    let committer_date: string;
    const now = timestamp();
    const defaultName = actor.name ?? actor.login;
    const defaultEmail = actor.email ?? `${actor.login}@users.noreply.github.com`;
    if (body.author && typeof body.author === "object" && body.author !== null) {
      const a = body.author as Record<string, unknown>;
      if (a.date !== undefined && (typeof a.date !== "string" || !Number.isFinite(Date.parse(a.date)))) {
        throw new ApiError(422, "author.date must be an ISO 8601 timestamp");
      }
      author_name = typeof a.name === "string" ? a.name : defaultName;
      author_email = typeof a.email === "string" ? a.email : defaultEmail;
      author_date = typeof a.date === "string" ? a.date : now;
    } else {
      author_name = defaultName;
      author_email = defaultEmail;
      author_date = now;
    }
    if (body.committer && typeof body.committer === "object" && body.committer !== null) {
      const a = body.committer as Record<string, unknown>;
      if (a.date !== undefined && (typeof a.date !== "string" || !Number.isFinite(Date.parse(a.date)))) {
        throw new ApiError(422, "committer.date must be an ISO 8601 timestamp");
      }
      committer_name = typeof a.name === "string" ? a.name : defaultName;
      committer_email = typeof a.email === "string" ? a.email : defaultEmail;
      committer_date = typeof a.date === "string" ? a.date : now;
    } else {
      committer_name = author_name;
      committer_email = author_email;
      committer_date = author_date;
    }
    const saved = findOrCreateCommit(gh, repo.id, {
      message: body.message as string,
      author_name,
      author_email,
      author_date,
      committer_name,
      committer_email,
      committer_date,
      tree_sha: treeSha,
      parent_shas: parents,
      user_id: actor.id,
    });
    return c.json(formatGitCommit(repo, saved, baseUrl), 201);
  });

  // --- Git trees ---

  app.get("/repos/:owner/:repo/git/trees/:tree_sha", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const treeSha = c.req.param("tree_sha")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoContentsRead(gh, c.get("authUser"), repo);
    const commit = resolveRefToCommit(gh, repo, treeSha);
    const tree =
      findTreeBySha(gh, repo.id, treeSha) ?? (commit ? findTreeBySha(gh, repo.id, commit.tree_sha) : undefined);
    if (!tree) throw notFoundResponse();
    const recursive = c.req.query("recursive") !== undefined;
    const repoUrl = `${baseUrl}/repos/${repo.full_name}`;
    const entries = recursive
      ? expandTreeEntries(gh, repo.id, tree.tree, true)
      : tree.tree.filter((e) => !e.path.includes("/"));
    return c.json({
      sha: tree.sha,
      url: `${repoUrl}/git/trees/${tree.sha}`,
      tree: entries,
      truncated: tree.truncated,
    });
  });

  app.post("/repos/:owner/:repo/git/trees", async (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoContentsWrite(gh, c.get("authUser"), repo);
    const body = await parseJsonBody(c);
    if (!Array.isArray(body.tree)) throw new ApiError(422, "tree array is required");
    const items = body.tree as Array<{
      path?: string;
      mode?: string;
      type?: string;
      sha?: string | null;
      content?: string;
    }>;
    const baseTreeSha = typeof body.base_tree === "string" ? body.base_tree : undefined;
    if (baseTreeSha && !findTreeBySha(gh, repo.id, baseTreeSha)) throw new ApiError(422, "Invalid base_tree");

    const updates: GitTreeUpdate[] = [];

    for (const raw of items) {
      if (
        typeof raw.path !== "string" ||
        typeof raw.mode !== "string" ||
        (raw.type !== "blob" && raw.type !== "tree" && raw.type !== "commit")
      ) {
        throw new ApiError(422, "Each tree entry needs path, mode, type (blob|tree|commit)");
      }
      if (
        !raw.path ||
        raw.path.includes("\0") ||
        raw.path.split("/").some((part) => part === "" || part === "." || part === "..")
      ) {
        throw new ApiError(422, "Invalid tree path");
      }
      if (raw.sha !== undefined && raw.content !== undefined) {
        throw new ApiError(422, "Cannot pass both sha and content");
      }
      const validMode =
        (raw.type === "blob" && ["100644", "100755", "120000"].includes(raw.mode)) ||
        (raw.type === "tree" && raw.mode === "040000") ||
        (raw.type === "commit" && raw.mode === "160000");
      if (!validMode) {
        throw new ApiError(422, "Invalid mode for tree entry type");
      }
      if (raw.type !== "blob" && raw.content !== undefined) {
        throw new ApiError(422, "Only blob entries may specify content");
      }
      if (raw.sha === null) {
        updates.push({ path: raw.path, mode: raw.mode, type: raw.type, sha: null });
        continue;
      }
      let sha = raw.sha;
      let size: number | undefined;
      if (raw.content !== undefined) {
        const buf = Buffer.from(String(raw.content), "utf8");
        const blob = findOrCreateBlob(gh, repo.id, buf);
        sha = blob.sha;
        size = blob.size;
      }
      if (typeof sha !== "string") throw new ApiError(422, "sha or content required");
      if (raw.type === "blob") {
        const blob = findBlobBySha(gh, repo.id, sha);
        if (!blob) throw new ApiError(422, "Invalid blob sha");
        size ??= blob.size;
      } else if (raw.type === "tree" && !findTreeBySha(gh, repo.id, sha)) {
        throw new ApiError(422, "Invalid tree sha");
      } else if (raw.type === "commit" && !/^[0-9a-f]{40}$/i.test(sha)) {
        throw new ApiError(422, "Invalid commit sha");
      }
      updates.push({ path: raw.path, mode: raw.mode, type: raw.type, sha, size });
    }

    const saved = persistGitTreeHierarchy(gh, repo.id, baseTreeSha, updates);
    const repoUrl = `${baseUrl}/repos/${repo.full_name}`;
    return c.json(
      {
        sha: saved.sha,
        url: `${repoUrl}/git/trees/${saved.sha}`,
        tree: saved.tree,
        truncated: saved.truncated,
      },
      201,
    );
  });

  // --- Git blobs ---

  app.get("/repos/:owner/:repo/git/blobs/:file_sha", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const fileSha = c.req.param("file_sha")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoContentsRead(gh, c.get("authUser"), repo);
    const blob = findBlobBySha(gh, repo.id, fileSha);
    if (!blob) throw notFoundResponse();
    const repoUrl = `${baseUrl}/repos/${repo.full_name}`;
    const content = blob.encoding === "base64" ? blob.content : Buffer.from(blob.content, "utf8").toString("base64");
    return c.json({
      sha: blob.sha,
      node_id: blob.node_id,
      size: blob.size,
      url: `${repoUrl}/git/blobs/${blob.sha}`,
      content,
      encoding: "base64",
    });
  });

  app.post("/repos/:owner/:repo/git/blobs", async (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoContentsWrite(gh, c.get("authUser"), repo);
    const body = (await parseJsonBody(c)) as {
      content?: unknown;
      encoding?: unknown;
    };
    if (typeof body.content !== "string") throw new ApiError(422, "content is required");
    const enc = body.encoding === "base64" || body.encoding === "utf-8" ? body.encoding : "utf-8";
    const content = enc === "base64" ? Buffer.from(body.content, "base64") : Buffer.from(body.content, "utf8");
    const saved = findOrCreateBlob(gh, repo.id, content);
    const repoUrl = `${baseUrl}/repos/${repo.full_name}`;
    return c.json(
      {
        sha: saved.sha,
        node_id: saved.node_id,
        url: `${repoUrl}/git/blobs/${saved.sha}`,
        size: saved.size,
      },
      201,
    );
  });

  // --- Git tags ---

  app.get("/repos/:owner/:repo/git/tags/:tag_sha", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const tagSha = c.req.param("tag_sha")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoContentsRead(gh, c.get("authUser"), repo);
    const tag = findTagObjectBySha(gh, repo.id, tagSha);
    if (!tag) throw notFoundResponse();
    const repoUrl = `${baseUrl}/repos/${repo.full_name}`;
    return c.json({
      tag: tag.tag,
      sha: tag.sha,
      node_id: tag.node_id,
      url: `${repoUrl}/git/tags/${tag.sha}`,
      message: tag.message,
      tagger: {
        name: tag.tagger_name,
        email: tag.tagger_email,
        date: tag.tagger_date,
      },
      object: {
        type: tag.object_type,
        sha: tag.object_sha,
        url: objectApiUrl(repo, baseUrl, resolveGitObjectType(gh, repo.id, tag.object_sha), tag.object_sha),
      },
      verification: { verified: false, reason: "unsigned", signature: null, payload: null, verified_at: null },
    });
  });

  app.post("/repos/:owner/:repo/git/tags", async (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoContentsWrite(gh, c.get("authUser"), repo);
    const body = await parseJsonBody(c);
    if (typeof body.tag !== "string") throw new ApiError(422, "tag is required");
    if (typeof body.message !== "string") throw new ApiError(422, "message is required");
    if (typeof body.object !== "string") throw new ApiError(422, "object is required");
    if (typeof body.type !== "string") throw new ApiError(422, "type is required");
    const now = timestamp();
    let tagger_name = "user";
    let tagger_email = "user@users.noreply.github.com";
    let tagger_date = now;
    if (body.tagger && typeof body.tagger === "object" && body.tagger !== null) {
      const t = body.tagger as Record<string, unknown>;
      if (typeof t.name === "string") tagger_name = t.name;
      if (typeof t.email === "string") tagger_email = t.email;
      if (typeof t.date === "string") tagger_date = t.date;
    }
    const tag = gh.tags.insert({
      repo_id: repo.id,
      tag: body.tag as string,
      sha: generateSha(),
      node_id: "",
      message: body.message as string,
      tagger_name,
      tagger_email,
      tagger_date,
      object_type: body.type as string,
      object_sha: body.object as string,
    } as Omit<GitHubTag, "id" | "created_at" | "updated_at">);
    gh.tags.update(tag.id, { node_id: generateNodeId("Tag", tag.id) });
    const saved = gh.tags.get(tag.id)!;
    const repoUrl = `${baseUrl}/repos/${repo.full_name}`;
    return c.json(
      {
        tag: saved.tag,
        sha: saved.sha,
        node_id: saved.node_id,
        url: `${repoUrl}/git/tags/${saved.sha}`,
        message: saved.message,
        tagger: {
          name: saved.tagger_name,
          email: saved.tagger_email,
          date: saved.tagger_date,
        },
        object: {
          type: saved.object_type,
          sha: saved.object_sha,
          url: objectApiUrl(repo, baseUrl, resolveGitObjectType(gh, repo.id, saved.object_sha), saved.object_sha),
        },
        verification: { verified: false, reason: "unsigned", signature: null, payload: null, verified_at: null },
      },
      201,
    );
  });
}
