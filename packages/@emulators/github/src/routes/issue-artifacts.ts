import type { Context, RouteContext } from "@emulators/core";
import { ApiError, forbidden, parseJsonBody, parsePagination } from "@emulators/core";
import type { GitHubIssueArtifact } from "../entities.js";
import { formatUser, lookupRepo, timestamp } from "../helpers.js";
import { assertIssueWrite, assertRepoPermission, notFoundResponse } from "../route-helpers.js";
import { getGitHubStore } from "../store.js";

const issueArtifactTypes: GitHubIssueArtifact["type"][] = ["generic", "link", "plan", "embedded_html"];

function parseIssueArtifactType(value: unknown): GitHubIssueArtifact["type"] {
  if (typeof value !== "string" || !issueArtifactTypes.includes(value as GitHubIssueArtifact["type"])) {
    throw new ApiError(422, "Validation failed");
  }
  return value as GitHubIssueArtifact["type"];
}

function parseIssueArtifactText(value: unknown): string {
  if (typeof value !== "string") throw new ApiError(422, "Validation failed");
  return value;
}

export function issueArtifactsRoutes({ app, store, baseUrl }: RouteContext): void {
  const gh = getGitHubStore(store);
  const path = "/repos/:owner/:repo/issues/:issue_number/artifacts";

  function resolveIssue(c: Context, write = false) {
    const repo = lookupRepo(gh, c.req.param("owner")!, c.req.param("repo")!);
    if (!repo) throw notFoundResponse();
    const actor = write ? assertIssueWrite(gh, c.get("authUser"), repo) : undefined;
    if (!write) assertRepoPermission(gh, c.get("authUser"), repo, ["issues", "pull_requests"]);
    if (!repo.has_issues) throw new ApiError(410, "Issues are disabled for this repo");
    const issue = gh.issues
      .findBy("repo_id", repo.id)
      .find((candidate) => candidate.number === Number(c.req.param("issue_number")));
    if (!issue) throw notFoundResponse();
    if (write && (repo.archived || issue.locked)) throw forbidden();
    return { repo, issue, actor };
  }

  function format(artifact: GitHubIssueArtifact) {
    const repo = gh.repos.get(artifact.repo_id)!;
    const creator = gh.users.get(artifact.creator_id);
    const updater = gh.users.get(artifact.updated_by_id);
    return {
      id: artifact.id,
      number: artifact.number,
      html_url: `${baseUrl}/${repo.full_name}/issues/${artifact.issue_number}/artifacts/${artifact.number}`,
      type: artifact.type,
      name: artifact.name,
      body: artifact.body,
      creator: creator ? formatUser(creator, baseUrl) : null,
      updated_by_actor: updater ? formatUser(updater, baseUrl) : null,
      created_at: artifact.created_at,
      updated_at: artifact.updated_at,
    };
  }

  function resolveArtifact(c: Context, write = false) {
    const target = resolveIssue(c, write);
    const artifact = gh.issueArtifacts
      .findBy("repo_id", target.repo.id)
      .find(
        (candidate) =>
          candidate.issue_number === target.issue.number && candidate.number === Number(c.req.param("artifact_number")),
      );
    if (!artifact) throw notFoundResponse();
    return { ...target, artifact };
  }

  app.get(path, (c) => {
    const { repo, issue } = resolveIssue(c);
    const query = c.req.query("type");
    const type = query === undefined ? undefined : parseIssueArtifactType(query);
    const artifacts = gh.issueArtifacts
      .findBy("repo_id", repo.id)
      .filter((artifact) => artifact.issue_number === issue.number && (type === undefined || artifact.type === type))
      .sort((a, b) => a.number - b.number);
    const { page, per_page } = parsePagination(c);
    const start = (page - 1) * per_page;
    return c.json(artifacts.slice(start, start + per_page).map(format));
  });

  app.post(path, async (c) => {
    const { repo, issue, actor } = resolveIssue(c, true);
    const raw = await parseJsonBody(c);
    const type = raw.type === undefined ? "generic" : parseIssueArtifactType(raw.type);
    const name = parseIssueArtifactText(raw.name);
    const body = parseIssueArtifactText(raw.body);
    const key = `github.artifact_number:${repo.id}:${issue.number}`;
    const number = (store.getData<number>(key) ?? 0) + 1;
    const artifact = gh.issueArtifacts.insert({
      repo_id: repo.id,
      issue_number: issue.number,
      number,
      type,
      name,
      body,
      creator_id: actor!.id,
      updated_by_id: actor!.id,
      versions: [{ version: 1, name, body, created_at: timestamp(), actor_id: actor!.id }],
    });
    store.setData(key, number);
    return c.json(format(artifact), 201);
  });

  app.get(`${path}/:artifact_number`, (c) => {
    const { artifact } = resolveArtifact(c);
    return c.json({
      artifact: format(artifact),
      versions: [...artifact.versions].reverse().map(({ actor_id, ...version }) => {
        const actor = gh.users.get(actor_id);
        return { ...version, actor: actor ? formatUser(actor, baseUrl) : null };
      }),
    });
  });

  app.patch(`${path}/:artifact_number`, async (c) => {
    const { artifact, actor } = resolveArtifact(c, true);
    const raw = await parseJsonBody(c);
    if (raw.name === undefined && raw.body === undefined) throw new ApiError(422, "Validation failed");
    const name = raw.name === undefined ? artifact.name : parseIssueArtifactText(raw.name);
    const body = raw.body === undefined ? artifact.body : parseIssueArtifactText(raw.body);
    const updated = gh.issueArtifacts.update(artifact.id, {
      name,
      body,
      updated_by_id: actor!.id,
      versions: [
        ...artifact.versions,
        { version: artifact.versions.length + 1, name, body, created_at: timestamp(), actor_id: actor!.id },
      ],
    })!;
    return c.json(format(updated));
  });

  app.delete(`${path}/:artifact_number`, (c) => {
    const { artifact } = resolveArtifact(c, true);
    gh.issueArtifacts.delete(artifact.id);
    return c.body(null, 204);
  });
}
