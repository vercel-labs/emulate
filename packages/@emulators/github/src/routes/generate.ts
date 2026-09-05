import type { AuthUser, RouteContext } from "@emulators/core";
import { ApiError, forbidden, parseJsonBody } from "@emulators/core";
import type { GitHubBranch, GitHubRef, GitHubRepo, GitHubUser } from "../entities.js";
import {
  blobBytes,
  findOrCreateBlob,
  findOrCreateCommit,
  findOrCreateTree,
  flattenTree,
  resolveBranchToCommit,
} from "../git-helpers.js";
import { formatRepo, formatUser, generateNodeId, lookupOwner, lookupRepo, timestamp } from "../helpers.js";
import { assertAuthenticatedActor, assertRepoRead, isOrgMember, notFoundResponse } from "../route-helpers.js";
import type { GitHubStore } from "../store.js";
import { getGitHubStore } from "../store.js";
import { createRepoRecord } from "./repos.js";

type RepoOwner = NonNullable<ReturnType<typeof lookupOwner>>;

/**
 * Whether the caller may create a repository owned by `target`.
 *
 * A GitHub App installation token acts for the account it is installed on and
 * needs the `administration: write` permission. A user token may create under
 * its own account or under an organization it is a member of.
 */
function mayCreateRepoFor(gh: GitHubStore, authUser: AuthUser, actor: GitHubUser, target: RepoOwner): boolean {
  const installation = authUser.installation;
  if (installation) {
    return (
      installation.accountType === target.type &&
      installation.accountId === target.id &&
      installation.permissions.administration === "write"
    );
  }
  if (target.type === "User") return target.id === actor.id;
  return isOrgMember(gh, actor.id, target.id);
}

/**
 * Copy one branch of `template` into `repo` as a single initial commit. GitHub
 * generates a fresh history rather than sharing the template's, so the copy has
 * no parents. Returns the byte size of the copied tree, or null when the
 * template branch has no commit to copy.
 */
function copyTemplateBranch(
  gh: GitHubStore,
  template: GitHubRepo,
  repo: GitHubRepo,
  branchName: string,
  actor: GitHubUser,
): number | null {
  const head = resolveBranchToCommit(gh, template, branchName);
  if (!head) return null;

  const flat = flattenTree(gh, template.id, head.tree_sha);
  const templateBlobs = gh.blobs.findBy("repo_id", template.id);
  const entries: Array<{ path: string; mode: string; type: "blob"; sha: string; size: number }> = [];
  let size = 0;
  for (const [path, entry] of flat.blobs) {
    if (entry.type !== "blob") continue;
    const source = templateBlobs.find((blob) => blob.sha === entry.sha);
    if (!source) continue;
    const bytes = blobBytes(source);
    const blob = findOrCreateBlob(gh, repo.id, bytes);
    entries.push({ path, mode: entry.mode, type: "blob", sha: blob.sha, size: bytes.byteLength });
    size += bytes.byteLength;
  }

  const tree = findOrCreateTree(gh, repo.id, entries);
  const now = timestamp();
  const authorName = actor.name ?? actor.login;
  const email = actor.email ?? `${actor.login}@users.noreply.github.com`;
  const commit = findOrCreateCommit(gh, repo.id, {
    message: "Initial commit",
    author_name: authorName,
    author_email: email,
    author_date: now,
    committer_name: authorName,
    committer_email: email,
    committer_date: now,
    tree_sha: tree.sha,
    parent_shas: [],
    user_id: actor.id,
  });

  gh.branches.insert({
    repo_id: repo.id,
    name: branchName,
    sha: commit.sha,
    protected: false,
  } as Omit<GitHubBranch, "id" | "created_at" | "updated_at">);
  const ref = gh.refs.insert({
    repo_id: repo.id,
    ref: `refs/heads/${branchName}`,
    sha: commit.sha,
    node_id: "",
  } as Omit<GitHubRef, "id" | "created_at" | "updated_at">);
  gh.refs.update(ref.id, { node_id: generateNodeId("Ref", ref.id) });

  return size;
}

export function generateRoutes(ctx: RouteContext): void {
  const { app, store, webhooks, baseUrl } = ctx;
  const gh = getGitHubStore(store);

  // POST /repos/:owner/:repo/generate creates a repository from a template.
  // The new repository starts with a single commit holding the template's
  // files, on the template's default branch, or on every branch with
  // include_all_branches.
  app.post("/repos/:owner/:repo/generate", async (c) => {
    const template = lookupRepo(gh, c.req.param("owner")!, c.req.param("repo")!);
    if (!template) throw notFoundResponse();
    const authUser = c.get("authUser");
    assertRepoRead(gh, authUser, template);
    if (!template.is_template) {
      throw new ApiError(422, "Repository is not a template", [
        { resource: "Repository", field: "is_template", code: "invalid" },
      ]);
    }

    const actor = assertAuthenticatedActor(gh, authUser);
    const body = await parseJsonBody(c);

    const ownerLogin = typeof body.owner === "string" && body.owner.trim() ? body.owner.trim() : actor.login;
    const target = lookupOwner(gh, ownerLogin);
    if (!target) {
      throw new ApiError(422, `Owner ${ownerLogin} is not a user or organization`, [
        { resource: "Repository", field: "owner", code: "invalid" },
      ]);
    }
    if (!mayCreateRepoFor(gh, authUser!, actor, target)) throw forbidden();

    const repo = createRepoRecord(
      gh,
      {
        name: body.name,
        description: typeof body.description === "string" ? body.description : null,
        private: typeof body.private === "boolean" ? body.private : false,
        homepage: null,
        has_issues: true,
        has_projects: true,
        has_wiki: true,
        auto_init: false,
        license_template: undefined,
        gitignore_template: undefined,
        owner_id: target.id,
        owner_type: target.type,
        owner_login: target.login,
        default_branch: template.default_branch,
        baseUrl,
      },
      actor,
    );

    const branchNames =
      body.include_all_branches === true
        ? gh.branches.findBy("repo_id", template.id).map((branch) => branch.name)
        : [template.default_branch];
    let size = 0;
    let copied = 0;
    for (const branchName of branchNames) {
      const branchSize = copyTemplateBranch(gh, template, repo, branchName, actor);
      if (branchSize === null) continue;
      copied += 1;
      if (branchName === template.default_branch) size = branchSize;
    }
    if (copied > 0) {
      gh.repos.update(repo.id, {
        size,
        pushed_at: timestamp(),
        language: template.language,
        languages: { ...template.languages },
      });
    }

    const finalRepo = gh.repos.get(repo.id)!;
    webhooks.dispatch(
      "repository",
      "created",
      { action: "created", repository: formatRepo(finalRepo, gh, baseUrl), sender: formatUser(actor, baseUrl) },
      target.login,
      finalRepo.name,
    );

    return c.json(
      {
        ...formatRepo(finalRepo, gh, baseUrl),
        template_repository: formatRepo(template, gh, baseUrl),
      },
      201,
    );
  });
}
