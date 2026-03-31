import type { RouteContext } from "@emulators/core";
import { ApiError, parseJsonBody, parsePagination, setLinkHeader } from "@emulators/core";
import { getGitHubStore } from "../store.js";
import {
  assertAuthenticatedUser,
  assertRepoRead,
  assertRepoWrite,
  notFoundResponse,
  ownerLoginOf,
} from "../route-helpers.js";
import type { GitHubStore } from "../store.js";
import type {
  GitHubBranch,
  GitHubCommit,
  GitHubIssue,
  GitHubPullRequest,
  GitHubRef,
  GitHubRepo,
  GitHubUser,
} from "../entities.js";
import {
  formatPullRequest,
  formatRepo,
  formatUser,
  generateNodeId,
  generateSha,
  getNextIssueNumber,
  lookupRepo,
  timestamp,
} from "../helpers.js";

function findPull(gh: GitHubStore, repoId: number, pullNumber: number): GitHubPullRequest | undefined {
  return gh.pullRequests
    .findBy("repo_id", repoId)
    .find((p) => p.number === pullNumber);
}

function findPrIssue(gh: GitHubStore, repoId: number, number: number): GitHubIssue | undefined {
  return gh.issues
    .findBy("repo_id", repoId)
    .find((i) => i.number === number && i.is_pull_request);
}

function adjustRepoOpenIssues(gh: GitHubStore, repoId: number, delta: number) {
  const repo = gh.repos.get(repoId);
  if (!repo) return;
  gh.repos.update(repoId, { open_issues_count: Math.max(0, repo.open_issues_count + delta) });
}

function getDefaultBranchSha(gh: GitHubStore, repo: GitHubRepo): string {
  const branch = gh.branches
    .findBy("repo_id", repo.id)
    .find((b) => b.name === repo.default_branch);
  if (!branch) {
    throw new ApiError(422, "The repository is empty.");
  }
  return branch.sha;
}

function createBranchAt(
  gh: GitHubStore,
  repo: GitHubRepo,
  branchName: string,
  sha: string
): GitHubBranch {
  const b = gh.branches.insert({
    repo_id: repo.id,
    name: branchName,
    sha,
    protected: false,
  } as Omit<GitHubBranch, "id" | "created_at" | "updated_at">);
  const ref = gh.refs.insert({
    repo_id: repo.id,
    ref: `refs/heads/${branchName}`,
    sha,
    node_id: "",
  } as Omit<GitHubRef, "id" | "created_at" | "updated_at">);
  gh.refs.update(ref.id, { node_id: generateNodeId("Ref", ref.id) });
  return b;
}

function getOrCreateBranch(gh: GitHubStore, repo: GitHubRepo, branchName: string): GitHubBranch {
  const existing = gh.branches.findBy("repo_id", repo.id).find((b) => b.name === branchName);
  if (existing) return existing;
  const tip = getDefaultBranchSha(gh, repo);
  return createBranchAt(gh, repo, branchName, tip);
}

function updateBranchSha(gh: GitHubStore, repo: GitHubRepo, branchName: string, newSha: string) {
  const branch = gh.branches.findBy("repo_id", repo.id).find((b) => b.name === branchName);
  if (branch) gh.branches.update(branch.id, { sha: newSha });
  const ref = gh.refs
    .findBy("repo_id", repo.id)
    .find((r) => r.ref === `refs/heads/${branchName}`);
  if (ref) gh.refs.update(ref.id, { sha: newSha });
}

function resolveHeadTarget(
  gh: GitHubStore,
  baseRepo: GitHubRepo,
  head: string
): { headRepo: GitHubRepo; headRef: string } {
  const trimmed = head.trim();
  if (!trimmed.includes(":")) {
    return { headRepo: baseRepo, headRef: trimmed };
  }
  const idx = trimmed.indexOf(":");
  const ownerLogin = trimmed.slice(0, idx).trim();
  const ref = trimmed.slice(idx + 1).trim();
  if (!ref) throw new ApiError(422, "Validation failed");

  const baseOwner = ownerLoginOf(gh, baseRepo);
  if (ownerLogin === baseOwner) {
    return { headRepo: baseRepo, headRef: ref };
  }

  const fork = gh.repos
    .all()
    .find((r) => {
      if (r.forked_from_id !== baseRepo.id) return false;
      const login =
        r.owner_type === "User"
          ? gh.users.get(r.owner_id)?.login
          : gh.orgs.get(r.owner_id)?.login;
      return login === ownerLogin;
    });
  if (!fork) throw new ApiError(422, "Validation failed");
  return { headRepo: fork, headRef: ref };
}

function countCommitsBetween(
  gh: GitHubStore,
  repo: GitHubRepo,
  headSha: string,
  baseSha: string
): number {
  const chain = walkCommitsToBase(gh, repo, headSha, baseSha);
  return chain.length;
}

function walkCommitsToBase(
  gh: GitHubStore,
  repo: GitHubRepo,
  headSha: string,
  baseSha: string
): GitHubCommit[] {
  const out: GitHubCommit[] = [];
  const seen = new Set<string>();
  let cur: string | undefined = headSha;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const commit = gh.commits.findBy("repo_id", repo.id).find((c) => c.sha === cur);
    if (!commit) break;
    out.push(commit);
    if (cur === baseSha) break;
    cur = commit.parent_shas[0];
  }
  return out.reverse();
}

function insertCommit(
  gh: GitHubStore,
  repo: GitHubRepo,
  opts: {
    treeSha: string;
    parentShas: string[];
    message: string;
    user: GitHubUser | null;
  }
): GitHubCommit {
  const u = opts.user;
  const authorName = u?.name ?? u?.login ?? "User";
  const login = u?.login ?? "user";
  const email = u?.email ?? `${login}@users.noreply.github.com`;
  const now = timestamp();
  const row = gh.commits.insert({
    repo_id: repo.id,
    sha: generateSha(),
    node_id: "",
    message: opts.message,
    author_name: authorName,
    author_email: email,
    author_date: now,
    committer_name: authorName,
    committer_email: email,
    committer_date: now,
    tree_sha: opts.treeSha,
    parent_shas: opts.parentShas,
    user_id: u?.id ?? null,
  } as Omit<GitHubCommit, "id" | "created_at" | "updated_at">);
  gh.commits.update(row.id, { node_id: generateNodeId("Commit", row.id) });
  return gh.commits.get(row.id)!;
}

function formatCommitApi(commit: GitHubCommit, repo: GitHubRepo, baseUrl: string) {
  const repoUrl = `${baseUrl}/repos/${repo.full_name}`;
  return {
    sha: commit.sha,
    node_id: commit.node_id,
    url: `${repoUrl}/commits/${commit.sha}`,
    html_url: `${baseUrl}/${repo.full_name}/commit/${commit.sha}`,
    comments_url: `${repoUrl}/comments/${commit.sha}`,
    commit: {
      url: `${repoUrl}/git/commits/${commit.sha}`,
      author: {
        name: commit.author_name,
        email: commit.author_email,
        date: commit.author_date,
      },
      committer: {
        name: commit.committer_name,
        email: commit.committer_email,
        date: commit.committer_date,
      },
      message: commit.message,
      tree: { sha: commit.tree_sha },
      comment_count: 0,
      verification: {
        verified: false,
        reason: "unsigned",
        signature: null,
        payload: null,
        verified_at: null,
      },
    },
    author: null,
    committer: null,
    parents: commit.parent_shas.map((sha) => ({
      sha,
      url: `${repoUrl}/commits/${sha}`,
      html_url: `${baseUrl}/${repo.full_name}/commit/${sha}`,
    })),
  };
}

function headLabel(gh: GitHubStore, pr: GitHubPullRequest): string {
  const headRepo = gh.repos.get(pr.head_repo_id);
  const owner = headRepo
    ? headRepo.owner_type === "User"
      ? gh.users.get(headRepo.owner_id)?.login
      : gh.orgs.get(headRepo.owner_id)?.login
    : undefined;
  return `${owner ?? "unknown"}:${pr.head_ref}`;
}

function matchesHeadFilter(gh: GitHubStore, pr: GitHubPullRequest, headParam: string): boolean {
  const trimmed = headParam.trim();
  if (!trimmed) return true;
  if (!trimmed.includes(":")) {
    return pr.head_ref === trimmed;
  }
  return headLabel(gh, pr) === trimmed;
}

function sortPulls(
  list: GitHubPullRequest[],
  sort: "created" | "updated" | "popularity" | "long-running",
  direction: "asc" | "desc"
): GitHubPullRequest[] {
  const sorted = [...list];
  sorted.sort((a, b) => {
    if (sort === "long-running") {
      const cmp = a.created_at.localeCompare(b.created_at);
      return direction === "desc" ? cmp : -cmp;
    }
    const mul = direction === "asc" ? 1 : -1;
    if (sort === "updated") {
      return a.updated_at.localeCompare(b.updated_at) * mul;
    }
    if (sort === "created") {
      return a.created_at.localeCompare(b.created_at) * mul;
    }
    const av = a.comments + a.review_comments;
    const bv = b.comments + b.review_comments;
    if (av < bv) return -1 * mul;
    if (av > bv) return 1 * mul;
    return 0;
  });
  return sorted;
}

function checkMergeRequirements(gh: GitHubStore, pr: GitHubPullRequest) {
  const baseRepo = gh.repos.get(pr.base_repo_id);
  if (!baseRepo) throw new ApiError(422, "Base repository not found");

  const rule = gh.branchProtections
    .findBy("repo_id", baseRepo.id)
    .find((p) => p.branch_name === pr.base_ref);

  if (!rule) return;

  const checks = rule.required_status_checks;
  if (checks && checks.contexts.length > 0) {
    const runs = gh.checkRuns
      .findBy("repo_id", baseRepo.id)
      .filter((r) => r.head_sha === pr.head_sha);
    for (const ctx of checks.contexts) {
      const ok = runs.some(
        (r) =>
          r.name === ctx && r.status === "completed" && r.conclusion === "success"
      );
      if (!ok) {
        throw new ApiError(422, "Required status checks have not succeeded.");
      }
    }
  }

  const rev = rule.required_pull_request_reviews;
  if (rev) {
    const need = rev.required_approving_review_count;
    const approved = gh.reviews
      .findBy("repo_id", baseRepo.id)
      .filter((r) => r.pull_number === pr.number && r.state === "APPROVED");
    const approvers = new Set(approved.map((r) => r.user_id));
    if (approvers.size < need) {
      throw new ApiError(422, "Required approving review count not met.");
    }
  }
}

function deleteBranchByName(gh: GitHubStore, repo: GitHubRepo, branchName: string) {
  const branch = gh.branches.findBy("repo_id", repo.id).find((b) => b.name === branchName);
  if (branch) gh.branches.delete(branch.id);
  const ref = gh.refs
    .findBy("repo_id", repo.id)
    .find((r) => r.ref === `refs/heads/${branchName}`);
  if (ref) gh.refs.delete(ref.id);
}

function lookupUserByLogin(gh: GitHubStore, login: string): GitHubUser {
  const u = gh.users.findOneBy("login", login);
  if (!u) throw new ApiError(422, "Validation failed");
  return u;
}

function lookupTeamSlug(gh: GitHubStore, orgId: number, slug: string) {
  const t = gh.teams
    .findBy("org_id", orgId)
    .find((x) => x.slug === slug);
  if (!t) throw new ApiError(422, "Validation failed");
  return t;
}

export function pullsRoutes({ app, store, webhooks, baseUrl }: RouteContext): void {
  const gh = getGitHubStore(store);

  app.get("/repos/:owner/:repo/pulls", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoRead(gh, c.get("authUser"), repo);

    const stateQ = c.req.query("state") ?? "open";
    const state: "open" | "closed" | "all" =
      stateQ === "closed" || stateQ === "all" || stateQ === "open" ? stateQ : "open";

    const headQ = c.req.query("head") ?? "";
    const baseQ = c.req.query("base") ?? "";

    const sortRaw = c.req.query("sort") ?? "created";
    const sort: "created" | "updated" | "popularity" | "long-running" =
      sortRaw === "updated" || sortRaw === "popularity" || sortRaw === "long-running"
        ? sortRaw
        : "created";

    const dirRaw = c.req.query("direction") ?? "desc";
    const direction: "asc" | "desc" = dirRaw === "asc" ? "asc" : "desc";

    let list = gh.pullRequests.findBy("repo_id", repo.id);
    if (state === "open") list = list.filter((p) => p.state === "open");
    else if (state === "closed") list = list.filter((p) => p.state === "closed");

    if (baseQ.trim()) {
      list = list.filter((p) => p.base_ref === baseQ.trim());
    }
    if (headQ.trim()) {
      list = list.filter((p) => matchesHeadFilter(gh, p, headQ));
    }

    list = sortPulls(list, sort, direction);

    const { page, per_page } = parsePagination(c);
    const total = list.length;
    setLinkHeader(c, total, page, per_page);
    const start = (page - 1) * per_page;
    const pageItems = list.slice(start, start + per_page);
    const body = pageItems
      .map((p) => formatPullRequest(p, gh, baseUrl))
      .filter((x): x is NonNullable<typeof x> => x !== null);
    return c.json(body);
  });

  app.post("/repos/:owner/:repo/pulls", async (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();

    const actor = assertRepoWrite(gh, c.get("authUser"), repo);
    const body = await parseJsonBody(c);

    const title = body.title;
    if (typeof title !== "string" || !title.trim()) {
      throw new ApiError(422, "Validation failed");
    }
    const headRaw = body.head;
    const baseRaw = body.base;
    if (typeof headRaw !== "string" || !headRaw.trim()) throw new ApiError(422, "Validation failed");
    if (typeof baseRaw !== "string" || !baseRaw.trim()) throw new ApiError(422, "Validation failed");

    const { headRepo, headRef } = resolveHeadTarget(gh, repo, headRaw);
    const baseRef = baseRaw.trim();

    if (headRef === baseRef && headRepo.id === repo.id) {
      throw new ApiError(422, "Validation failed");
    }

    const prBody = typeof body.body === "string" || body.body === null ? (body.body as string | null) : null;
    const draft = typeof body.draft === "boolean" ? body.draft : false;

    const headBranch = getOrCreateBranch(gh, headRepo, headRef);
    const baseBranch = getOrCreateBranch(gh, repo, baseRef);

    const num = getNextIssueNumber(gh, repo.id);
    const now = timestamp();

    const issueRow = gh.issues.insert({
      node_id: "",
      number: num,
      repo_id: repo.id,
      title: title.trim(),
      body: prBody,
      state: "open",
      state_reason: null,
      locked: false,
      active_lock_reason: null,
      user_id: actor.id,
      assignee_ids: [],
      label_ids: [],
      milestone_id: null,
      comments: 0,
      closed_at: null,
      closed_by_id: null,
      is_pull_request: true,
    } as Omit<GitHubIssue, "id" | "created_at" | "updated_at">);
    gh.issues.update(issueRow.id, { node_id: generateNodeId("Issue", issueRow.id) });

    const commitCount = countCommitsBetween(gh, headRepo, headBranch.sha, baseBranch.sha);

    const prRow = gh.pullRequests.insert({
      node_id: "",
      number: num,
      repo_id: repo.id,
      title: title.trim(),
      body: prBody,
      state: "open",
      locked: false,
      user_id: actor.id,
      assignee_ids: [],
      label_ids: [],
      milestone_id: null,
      head_ref: headRef,
      head_sha: headBranch.sha,
      head_repo_id: headRepo.id,
      base_ref: baseRef,
      base_sha: baseBranch.sha,
      base_repo_id: repo.id,
      merged: false,
      merged_at: null,
      merged_by_id: null,
      merge_commit_sha: null,
      mergeable: true,
      mergeable_state: "clean",
      comments: 0,
      review_comments: 0,
      commits: Math.max(1, commitCount),
      additions: 0,
      deletions: 0,
      changed_files: 0,
      draft,
      requested_reviewer_ids: [],
      requested_team_ids: [],
      closed_at: null,
      auto_merge: null,
    } as Omit<GitHubPullRequest, "id" | "created_at" | "updated_at">);
    gh.pullRequests.update(prRow.id, { node_id: generateNodeId("PullRequest", prRow.id) });

    adjustRepoOpenIssues(gh, repo.id, 1);

    const pr = gh.pullRequests.get(prRow.id)!;
    const prFmt = formatPullRequest(pr, gh, baseUrl)!;
    const ownerLogin = ownerLoginOf(gh, repo);

    webhooks.dispatch(
      "pull_request",
      "opened",
      {
        action: "opened",
        pull_request: prFmt,
        repository: formatRepo(repo, gh, baseUrl),
        sender: formatUser(actor, baseUrl),
      },
      ownerLogin,
      repo.name
    );

    return c.json(prFmt, 201);
  });

  app.get("/repos/:owner/:repo/pulls/:pull_number", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoRead(gh, c.get("authUser"), repo);

    const pullNumber = parseInt(c.req.param("pull_number")!, 10);
    if (!Number.isFinite(pullNumber)) throw notFoundResponse();

    const pr = findPull(gh, repo.id, pullNumber);
    if (!pr) throw notFoundResponse();

    const fmt = formatPullRequest(pr, gh, baseUrl);
    if (!fmt) throw notFoundResponse();
    return c.json(fmt);
  });

  app.patch("/repos/:owner/:repo/pulls/:pull_number", async (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();

    const actor = assertRepoWrite(gh, c.get("authUser"), repo);
    const pullNumber = parseInt(c.req.param("pull_number")!, 10);
    if (!Number.isFinite(pullNumber)) throw notFoundResponse();

    const pr = findPull(gh, repo.id, pullNumber);
    if (!pr) throw notFoundResponse();

    const body = await parseJsonBody(c);
    const patch: Partial<GitHubPullRequest> = {};
    const issuePatch: Partial<GitHubIssue> = {};

    if (typeof body.title === "string") {
      patch.title = body.title;
      issuePatch.title = body.title;
    }
    if (typeof body.body === "string" || body.body === null) {
      patch.body = body.body as string | null;
      issuePatch.body = body.body as string | null;
    }
    if (body.state === "open" || body.state === "closed") {
      const wasClosed = pr.state === "closed";
      patch.state = body.state;
      issuePatch.state = body.state;
      if (body.state === "closed") {
        patch.closed_at = timestamp();
        issuePatch.closed_at = timestamp();
        issuePatch.closed_by_id = actor.id;
      } else {
        patch.closed_at = null;
        issuePatch.closed_at = null;
        issuePatch.closed_by_id = null;
      }
      if (!wasClosed && body.state === "closed") {
        adjustRepoOpenIssues(gh, repo.id, -1);
      } else if (wasClosed && body.state === "open") {
        adjustRepoOpenIssues(gh, repo.id, 1);
      }
    }
    if (typeof body.base === "string" && body.base.trim()) {
      const newBase = body.base.trim();
      const bb = getOrCreateBranch(gh, repo, newBase);
      patch.base_ref = newBase;
      patch.base_sha = bb.sha;
      patch.base_repo_id = repo.id;
    }
    if (typeof body.draft === "boolean") {
      patch.draft = body.draft;
    }

    const updated = gh.pullRequests.update(pr.id, patch);
    if (!updated) throw notFoundResponse();

    const iss = findPrIssue(gh, repo.id, pullNumber);
    if (iss) {
      gh.issues.update(iss.id, issuePatch);
    }

    const fresh = gh.pullRequests.get(pr.id)!;
    const prFmt = formatPullRequest(fresh, gh, baseUrl)!;
    const ownerLogin = ownerLoginOf(gh, repo);

    if (body.state === "closed" && pr.state === "open") {
      webhooks.dispatch(
        "pull_request",
        "closed",
        {
          action: "closed",
          pull_request: prFmt,
          repository: formatRepo(repo, gh, baseUrl),
          sender: formatUser(actor, baseUrl),
        },
        ownerLogin,
        repo.name
      );
    } else if (body.state === "open" && pr.state === "closed") {
      webhooks.dispatch(
        "pull_request",
        "reopened",
        {
          action: "reopened",
          pull_request: prFmt,
          repository: formatRepo(repo, gh, baseUrl),
          sender: formatUser(actor, baseUrl),
        },
        ownerLogin,
        repo.name
      );
    } else if (
      typeof body.title === "string" ||
      typeof body.body === "string" ||
      body.body === null
    ) {
      webhooks.dispatch(
        "pull_request",
        "edited",
        {
          action: "edited",
          pull_request: prFmt,
          repository: formatRepo(repo, gh, baseUrl),
          sender: formatUser(actor, baseUrl),
        },
        ownerLogin,
        repo.name
      );
    }

    return c.json(prFmt);
  });

  app.put("/repos/:owner/:repo/pulls/:pull_number/merge", async (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();

    const actor = assertRepoWrite(gh, c.get("authUser"), repo);
    const pullNumber = parseInt(c.req.param("pull_number")!, 10);
    if (!Number.isFinite(pullNumber)) throw notFoundResponse();

    const pr = findPull(gh, repo.id, pullNumber);
    if (!pr) throw notFoundResponse();
    if (pr.merged || pr.state === "closed") {
      throw new ApiError(422, "Pull Request is not mergeable");
    }
    if (pr.draft) {
      throw new ApiError(422, "Draft pull requests cannot be merged.");
    }

    const body = await parseJsonBody(c);
    if (typeof body.sha === "string" && body.sha !== pr.head_sha) {
      throw new ApiError(422, "Head sha is out of date");
    }

    const mergeMethod =
      body.merge_method === "squash" || body.merge_method === "rebase"
        ? body.merge_method
        : "merge";

    if (mergeMethod === "merge" && !repo.allow_merge_commit) {
      throw new ApiError(422, "Merge commits are not allowed on this repository.");
    }
    if (mergeMethod === "squash" && !repo.allow_squash_merge) {
      throw new ApiError(422, "Squash merges are not allowed on this repository.");
    }
    if (mergeMethod === "rebase" && !repo.allow_rebase_merge) {
      throw new ApiError(422, "Rebase merges are not allowed on this repository.");
    }

    checkMergeRequirements(gh, pr);

    const baseRepo = gh.repos.get(pr.base_repo_id)!;
    const headRepo = gh.repos.get(pr.head_repo_id)!;

    const baseCommit = gh.commits
      .findBy("repo_id", baseRepo.id)
      .find((x) => x.sha === pr.base_sha);
    const headCommit = gh.commits
      .findBy("repo_id", headRepo.id)
      .find((x) => x.sha === pr.head_sha);

    if (!baseCommit || !headCommit) {
      throw new ApiError(422, "Could not resolve commits to merge.");
    }

    const commitTitle =
      typeof body.commit_title === "string" && body.commit_title.trim()
        ? body.commit_title.trim()
        : `Merge pull request #${pr.number} from ${headLabel(gh, pr)}`;
    const commitMessage =
      typeof body.commit_message === "string" && body.commit_message.trim()
        ? body.commit_message.trim()
        : "";

    const fullMessage = commitMessage ? `${commitTitle}\n\n${commitMessage}` : commitTitle;

    let mergeCommit: GitHubCommit;
    if (mergeMethod === "merge") {
      mergeCommit = insertCommit(gh, baseRepo, {
        treeSha: headCommit.tree_sha,
        parentShas: [pr.base_sha, pr.head_sha],
        message: fullMessage,
        user: actor,
      });
    } else {
      mergeCommit = insertCommit(gh, baseRepo, {
        treeSha: headCommit.tree_sha,
        parentShas: [pr.base_sha],
        message: fullMessage,
        user: actor,
      });
    }

    updateBranchSha(gh, baseRepo, pr.base_ref, mergeCommit.sha);

    const now = timestamp();
    gh.pullRequests.update(pr.id, {
      merged: true,
      merged_at: now,
      merged_by_id: actor.id,
      merge_commit_sha: mergeCommit.sha,
      state: "closed",
      closed_at: now,
      mergeable: false,
      mergeable_state: "unknown",
    });

    const iss = findPrIssue(gh, repo.id, pullNumber);
    if (iss) {
      gh.issues.update(iss.id, {
        state: "closed",
        closed_at: now,
        closed_by_id: actor.id,
      });
    }

    adjustRepoOpenIssues(gh, repo.id, -1);

    if (repo.delete_branch_on_merge && pr.head_ref !== pr.base_ref) {
      deleteBranchByName(gh, headRepo, pr.head_ref);
    }

    const mergedPr = gh.pullRequests.get(pr.id)!;
    const prFmt = formatPullRequest(mergedPr, gh, baseUrl)!;
    const ownerLogin = ownerLoginOf(gh, repo);

    webhooks.dispatch(
      "pull_request",
      "closed",
      {
        action: "closed",
        pull_request: { ...prFmt, merged: true },
        repository: formatRepo(repo, gh, baseUrl),
        sender: formatUser(actor, baseUrl),
      },
      ownerLogin,
      repo.name
    );

    return c.json({
      sha: mergeCommit.sha,
      merged: true,
      message: "Pull Request successfully merged",
    });
  });

  app.get("/repos/:owner/:repo/pulls/:pull_number/commits", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoRead(gh, c.get("authUser"), repo);

    const pullNumber = parseInt(c.req.param("pull_number")!, 10);
    if (!Number.isFinite(pullNumber)) throw notFoundResponse();

    const pr = findPull(gh, repo.id, pullNumber);
    if (!pr) throw notFoundResponse();

    const headRepo = gh.repos.get(pr.head_repo_id);
    if (!headRepo) throw notFoundResponse();

    const chain = walkCommitsToBase(gh, headRepo, pr.head_sha, pr.base_sha);
    const { page, per_page } = parsePagination(c);
    const total = chain.length;
    setLinkHeader(c, total, page, per_page);
    const start = (page - 1) * per_page;
    const slice = chain.slice(start, start + per_page);

    return c.json(slice.map((commit) => formatCommitApi(commit, headRepo, baseUrl)));
  });

  app.get("/repos/:owner/:repo/pulls/:pull_number/files", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoRead(gh, c.get("authUser"), repo);

    const pullNumber = parseInt(c.req.param("pull_number")!, 10);
    if (!Number.isFinite(pullNumber)) throw notFoundResponse();

    const pr = findPull(gh, repo.id, pullNumber);
    if (!pr) throw notFoundResponse();

    const { page, per_page } = parsePagination(c);
    const n = pr.changed_files;
    const stubNames = Array.from({ length: n }, (_, i) => `file${i + 1}.ts`);
    const total = stubNames.length;
    setLinkHeader(c, total, page, per_page);
    const start = (page - 1) * per_page;
    const pageNames = stubNames.slice(start, start + per_page);

    return c.json(
      pageNames.map((filename, i) => ({
        sha: generateSha(),
        filename,
        status: "modified",
        additions: 1,
        deletions: 0,
        changes: 1,
        blob_url: `${baseUrl}/${repo.full_name}/blob/${pr.head_sha}/${filename}`,
        raw_url: `${baseUrl}/${repo.full_name}/raw/${pr.head_sha}/${filename}`,
        contents_url: `${baseUrl}/repos/${repo.full_name}/contents/${encodeURIComponent(
          filename
        )}?ref=${pr.head_ref}`,
        patch: "",
      }))
    );
  });

  app.post("/repos/:owner/:repo/pulls/:pull_number/requested_reviewers", async (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();

    const actor = assertRepoWrite(gh, c.get("authUser"), repo);
    const pullNumber = parseInt(c.req.param("pull_number")!, 10);
    if (!Number.isFinite(pullNumber)) throw notFoundResponse();

    const pr = findPull(gh, repo.id, pullNumber);
    if (!pr) throw notFoundResponse();

    const body = await parseJsonBody(c) as {
      reviewers?: unknown;
      team_reviewers?: unknown;
    };

    const reviewerLogins = Array.isArray(body.reviewers)
      ? body.reviewers.filter((x): x is string => typeof x === "string")
      : [];
    const teamSlugs = Array.isArray(body.team_reviewers)
      ? body.team_reviewers.filter((x): x is string => typeof x === "string")
      : [];

    const newUserIds = reviewerLogins.map((login) => lookupUserByLogin(gh, login).id);
    let newTeamIds: number[] = [];
    if (teamSlugs.length > 0) {
      if (repo.owner_type !== "Organization") {
        throw new ApiError(422, "Team reviewers are only supported for organization repositories.");
      }
      newTeamIds = teamSlugs.map((slug) => lookupTeamSlug(gh, repo.owner_id, slug).id);
    }

    const requested_reviewer_ids = [...new Set([...pr.requested_reviewer_ids, ...newUserIds])];
    const requested_team_ids = [...new Set([...pr.requested_team_ids, ...newTeamIds])];

    gh.pullRequests.update(pr.id, { requested_reviewer_ids, requested_team_ids });
    const fresh = gh.pullRequests.get(pr.id)!;
    const prFmt = formatPullRequest(fresh, gh, baseUrl)!;
    const ownerLogin = ownerLoginOf(gh, repo);

    webhooks.dispatch(
      "pull_request",
      "review_requested",
      {
        action: "review_requested",
        pull_request: prFmt,
        repository: formatRepo(repo, gh, baseUrl),
        sender: formatUser(actor, baseUrl),
      },
      ownerLogin,
      repo.name
    );

    return c.json(prFmt);
  });

  app.delete("/repos/:owner/:repo/pulls/:pull_number/requested_reviewers", async (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();

    assertRepoWrite(gh, c.get("authUser"), repo);
    const pullNumber = parseInt(c.req.param("pull_number")!, 10);
    if (!Number.isFinite(pullNumber)) throw notFoundResponse();

    const pr = findPull(gh, repo.id, pullNumber);
    if (!pr) throw notFoundResponse();

    const body = await parseJsonBody(c) as {
      reviewers?: unknown;
      team_reviewers?: unknown;
    };

    const reviewerLogins = Array.isArray(body.reviewers)
      ? body.reviewers.filter((x): x is string => typeof x === "string")
      : [];
    const teamSlugs = Array.isArray(body.team_reviewers)
      ? body.team_reviewers.filter((x): x is string => typeof x === "string")
      : [];

    const removeUserIds = new Set(reviewerLogins.map((login) => lookupUserByLogin(gh, login).id));
    let removeTeamIds = new Set<number>();
    if (teamSlugs.length > 0 && repo.owner_type === "Organization") {
      removeTeamIds = new Set(teamSlugs.map((slug) => lookupTeamSlug(gh, repo.owner_id, slug).id));
    }

    const requested_reviewer_ids = pr.requested_reviewer_ids.filter((id) => !removeUserIds.has(id));
    const requested_team_ids = pr.requested_team_ids.filter((id) => !removeTeamIds.has(id));

    gh.pullRequests.update(pr.id, { requested_reviewer_ids, requested_team_ids });
    const fresh = gh.pullRequests.get(pr.id)!;
    return c.json(formatPullRequest(fresh, gh, baseUrl)!);
  });

  app.put("/repos/:owner/:repo/pulls/:pull_number/update-branch", async (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();

    assertRepoWrite(gh, c.get("authUser"), repo);
    const pullNumber = parseInt(c.req.param("pull_number")!, 10);
    if (!Number.isFinite(pullNumber)) throw notFoundResponse();

    const pr = findPull(gh, repo.id, pullNumber);
    if (!pr) throw notFoundResponse();
    if (pr.state === "closed" || pr.merged) {
      throw new ApiError(422, "Cannot update a closed pull request");
    }

    const body = await parseJsonBody(c) as { expected_head_sha?: unknown };
    if (typeof body.expected_head_sha === "string" && body.expected_head_sha !== pr.head_sha) {
      throw new ApiError(422, "Head sha is out of date");
    }

    const headRepo = gh.repos.get(pr.head_repo_id);
    const baseRepo = gh.repos.get(pr.base_repo_id);
    if (!headRepo || !baseRepo) throw notFoundResponse();

    const headCommit = gh.commits
      .findBy("repo_id", headRepo.id)
      .find((x) => x.sha === pr.head_sha);
    const baseCommit = gh.commits
      .findBy("repo_id", baseRepo.id)
      .find((x) => x.sha === pr.base_sha);
    if (!headCommit || !baseCommit) throw new ApiError(422, "Could not resolve commits.");

    const actor = assertAuthenticatedUser(gh, c.get("authUser"));
    const mergeMsg = `Merge branch '${pr.base_ref}' into ${pr.head_ref}`;
    const newCommit = insertCommit(gh, headRepo, {
      treeSha: headCommit.tree_sha,
      parentShas: [pr.head_sha, pr.base_sha],
      message: mergeMsg,
      user: actor,
    });

    updateBranchSha(gh, headRepo, pr.head_ref, newCommit.sha);
    const next = gh.pullRequests.update(pr.id, {
      head_sha: newCommit.sha,
      commits: pr.commits + 1,
    });
    if (!next) throw notFoundResponse();

    const apiUrl = `${baseUrl}/repos/${repo.full_name}/pulls/${pullNumber}`;
    return c.json(
      {
        message: "Updating pull request branch.",
        url: apiUrl,
      },
      202
    );
  });
}
