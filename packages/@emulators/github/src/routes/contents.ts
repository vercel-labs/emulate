import type { AppEnv, Context, RouteContext } from "@emulators/core";
import { ApiError, parseJsonBody } from "@emulators/core";
import { getGitHubStore } from "../store.js";
import type { GitHubStore } from "../store.js";
import type {
  GitHubBlob,
  GitHubBranch,
  GitHubCommit,
  GitHubRef,
  GitHubRepo,
  GitHubTree,
  GitHubUser,
} from "../entities.js";
import { formatRepo, formatUser, generateNodeId, generateSha, lookupRepo, timestamp } from "../helpers.js";
import { assertRepoRead, assertRepoWrite, notFoundResponse, ownerLoginOf } from "../route-helpers.js";
import { flattenTree, formatGitCommit, resolveRefToCommit, type FlatTree } from "../git-helpers.js";

function normalizePath(raw: string): string {
  return decodeURIComponent(raw).replace(/^\/+|\/+$/g, "");
}

function contentLinks(repo: GitHubRepo, baseUrl: string, path: string, ref: string, blobSha?: string) {
  const repoUrl = `${baseUrl}/repos/${repo.full_name}`;
  const self = `${repoUrl}/contents/${path}?ref=${encodeURIComponent(ref)}`;
  const html = `${baseUrl}/${repo.full_name}/blob/${ref}/${path}`;
  const git = blobSha ? `${repoUrl}/git/blobs/${blobSha}` : null;
  return { self, html, git };
}

function formatFileContent(
  gh: GitHubStore,
  repo: GitHubRepo,
  baseUrl: string,
  path: string,
  ref: string,
  entry: { mode: string; sha: string; size?: number },
  withContent: boolean,
) {
  const blob = gh.blobs.findBy("repo_id", repo.id).find((b) => b.sha === entry.sha);
  const size = blob?.size ?? entry.size ?? 0;
  const links = contentLinks(repo, baseUrl, path, ref, entry.sha);
  const base = {
    type: "file",
    size,
    name: path.split("/").pop()!,
    path,
    sha: entry.sha,
    url: links.self,
    git_url: links.git,
    html_url: links.html,
    download_url: `${baseUrl}/${repo.full_name}/raw/${ref}/${path}`,
    _links: { self: links.self, git: links.git, html: links.html },
  };
  if (!withContent) return base;
  const content = blob
    ? blob.encoding === "base64"
      ? blob.content
      : Buffer.from(blob.content, "utf8").toString("base64")
    : "";
  return { ...base, content, encoding: "base64" };
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
      files.push(formatFileContent(gh, repo, baseUrl, path, ref, entry, false));
    } else {
      dirNames.add(rest.slice(0, slash));
    }
  }

  const dirs = [...dirNames].map((name) => {
    const path = prefix + name;
    const links = contentLinks(repo, baseUrl, path, ref);
    return {
      type: "dir",
      size: 0,
      name,
      path,
      sha: flat.dirs.get(path) ?? "",
      url: links.self,
      git_url: null,
      html_url: `${baseUrl}/${repo.full_name}/tree/${ref}/${path}`,
      download_url: null,
      _links: { self: links.self, git: null, html: `${baseUrl}/${repo.full_name}/tree/${ref}/${path}` },
    };
  });

  return [...dirs, ...files].sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

function decodeBodyContent(content: string): { text: string | null; base64: string } {
  const buf = Buffer.from(content, "base64");
  const text = buf.toString("utf8");
  // Round-trips cleanly -> store as searchable utf-8 text; otherwise keep base64.
  if (!text.includes("\0") && Buffer.from(text, "utf8").equals(buf)) {
    return { text, base64: content };
  }
  return { text: null, base64: buf.toString("base64") };
}

interface CommitFilesParams {
  repo: GitHubRepo;
  branchName: string;
  message: string;
  actor: GitHubUser;
  author?: { name?: string; email?: string; date?: string };
  committer?: { name?: string; email?: string; date?: string };
  /** path -> new entry, or null to delete the path */
  changes: Map<string, { mode: string; sha: string; size: number } | null>;
  headCommit: GitHubCommit | null;
}

function commitFiles(gh: GitHubStore, params: CommitFilesParams): GitHubCommit {
  const { repo, branchName, headCommit, actor } = params;

  const entries = new Map<string, { mode: string; sha: string; size?: number }>();
  if (headCommit) {
    for (const [path, entry] of flattenTree(gh, repo.id, headCommit.tree_sha).blobs) {
      entries.set(path, entry);
    }
  }
  for (const [path, change] of params.changes) {
    if (change === null) entries.delete(path);
    else entries.set(path, change);
  }

  const tree = gh.trees.insert({
    repo_id: repo.id,
    sha: generateSha(),
    node_id: "",
    tree: [...entries.entries()].map(([path, e]) => ({
      path,
      mode: e.mode,
      type: "blob" as const,
      sha: e.sha,
      size: e.size,
    })),
    truncated: false,
  } as Omit<GitHubTree, "id" | "created_at" | "updated_at">);
  gh.trees.update(tree.id, { node_id: generateNodeId("Tree", tree.id) });

  const now = timestamp();
  const defaultName = actor.name ?? actor.login;
  const defaultEmail = actor.email ?? `${actor.login}@users.noreply.github.com`;
  const author = {
    name: params.author?.name ?? defaultName,
    email: params.author?.email ?? defaultEmail,
    date: params.author?.date ?? now,
  };
  const committer = {
    name: params.committer?.name ?? author.name,
    email: params.committer?.email ?? author.email,
    date: params.committer?.date ?? author.date,
  };

  const commit = gh.commits.insert({
    repo_id: repo.id,
    sha: generateSha(),
    node_id: "",
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
  } as Omit<GitHubCommit, "id" | "created_at" | "updated_at">);
  gh.commits.update(commit.id, { node_id: generateNodeId("Commit", commit.id) });
  const saved = gh.commits.get(commit.id)!;

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
    assertRepoRead(gh, c.get("authUser"), repo);

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
      return c.json(formatFileContent(gh, repo, baseUrl, path, ref, entry, true));
    }
    const prefix = `${path}/`;
    if (flat.dirs.has(path) || [...flat.blobs.keys()].some((p) => p.startsWith(prefix))) {
      return c.json(formatDirListing(gh, repo, baseUrl, path, ref, flat));
    }
    throw notFoundResponse();
  };

  app.get("/repos/:owner/:repo/readme", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoRead(gh, c.get("authUser"), repo);

    const refParam = c.req.query("ref");
    const commit = resolveRefToCommit(gh, repo, refParam);
    if (!commit) throw notFoundResponse();
    const ref = refParam && refParam !== "HEAD" ? refParam : repo.default_branch;

    const flat = flattenTree(gh, repo.id, commit.tree_sha);
    const readmePath = [...flat.blobs.keys()].filter((p) => !p.includes("/") && /^readme(\.|$)/i.test(p)).sort()[0];
    if (!readmePath) throw notFoundResponse();
    return c.json(formatFileContent(gh, repo, baseUrl, readmePath, ref, flat.blobs.get(readmePath)!, true));
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
    const user = assertRepoWrite(gh, c.get("authUser"), repo);
    if (!path) throw new ApiError(422, "path is required");

    const body = await parseJsonBody(c);
    if (typeof body.message !== "string" || !body.message) throw new ApiError(422, "message is required");
    if (typeof body.content !== "string") throw new ApiError(422, "content is required");

    const branchName = typeof body.branch === "string" && body.branch ? body.branch : repo.default_branch;
    const hasCommits = gh.commits.findBy("repo_id", repo.id).length > 0;
    const headCommit = resolveRefToCommit(gh, repo, branchName) ?? null;
    if (hasCommits && !headCommit) throw notFoundResponse();

    const existing = headCommit ? flattenTree(gh, repo.id, headCommit.tree_sha).blobs.get(path) : undefined;
    if (existing) {
      if (typeof body.sha !== "string") {
        throw new ApiError(422, `"sha" wasn't supplied. ${path} already exists.`);
      }
      if (body.sha !== existing.sha) {
        throw new ApiError(409, `${path} does not match ${body.sha}`);
      }
    }

    const decoded = decodeBodyContent(body.content);
    const size =
      decoded.text !== null ? Buffer.byteLength(decoded.text, "utf8") : Buffer.from(decoded.base64, "base64").length;
    const blob = gh.blobs.insert({
      repo_id: repo.id,
      sha: generateSha(),
      node_id: "",
      content: decoded.text ?? decoded.base64,
      encoding: decoded.text !== null ? "utf-8" : "base64",
      size,
    } as Omit<GitHubBlob, "id" | "created_at" | "updated_at">);
    gh.blobs.update(blob.id, { node_id: generateNodeId("Blob", blob.id) });

    const commit = commitFiles(gh, {
      repo,
      branchName,
      message: body.message,
      actor: user,
      author: body.author as CommitFilesParams["author"],
      committer: body.committer as CommitFilesParams["committer"],
      changes: new Map([[path, { mode: existing?.mode ?? "100644", sha: gh.blobs.get(blob.id)!.sha, size }]]),
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

    const entry = { mode: existing?.mode ?? "100644", sha: gh.blobs.get(blob.id)!.sha, size };
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
    const user = assertRepoWrite(gh, c.get("authUser"), repo);

    const body = await parseJsonBody(c);
    if (typeof body.message !== "string" || !body.message) throw new ApiError(422, "message is required");
    if (typeof body.sha !== "string") throw new ApiError(422, "sha is required");

    const branchName = typeof body.branch === "string" && body.branch ? body.branch : repo.default_branch;
    const headCommit = resolveRefToCommit(gh, repo, branchName);
    if (!headCommit) throw notFoundResponse();

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
      author: body.author as CommitFilesParams["author"],
      committer: body.committer as CommitFilesParams["committer"],
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
