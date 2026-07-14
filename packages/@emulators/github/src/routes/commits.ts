import type { RouteContext } from "@emulators/core";
import { ApiError, parsePagination, setLinkHeader } from "@emulators/core";
import { getGitHubStore } from "../store.js";
import type { GitHubStore } from "../store.js";
import type { GitHubCommit, GitHubRepo } from "../entities.js";
import { lookupRepo } from "../helpers.js";
import { assertRepoRead, notFoundResponse } from "../route-helpers.js";
import {
  diffTrees,
  findCommitBySha,
  flattenTree,
  formatCommitItem,
  formatFileDiff,
  listAncestors,
  resolveRefToCommit,
} from "../git-helpers.js";

function blobShaAt(gh: GitHubStore, repoId: number, treeSha: string, path: string): string | undefined {
  return flattenTree(gh, repoId, treeSha).blobs.get(path)?.sha;
}

/** A commit "touches" a path when the blob sha at that path differs from its first parent's. */
function commitTouchesPath(gh: GitHubStore, repoId: number, commit: GitHubCommit, path: string): boolean {
  const current = blobShaAt(gh, repoId, commit.tree_sha, path);
  const parent = commit.parent_shas[0] ? findCommitBySha(gh, repoId, commit.parent_shas[0]) : undefined;
  const previous = parent ? blobShaAt(gh, repoId, parent.tree_sha, path) : undefined;
  return current !== previous;
}

function matchesAuthor(gh: GitHubStore, commit: GitHubCommit, author: string): boolean {
  if (commit.author_name === author || commit.author_email === author) return true;
  const user = commit.user_id ? gh.users.get(commit.user_id) : null;
  return user?.login === author;
}

function formatFullCommit(gh: GitHubStore, repo: GitHubRepo, commit: GitHubCommit, baseUrl: string) {
  const parent = commit.parent_shas[0] ? findCommitBySha(gh, repo.id, commit.parent_shas[0]) : undefined;
  const files = diffTrees(gh, repo.id, parent?.tree_sha ?? null, commit.tree_sha);
  const additions = files.reduce((sum, f) => sum + f.additions, 0);
  const deletions = files.reduce((sum, f) => sum + f.deletions, 0);
  return {
    ...formatCommitItem(gh, repo, commit, baseUrl),
    stats: { total: additions + deletions, additions, deletions },
    files: files.map((f) => formatFileDiff(f, repo, commit.sha, baseUrl)),
  };
}

export function commitsRoutes({ app, store, baseUrl }: RouteContext): void {
  const gh = getGitHubStore(store);

  app.get("/repos/:owner/:repo/commits", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoRead(gh, c.get("authUser"), repo);

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
      history = history.filter((commit) => matchesAuthor(gh, commit, author));
    }
    const since = c.req.query("since");
    if (since) {
      history = history.filter((commit) => commit.committer_date >= since);
    }
    const until = c.req.query("until");
    if (until) {
      history = history.filter((commit) => commit.committer_date <= until);
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
    const basehead = decodeURIComponent(c.req.param("basehead")!);
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoRead(gh, c.get("authUser"), repo);

    const sep = basehead.indexOf("...");
    if (sep === -1) throw notFoundResponse();
    const base = resolveRefToCommit(gh, repo, basehead.slice(0, sep));
    const head = resolveRefToCommit(gh, repo, basehead.slice(sep + 3));
    if (!base || !head) throw notFoundResponse();

    const baseAncestors = new Set(listAncestors(gh, repo.id, base.sha).map((x) => x.sha));
    const headAncestry = listAncestors(gh, repo.id, head.sha);
    const headAncestors = new Set(headAncestry.map((x) => x.sha));

    // Newest common ancestor (listAncestors is sorted newest first).
    const mergeBase = headAncestry.find((x) => baseAncestors.has(x.sha)) ?? base;
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

    const files = diffTrees(gh, repo.id, mergeBase.tree_sha, head.tree_sha);
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
      commits: aheadCommits.map((commit) => formatCommitItem(gh, repo, commit, baseUrl)),
      files: files.map((f) => formatFileDiff(f, repo, head.sha, baseUrl)),
    });
  });

  app.get("/repos/:owner/:repo/commits/:ref{.+}", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const refParam = decodeURIComponent(c.req.param("ref")!);
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoRead(gh, c.get("authUser"), repo);

    const commit = resolveRefToCommit(gh, repo, refParam);
    if (!commit) throw notFoundResponse();
    return c.json(formatFullCommit(gh, repo, commit, baseUrl));
  });
}
