import type { GitHubBlob, GitHubBranch, GitHubCommit, GitHubRef, GitHubRepo, GitHubTree } from "./entities.js";
import type { GitHubStore } from "./store.js";
import { generateNodeId } from "./helpers.js";
import {
  compareTreeEntries,
  gitObjectSha,
  serializeBlob,
  serializeCommit,
  serializeTree,
  type GitObject,
  type GitTreeEntry,
} from "./git-objects.js";

/**
 * Bridges the REST-facing store rows (blobs, trees, commits, refs) and real
 * git objects. Repos materialized here use canonical git shas, so the same
 * history can be served both through the REST API and through the git smart
 * HTTP endpoints.
 */

/** Fixed commit date for seeded fixtures so their shas are stable across emulator restarts. */
export const FIXTURE_COMMIT_DATE = "2024-01-01T00:00:00.000Z";

export interface MaterializeOptions {
  authorName: string;
  authorEmail: string;
  commitDate: string;
  pushedAt: string;
  message: string;
  userId: number | null;
}

export function defaultReadmeFiles(title: string): Record<string, string> {
  return { "README.md": `# ${title}\n` };
}

/** REST tree rows name entries `path`; the wire format calls the same field `name`. */
function toGitEntry(entry: { mode: string; path: string; sha: string }): GitTreeEntry {
  return { mode: entry.mode, name: entry.path, sha: entry.sha };
}

interface DirNode {
  files: Map<string, string>;
  dirs: Map<string, DirNode>;
}

function newDirNode(): DirNode {
  return { files: new Map(), dirs: new Map() };
}

function validateSegment(segment: string, fullPath: string): void {
  if (!segment || segment === "." || segment === "..") {
    throw new Error(`Invalid repo file path "${fullPath}": empty, "." and ".." path segments are not allowed`);
  }
  if (segment.toLowerCase() === ".git") {
    throw new Error(`Invalid repo file path "${fullPath}": ".git" path segments are not allowed`);
  }
  if (segment.includes("\0")) {
    throw new Error(`Invalid repo file path "${fullPath}": null bytes are not allowed`);
  }
}

function buildFileTree(files: Record<string, string>): DirNode {
  const root = newDirNode();
  for (const [path, content] of Object.entries(files)) {
    const segments = path.split("/");
    for (const segment of segments) {
      validateSegment(segment, path);
    }
    let node = root;
    for (const segment of segments.slice(0, -1)) {
      if (node.files.has(segment)) {
        throw new Error(`Invalid repo files: "${path}" uses "${segment}" as a directory but it is also a file`);
      }
      let child = node.dirs.get(segment);
      if (!child) {
        child = newDirNode();
        node.dirs.set(segment, child);
      }
      node = child;
    }
    const name = segments[segments.length - 1];
    if (node.dirs.has(name)) {
      throw new Error(`Invalid repo files: "${path}" is both a file and a directory`);
    }
    node.files.set(name, content);
  }
  return root;
}

/** Validates fixture file paths without writing anything, so callers can fail before creating rows. */
export function validateRepoFiles(files: Record<string, string>): void {
  buildFileTree(files);
}

/**
 * Creates blob, tree, commit, branch, and ref rows for a freshly created repo
 * from a path-to-content map. All shas are canonical git object ids, which
 * makes the repo cloneable through the git smart HTTP endpoints.
 */
export function materializeRepoGit(
  gh: GitHubStore,
  repo: GitHubRepo,
  files: Record<string, string>,
  options: MaterializeOptions,
): { totalBytes: number } {
  const root = buildFileTree(files);
  const insertedBlobs = new Set<string>();
  const insertedTrees = new Set<string>();
  let totalBytes = 0;

  const insertBlob = (content: string): { sha: string; size: number } => {
    const obj = serializeBlob(content, "utf-8");
    const sha = gitObjectSha(obj);
    const size = obj.data.length;
    if (!insertedBlobs.has(sha)) {
      insertedBlobs.add(sha);
      totalBytes += size;
      const blob = gh.blobs.insert({
        repo_id: repo.id,
        sha,
        node_id: "",
        content,
        encoding: "utf-8",
        size,
      } as Omit<GitHubBlob, "id" | "created_at" | "updated_at">);
      gh.blobs.update(blob.id, { node_id: generateNodeId("Blob", blob.id) });
    }
    return { sha, size };
  };

  const insertTree = (node: DirNode): string => {
    const entries: GitHubTree["tree"] = [];
    for (const [name, child] of node.dirs) {
      entries.push({ path: name, mode: "040000", type: "tree", sha: insertTree(child) });
    }
    for (const [name, content] of node.files) {
      const { sha, size } = insertBlob(content);
      entries.push({ path: name, mode: "100644", type: "blob", sha, size });
    }
    entries.sort((a, b) => compareTreeEntries(toGitEntry(a), toGitEntry(b)));
    const obj = serializeTree(entries.map(toGitEntry));
    const sha = gitObjectSha(obj);
    if (!insertedTrees.has(sha)) {
      insertedTrees.add(sha);
      const tree = gh.trees.insert({
        repo_id: repo.id,
        sha,
        node_id: "",
        tree: entries,
        truncated: false,
      } as Omit<GitHubTree, "id" | "created_at" | "updated_at">);
      gh.trees.update(tree.id, { node_id: generateNodeId("Tree", tree.id) });
    }
    return sha;
  };

  const treeSha = insertTree(root);

  const commitMeta = {
    treeSha,
    parentShas: [],
    authorName: options.authorName,
    authorEmail: options.authorEmail,
    authorDate: options.commitDate,
    committerName: options.authorName,
    committerEmail: options.authorEmail,
    committerDate: options.commitDate,
    message: options.message,
  };
  const commitSha = gitObjectSha(serializeCommit(commitMeta));

  const commit = gh.commits.insert({
    repo_id: repo.id,
    sha: commitSha,
    node_id: "",
    message: options.message,
    author_name: options.authorName,
    author_email: options.authorEmail,
    author_date: options.commitDate,
    committer_name: options.authorName,
    committer_email: options.authorEmail,
    committer_date: options.commitDate,
    tree_sha: treeSha,
    parent_shas: [],
    user_id: options.userId,
  } as Omit<GitHubCommit, "id" | "created_at" | "updated_at">);
  gh.commits.update(commit.id, { node_id: generateNodeId("Commit", commit.id) });

  gh.branches.insert({
    repo_id: repo.id,
    name: repo.default_branch,
    sha: commitSha,
    protected: false,
  } as Omit<GitHubBranch, "id" | "created_at" | "updated_at">);

  const ref = gh.refs.insert({
    repo_id: repo.id,
    ref: `refs/heads/${repo.default_branch}`,
    sha: commitSha,
    node_id: "",
  } as Omit<GitHubRef, "id" | "created_at" | "updated_at">);
  gh.refs.update(ref.id, { node_id: generateNodeId("Ref", ref.id) });

  gh.repos.update(repo.id, { size: totalBytes, pushed_at: options.pushedAt });

  return { totalBytes };
}

/**
 * Returns a resolver that collects every object reachable from a commit,
 * verifying that each row still serializes to its recorded sha. The resolver
 * returns null when any reachable object is missing or was created with a
 * synthetic (non-git) sha, for example by the plain REST git data endpoints.
 */
export function createRepoObjectSource(
  gh: GitHubStore,
  repoId: number,
): (tipSha: string) => Map<string, GitObject> | null {
  const bySha = <T extends { sha: string }>(rows: T[]): Map<string, T> => new Map(rows.map((row) => [row.sha, row]));
  const commits = bySha(gh.commits.findBy("repo_id", repoId));
  const trees = bySha(gh.trees.findBy("repo_id", repoId));
  const blobs = bySha(gh.blobs.findBy("repo_id", repoId));

  const verified = new Map<string, GitObject>();
  const verifiedObject = (sha: string, build: () => GitObject): GitObject | null => {
    let obj = verified.get(sha);
    if (!obj) {
      obj = build();
      if (gitObjectSha(obj) !== sha) return null;
      verified.set(sha, obj);
    }
    return obj;
  };

  const resolveCommit = (sha: string, out: Map<string, GitObject>): boolean => {
    if (out.has(sha)) return true;
    const row = commits.get(sha);
    if (!row) return false;
    const obj = verifiedObject(sha, () =>
      serializeCommit({
        treeSha: row.tree_sha,
        parentShas: row.parent_shas,
        authorName: row.author_name,
        authorEmail: row.author_email,
        authorDate: row.author_date,
        committerName: row.committer_name,
        committerEmail: row.committer_email,
        committerDate: row.committer_date,
        message: row.message,
      }),
    );
    if (!obj) return false;
    out.set(sha, obj);
    return resolveTree(row.tree_sha, out) && row.parent_shas.every((parent) => resolveCommit(parent, out));
  };

  const resolveTree = (sha: string, out: Map<string, GitObject>): boolean => {
    if (out.has(sha)) return true;
    const row = trees.get(sha);
    if (!row) return false;
    const obj = verifiedObject(sha, () => serializeTree(row.tree.map(toGitEntry)));
    if (!obj) return false;
    out.set(sha, obj);
    for (const entry of row.tree) {
      const ok = entry.type === "tree" ? resolveTree(entry.sha, out) : resolveBlob(entry.sha, out);
      if (!ok) return false;
    }
    return true;
  };

  const resolveBlob = (sha: string, out: Map<string, GitObject>): boolean => {
    if (out.has(sha)) return true;
    const row = blobs.get(sha);
    if (!row) return false;
    const obj = verifiedObject(sha, () => serializeBlob(row.content, row.encoding));
    if (!obj) return false;
    out.set(sha, obj);
    return true;
  };

  return (tipSha) => {
    const out = new Map<string, GitObject>();
    return resolveCommit(tipSha, out) ? out : null;
  };
}
