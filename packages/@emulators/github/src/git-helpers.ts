import { createHash } from "crypto";
import type { GitHubStore } from "./store.js";
import type { GitHubBlob, GitHubCommit, GitHubRepo, GitHubTree, GitHubUser } from "./entities.js";
import { formatUser, generateNodeId } from "./helpers.js";

function gitObjectSha(type: "blob" | "tree" | "commit", content: Buffer): string {
  const header = Buffer.from(`${type} ${content.byteLength}\0`, "utf8");
  return createHash("sha1").update(header).update(content).digest("hex");
}

export function blobBytes(blob: GitHubBlob): Buffer {
  return blob.encoding === "base64" ? Buffer.from(blob.content, "base64") : Buffer.from(blob.content, "utf8");
}

export function findOrCreateBlob(gh: GitHubStore, repoId: number, content: Buffer): GitHubBlob {
  const sha = gitObjectSha("blob", content);
  const sameSha = gh.blobs.findBy("repo_id", repoId).find((blob) => blob.sha === sha);
  if (sameSha) return sameSha;

  const text = content.toString("utf8");
  const isText = !text.includes("\0") && Buffer.from(text, "utf8").equals(content);
  const blob = gh.blobs.insert({
    repo_id: repoId,
    sha,
    node_id: "",
    content: isText ? text : content.toString("base64"),
    encoding: isText ? "utf-8" : "base64",
    size: content.byteLength,
  } as Omit<GitHubBlob, "id" | "created_at" | "updated_at">);
  gh.blobs.update(blob.id, { node_id: generateNodeId("Blob", blob.id) });
  return gh.blobs.get(blob.id)!;
}

type GitTreeEntry = GitHubTree["tree"][number];

function treeContent(entries: GitTreeEntry[]): Buffer {
  const ordered = [...entries].sort((left, right) => {
    const leftName = left.type === "tree" ? `${left.path}/` : left.path;
    const rightName = right.type === "tree" ? `${right.path}/` : right.path;
    return Buffer.compare(Buffer.from(leftName, "utf8"), Buffer.from(rightName, "utf8"));
  });
  return Buffer.concat(
    ordered.flatMap((entry) => [
      Buffer.from(`${entry.mode.replace(/^0+/, "")} ${entry.path}\0`, "utf8"),
      Buffer.from(entry.sha, "hex"),
    ]),
  );
}

export function findOrCreateTree(gh: GitHubStore, repoId: number, entries: GitTreeEntry[]): GitHubTree {
  const sha = gitObjectSha("tree", treeContent(entries));
  const sameSha = gh.trees.findBy("repo_id", repoId).find((tree) => tree.sha === sha);
  if (sameSha) return sameSha;

  const tree = gh.trees.insert({
    repo_id: repoId,
    sha,
    node_id: "",
    tree: [...entries].sort((left, right) => left.path.localeCompare(right.path)),
    truncated: false,
  } as Omit<GitHubTree, "id" | "created_at" | "updated_at">);
  gh.trees.update(tree.id, { node_id: generateNodeId("Tree", tree.id) });
  return gh.trees.get(tree.id)!;
}

export interface GitCommitData {
  message: string;
  author_name: string;
  author_email: string;
  author_date: string;
  committer_name: string;
  committer_email: string;
  committer_date: string;
  tree_sha: string;
  parent_shas: string[];
  user_id: number | null;
}

function gitIdentityDate(date: string): string {
  const milliseconds = Date.parse(date);
  if (!Number.isFinite(milliseconds)) throw new Error(`Invalid Git identity date: ${date}`);
  const zone = date.match(/(Z|([+-])(\d{2}):?(\d{2}))$/i);
  const offset = !zone || zone[1].toUpperCase() === "Z" ? "+0000" : `${zone[2]}${zone[3]}${zone[4]}`;
  return `${Math.floor(milliseconds / 1000)} ${offset}`;
}

function gitCommitContent(data: GitCommitData): Buffer {
  const headers = [`tree ${data.tree_sha}`, ...data.parent_shas.map((sha) => `parent ${sha}`)];
  headers.push(`author ${data.author_name} <${data.author_email}> ${gitIdentityDate(data.author_date)}`);
  headers.push(`committer ${data.committer_name} <${data.committer_email}> ${gitIdentityDate(data.committer_date)}`);
  const message = data.message.endsWith("\n") ? data.message : `${data.message}\n`;
  return Buffer.from(`${headers.join("\n")}\n\n${message}`, "utf8");
}

export function findOrCreateCommit(gh: GitHubStore, repoId: number, data: GitCommitData): GitHubCommit {
  const sha = gitObjectSha("commit", gitCommitContent(data));
  const existing = gh.commits.findBy("repo_id", repoId).find((commit) => commit.sha === sha);
  if (existing) return existing;

  const commit = gh.commits.insert({
    repo_id: repoId,
    sha,
    node_id: "",
    ...data,
  } as Omit<GitHubCommit, "id" | "created_at" | "updated_at">);
  gh.commits.update(commit.id, { node_id: generateNodeId("Commit", commit.id) });
  return gh.commits.get(commit.id)!;
}

export function findCommitBySha(gh: GitHubStore, repoId: number, sha: string): GitHubCommit | undefined {
  return gh.commits.findBy("repo_id", repoId).find((c) => c.sha === sha);
}

function peelToCommit(gh: GitHubStore, repoId: number, sha: string): GitHubCommit | undefined {
  const commit = findCommitBySha(gh, repoId, sha);
  if (commit) return commit;
  const tag = gh.tags.findBy("repo_id", repoId).find((t) => t.sha === sha);
  if (tag) return peelToCommit(gh, repoId, tag.object_sha);
  return undefined;
}

/** Resolve a ref expression (branch, tag, full ref, sha, sha prefix, or HEAD) to a commit. */
export function resolveRefToCommit(gh: GitHubStore, repo: GitHubRepo, refParam?: string): GitHubCommit | undefined {
  const ref = !refParam || refParam === "HEAD" ? repo.default_branch : refParam;

  const branchName = ref.startsWith("refs/heads/")
    ? ref.slice("refs/heads/".length)
    : ref.startsWith("heads/")
      ? ref.slice("heads/".length)
      : ref;
  const branch = resolveBranchToCommit(gh, repo, branchName);
  if (branch && !ref.startsWith("tags/") && !ref.startsWith("refs/tags/")) return branch;

  const refs = gh.refs.findBy("repo_id", repo.id);
  const candidates = ref.startsWith("refs/")
    ? [ref]
    : ref.startsWith("heads/") || ref.startsWith("tags/")
      ? [`refs/${ref}`]
      : [`refs/heads/${ref}`, `refs/tags/${ref}`];
  const refRec = candidates.map((candidate) => refs.find((r) => r.ref === candidate)).find(Boolean);
  if (refRec) return peelToCommit(gh, repo.id, refRec.sha);

  const commits = gh.commits.findBy("repo_id", repo.id);
  const exact = commits.find((c) => c.sha === ref);
  if (exact) return exact;
  if (/^[0-9a-f]{4,39}$/.test(ref)) {
    return commits.find((c) => c.sha.startsWith(ref));
  }
  return undefined;
}

/** Resolve only an existing branch name to its head commit. */
export function resolveBranchToCommit(gh: GitHubStore, repo: GitHubRepo, branchName: string): GitHubCommit | undefined {
  const branch = gh.branches.findBy("repo_id", repo.id).find((b) => b.name === branchName);
  const ref = gh.refs.findBy("repo_id", repo.id).find((r) => r.ref === `refs/heads/${branchName}`);
  const sha = ref?.sha ?? branch?.sha;
  return sha ? peelToCommit(gh, repo.id, sha) : undefined;
}

export interface FlatTree {
  /** Full slash-separated non-tree path -> entry. */
  blobs: Map<string, { mode: string; type: "blob" | "commit"; sha: string; size?: number }>;
  /** Full slash-separated directory path -> tree sha ("" when synthesized from flat paths). */
  dirs: Map<string, string>;
}

/**
 * Flatten a tree into full-path blob and directory maps. Handles both nested
 * subtree entries and flat trees whose entry paths contain slashes (the shape
 * POST /git/trees produces).
 */
export function flattenTree(gh: GitHubStore, repoId: number, treeSha: string): FlatTree {
  const blobs: FlatTree["blobs"] = new Map();
  const dirs: FlatTree["dirs"] = new Map();

  const registerParentDirs = (path: string) => {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      if (!dirs.has(dir)) dirs.set(dir, "");
    }
  };

  const walk = (sha: string, prefix: string, ancestors: Set<string>) => {
    if (ancestors.has(sha)) return;
    const tree = gh.trees.findBy("repo_id", repoId).find((t) => t.sha === sha);
    if (!tree) return;
    const nextAncestors = new Set(ancestors).add(sha);
    for (const e of tree.tree) {
      const path = prefix ? `${prefix}/${e.path}` : e.path;
      if (e.type !== "tree") {
        blobs.set(path, { mode: e.mode, type: e.type, sha: e.sha, size: e.size });
        registerParentDirs(path);
      } else {
        dirs.set(path, e.sha);
        registerParentDirs(path);
        walk(e.sha, path, nextAncestors);
      }
    }
  };

  walk(treeSha, "", new Set());
  return { blobs, dirs };
}

/** All commits reachable from head in child-before-parent date order. */
export function listAncestors(gh: GitHubStore, repoId: number, headSha: string): GitHubCommit[] {
  const reachable = new Map<string, GitHubCommit>();
  const stack = [headSha];
  while (stack.length) {
    const sha = stack.pop()!;
    if (reachable.has(sha)) continue;
    const commit = findCommitBySha(gh, repoId, sha);
    if (!commit) continue;
    reachable.set(sha, commit);
    for (const p of commit.parent_shas) stack.push(p);
  }

  const childCounts = new Map([...reachable.keys()].map((sha) => [sha, 0]));
  for (const commit of reachable.values()) {
    for (const parentSha of commit.parent_shas) {
      if (reachable.has(parentSha)) childCounts.set(parentSha, childCounts.get(parentSha)! + 1);
    }
  }

  const eligible = [...reachable.values()].filter((commit) => childCounts.get(commit.sha) === 0);
  const out: GitHubCommit[] = [];
  while (eligible.length) {
    eligible.sort((a, b) =>
      a.committer_date === b.committer_date ? b.id - a.id : a.committer_date < b.committer_date ? 1 : -1,
    );
    const commit = eligible.shift()!;
    out.push(commit);
    for (const parentSha of commit.parent_shas) {
      if (!reachable.has(parentSha)) continue;
      const remainingChildren = childCounts.get(parentSha)! - 1;
      childCounts.set(parentSha, remainingChildren);
      if (remainingChildren === 0) eligible.push(reachable.get(parentSha)!);
    }
  }
  return out;
}

export function blobText(gh: GitHubStore, repoId: number, sha: string): string | null {
  const blob = gh.blobs.findBy("repo_id", repoId).find((b) => b.sha === sha);
  if (!blob) return null;
  if (blob.encoding !== "base64") return blob.content.includes("\0") ? null : blob.content;
  const bytes = Buffer.from(blob.content, "base64");
  const text = bytes.toString("utf8");
  if (text.includes("\0") || !Buffer.from(text, "utf8").equals(bytes)) return null;
  return text;
}

export function encodeContentPath(path: string): string {
  return path
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function commitEmailMatchesUser(email: string, user: GitHubUser): boolean {
  const normalized = email.toLowerCase();
  const login = user.login.toLowerCase();
  if (user.email?.toLowerCase() === normalized) return true;
  if (normalized === `${login}@localhost`) return true;
  if (normalized === `${login}@users.noreply.github.com`) return true;
  return normalized.endsWith(`+${login}@users.noreply.github.com`);
}

export function resolveCommitUser(gh: GitHubStore, email: string): GitHubUser | undefined {
  return gh.users.all().find((user) => commitEmailMatchesUser(email, user));
}

export function commitIdentityMatches(gh: GitHubStore, email: string, query: string): boolean {
  if (email.toLowerCase() === query.toLowerCase()) return true;
  return resolveCommitUser(gh, email)?.login.toLowerCase() === query.toLowerCase();
}

type Op = { type: "eq" | "del" | "ins"; text: string };

function lcsOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const dp: Uint32Array[] = [];
  for (let i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: "eq", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: "del", text: a[i] });
      i++;
    } else {
      ops.push({ type: "ins", text: b[j] });
      j++;
    }
  }
  while (i < n) ops.push({ type: "del", text: a[i++] });
  while (j < m) ops.push({ type: "ins", text: b[j++] });
  return ops;
}

function myersBisectOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const maxD = Math.ceil((n + m) / 2);
  const offset = maxD;
  const vectorLength = maxD * 2;
  const forward = new Int32Array(vectorLength);
  const reverse = new Int32Array(vectorLength);
  forward.fill(-1);
  reverse.fill(-1);
  forward[offset + 1] = 0;
  reverse[offset + 1] = 0;

  const delta = n - m;
  const frontOverlaps = delta % 2 !== 0;
  let forwardStart = 0;
  let forwardEnd = 0;
  let reverseStart = 0;
  let reverseEnd = 0;

  const split = (x: number, y: number): Op[] => {
    if ((x === 0 && y === 0) || (x === n && y === m)) {
      return [...a.map((text): Op => ({ type: "del", text })), ...b.map((text): Op => ({ type: "ins", text }))];
    }
    return [...diffOps(a.slice(0, x), b.slice(0, y)), ...diffOps(a.slice(x), b.slice(y))];
  };

  for (let d = 0; d < maxD; d++) {
    for (let k = -d + forwardStart; k <= d - forwardEnd; k += 2) {
      const index = offset + k;
      let x: number;
      if (k === -d || (k !== d && forward[index - 1] < forward[index + 1])) {
        x = forward[index + 1];
      } else {
        x = forward[index - 1] + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      forward[index] = x;

      if (x > n) {
        forwardEnd += 2;
      } else if (y > m) {
        forwardStart += 2;
      } else if (frontOverlaps) {
        const reverseIndex = offset + delta - k;
        if (reverseIndex >= 0 && reverseIndex < vectorLength && reverse[reverseIndex] !== -1) {
          const reverseX = n - reverse[reverseIndex];
          if (x >= reverseX) return split(x, y);
        }
      }
    }

    for (let k = -d + reverseStart; k <= d - reverseEnd; k += 2) {
      const index = offset + k;
      let x: number;
      if (k === -d || (k !== d && reverse[index - 1] < reverse[index + 1])) {
        x = reverse[index + 1];
      } else {
        x = reverse[index - 1] + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[n - x - 1] === b[m - y - 1]) {
        x++;
        y++;
      }
      reverse[index] = x;

      if (x > n) {
        reverseEnd += 2;
      } else if (y > m) {
        reverseStart += 2;
      } else if (!frontOverlaps) {
        const forwardIndex = offset + delta - k;
        if (forwardIndex >= 0 && forwardIndex < vectorLength && forward[forwardIndex] !== -1) {
          const forwardX = forward[forwardIndex];
          const forwardY = offset + forwardX - forwardIndex;
          const reverseX = n - x;
          if (forwardX >= reverseX) return split(forwardX, forwardY);
        }
      }
    }
  }

  return [...a.map((text): Op => ({ type: "del", text })), ...b.map((text): Op => ({ type: "ins", text }))];
}

function diffOps(a: string[], b: string[]): Op[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  let mid: Op[];
  if (!midA.length) {
    mid = midB.map((text): Op => ({ type: "ins", text }));
  } else if (!midB.length) {
    mid = midA.map((text): Op => ({ type: "del", text }));
  } else {
    mid = midA.length * midB.length > 250_000 ? myersBisectOps(midA, midB) : lcsOps(midA, midB);
  }
  return [
    ...a.slice(0, start).map((text): Op => ({ type: "eq", text })),
    ...mid,
    ...a.slice(endA).map((text): Op => ({ type: "eq", text })),
  ];
}

const PATCH_CONTEXT = 3;
const PATCH_MAX_LINES = 10_000;

function opsToPatch(ops: Array<Op & { oldLine: number; newLine: number }>): string | undefined {
  const changeIdx = ops.map((o, i) => (o.type === "eq" ? -1 : i)).filter((i) => i >= 0);
  if (!changeIdx.length) return undefined;

  const groups: Array<[number, number]> = [];
  let gs = changeIdx[0];
  let ge = changeIdx[0];
  for (const idx of changeIdx.slice(1)) {
    if (idx - ge - 1 <= PATCH_CONTEXT * 2) {
      ge = idx;
    } else {
      groups.push([gs, ge]);
      gs = idx;
      ge = idx;
    }
  }
  groups.push([gs, ge]);

  const chunks: string[] = [];
  for (const [s, e] of groups) {
    const lo = Math.max(0, s - PATCH_CONTEXT);
    const hi = Math.min(ops.length - 1, e + PATCH_CONTEXT);
    const slice = ops.slice(lo, hi + 1);
    const oldCount = slice.filter((o) => o.type !== "ins").length;
    const newCount = slice.filter((o) => o.type !== "del").length;
    const oldStart = oldCount === 0 ? slice[0].oldLine - 1 : slice[0].oldLine;
    const newStart = newCount === 0 ? slice[0].newLine - 1 : slice[0].newLine;
    chunks.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const o of slice) {
      const terminated = o.text.endsWith("\n");
      const text = terminated ? o.text.slice(0, -1) : o.text;
      chunks.push(`${o.type === "eq" ? " " : o.type === "del" ? "-" : "+"}${text}`);
      if (!terminated) chunks.push("\\ No newline at end of file");
    }
  }
  return chunks.join("\n");
}

export interface TextDiff {
  additions: number;
  deletions: number;
  patch?: string;
}

export function diffText(oldText: string | null, newText: string | null): TextDiff {
  const splitLines = (t: string | null) => {
    if (t === null || t === "") return [];
    const terminated = t.endsWith("\n");
    const lines = t.split("\n");
    if (terminated) lines.pop();
    return lines.map((line, index) => (terminated || index < lines.length - 1 ? `${line}\n` : line));
  };
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const ops = diffOps(a, b);

  let additions = 0;
  let deletions = 0;
  let oldLine = 1;
  let newLine = 1;
  const annotated = ops.map((o) => {
    const entry = { ...o, oldLine, newLine };
    if (o.type === "eq") {
      oldLine++;
      newLine++;
    } else if (o.type === "del") {
      deletions++;
      oldLine++;
    } else {
      additions++;
      newLine++;
    }
    return entry;
  });

  const patch = a.length + b.length > PATCH_MAX_LINES ? undefined : opsToPatch(annotated);
  return { additions, deletions, patch };
}

export interface FileDiff {
  sha: string;
  filename: string;
  status: "added" | "removed" | "modified" | "renamed";
  previous_filename?: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
}

/** Diff two trees by flattened blob paths. Pass null for baseTreeSha to diff from an empty tree. */
export function diffTrees(
  gh: GitHubStore,
  repoId: number,
  baseTreeSha: string | null,
  headTreeSha: string,
): FileDiff[] {
  const base = baseTreeSha ? flattenTree(gh, repoId, baseTreeSha) : { blobs: new Map(), dirs: new Map() };
  const head = flattenTree(gh, repoId, headTreeSha);

  const paths = [...new Set([...base.blobs.keys(), ...head.blobs.keys()])].sort();
  const out: FileDiff[] = [];
  const pairedPaths = new Set<string>();
  const addedBySha = new Map<string, string[]>();
  for (const path of paths) {
    if (base.blobs.has(path)) continue;
    const entry = head.blobs.get(path);
    if (!entry) continue;
    const candidates = addedBySha.get(entry.sha) ?? [];
    candidates.push(path);
    addedBySha.set(entry.sha, candidates);
  }
  for (const previousPath of paths) {
    const before = base.blobs.get(previousPath);
    if (!before || head.blobs.has(previousPath)) continue;
    const candidates = addedBySha.get(before.sha)?.filter((path) => !pairedPaths.has(path)) ?? [];
    const filename = candidates.find((path) => head.blobs.get(path)?.mode === before.mode) ?? candidates[0];
    if (!filename) continue;
    pairedPaths.add(previousPath);
    pairedPaths.add(filename);
    out.push({
      sha: before.sha,
      filename,
      previous_filename: previousPath,
      status: "renamed",
      additions: 0,
      deletions: 0,
      changes: 0,
    });
  }

  for (const path of paths) {
    if (pairedPaths.has(path)) continue;
    const before = base.blobs.get(path);
    const after = head.blobs.get(path);
    if (before && after && before.sha === after.sha && before.mode === after.mode) continue;

    const status: FileDiff["status"] = !before ? "added" : !after ? "removed" : "modified";
    const oldText = before ? blobText(gh, repoId, before.sha) : "";
    const newText = after ? blobText(gh, repoId, after.sha) : "";
    const binary = oldText === null || newText === null;
    const diff = binary ? { additions: 0, deletions: 0, patch: undefined } : diffText(oldText, newText);

    out.push({
      sha: (after ?? before)!.sha,
      filename: path,
      status,
      additions: diff.additions,
      deletions: diff.deletions,
      changes: diff.additions + diff.deletions,
      patch: diff.patch,
    });
  }
  return out.sort((left, right) => left.filename.localeCompare(right.filename));
}

export function formatFileDiff(
  diff: FileDiff,
  repo: GitHubRepo,
  baseSha: string | null,
  headSha: string,
  baseUrl: string,
) {
  const repoUrl = `${baseUrl}/repos/${repo.full_name}`;
  const encodedPath = encodeContentPath(diff.filename);
  const contentSha = diff.status === "removed" && baseSha ? baseSha : headSha;
  return {
    sha: diff.sha,
    filename: diff.filename,
    status: diff.status,
    additions: diff.additions,
    deletions: diff.deletions,
    changes: diff.changes,
    blob_url: `${baseUrl}/${repo.full_name}/blob/${contentSha}/${encodedPath}`,
    raw_url: `${baseUrl}/${repo.full_name}/raw/${contentSha}/${encodedPath}`,
    contents_url: `${repoUrl}/contents/${encodedPath}?ref=${contentSha}`,
    ...(diff.previous_filename !== undefined ? { previous_filename: diff.previous_filename } : {}),
    ...(diff.patch !== undefined ? { patch: diff.patch } : {}),
  };
}

/** REST commit object (the /repos/{owner}/{repo}/commits shape, without stats/files). */
export function formatCommitItem(gh: GitHubStore, repo: GitHubRepo, c: GitHubCommit, baseUrl: string) {
  const repoUrl = `${baseUrl}/repos/${repo.full_name}`;
  const authorUser = resolveCommitUser(gh, c.author_email);
  const committerUser = resolveCommitUser(gh, c.committer_email);
  const commentCount = gh.comments
    .findBy("repo_id", repo.id)
    .filter((comment) => comment.comment_type === "commit" && comment.commit_sha === c.sha).length;
  return {
    sha: c.sha,
    node_id: c.node_id,
    commit: {
      author: { name: c.author_name, email: c.author_email, date: c.author_date },
      committer: { name: c.committer_name, email: c.committer_email, date: c.committer_date },
      message: c.message,
      tree: { sha: c.tree_sha, url: `${repoUrl}/git/trees/${c.tree_sha}` },
      url: `${repoUrl}/git/commits/${c.sha}`,
      comment_count: commentCount,
      verification: { verified: false, reason: "unsigned", signature: null, payload: null, verified_at: null },
    },
    url: `${repoUrl}/commits/${c.sha}`,
    html_url: `${baseUrl}/${repo.full_name}/commit/${c.sha}`,
    comments_url: `${repoUrl}/commits/${c.sha}/comments`,
    author: authorUser ? formatUser(authorUser, baseUrl) : null,
    committer: committerUser ? formatUser(committerUser, baseUrl) : null,
    parents: c.parent_shas.map((sha) => ({
      sha,
      url: `${repoUrl}/commits/${sha}`,
      html_url: `${baseUrl}/${repo.full_name}/commit/${sha}`,
    })),
  };
}

/** Git-data commit object (the /git/commits shape) used in contents write responses. */
export function formatGitCommit(repo: GitHubRepo, c: GitHubCommit, baseUrl: string) {
  const repoUrl = `${baseUrl}/repos/${repo.full_name}`;
  return {
    sha: c.sha,
    node_id: c.node_id,
    url: `${repoUrl}/git/commits/${c.sha}`,
    html_url: `${baseUrl}/${repo.full_name}/commit/${c.sha}`,
    author: { name: c.author_name, email: c.author_email, date: c.author_date },
    committer: { name: c.committer_name, email: c.committer_email, date: c.committer_date },
    message: c.message,
    tree: { sha: c.tree_sha, url: `${repoUrl}/git/trees/${c.tree_sha}` },
    parents: c.parent_shas.map((sha) => ({
      sha,
      url: `${repoUrl}/git/commits/${sha}`,
      html_url: `${baseUrl}/${repo.full_name}/commit/${sha}`,
    })),
    verification: { verified: false, reason: "unsigned", signature: null, payload: null, verified_at: null },
  };
}
