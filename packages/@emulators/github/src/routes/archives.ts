import type { AppEnv, Context, RouteContext } from "@emulators/core";
import { getGitHubStore } from "../store.js";
import type { GitHubStore } from "../store.js";
import type { GitHubCommit, GitHubRepo } from "../entities.js";
import { lookupRepo } from "../helpers.js";
import { assertRepoContentsRead, notFoundResponse } from "../route-helpers.js";
import { blobBytes, flattenTree, resolveRefToCommit } from "../git-helpers.js";
import { createTarball, createZipball, type ArchiveEntry } from "../archive.js";

type ArchiveFormat = "tarball" | "zipball";

const EMPTY = Buffer.alloc(0);

/** Root directory of an archive, using GitHub's `<owner>-<repo>-<short sha>` convention. */
function archivePrefix(repo: GitHubRepo, commit: GitHubCommit): string {
  return `${repo.full_name.replace("/", "-")}-${commit.sha.slice(0, 7)}`;
}

function directoryEntry(path: string): ArchiveEntry {
  return { path: `${path}/`, kind: "dir", mode: 0o755, data: EMPTY };
}

function archiveEntries(gh: GitHubStore, repo: GitHubRepo, commit: GitHubCommit, prefix: string): ArchiveEntry[] {
  const flat = flattenTree(gh, repo.id, commit.tree_sha);
  const blobsBySha = new Map(gh.blobs.findBy("repo_id", repo.id).map((blob) => [blob.sha, blob]));
  const entries = new Map<string, ArchiveEntry>();
  const add = (entry: ArchiveEntry) => entries.set(entry.path, entry);

  add(directoryEntry(prefix));
  for (const dir of flat.dirs.keys()) add(directoryEntry(`${prefix}/${dir}`));
  for (const [path, entry] of flat.blobs) {
    const archivePath = `${prefix}/${path}`;
    if (entry.type === "commit" || entry.mode === "160000") {
      // Submodules become empty directories, as in git archive output.
      add(directoryEntry(archivePath));
      continue;
    }
    const blob = blobsBySha.get(entry.sha);
    if (!blob) continue;
    const data = blobBytes(blob);
    if (entry.mode === "120000") {
      add({ path: archivePath, kind: "symlink", mode: 0o777, data });
    } else {
      add({ path: archivePath, kind: "file", mode: entry.mode === "100755" ? 0o755 : 0o644, data });
    }
  }

  return [...entries.values()].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

export function archivesRoutes({ app, store }: RouteContext): void {
  const gh = getGitHubStore(store);

  const download = (c: Context<AppEnv>, format: ArchiveFormat) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoContentsRead(gh, c.get("authUser"), repo);

    const commit = resolveRefToCommit(gh, repo, c.req.param("ref") || undefined);
    if (!commit) throw notFoundResponse();

    const prefix = archivePrefix(repo, commit);
    const entries = archiveEntries(gh, repo, commit, prefix);
    const options = { mtime: new Date(commit.committer_date), comment: commit.sha };
    const bytes = format === "tarball" ? createTarball(entries, options) : createZipball(entries, options);
    const filename = format === "tarball" ? `${prefix}.tar.gz` : `${prefix}.zip`;

    // GitHub answers with a 302 to codeload.github.com. The emulator serves the
    // bytes directly so clients that do not follow redirects still get the archive.
    return c.body(bytes, 200, {
      "Content-Type": format === "tarball" ? "application/x-gzip" : "application/zip",
      "Content-Disposition": `attachment; filename=${filename}`,
      "Content-Length": String(bytes.byteLength),
    });
  };

  for (const format of ["tarball", "zipball"] as const) {
    app.get(`/repos/:owner/:repo/${format}`, (c) => download(c, format));
    app.get(`/repos/:owner/:repo/${format}/`, (c) => download(c, format));
    app.get(`/repos/:owner/:repo/${format}/:ref{.+}`, (c) => download(c, format));
  }
}
