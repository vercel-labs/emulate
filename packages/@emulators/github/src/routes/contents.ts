import type { AppEnv, Context, RouteContext } from "@emulators/core";
import { ApiError, parseJsonBody } from "@emulators/core";
import { getGitHubStore } from "../store.js";
import type { GitHubStore } from "../store.js";
import type { GitHubBranch, GitHubCommit, GitHubRef, GitHubRepo, GitHubTree, GitHubUser } from "../entities.js";
import { formatRepo, formatUser, generateNodeId, lookupRepo, timestamp } from "../helpers.js";
import {
  assertBranchUpdateAllowed,
  assertRepoContentsRead,
  assertRepoContentsWrite,
  assertRepoPermission,
  notFoundResponse,
  ownerLoginOf,
} from "../route-helpers.js";
import {
  blobBytes,
  encodeContentPath,
  findOrCreateBlob,
  findOrCreateCommit,
  findOrCreateTree,
  flattenTree,
  formatGitCommit,
  resolveBranchToCommit,
  resolveRefToCommit,
  type FlatTree,
} from "../git-helpers.js";

function normalizePath(raw: string): string {
  const path = raw.replace(/^\/+|\/+$/g, "");
  if (path.includes("\0") || path.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new ApiError(422, "path is invalid");
  }
  return path;
}

function isWorkflowPath(path: string): boolean {
  return path.startsWith(".github/workflows/");
}

type FileTreeEntry = { mode: string; type: "blob" | "commit"; sha: string; size?: number };

function contentLinks(repo: GitHubRepo, baseUrl: string, path: string, ref: string, blobSha?: string) {
  const repoUrl = `${baseUrl}/repos/${repo.full_name}`;
  const encodedPath = encodeContentPath(path);
  const encodedRef = encodeURIComponent(ref);
  const self = `${repoUrl}/contents/${encodedPath}?ref=${encodedRef}`;
  const html = `${baseUrl}/${repo.full_name}/blob/${encodedRef}/${encodedPath}`;
  const git = blobSha ? `${repoUrl}/git/blobs/${blobSha}` : null;
  return { self, html, git };
}

function findBlob(gh: GitHubStore, repoId: number, sha: string) {
  return gh.blobs.findBy("repo_id", repoId).find((blob) => blob.sha === sha);
}

function blobBase64(blob: ReturnType<typeof findBlob>): string {
  if (!blob) return "";
  return blob.encoding === "base64" ? blob.content : Buffer.from(blob.content, "utf8").toString("base64");
}

function resolveSymlinkPath(path: string, target: string): string | undefined {
  if (!target || target.startsWith("/") || target.includes("\0")) return undefined;
  const parts = path.split("/").slice(0, -1);
  for (const part of target.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return undefined;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join("/");
}

function resolveSymlinkEntry(
  gh: GitHubStore,
  repoId: number,
  path: string,
  entry: FileTreeEntry,
  flat: FlatTree,
): FileTreeEntry | undefined {
  if (entry.mode !== "120000" || entry.type !== "blob") return undefined;
  const link = findBlob(gh, repoId, entry.sha);
  if (!link) return undefined;
  const targetPath = resolveSymlinkPath(path, blobBytes(link).toString("utf8"));
  if (!targetPath) return undefined;
  const target = flat.blobs.get(targetPath);
  return target?.type === "blob" && (target.mode === "100644" || target.mode === "100755") ? target : undefined;
}

function submoduleUrls(gh: GitHubStore, repoId: number, flat: FlatTree): Map<string, string> {
  const result = new Map<string, string>();
  const entry = flat.blobs.get(".gitmodules");
  if (!entry || entry.type !== "blob") return result;
  const blob = findBlob(gh, repoId, entry.sha);
  if (!blob) return result;

  let current: { path?: string; url?: string } | undefined;
  const save = () => {
    if (current?.path && current.url) result.set(current.path, current.url);
  };
  for (const line of blobBytes(blob).toString("utf8").split(/\r?\n/)) {
    if (/^\s*\[submodule\s+"(?:[^"\\]|\\.)*"\]\s*(?:[#;].*)?$/.test(line)) {
      save();
      current = {};
      continue;
    }
    if (!current) continue;
    const property = line.match(/^\s*(path|url)\s*=\s*(.*?)\s*$/);
    if (!property) continue;
    current[property[1] as "path" | "url"] = property[2];
  }
  save();
  return result;
}

function githubSubmoduleFullName(repo: GitHubRepo, url: string | undefined): string | undefined {
  if (!url) return undefined;
  const hosted = url.match(
    /^(?:(?:https?|git):\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^/]+)\/([^/]+?)(?:\.git)?\/?$/i,
  );
  if (hosted) return `${hosted[1]}/${hosted[2]}`;
  const relative = url.match(/^\.\.\/([^/]+?)(?:\.git)?\/?$/);
  if (relative) return `${repo.full_name.split("/")[0]}/${relative[1]}`;
  return undefined;
}

function formatFileContent(
  gh: GitHubStore,
  repo: GitHubRepo,
  baseUrl: string,
  path: string,
  ref: string,
  entry: FileTreeEntry,
  withContent: boolean,
  flat?: FlatTree,
) {
  const name = path.split("/").pop()!;
  const encodedPath = encodeContentPath(path);
  const encodedRef = encodeURIComponent(ref);
  const self = contentLinks(repo, baseUrl, path, ref).self;

  if (entry.type === "commit" || entry.mode === "160000") {
    const submoduleUrl = flat ? submoduleUrls(gh, repo.id, flat).get(path) : undefined;
    const fullName = githubSubmoduleFullName(repo, submoduleUrl);
    const gitUrl = fullName ? `${baseUrl}/repos/${fullName}/git/trees/${entry.sha}` : null;
    const htmlUrl = fullName ? `${baseUrl}/${fullName}/tree/${entry.sha}` : null;
    return {
      type: withContent ? "submodule" : "file",
      submodule_git_url: submoduleUrl ?? null,
      size: 0,
      name,
      path,
      sha: entry.sha,
      url: self,
      git_url: gitUrl,
      html_url: htmlUrl,
      download_url: null,
      _links: { self, git: gitUrl, html: htmlUrl },
    };
  }

  const blob = findBlob(gh, repo.id, entry.sha);
  if (entry.mode === "120000") {
    const target = blob ? blobBytes(blob).toString("utf8") : "";
    const resolved = flat ? resolveSymlinkEntry(gh, repo.id, path, entry, flat) : undefined;
    if (!resolved) {
      const links = contentLinks(repo, baseUrl, path, ref, entry.sha);
      return {
        type: "symlink",
        target,
        size: blob?.size ?? entry.size ?? 0,
        name,
        path,
        sha: entry.sha,
        url: links.self,
        git_url: links.git,
        html_url: links.html,
        download_url: `${baseUrl}/${repo.full_name}/raw/${encodedRef}/${encodedPath}`,
        _links: { self: links.self, git: links.git, html: links.html },
      };
    }
    const targetBlob = findBlob(gh, repo.id, resolved.sha);
    const links = contentLinks(repo, baseUrl, path, ref, entry.sha);
    const base = {
      type: "file",
      size: targetBlob?.size ?? resolved.size ?? 0,
      name,
      path,
      sha: entry.sha,
      url: links.self,
      git_url: links.git,
      html_url: links.html,
      download_url: `${baseUrl}/${repo.full_name}/raw/${encodedRef}/${encodedPath}`,
      _links: { self: links.self, git: links.git, html: links.html },
    };
    return withContent ? { ...base, content: blobBase64(targetBlob), encoding: "base64" } : base;
  }

  const size = blob?.size ?? entry.size ?? 0;
  const links = contentLinks(repo, baseUrl, path, ref, entry.sha);
  const base = {
    type: "file",
    size,
    name,
    path,
    sha: entry.sha,
    url: links.self,
    git_url: links.git,
    html_url: links.html,
    download_url: `${baseUrl}/${repo.full_name}/raw/${encodedRef}/${encodedPath}`,
    _links: { self: links.self, git: links.git, html: links.html },
  };
  if (!withContent) return base;
  return { ...base, content: blobBase64(blob), encoding: "base64" };
}

function formatDirListing(
  gh: GitHubStore,
  repo: GitHubRepo,
  baseUrl: string,
  dirPath: string,
  ref: string,
  flat: FlatTree,
) {
  const prefix = dirPath ? `${dirPath}/` : "";
  const files: Array<Record<string, unknown>> = [];
  const dirNames = new Set<string>();

  for (const [path, entry] of flat.blobs) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    if (!rest) continue;
    const slash = rest.indexOf("/");
    if (slash === -1) {
      files.push(formatFileContent(gh, repo, baseUrl, path, ref, entry, false, flat));
    } else {
      dirNames.add(rest.slice(0, slash));
    }
  }

  const dirs = [...dirNames].map((name) => {
    const path = prefix + name;
    const links = contentLinks(repo, baseUrl, path, ref);
    const treeSha = flat.dirs.get(path) || null;
    const gitUrl = treeSha ? `${baseUrl}/repos/${repo.full_name}/git/trees/${treeSha}` : null;
    const encodedPath = encodeContentPath(path);
    const encodedRef = encodeURIComponent(ref);
    const htmlUrl = `${baseUrl}/${repo.full_name}/tree/${encodedRef}/${encodedPath}`;
    return {
      type: "dir",
      size: 0,
      name,
      path,
      sha: treeSha ?? "",
      url: links.self,
      git_url: gitUrl,
      html_url: htmlUrl,
      download_url: null,
      _links: { self: links.self, git: gitUrl, html: htmlUrl },
    };
  });

  return [...dirs, ...files].sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

function decodeBodyContent(content: string): { text: string | null; base64: string } {
  const normalized = content.replace(/\s/g, "");
  if (
    normalized.length % 4 === 1 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) ||
    normalized.slice(0, -2).includes("=")
  ) {
    throw new ApiError(422, "content is not valid Base64");
  }
  const buf = Buffer.from(normalized, "base64");
  if (buf.toString("base64").replace(/=+$/, "") !== normalized.replace(/=+$/, "")) {
    throw new ApiError(422, "content is not valid Base64");
  }
  const text = buf.toString("utf8");
  if (!text.includes("\0") && Buffer.from(text, "utf8").equals(buf)) {
    return { text, base64: normalized };
  }
  return { text: null, base64: buf.toString("base64") };
}

interface CommitIdentity {
  name: string;
  email: string;
  date?: string;
}

function parseCommitIdentity(value: unknown, field: "author" | "committer"): CommitIdentity | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(422, `${field} must be an object`);
  }
  const input = value as Record<string, unknown>;
  if (typeof input.name !== "string" || !input.name) {
    throw new ApiError(422, `${field}.name is required`);
  }
  if (typeof input.email !== "string" || !input.email) {
    throw new ApiError(422, `${field}.email is required`);
  }
  if (input.date !== undefined && (typeof input.date !== "string" || !Number.isFinite(Date.parse(input.date)))) {
    throw new ApiError(422, `${field}.date must be an ISO 8601 timestamp`);
  }
  return {
    name: input.name,
    email: input.email,
    ...(typeof input.date === "string" ? { date: input.date } : {}),
  };
}

interface PendingTree {
  files: Map<string, FileTreeEntry>;
  dirs: Map<string, PendingTree>;
}

function persistTree(gh: GitHubStore, repoId: number, entries: Map<string, FileTreeEntry>): GitHubTree {
  const root: PendingTree = { files: new Map(), dirs: new Map() };

  for (const [path, entry] of entries) {
    const parts = path.split("/");
    let current = root;
    for (const part of parts.slice(0, -1)) {
      if (current.files.has(part)) throw new ApiError(422, `${path} conflicts with an existing file`);
      let child = current.dirs.get(part);
      if (!child) {
        child = { files: new Map(), dirs: new Map() };
        current.dirs.set(part, child);
      }
      current = child;
    }
    const name = parts.at(-1)!;
    if (current.dirs.has(name)) throw new ApiError(422, `${path} conflicts with an existing directory`);
    current.files.set(name, entry);
  }

  const write = (pending: PendingTree): GitHubTree => {
    const treeEntries: GitHubTree["tree"] = [];
    for (const [name, child] of [...pending.dirs].sort(([a], [b]) => a.localeCompare(b))) {
      const subtree = write(child);
      treeEntries.push({ path: name, mode: "040000", type: "tree", sha: subtree.sha });
    }
    for (const [name, entry] of [...pending.files].sort(([a], [b]) => a.localeCompare(b))) {
      treeEntries.push({ path: name, mode: entry.mode, type: entry.type, sha: entry.sha, size: entry.size });
    }

    return findOrCreateTree(gh, repoId, treeEntries);
  };

  return write(root);
}

interface CommitFilesParams {
  repo: GitHubRepo;
  branchName: string;
  message: string;
  actor: GitHubUser;
  author?: CommitIdentity;
  committer?: CommitIdentity;
  /** path -> new entry, or null to delete the path */
  changes: Map<string, FileTreeEntry | null>;
  headCommit: GitHubCommit | null;
}

function commitFiles(gh: GitHubStore, params: CommitFilesParams): GitHubCommit {
  const { repo, branchName, headCommit, actor } = params;

  const entries = new Map<string, FileTreeEntry>();
  if (headCommit) {
    for (const [path, entry] of flattenTree(gh, repo.id, headCommit.tree_sha).blobs) {
      entries.set(path, entry);
    }
  }
  for (const [path, change] of params.changes) {
    if (change === null) entries.delete(path);
    else entries.set(path, change);
  }

  const tree = persistTree(gh, repo.id, entries);

  const now = timestamp();
  const defaultName = actor.name ?? actor.login;
  const defaultEmail = actor.email ?? `${actor.login}@users.noreply.github.com`;
  const committer = {
    name: params.committer?.name ?? defaultName,
    email: params.committer?.email ?? defaultEmail,
    date: params.committer?.date ?? now,
  };
  const author = {
    name: params.author?.name ?? params.committer?.name ?? defaultName,
    email: params.author?.email ?? params.committer?.email ?? defaultEmail,
    date: params.author?.date ?? params.committer?.date ?? now,
  };

  const saved = findOrCreateCommit(gh, repo.id, {
    message: params.message,
    author_name: author.name,
    author_email: author.email,
    author_date: author.date,
    committer_name: committer.name,
    committer_email: committer.email,
    committer_date: committer.date,
    tree_sha: tree.sha,
    parent_shas: headCommit ? [headCommit.sha] : [],
    user_id: actor.id,
  });

  const fullRef = `refs/heads/${branchName}`;
  const refRec = gh.refs.findBy("repo_id", repo.id).find((r) => r.ref === fullRef);
  if (refRec) {
    gh.refs.update(refRec.id, { sha: saved.sha });
  } else {
    const inserted = gh.refs.insert({
      repo_id: repo.id,
      ref: fullRef,
      sha: saved.sha,
      node_id: "",
    } as Omit<GitHubRef, "id" | "created_at" | "updated_at">);
    gh.refs.update(inserted.id, { node_id: generateNodeId("Ref", inserted.id) });
  }

  const branch = gh.branches.findBy("repo_id", repo.id).find((b) => b.name === branchName);
  if (branch) {
    gh.branches.update(branch.id, { sha: saved.sha });
  } else {
    gh.branches.insert({
      repo_id: repo.id,
      name: branchName,
      sha: saved.sha,
      protected: false,
    } as Omit<GitHubBranch, "id" | "created_at" | "updated_at">);
  }

  gh.repos.update(repo.id, { pushed_at: now });
  return saved;
}

export function contentsRoutes({ app, store, webhooks, baseUrl }: RouteContext): void {
  const gh = getGitHubStore(store);

  const getContents = (c: Context<AppEnv>, path: string) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoContentsRead(gh, c.get("authUser"), repo);

    const refParam = c.req.query("ref");
    const commit = resolveRefToCommit(gh, repo, refParam);
    if (!commit) throw notFoundResponse();
    const ref = refParam && refParam !== "HEAD" ? refParam : repo.default_branch;

    const flat = flattenTree(gh, repo.id, commit.tree_sha);
    if (path === "") {
      return c.json(formatDirListing(gh, repo, baseUrl, "", ref, flat));
    }
    const entry = flat.blobs.get(path);
    if (entry) {
      return c.json(formatFileContent(gh, repo, baseUrl, path, ref, entry, true, flat));
    }
    const prefix = `${path}/`;
    if (flat.dirs.has(path) || [...flat.blobs.keys()].some((p) => p.startsWith(prefix))) {
      return c.json(formatDirListing(gh, repo, baseUrl, path, ref, flat));
    }
    throw notFoundResponse();
  };

  app.get("/:owner/:repo/raw/:ref/:path{.+}", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const ref = c.req.param("ref")!;
    const path = normalizePath(c.req.param("path")!);
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoContentsRead(gh, c.get("authUser"), repo);

    const commit = resolveRefToCommit(gh, repo, ref);
    if (!commit) throw notFoundResponse();
    const flat = flattenTree(gh, repo.id, commit.tree_sha);
    const entry = flat.blobs.get(path);
    if (!entry) throw notFoundResponse();
    const resolved = resolveSymlinkEntry(gh, repo.id, path, entry, flat);
    const blob = findBlob(gh, repo.id, resolved?.sha ?? entry.sha);
    if (!blob) throw notFoundResponse();
    const content = blobBytes(blob);
    return c.body(content, 200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(content.byteLength),
    });
  });

  app.get("/repos/:owner/:repo/readme", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoContentsRead(gh, c.get("authUser"), repo);

    const refParam = c.req.query("ref");
    const commit = resolveRefToCommit(gh, repo, refParam);
    if (!commit) throw notFoundResponse();
    const ref = refParam && refParam !== "HEAD" ? refParam : repo.default_branch;

    const flat = flattenTree(gh, repo.id, commit.tree_sha);
    const findReadme = (dir: "" | ".github" | "docs") =>
      [...flat.blobs.keys()]
        .filter((path) => {
          const slash = path.lastIndexOf("/");
          const parent = slash === -1 ? "" : path.slice(0, slash);
          const name = slash === -1 ? path : path.slice(slash + 1);
          return parent === dir && /^readme(\.|$)/i.test(name);
        })
        .sort()[0];
    const readmePath = findReadme(".github") ?? findReadme("") ?? findReadme("docs");
    if (!readmePath) throw notFoundResponse();
    return c.json(formatFileContent(gh, repo, baseUrl, readmePath, ref, flat.blobs.get(readmePath)!, true, flat));
  });

  app.get("/repos/:owner/:repo/contents", (c) => getContents(c, ""));
  app.get("/repos/:owner/:repo/contents/", (c) => getContents(c, ""));
  app.get("/repos/:owner/:repo/contents/:path{.+}", (c) => getContents(c, normalizePath(c.req.param("path")!)));

  app.put("/repos/:owner/:repo/contents/:path{.+}", async (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const path = normalizePath(c.req.param("path")!);
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    const authUser = c.get("authUser");
    const user = assertRepoContentsWrite(gh, authUser, repo);
    if (!path) throw new ApiError(422, "path is required");
    if (isWorkflowPath(path)) assertRepoPermission(gh, authUser, repo, "workflows", "write");

    const body = await parseJsonBody(c);
    if (typeof body.message !== "string" || !body.message) throw new ApiError(422, "message is required");
    if (typeof body.content !== "string") throw new ApiError(422, "content is required");
    if (body.branch !== undefined && (typeof body.branch !== "string" || !body.branch)) {
      throw new ApiError(422, "branch must be a non-empty string");
    }
    if (body.sha !== undefined && typeof body.sha !== "string") throw new ApiError(422, "sha must be a string");
    const author = parseCommitIdentity(body.author, "author");
    const committer = parseCommitIdentity(body.committer, "committer");

    const branchName = typeof body.branch === "string" && body.branch ? body.branch : repo.default_branch;
    const hasBranches =
      gh.refs.findBy("repo_id", repo.id).some((ref) => ref.ref.startsWith("refs/heads/")) ||
      gh.branches.findBy("repo_id", repo.id).length > 0;
    const headCommit = resolveBranchToCommit(gh, repo, branchName) ?? null;
    if (hasBranches && !headCommit) throw notFoundResponse();
    assertBranchUpdateAllowed(gh, user, repo, branchName, { parentCount: headCommit ? 1 : 0 });

    const flat = headCommit ? flattenTree(gh, repo.id, headCommit.tree_sha) : undefined;
    const existing = flat?.blobs.get(path);
    if (existing) {
      if (typeof body.sha !== "string") {
        throw new ApiError(422, `"sha" wasn't supplied. ${path} already exists.`);
      }
      if (body.sha !== existing.sha) {
        throw new ApiError(409, `${path} does not match ${body.sha}`);
      }
    } else {
      if (body.sha !== undefined) throw new ApiError(422, `${path} does not exist`);
      const parts = path.split("/");
      for (let i = 1; i < parts.length; i++) {
        const parent = parts.slice(0, i).join("/");
        if (flat?.blobs.has(parent)) throw new ApiError(422, `${path} conflicts with an existing file`);
      }
      if (
        flat?.dirs.has(path) ||
        [...(flat?.blobs.keys() ?? [])].some((candidate) => candidate.startsWith(`${path}/`))
      ) {
        throw new ApiError(422, `${path} conflicts with an existing directory`);
      }
    }

    const decoded = decodeBodyContent(body.content);
    const bytes = decoded.text !== null ? Buffer.from(decoded.text, "utf8") : Buffer.from(decoded.base64, "base64");
    const blob = findOrCreateBlob(gh, repo.id, bytes);
    const size = blob.size;

    const commit = commitFiles(gh, {
      repo,
      branchName,
      message: body.message,
      actor: user,
      author,
      committer,
      changes: new Map([
        [
          path,
          {
            mode: existing?.type === "blob" ? existing.mode : "100644",
            type: "blob" as const,
            sha: blob.sha,
            size,
          },
        ],
      ]),
      headCommit,
    });

    webhooks.dispatch(
      "push",
      undefined,
      {
        ref: `refs/heads/${branchName}`,
        before: headCommit?.sha ?? "0".repeat(40),
        after: commit.sha,
        repository: formatRepo(gh.repos.get(repo.id)!, gh, baseUrl),
        sender: formatUser(user, baseUrl),
        commits: [
          {
            id: commit.sha,
            message: commit.message,
            timestamp: commit.committer_date,
            author: { name: commit.author_name, email: commit.author_email },
            added: existing ? [] : [path],
            removed: [],
            modified: existing ? [path] : [],
          },
        ],
      },
      ownerLoginOf(gh, repo),
      repo.name,
    );

    const entry: FileTreeEntry = {
      mode: existing?.type === "blob" ? existing.mode : "100644",
      type: "blob",
      sha: blob.sha,
      size,
    };
    return c.json(
      {
        content: formatFileContent(gh, repo, baseUrl, path, branchName, entry, false),
        commit: formatGitCommit(repo, commit, baseUrl),
      },
      existing ? 200 : 201,
    );
  });

  app.delete("/repos/:owner/:repo/contents/:path{.+}", async (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const path = normalizePath(c.req.param("path")!);
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    const authUser = c.get("authUser");
    const user = assertRepoContentsWrite(gh, authUser, repo);
    if (!path) throw new ApiError(422, "path is required");
    if (isWorkflowPath(path)) assertRepoPermission(gh, authUser, repo, "workflows", "write");

    const body = await parseJsonBody(c);
    if (typeof body.message !== "string" || !body.message) throw new ApiError(422, "message is required");
    if (typeof body.sha !== "string") throw new ApiError(422, "sha is required");
    if (body.branch !== undefined && (typeof body.branch !== "string" || !body.branch)) {
      throw new ApiError(422, "branch must be a non-empty string");
    }
    const author = parseCommitIdentity(body.author, "author");
    const committer = parseCommitIdentity(body.committer, "committer");

    const branchName = typeof body.branch === "string" && body.branch ? body.branch : repo.default_branch;
    const headCommit = resolveBranchToCommit(gh, repo, branchName);
    if (!headCommit) throw notFoundResponse();
    assertBranchUpdateAllowed(gh, user, repo, branchName, { parentCount: 1 });

    const existing = flattenTree(gh, repo.id, headCommit.tree_sha).blobs.get(path);
    if (!existing) throw notFoundResponse();
    if (body.sha !== existing.sha) {
      throw new ApiError(409, `${path} does not match ${body.sha}`);
    }

    const commit = commitFiles(gh, {
      repo,
      branchName,
      message: body.message,
      actor: user,
      author,
      committer,
      changes: new Map([[path, null]]),
      headCommit,
    });

    webhooks.dispatch(
      "push",
      undefined,
      {
        ref: `refs/heads/${branchName}`,
        before: headCommit.sha,
        after: commit.sha,
        repository: formatRepo(gh.repos.get(repo.id)!, gh, baseUrl),
        sender: formatUser(user, baseUrl),
        commits: [
          {
            id: commit.sha,
            message: commit.message,
            timestamp: commit.committer_date,
            author: { name: commit.author_name, email: commit.author_email },
            added: [],
            removed: [path],
            modified: [],
          },
        ],
      },
      ownerLoginOf(gh, repo),
      repo.name,
    );

    return c.json({ content: null, commit: formatGitCommit(repo, commit, baseUrl) });
  });
}
