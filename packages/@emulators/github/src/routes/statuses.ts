import type { RouteContext } from "@emulators/core";
import { ApiError, parseJsonBody, parsePagination, setLinkHeader } from "@emulators/core";
import { getGitHubStore } from "../store.js";
import type { GitHubStore } from "../store.js";
import type { GitHubCommit, GitHubCommitStatus, GitHubRepo } from "../entities.js";
import { formatRepo, formatUser, generateNodeId, lookupRepo } from "../helpers.js";
import { assertRepoPermission, assertRepoWrite, notFoundResponse, ownerLoginOf } from "../route-helpers.js";
import { findCommitBySha, formatCommitItem, listAncestors, resolveRefToCommit } from "../git-helpers.js";

const STATUS_STATES: ReadonlySet<string> = new Set(["error", "failure", "pending", "success"]);
const DESCRIPTION_MAX_LENGTH = 140;
const PAYLOAD_BRANCH_LIMIT = 10;

function newestFirst(left: GitHubCommitStatus, right: GitHubCommitStatus): number {
  if (left.created_at !== right.created_at) return left.created_at < right.created_at ? 1 : -1;
  return right.id - left.id;
}

/** The most recent status for each context, newest first. */
function latestStatusesByContext(statuses: GitHubCommitStatus[]): GitHubCommitStatus[] {
  const seen = new Set<string>();
  const latest: GitHubCommitStatus[] = [];
  for (const status of [...statuses].sort(newestFirst)) {
    if (seen.has(status.context)) continue;
    seen.add(status.context);
    latest.push(status);
  }
  return latest;
}

/** GitHub's rollup: any failure or error is failure, otherwise any pending (or no statuses) is pending. */
function combinedState(latest: GitHubCommitStatus[]): "failure" | "pending" | "success" {
  if (latest.length === 0) return "pending";
  if (latest.some((status) => status.state === "failure" || status.state === "error")) return "failure";
  if (latest.some((status) => status.state === "pending")) return "pending";
  return "success";
}

function statusesForCommit(gh: GitHubStore, repoId: number, sha: string): GitHubCommitStatus[] {
  return gh.commitStatuses.findBy("repo_id", repoId).filter((status) => status.sha === sha);
}

/** Statuses are created against a commit sha (full or unique prefix), never a branch or tag name. */
function findCommitForStatus(gh: GitHubStore, repoId: number, shaParam: string): GitHubCommit | undefined {
  const exact = findCommitBySha(gh, repoId, shaParam);
  if (exact) return exact;
  if (!/^[0-9a-f]{4,39}$/i.test(shaParam)) return undefined;
  const prefix = shaParam.toLowerCase();
  const matches = gh.commits.findBy("repo_id", repoId).filter((commit) => commit.sha.startsWith(prefix));
  return matches.length === 1 ? matches[0] : undefined;
}

function parseOptionalString(body: Record<string, unknown>, field: string): string | null {
  const value = body[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new ApiError(422, `${field} must be a string`);
  return value;
}

function isValidUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function formatCommitStatus(status: GitHubCommitStatus, repo: GitHubRepo, gh: GitHubStore, baseUrl: string) {
  const creator = gh.users.get(status.creator_id);
  return {
    url: `${baseUrl}/repos/${repo.full_name}/statuses/${status.sha}`,
    avatar_url: creator ? `${baseUrl}/avatars/u/${creator.login}` : null,
    id: status.id,
    node_id: status.node_id,
    state: status.state,
    description: status.description,
    target_url: status.target_url,
    context: status.context,
    created_at: status.created_at,
    updated_at: status.updated_at,
    creator: creator ? formatUser(creator, baseUrl) : null,
  };
}

/** Branches whose history contains the commit, as listed in `status` event payloads. */
function branchesContainingCommit(gh: GitHubStore, repo: GitHubRepo, sha: string, baseUrl: string) {
  const repoUrl = `${baseUrl}/repos/${repo.full_name}`;
  return gh.branches
    .findBy("repo_id", repo.id)
    .filter((branch) => branch.sha === sha || listAncestors(gh, repo.id, branch.sha).some((c) => c.sha === sha))
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, PAYLOAD_BRANCH_LIMIT)
    .map((branch) => ({
      name: branch.name,
      commit: { sha: branch.sha, url: `${repoUrl}/commits/${branch.sha}` },
      protected: branch.protected,
    }));
}

export function statusesRoutes({ app, store, webhooks, baseUrl }: RouteContext): void {
  const gh = getGitHubStore(store);

  app.post("/repos/:owner/:repo/statuses/:sha", async (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const shaParam = c.req.param("sha")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    const actor = assertRepoWrite(gh, c.get("authUser"), repo, "statuses");

    const body = await parseJsonBody(c);
    if (typeof body.state !== "string" || !STATUS_STATES.has(body.state)) {
      throw new ApiError(422, "state is not included in the list");
    }
    const state = body.state as GitHubCommitStatus["state"];
    const commit = findCommitForStatus(gh, repo.id, shaParam);
    if (!commit) throw new ApiError(422, `No commit found for SHA: ${shaParam}`);

    const targetUrl = parseOptionalString(body, "target_url") || null;
    if (targetUrl !== null && !isValidUrl(targetUrl)) throw new ApiError(422, "target_url must be a valid URL");
    const description = parseOptionalString(body, "description");
    if (description !== null && description.length > DESCRIPTION_MAX_LENGTH) {
      throw new ApiError(422, `description is too long (maximum is ${DESCRIPTION_MAX_LENGTH} characters)`);
    }
    const context = body.context === undefined || body.context === null ? "default" : body.context;
    if (typeof context !== "string" || !context) throw new ApiError(422, "context must be a non-empty string");

    const row = gh.commitStatuses.insert({
      node_id: "",
      repo_id: repo.id,
      sha: commit.sha,
      state,
      target_url: targetUrl,
      description,
      context,
      creator_id: actor.id,
    } as Omit<GitHubCommitStatus, "id" | "created_at" | "updated_at">);
    gh.commitStatuses.update(row.id, { node_id: generateNodeId("Status", row.id) });
    const status = gh.commitStatuses.get(row.id)!;
    const formatted = formatCommitStatus(status, repo, gh, baseUrl);

    webhooks.dispatch(
      "status",
      undefined,
      {
        id: status.id,
        sha: status.sha,
        name: repo.full_name,
        avatar_url: formatted.avatar_url,
        target_url: status.target_url,
        context: status.context,
        description: status.description,
        state: status.state,
        commit: formatCommitItem(gh, repo, commit, baseUrl),
        branches: branchesContainingCommit(gh, repo, commit.sha, baseUrl),
        created_at: status.created_at,
        updated_at: status.updated_at,
        repository: formatRepo(repo, gh, baseUrl),
        sender: formatUser(actor, baseUrl),
      },
      ownerLoginOf(gh, repo),
      repo.name,
    );

    return c.json(formatted, 201);
  });

  app.get("/repos/:owner/:repo/commits/:ref{.+}/statuses", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoPermission(gh, c.get("authUser"), repo, "statuses");

    const commit = resolveRefToCommit(gh, repo, c.req.param("ref")!);
    if (!commit) throw notFoundResponse();

    const statuses = statusesForCommit(gh, repo.id, commit.sha).sort(newestFirst);
    const { page, per_page } = parsePagination(c);
    const start = (page - 1) * per_page;
    setLinkHeader(c, statuses.length, page, per_page);
    return c.json(
      statuses.slice(start, start + per_page).map((status) => formatCommitStatus(status, repo, gh, baseUrl)),
    );
  });

  app.get("/repos/:owner/:repo/commits/:ref{.+}/status", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoPermission(gh, c.get("authUser"), repo, "statuses");

    const commit = resolveRefToCommit(gh, repo, c.req.param("ref")!);
    if (!commit) throw notFoundResponse();

    const latest = latestStatusesByContext(statusesForCommit(gh, repo.id, commit.sha));
    const { page, per_page } = parsePagination(c);
    const start = (page - 1) * per_page;
    setLinkHeader(c, latest.length, page, per_page);
    const repoUrl = `${baseUrl}/repos/${repo.full_name}`;
    return c.json({
      state: combinedState(latest),
      statuses: latest.slice(start, start + per_page).map((status) => formatCommitStatus(status, repo, gh, baseUrl)),
      sha: commit.sha,
      total_count: latest.length,
      repository: formatRepo(repo, gh, baseUrl),
      commit_url: `${repoUrl}/commits/${commit.sha}`,
      url: `${repoUrl}/commits/${commit.sha}/status`,
    });
  });
}
