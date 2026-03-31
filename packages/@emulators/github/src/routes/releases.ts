import type { RouteContext, WebhookDispatcher, AuthUser } from "@emulators/core";
import { ApiError, parseJsonBody, parsePagination, setLinkHeader } from "@emulators/core";
import { getGitHubStore } from "../store.js";
import type { GitHubStore } from "../store.js";
import type { GitHubRelease, GitHubReleaseAsset, GitHubRepo, GitHubUser } from "../entities.js";
import {
  formatRelease,
  formatReleaseAsset,
  formatRepo,
  formatUser,
  generateNodeId,
  lookupRepo,
  timestamp,
} from "../helpers.js";
import {
  assertRepoRead,
  assertRepoWrite,
  getActorUser,
  notFoundResponse,
  ownerLoginOf,
} from "../route-helpers.js";

/** Draft releases are omitted for anonymous API clients; any authenticated user may see them once repo read is allowed. */
function isAuthenticatedActor(gh: GitHubStore, authUser: AuthUser | undefined): boolean {
  return Boolean(authUser && getActorUser(gh, authUser));
}

function assertReleaseVisible(
  gh: GitHubStore,
  authUser: AuthUser | undefined,
  release: GitHubRelease
) {
  if (release.draft && !isAuthenticatedActor(gh, authUser)) {
    throw notFoundResponse();
  }
}

function releasesForRepo(gh: GitHubStore, repoId: number): GitHubRelease[] {
  return gh.releases.findBy("repo_id", repoId);
}

function findReleaseById(gh: GitHubStore, repoId: number, releaseId: number): GitHubRelease | undefined {
  const r = gh.releases.get(releaseId);
  if (!r || r.repo_id !== repoId) return undefined;
  return r;
}

function findReleaseByTag(gh: GitHubStore, repoId: number, tagName: string): GitHubRelease | undefined {
  return releasesForRepo(gh, repoId).find((rel) => rel.tag_name === tagName);
}

function tagTaken(gh: GitHubStore, repoId: number, tagName: string, exceptId?: number): boolean {
  return releasesForRepo(gh, repoId).some((r) => r.tag_name === tagName && r.id !== exceptId);
}

function sortReleasesByCreatedDesc(a: GitHubRelease, b: GitHubRelease): number {
  return b.created_at.localeCompare(a.created_at);
}

function deleteAssetsForRelease(gh: GitHubStore, releaseId: number) {
  for (const a of gh.releaseAssets.findBy("release_id", releaseId)) {
    gh.releaseAssets.delete(a.id);
  }
}

function dispatchReleaseWebhook(
  webhooks: WebhookDispatcher,
  gh: GitHubStore,
  repo: GitHubRepo,
  actor: GitHubUser,
  release: GitHubRelease,
  action: string,
  baseUrl: string
) {
  const relFmt = formatRelease(release, gh, baseUrl);
  if (!relFmt) return;
  const ownerLogin = ownerLoginOf(gh, repo);
  webhooks.dispatch(
    "release",
    action,
    {
      action,
      release: relFmt,
      repository: formatRepo(repo, gh, baseUrl),
      sender: formatUser(actor, baseUrl),
    },
    ownerLogin,
    repo.name
  );
}

export function releasesRoutes({ app, store, webhooks, baseUrl }: RouteContext): void {
  const gh = getGitHubStore(store);

  app.get("/repos/:owner/:repo/releases", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoRead(gh, c.get("authUser"), repo);

    const authUser = c.get("authUser");
    const showDrafts = isAuthenticatedActor(gh, authUser);

    let list = releasesForRepo(gh, repo.id);
    if (!showDrafts) {
      list = list.filter((r) => !r.draft);
    }
    list = [...list].sort(sortReleasesByCreatedDesc);

    const { page, per_page } = parsePagination(c);
    const total = list.length;
    setLinkHeader(c, total, page, per_page);
    const start = (page - 1) * per_page;
    const pageItems = list.slice(start, start + per_page);

    const out = pageItems
      .map((r) => formatRelease(r, gh, baseUrl))
      .filter(Boolean);
    return c.json(out);
  });

  app.post("/repos/:owner/:repo/releases/generate-notes", async (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoRead(gh, c.get("authUser"), repo);

    const body = await parseJsonBody(c);
    const tagName = typeof body.tag_name === "string" ? body.tag_name : "";
    const target =
      typeof body.target_commitish === "string" ? body.target_commitish : undefined;
    const prev =
      typeof body.previous_tag_name === "string" ? body.previous_tag_name : undefined;
    return c.json({
      name: tagName ? `Release ${tagName}` : "Release",
      body: `## What's changed\n\n_Auto-generated release notes (stub)._\n\n<!-- target: ${target ?? "default"} previous: ${prev ?? "none"} -->`,
    });
  });

  app.get("/repos/:owner/:repo/releases/latest", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoRead(gh, c.get("authUser"), repo);

    const candidates = releasesForRepo(gh, repo.id).filter(
      (r) => !r.draft && !r.prerelease && r.published_at
    );
    if (candidates.length === 0) throw notFoundResponse();

    candidates.sort((a, b) => {
      const pa = a.published_at ?? a.created_at;
      const pb = b.published_at ?? b.created_at;
      return pb.localeCompare(pa);
    });
    const latest = candidates[0]!;
    const fmt = formatRelease(latest, gh, baseUrl);
    if (!fmt) throw notFoundResponse();
    return c.json(fmt);
  });

  app.get("/repos/:owner/:repo/releases/tags/:tag", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoRead(gh, c.get("authUser"), repo);

    const tag = decodeURIComponent(c.req.param("tag")!);
    const release = findReleaseByTag(gh, repo.id, tag);
    if (!release) throw notFoundResponse();
    assertReleaseVisible(gh, c.get("authUser"), release);

    const fmt = formatRelease(release, gh, baseUrl);
    if (!fmt) throw notFoundResponse();
    return c.json(fmt);
  });

  app.get("/repos/:owner/:repo/releases/assets/:asset_id", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoRead(gh, c.get("authUser"), repo);

    const assetId = parseInt(c.req.param("asset_id")!, 10);
    if (!Number.isFinite(assetId)) throw notFoundResponse();

    const asset = gh.releaseAssets.get(assetId);
    if (!asset || asset.repo_id !== repo.id) throw notFoundResponse();

    const release = gh.releases.get(asset.release_id);
    if (release) {
      assertReleaseVisible(gh, c.get("authUser"), release);
    }

    return c.json(formatReleaseAsset(asset, repo, baseUrl));
  });

  app.patch("/repos/:owner/:repo/releases/assets/:asset_id", async (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoWrite(gh, c.get("authUser"), repo);

    const assetId = parseInt(c.req.param("asset_id")!, 10);
    if (!Number.isFinite(assetId)) throw notFoundResponse();

    const asset = gh.releaseAssets.get(assetId);
    if (!asset || asset.repo_id !== repo.id) throw notFoundResponse();

    const body = await parseJsonBody(c);
    const patch: Partial<GitHubReleaseAsset> = {};
    if (typeof body.name === "string") patch.name = body.name;
    if (typeof body.label === "string" || body.label === null) patch.label = body.label as string | null;

    const updated = gh.releaseAssets.update(asset.id, patch);
    if (!updated) throw notFoundResponse();

    return c.json(formatReleaseAsset(updated, repo, baseUrl));
  });

  app.delete("/repos/:owner/:repo/releases/assets/:asset_id", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoWrite(gh, c.get("authUser"), repo);

    const assetId = parseInt(c.req.param("asset_id")!, 10);
    if (!Number.isFinite(assetId)) throw notFoundResponse();

    const asset = gh.releaseAssets.get(assetId);
    if (!asset || asset.repo_id !== repo.id) throw notFoundResponse();

    gh.releaseAssets.delete(asset.id);
    return c.body(null, 204);
  });

  app.post("/repos/:owner/:repo/releases", async (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();

    const actor = assertRepoWrite(gh, c.get("authUser"), repo);

    const body = await parseJsonBody(c);
    if (typeof body.tag_name !== "string" || !body.tag_name.trim()) {
      throw new ApiError(422, "Validation failed");
    }
    const tag_name = body.tag_name.trim();
    if (tagTaken(gh, repo.id, tag_name)) {
      throw new ApiError(422, "Validation failed");
    }

    const target_commitish =
      typeof body.target_commitish === "string" && body.target_commitish.trim()
        ? body.target_commitish.trim()
        : repo.default_branch;

    const draft = typeof body.draft === "boolean" ? body.draft : false;
    const prerelease = typeof body.prerelease === "boolean" ? body.prerelease : false;

    let name: string | null =
      typeof body.name === "string" || body.name === null ? (body.name as string | null) : null;
    let releaseBody: string | null =
      typeof body.body === "string" || body.body === null ? (body.body as string | null) : null;

    if (body.generate_release_notes === true) {
      releaseBody =
        releaseBody ??
        `## What's changed\n\n_Auto-generated release notes (stub) for ${tag_name}._`;
      name = name ?? `Release ${tag_name}`;
    }

    const published_at = draft ? null : timestamp();

    const row = gh.releases.insert({
      node_id: "",
      repo_id: repo.id,
      tag_name,
      target_commitish,
      name,
      body: releaseBody,
      draft,
      prerelease,
      author_id: actor.id,
      published_at,
    } as Omit<GitHubRelease, "id" | "created_at" | "updated_at">);
    gh.releases.update(row.id, { node_id: generateNodeId("Release", row.id) });

    const release = gh.releases.get(row.id)!;

    if (draft) {
      dispatchReleaseWebhook(webhooks, gh, repo, actor, release, "created", baseUrl);
    } else {
      dispatchReleaseWebhook(webhooks, gh, repo, actor, release, "published", baseUrl);
    }

    const fmt = formatRelease(release, gh, baseUrl);
    if (!fmt) throw notFoundResponse();
    return c.json(fmt, 201);
  });

  app.get("/repos/:owner/:repo/releases/:release_id", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoRead(gh, c.get("authUser"), repo);

    const releaseId = parseInt(c.req.param("release_id")!, 10);
    if (!Number.isFinite(releaseId)) throw notFoundResponse();

    const release = findReleaseById(gh, repo.id, releaseId);
    if (!release) throw notFoundResponse();
    assertReleaseVisible(gh, c.get("authUser"), release);

    const fmt = formatRelease(release, gh, baseUrl);
    if (!fmt) throw notFoundResponse();
    return c.json(fmt);
  });

  app.patch("/repos/:owner/:repo/releases/:release_id", async (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();

    const actor = assertRepoWrite(gh, c.get("authUser"), repo);

    const releaseId = parseInt(c.req.param("release_id")!, 10);
    if (!Number.isFinite(releaseId)) throw notFoundResponse();

    const release = findReleaseById(gh, repo.id, releaseId);
    if (!release) throw notFoundResponse();

    const body = await parseJsonBody(c);
    const patch: Partial<GitHubRelease> = {};

    if (typeof body.tag_name === "string" && body.tag_name.trim()) {
      const nextTag = body.tag_name.trim();
      if (tagTaken(gh, repo.id, nextTag, release.id)) {
        throw new ApiError(422, "Validation failed");
      }
      patch.tag_name = nextTag;
    }
    if (typeof body.target_commitish === "string" && body.target_commitish.trim()) {
      patch.target_commitish = body.target_commitish.trim();
    }
    if (typeof body.name === "string" || body.name === null) patch.name = body.name as string | null;
    if (typeof body.body === "string" || body.body === null) patch.body = body.body as string | null;
    if (typeof body.draft === "boolean") patch.draft = body.draft;
    if (typeof body.prerelease === "boolean") patch.prerelease = body.prerelease;

    const wasDraft = release.draft;
    let publishedJustNow = false;
    if (wasDraft && typeof body.draft === "boolean" && body.draft === false) {
      patch.published_at = timestamp();
      publishedJustNow = true;
    }

    const updated = gh.releases.update(release.id, patch);
    if (!updated) throw notFoundResponse();

    if (publishedJustNow) {
      dispatchReleaseWebhook(webhooks, gh, repo, actor, updated, "published", baseUrl);
    }

    const fmt = formatRelease(updated, gh, baseUrl);
    if (!fmt) throw notFoundResponse();
    return c.json(fmt);
  });

  app.delete("/repos/:owner/:repo/releases/:release_id", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoWrite(gh, c.get("authUser"), repo);

    const releaseId = parseInt(c.req.param("release_id")!, 10);
    if (!Number.isFinite(releaseId)) throw notFoundResponse();

    const release = findReleaseById(gh, repo.id, releaseId);
    if (!release) throw notFoundResponse();

    deleteAssetsForRelease(gh, release.id);
    gh.releases.delete(release.id);
    return c.body(null, 204);
  });

  app.get("/repos/:owner/:repo/releases/:release_id/assets", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoRead(gh, c.get("authUser"), repo);

    const releaseId = parseInt(c.req.param("release_id")!, 10);
    if (!Number.isFinite(releaseId)) throw notFoundResponse();

    const release = findReleaseById(gh, repo.id, releaseId);
    if (!release) throw notFoundResponse();
    assertReleaseVisible(gh, c.get("authUser"), release);

    let assets = gh.releaseAssets.findBy("release_id", release.id);
    assets = [...assets].sort((a, b) => b.created_at.localeCompare(a.created_at));

    const { page, per_page } = parsePagination(c);
    const total = assets.length;
    setLinkHeader(c, total, page, per_page);
    const start = (page - 1) * per_page;
    const pageItems = assets.slice(start, start + per_page);

    return c.json(pageItems.map((a) => formatReleaseAsset(a, repo, baseUrl)));
  });

  app.post("/repos/:owner/:repo/releases/:release_id/assets", async (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();

    const actor = assertRepoWrite(gh, c.get("authUser"), repo);

    const releaseId = parseInt(c.req.param("release_id")!, 10);
    if (!Number.isFinite(releaseId)) throw notFoundResponse();

    const release = findReleaseById(gh, repo.id, releaseId);
    if (!release) throw notFoundResponse();

    const nameQ = c.req.query("name");
    if (!nameQ || !nameQ.trim()) {
      throw new ApiError(422, "Validation failed");
    }
    const assetName = nameQ.trim();
    const labelRaw = c.req.query("label");
    const label = labelRaw === undefined || labelRaw === "" ? null : labelRaw;

    const buf = await c.req.arrayBuffer();
    const size = buf.byteLength;

    const contentType =
      c.req.header("Content-Type")?.split(";")[0]?.trim() || "application/octet-stream";

    const row = gh.releaseAssets.insert({
      node_id: "",
      release_id: release.id,
      repo_id: repo.id,
      name: assetName,
      label,
      state: "uploaded",
      content_type: contentType,
      size,
      download_count: 0,
      uploader_id: actor.id,
    } as Omit<GitHubReleaseAsset, "id" | "created_at" | "updated_at">);
    gh.releaseAssets.update(row.id, { node_id: generateNodeId("ReleaseAsset", row.id) });

    const asset = gh.releaseAssets.get(row.id)!;
    return c.json(formatReleaseAsset(asset, repo, baseUrl), 201);
  });
}
