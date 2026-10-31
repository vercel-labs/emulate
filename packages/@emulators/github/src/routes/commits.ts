import type { RouteContext } from "@emulators/core";
import { ApiError, parsePagination, setLinkHeader } from "@emulators/core";
import { getGitHubStore } from "../store.js";
import type { GitHubStore } from "../store.js";
import type { GitHubCommit, GitHubRepo } from "../entities.js";
import { lookupRepo } from "../helpers.js";
import { assertRepoContentsRead, notFoundResponse } from "../route-helpers.js";
import {
  commitIdentityMatches,
  diffTrees,
  findCommitBySha,
  flattenTree,
  formatCommitItem,
  formatFileDiff,
  listAncestors,
  resolveRefToCommit,
} from "../git-helpers.js";

function blobsAtPath(gh: GitHubStore, repoId: number, treeSha: string, path: string) {
  const prefix = `${path.replace(/\/+$/, "")}/`;
  return new Map(
    [...flattenTree(gh, repoId, treeSha).blobs].filter(
      ([candidate]) => candidate === path || candidate.startsWith(prefix),
    ),
  );
}

/** A commit "touches" a path when that blob or any descendant differs from its first parent's. */
function commitTouchesPath(gh: GitHubStore, repoId: number, commit: GitHubCommit, path: string): boolean {
  const current = blobsAtPath(gh, repoId, commit.tree_sha, path);
  const parent = commit.parent_shas[0] ? findCommitBySha(gh, repoId, commit.parent_shas[0]) : undefined;
  const previous = parent ? blobsAtPath(gh, repoId, parent.tree_sha, path) : new Map();
  const candidates = new Set([...current.keys(), ...previous.keys()]);
  return [...candidates].some((candidate) => {
    const after = current.get(candidate);
    const before = previous.get(candidate);
    return after?.sha !== before?.sha || after?.mode !== before?.mode;
  });
}

function parseDateFilter(value: string): number | undefined {
  const date = Date.parse(value);
  return Number.isFinite(date) ? date : undefined;
}

function ancestorDistances(gh: GitHubStore, repoId: number, startSha: string): Map<string, number> {
  const distances = new Map<string, number>();
  const queue: Array<{ sha: string; distance: number }> = [{ sha: startSha, distance: 0 }];
  for (let i = 0; i < queue.length; i++) {
    const { sha, distance } = queue[i];
    const known = distances.get(sha);
    if (known !== undefined && known <= distance) continue;
    distances.set(sha, distance);
    const commit = findCommitBySha(gh, repoId, sha);
    if (!commit) continue;
    for (const parent of commit.parent_shas) queue.push({ sha: parent, distance: distance + 1 });
  }
  return distances;
}

function findMergeBase(gh: GitHubStore, repoId: number, baseSha: string, headSha: string): GitHubCommit | undefined {
  const fromBase = ancestorDistances(gh, repoId, baseSha);
  const fromHead = ancestorDistances(gh, repoId, headSha);
  return [...fromBase.keys()]
    .filter((sha) => fromHead.has(sha))
    .map((sha) => ({ commit: findCommitBySha(gh, repoId, sha), score: fromBase.get(sha)! + fromHead.get(sha)! }))
    .filter((candidate): candidate is { commit: GitHubCommit; score: number } => candidate.commit !== undefined)
    .sort((a, b) => a.score - b.score || b.commit.id - a.commit.id)[0]?.commit;
}

function formatFullCommit(
  gh: GitHubStore,
  repo: GitHubRepo,
  commit: GitHubCommit,
  baseUrl: string,
  baseSha: string | null,
  allFiles: ReturnType<typeof diffTrees>,
  pageFiles: ReturnType<typeof diffTrees>,
) {
  const additions = allFiles.reduce((sum, f) => sum + f.additions, 0);
  const deletions = allFiles.reduce((sum, f) => sum + f.deletions, 0);
  return {
    ...formatCommitItem(gh, repo, commit, baseUrl),
    stats: { total: additions + deletions, additions, deletions },
    files: pageFiles.map((f) => formatFileDiff(f, repo, baseSha, commit.sha, baseUrl)),
  };
}

export function commitsRoutes({ app, store, baseUrl }: RouteContext): void {
  const gh = getGitHubStore(store);

  app.get("/repos/:owner/:repo/commits", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoContentsRead(gh, c.get("authUser"), repo);

    if (gh.commits.findBy("repo_id", repo.id).length === 0) {
      throw new ApiError(409, "Git Repository is empty.");
    }

    const shaParam = c.req.query("sha");
    const head = resolveRefToCommit(gh, repo, shaParam);
    if (!head) throw notFoundResponse();

    let history = listAncestors(gh, repo.id, head.sha);

    const path = c.req.query("path");
    if (path) {
      history = history.filter((commit) => commitTouchesPath(gh, repo.id, commit, path));
    }
    const author = c.req.query("author");
    if (author) {
      history = history.filter((commit) => commitIdentityMatches(gh, commit.author_email, author));
    }
    const committer = c.req.query("committer");
    if (committer) {
      history = history.filter((commit) => commitIdentityMatches(gh, commit.committer_email, committer));
    }
    const since = c.req.query("since");
    if (since) {
      const sinceDate = parseDateFilter(since);
      history =
        sinceDate === undefined ? [] : history.filter((commit) => Date.parse(commit.committer_date) >= sinceDate);
    }
    const until = c.req.query("until");
    if (until) {
      const untilDate = parseDateFilter(until);
      if (untilDate !== undefined) {
        history = history.filter((commit) => Date.parse(commit.committer_date) <= untilDate);
      }
    }

    const { page, per_page } = parsePagination(c);
    const total = history.length;
    const start = (page - 1) * per_page;
    const slice = history.slice(start, start + per_page);

    setLinkHeader(c, total, page, per_page);
    return c.json(slice.map((commit) => formatCommitItem(gh, repo, commit, baseUrl)));
  });

  app.get("/repos/:owner/:repo/compare/:basehead{.+}", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const basehead = c.req.param("basehead")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoContentsRead(gh, c.get("authUser"), repo);

    const sep = basehead.indexOf("...");
    if (sep === -1) throw notFoundResponse();
    const base = resolveRefToCommit(gh, repo, basehead.slice(0, sep));
    const head = resolveRefToCommit(gh, repo, basehead.slice(sep + 3));
    if (!base || !head) throw notFoundResponse();

    const baseAncestors = new Set(listAncestors(gh, repo.id, base.sha).map((x) => x.sha));
    const headAncestry = listAncestors(gh, repo.id, head.sha);
    const headAncestors = new Set(headAncestry.map((x) => x.sha));

    const mergeBase = findMergeBase(gh, repo.id, base.sha, head.sha);
    if (!mergeBase) throw notFoundResponse();
    const aheadCommits = headAncestry.filter((x) => !baseAncestors.has(x.sha)).reverse();
    const behindBy = listAncestors(gh, repo.id, base.sha).filter((x) => !headAncestors.has(x.sha)).length;

    const status =
      base.sha === head.sha || (aheadCommits.length === 0 && behindBy === 0)
        ? "identical"
        : aheadCommits.length > 0 && behindBy === 0
          ? "ahead"
          : aheadCommits.length === 0
            ? "behind"
            : "diverged";

    const allFiles = diffTrees(gh, repo.id, mergeBase.tree_sha, head.tree_sha);
    const hasPagination = c.req.query("page") !== undefined || c.req.query("per_page") !== undefined;
    let commits = aheadCommits;
    let files = allFiles.slice(0, 300);
    if (hasPagination) {
      const { page, per_page } = parsePagination(c);
      const start = (page - 1) * per_page;
      commits = aheadCommits.slice(start, start + per_page);
      files = page === 1 ? files : [];
      setLinkHeader(c, aheadCommits.length, page, per_page);
    } else if (commits.length > 250) {
      commits = [...commits.slice(0, 249), commits.at(-1)!];
    }
    const repoUrl = `${baseUrl}/repos/${repo.full_name}`;

    return c.json({
      url: `${repoUrl}/compare/${basehead}`,
      html_url: `${baseUrl}/${repo.full_name}/compare/${basehead}`,
      permalink_url: `${baseUrl}/${repo.full_name}/compare/${base.sha.slice(0, 12)}...${head.sha.slice(0, 12)}`,
      diff_url: `${baseUrl}/${repo.full_name}/compare/${basehead}.diff`,
      patch_url: `${baseUrl}/${repo.full_name}/compare/${basehead}.patch`,
      base_commit: formatCommitItem(gh, repo, base, baseUrl),
      merge_base_commit: formatCommitItem(gh, repo, mergeBase, baseUrl),
      status,
      ahead_by: aheadCommits.length,
      behind_by: behindBy,
      total_commits: aheadCommits.length,
      commits: commits.map((commit) => formatCommitItem(gh, repo, commit, baseUrl)),
      files: files.map((f) => formatFileDiff(f, repo, mergeBase.sha, head.sha, baseUrl)),
    });
  });

  app.get("/repos/:owner/:repo/commits/:ref{.+}", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const refParam = c.req.param("ref")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoContentsRead(gh, c.get("authUser"), repo);

    const commit = resolveRefToCommit(gh, repo, refParam);
    if (!commit) throw notFoundResponse();
    const parent = commit.parent_shas[0] ? findCommitBySha(gh, repo.id, commit.parent_shas[0]) : undefined;
    const allFiles = diffTrees(gh, repo.id, parent?.tree_sha ?? null, commit.tree_sha);
    const listedFiles = allFiles.slice(0, 3_000);
    const hasPagination = c.req.query("page") !== undefined || c.req.query("per_page") !== undefined;
    const { page, per_page } = hasPagination ? parsePagination(c) : { page: 1, per_page: 300 };
    const start = (page - 1) * per_page;
    const pageFiles = listedFiles.slice(start, start + per_page);
    setLinkHeader(c, listedFiles.length, page, per_page);
    return c.json(formatFullCommit(gh, repo, commit, baseUrl, parent?.sha ?? null, allFiles, pageFiles));
  });
}
