import type { Context } from "hono";
import type { RouteContext } from "@emulators/core";
import { ApiError, parseJsonBody, parsePagination, setLinkHeader } from "@emulators/core";
import { getGitHubStore } from "../store.js";
import type { GitHubStore } from "../store.js";
import type { GitHubIssue, GitHubIssueEvent, GitHubLabel, GitHubMilestone, GitHubRepo, GitHubUser } from "../entities.js";
import {
  formatIssue,
  formatLabel,
  formatMilestone,
  formatPullRequest,
  formatRepo,
  formatUser,
  generateNodeId,
  getNextMilestoneNumber,
  lookupRepo,
  timestamp,
} from "../helpers.js";
import {
  assertIssueWrite,
  assertRepoRead,
  notFoundResponse,
  ownerLoginOf,
} from "../route-helpers.js";

function findIssueByNumber(gh: GitHubStore, repoId: number, issueNumber: number): GitHubIssue | undefined {
  return gh.issues.findBy("repo_id", repoId).find((i) => i.number === issueNumber);
}

function findPullByNumber(gh: GitHubStore, repoId: number, num: number) {
  return gh.pullRequests.findBy("repo_id", repoId).find((p) => p.number === num);
}

function formatIssueOrPullPayload(
  gh: GitHubStore,
  issue: GitHubIssue,
  current: GitHubIssue,
  baseUrl: string
) {
  if (issue.is_pull_request) {
    const pr = findPullByNumber(gh, issue.repo_id, issue.number);
    return pr ? formatPullRequest(pr, gh, baseUrl) : null;
  }
  return formatIssue(current, gh, baseUrl);
}

/** Keep issue and pull request rows in sync for label_ids. */
function setIssueLabelIds(gh: GitHubStore, issue: GitHubIssue, labelIds: number[]) {
  gh.issues.update(issue.id, { label_ids: labelIds });
  if (issue.is_pull_request) {
    const pr = findPullByNumber(gh, issue.repo_id, issue.number);
    if (pr) gh.pullRequests.update(pr.id, { label_ids: labelIds });
  }
}

function insertIssueEvent(
  gh: GitHubStore,
  repo: GitHubRepo,
  issueNumber: number,
  event: string,
  actorId: number,
  extra?: Partial<
    Pick<
      GitHubIssueEvent,
      "commit_id" | "commit_url" | "label_name" | "assignee_id" | "milestone_title" | "rename"
    >
  >
): GitHubIssueEvent {
  const row = gh.issueEvents.insert({
    node_id: "",
    repo_id: repo.id,
    issue_number: issueNumber,
    event,
    actor_id: actorId,
    commit_id: null,
    commit_url: null,
    label_name: null,
    assignee_id: null,
    milestone_title: null,
    rename: null,
    ...extra,
  } as Omit<GitHubIssueEvent, "id" | "created_at" | "updated_at">);
  gh.issueEvents.update(row.id, { node_id: generateNodeId("IssueEvent", row.id) });
  return gh.issueEvents.get(row.id)!;
}

function randomLabelColor(): string {
  return Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, "0");
}

function normalizeColor(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new ApiError(422, "Validation failed");
  }
  let s = raw.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(s)) {
    throw new ApiError(422, "Validation failed");
  }
  return s.toLowerCase();
}

function getOrCreateLabel(gh: GitHubStore, repo: GitHubRepo, name: string): GitHubLabel {
  const existing = gh.labels.findBy("repo_id", repo.id).find((l) => l.name === name);
  if (existing) return existing;
  const label = gh.labels.insert({
    node_id: "",
    repo_id: repo.id,
    name,
    description: null,
    color: randomLabelColor(),
    default: false,
  } as Omit<GitHubLabel, "id" | "created_at" | "updated_at">);
  gh.labels.update(label.id, { node_id: generateNodeId("Label", label.id) });
  return gh.labels.get(label.id)!;
}

async function parseLabelNamesFromBody(c: Context): Promise<string[]> {
  const raw = await c.req.json().catch(() => null);
  if (raw === null) throw new ApiError(422, "Validation failed");
  let arr: unknown[];
  if (Array.isArray(raw)) {
    arr = raw;
  } else if (typeof raw === "object" && raw !== null && Array.isArray((raw as { labels?: unknown }).labels)) {
    arr = (raw as { labels: unknown[] }).labels;
  } else {
    throw new ApiError(422, "Validation failed");
  }
  const names = arr.filter((x): x is string => typeof x === "string" && x.length > 0);
  if (names.length !== arr.length) throw new ApiError(422, "Validation failed");
  return names;
}

function removeLabelFromAllIssuesAndPrs(gh: GitHubStore, repoId: number, labelId: number) {
  for (const i of gh.issues.findBy("repo_id", repoId)) {
    if (i.label_ids.includes(labelId)) {
      const next = i.label_ids.filter((id) => id !== labelId);
      setIssueLabelIds(gh, i, next);
    }
  }
}

function recalcMilestoneIssueCounts(gh: GitHubStore, repoId: number, milestoneId: number): GitHubMilestone | undefined {
  const m = gh.milestones.get(milestoneId);
  if (!m) return undefined;
  const items = gh.issues.findBy("repo_id", repoId).filter((i) => i.milestone_id === milestoneId);
  let open = 0;
  let closed = 0;
  for (const i of items) {
    if (i.state === "open") open++;
    else closed++;
  }
  return gh.milestones.update(milestoneId, { open_issues: open, closed_issues: closed }) ?? m;
}

function sortMilestones(
  list: GitHubMilestone[],
  sort: "due_on" | "completeness",
  direction: "asc" | "desc"
): GitHubMilestone[] {
  const mul = direction === "asc" ? 1 : -1;
  const sorted = [...list];
  sorted.sort((a, b) => {
    if (sort === "due_on") {
      const aNull = a.due_on === null;
      const bNull = b.due_on === null;
      if (aNull && bNull) return 0;
      // Asc: no due date last. Desc: no due date first (GitHub-style).
      if (aNull) return direction === "asc" ? 1 : -1;
      if (bNull) return direction === "asc" ? -1 : 1;
      const cmp = a.due_on! < b.due_on! ? -1 : a.due_on! > b.due_on! ? 1 : 0;
      return cmp * mul;
    }
    const totalA = a.open_issues + a.closed_issues;
    const totalB = b.open_issues + b.closed_issues;
    const pctA = totalA === 0 ? 0 : a.closed_issues / totalA;
    const pctB = totalB === 0 ? 0 : b.closed_issues / totalB;
    const cmp = pctA < pctB ? -1 : pctA > pctB ? 1 : 0;
    return cmp * mul;
  });
  return sorted;
}

export function labelsAndMilestonesRoutes({ app, store, webhooks, baseUrl }: RouteContext): void {
  const gh = getGitHubStore(store);

  app.get("/repos/:owner/:repo/labels", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoRead(gh, c.get("authUser"), repo);

    const { page, per_page } = parsePagination(c);
    let list = gh.labels.findBy("repo_id", repo.id).slice();
    list.sort((a, b) => a.name.localeCompare(b.name));
    const total = list.length;
    setLinkHeader(c, total, page, per_page);
    const start = (page - 1) * per_page;
    const pageItems = list.slice(start, start + per_page);
    return c.json(pageItems.map((l) => formatLabel(l, repo, baseUrl)));
  });

  app.post("/repos/:owner/:repo/labels", async (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    const actor = assertIssueWrite(gh, c.get("authUser"), repo);

    const body = await parseJsonBody(c);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) throw new ApiError(422, "Validation failed");

    const dup = gh.labels.findBy("repo_id", repo.id).find((l) => l.name === name);
    if (dup) throw new ApiError(422, "Validation failed");

    const color =
      body.color !== undefined && body.color !== null
        ? normalizeColor(body.color)
        : randomLabelColor();
    const description =
      typeof body.description === "string" || body.description === null ? (body.description as string | null) : null;

    const row = gh.labels.insert({
      node_id: "",
      repo_id: repo.id,
      name,
      description,
      color,
      default: false,
    } as Omit<GitHubLabel, "id" | "created_at" | "updated_at">);
    gh.labels.update(row.id, { node_id: generateNodeId("Label", row.id) });
    const label = gh.labels.get(row.id)!;

    const ownerLogin = ownerLoginOf(gh, repo);
    webhooks.dispatch(
      "label",
      "created",
      {
        action: "created",
        label: formatLabel(label, repo, baseUrl),
        repository: formatRepo(repo, gh, baseUrl),
        sender: formatUser(actor, baseUrl),
      },
      ownerLogin,
      repo.name
    );

    return c.json(formatLabel(label, repo, baseUrl), 201);
  });

  app.get("/repos/:owner/:repo/labels/:name", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoRead(gh, c.get("authUser"), repo);

    const rawName = c.req.param("name")!;
    const name = decodeURIComponent(rawName);
    const label = gh.labels.findBy("repo_id", repo.id).find((l) => l.name === name);
    if (!label) throw notFoundResponse();
    return c.json(formatLabel(label, repo, baseUrl));
  });

  app.patch("/repos/:owner/:repo/labels/:name", async (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    const actor = assertIssueWrite(gh, c.get("authUser"), repo);

    const rawName = c.req.param("name")!;
    const name = decodeURIComponent(rawName);
    let label = gh.labels.findBy("repo_id", repo.id).find((l) => l.name === name);
    if (!label) throw notFoundResponse();
    const labelId = label.id;

    const body = await parseJsonBody(c);
    const patch: Partial<GitHubLabel> = {};
    if (typeof body.new_name === "string" && body.new_name.trim()) {
      const nn = body.new_name.trim();
      const clash = gh.labels.findBy("repo_id", repo.id).find((l) => l.name === nn && l.id !== labelId);
      if (clash) throw new ApiError(422, "Validation failed");
      patch.name = nn;
    }
    if (body.color !== undefined) {
      patch.color = normalizeColor(body.color);
    }
    if ("description" in body) {
      patch.description =
        typeof body.description === "string" || body.description === null
          ? (body.description as string | null)
          : null;
    }

    const updated = gh.labels.update(labelId, patch);
    if (!updated) throw notFoundResponse();
    label = updated;

    const ownerLogin = ownerLoginOf(gh, repo);
    webhooks.dispatch(
      "label",
      "edited",
      {
        action: "edited",
        label: formatLabel(label, repo, baseUrl),
        repository: formatRepo(repo, gh, baseUrl),
        sender: formatUser(actor, baseUrl),
      },
      ownerLogin,
      repo.name
    );

    return c.json(formatLabel(label, repo, baseUrl));
  });

  app.delete("/repos/:owner/:repo/labels/:name", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    const actor = assertIssueWrite(gh, c.get("authUser"), repo);

    const rawName = c.req.param("name")!;
    const name = decodeURIComponent(rawName);
    const label = gh.labels.findBy("repo_id", repo.id).find((l) => l.name === name);
    if (!label) throw notFoundResponse();

    removeLabelFromAllIssuesAndPrs(gh, repo.id, label.id);
    gh.labels.delete(label.id);

    const ownerLogin = ownerLoginOf(gh, repo);
    webhooks.dispatch(
      "label",
      "deleted",
      {
        action: "deleted",
        label: formatLabel(label, repo, baseUrl),
        repository: formatRepo(repo, gh, baseUrl),
        sender: formatUser(actor, baseUrl),
      },
      ownerLogin,
      repo.name
    );

    return c.body(null, 204);
  });

  app.get("/repos/:owner/:repo/issues/:issue_number/labels", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoRead(gh, c.get("authUser"), repo);
    if (!repo.has_issues) throw notFoundResponse();

    const issueNumber = parseInt(c.req.param("issue_number")!, 10);
    if (!Number.isFinite(issueNumber)) throw notFoundResponse();

    const issue = findIssueByNumber(gh, repo.id, issueNumber);
    if (!issue) throw notFoundResponse();

    const labels = issue.label_ids
      .map((id) => gh.labels.get(id))
      .filter(Boolean)
      .map((l) => formatLabel(l!, repo, baseUrl));
    return c.json(labels);
  });

  app.post("/repos/:owner/:repo/issues/:issue_number/labels", async (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    const actor = assertIssueWrite(gh, c.get("authUser"), repo);
    if (!repo.has_issues) throw notFoundResponse();

    const issueNumber = parseInt(c.req.param("issue_number")!, 10);
    if (!Number.isFinite(issueNumber)) throw notFoundResponse();

    const issue = findIssueByNumber(gh, repo.id, issueNumber);
    if (!issue) throw notFoundResponse();

    const names = await parseLabelNamesFromBody(c);
    const prev = new Set(issue.label_ids);
    const ids = [...prev];
    for (const n of names) {
      const label = getOrCreateLabel(gh, repo, n);
      if (!ids.includes(label.id)) ids.push(label.id);
    }
    setIssueLabelIds(gh, issue, ids);

    const ownerLogin = ownerLoginOf(gh, repo);
    const after = gh.issues.get(issue.id)!;
    for (const id of after.label_ids) {
      if (!prev.has(id)) {
        const lbl = gh.labels.get(id);
        if (lbl) {
          insertIssueEvent(gh, repo, issue.number, "labeled", actor.id, { label_name: lbl.name });
          webhooks.dispatch(
            "issues",
            "labeled",
            {
              action: "labeled",
              issue: formatIssueOrPullPayload(gh, issue, after, baseUrl),
              label: lbl ? { name: lbl.name, color: lbl.color } : null,
              repository: formatRepo(repo, gh, baseUrl),
              sender: formatUser(actor, baseUrl),
            },
            ownerLogin,
            repo.name
          );
        }
      }
    }

    const labelsJson = after.label_ids
      .map((id) => gh.labels.get(id))
      .filter(Boolean)
      .map((l) => formatLabel(l!, repo, baseUrl));
    return c.json(labelsJson);
  });

  app.put("/repos/:owner/:repo/issues/:issue_number/labels", async (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    const actor = assertIssueWrite(gh, c.get("authUser"), repo);
    if (!repo.has_issues) throw notFoundResponse();

    const issueNumber = parseInt(c.req.param("issue_number")!, 10);
    if (!Number.isFinite(issueNumber)) throw notFoundResponse();

    const issue = findIssueByNumber(gh, repo.id, issueNumber);
    if (!issue) throw notFoundResponse();

    const names = await parseLabelNamesFromBody(c);
    const newIds = [...new Set(names.map((n) => getOrCreateLabel(gh, repo, n).id))];
    const prev = new Set(issue.label_ids);

    setIssueLabelIds(gh, issue, newIds);
    const after = gh.issues.get(issue.id)!;

    const ownerLogin = ownerLoginOf(gh, repo);
    for (const id of prev) {
      if (!newIds.includes(id)) {
        const lbl = gh.labels.get(id);
        insertIssueEvent(gh, repo, issue.number, "unlabeled", actor.id, { label_name: lbl?.name ?? null });
        webhooks.dispatch(
          "issues",
          "unlabeled",
          {
            action: "unlabeled",
            issue: formatIssueOrPullPayload(gh, issue, after, baseUrl),
            label: lbl ? { name: lbl.name, color: lbl.color } : null,
            repository: formatRepo(repo, gh, baseUrl),
            sender: formatUser(actor, baseUrl),
          },
          ownerLogin,
          repo.name
        );
      }
    }
    for (const id of newIds) {
      if (!prev.has(id)) {
        const lbl = gh.labels.get(id);
        if (lbl) {
          insertIssueEvent(gh, repo, issue.number, "labeled", actor.id, { label_name: lbl.name });
          webhooks.dispatch(
            "issues",
            "labeled",
            {
              action: "labeled",
              issue: formatIssueOrPullPayload(gh, issue, after, baseUrl),
              label: { name: lbl.name, color: lbl.color },
              repository: formatRepo(repo, gh, baseUrl),
              sender: formatUser(actor, baseUrl),
            },
            ownerLogin,
            repo.name
          );
        }
      }
    }

    const labelsJson = after.label_ids
      .map((id) => gh.labels.get(id))
      .filter(Boolean)
      .map((l) => formatLabel(l!, repo, baseUrl));
    return c.json(labelsJson);
  });

  app.delete("/repos/:owner/:repo/issues/:issue_number/labels/:name", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    const actor = assertIssueWrite(gh, c.get("authUser"), repo);
    if (!repo.has_issues) throw notFoundResponse();

    const issueNumber = parseInt(c.req.param("issue_number")!, 10);
    if (!Number.isFinite(issueNumber)) throw notFoundResponse();

    const issue = findIssueByNumber(gh, repo.id, issueNumber);
    if (!issue) throw notFoundResponse();

    const rawLabelName = c.req.param("name")!;
    const labelName = decodeURIComponent(rawLabelName);
    const label = gh.labels.findBy("repo_id", repo.id).find((l) => l.name === labelName);
    if (!label || !issue.label_ids.includes(label.id)) throw notFoundResponse();

    const next = issue.label_ids.filter((id) => id !== label.id);
    setIssueLabelIds(gh, issue, next);
    const after = gh.issues.get(issue.id)!;

    insertIssueEvent(gh, repo, issue.number, "unlabeled", actor.id, { label_name: label.name });
    const ownerLogin = ownerLoginOf(gh, repo);
    webhooks.dispatch(
      "issues",
      "unlabeled",
      {
        action: "unlabeled",
        issue: formatIssueOrPullPayload(gh, issue, after, baseUrl),
        label: { name: label.name, color: label.color },
        repository: formatRepo(repo, gh, baseUrl),
        sender: formatUser(actor, baseUrl),
      },
      ownerLogin,
      repo.name
    );

    const labelsJson = after.label_ids
      .map((id) => gh.labels.get(id))
      .filter(Boolean)
      .map((l) => formatLabel(l!, repo, baseUrl));
    return c.json(labelsJson);
  });

  app.delete("/repos/:owner/:repo/issues/:issue_number/labels", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertIssueWrite(gh, c.get("authUser"), repo);
    if (!repo.has_issues) throw notFoundResponse();

    const issueNumber = parseInt(c.req.param("issue_number")!, 10);
    if (!Number.isFinite(issueNumber)) throw notFoundResponse();

    const issue = findIssueByNumber(gh, repo.id, issueNumber);
    if (!issue) throw notFoundResponse();

    setIssueLabelIds(gh, issue, []);
    return c.body(null, 204);
  });

  app.get("/repos/:owner/:repo/milestones", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoRead(gh, c.get("authUser"), repo);
    if (!repo.has_issues) throw notFoundResponse();

    const stateQ = c.req.query("state") ?? "open";
    const state: "open" | "closed" | "all" =
      stateQ === "closed" || stateQ === "all" || stateQ === "open" ? stateQ : "open";

    const sortRaw = c.req.query("sort") ?? "due_on";
    const sort: "due_on" | "completeness" = sortRaw === "completeness" ? "completeness" : "due_on";

    const dirRaw = c.req.query("direction") ?? "desc";
    const direction: "asc" | "desc" = dirRaw === "asc" ? "asc" : "desc";

    let list = gh.milestones.findBy("repo_id", repo.id).map((m) => recalcMilestoneIssueCounts(gh, repo.id, m.id)!);

    if (state === "open") list = list.filter((m) => m.state === "open");
    else if (state === "closed") list = list.filter((m) => m.state === "closed");

    list = sortMilestones(list, sort, direction);

    const { page, per_page } = parsePagination(c);
    const total = list.length;
    setLinkHeader(c, total, page, per_page);
    const start = (page - 1) * per_page;
    const pageItems = list.slice(start, start + per_page);
    return c.json(pageItems.map((m) => formatMilestone(m, repo, gh, baseUrl)));
  });

  app.post("/repos/:owner/:repo/milestones", async (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    const actor = assertIssueWrite(gh, c.get("authUser"), repo);
    if (!repo.has_issues) throw notFoundResponse();

    const body = await parseJsonBody(c);
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title) throw new ApiError(422, "Validation failed");

    let state: "open" | "closed" = "open";
    if (body.state === "open" || body.state === "closed") state = body.state;

    const description =
      typeof body.description === "string" || body.description === null ? (body.description as string | null) : null;

    let due_on: string | null = null;
    if ("due_on" in body) {
      if (body.due_on === null) {
        due_on = null;
      } else if (typeof body.due_on === "string") {
        due_on = body.due_on;
      } else {
        throw new ApiError(422, "Validation failed");
      }
    }

    const num = getNextMilestoneNumber(gh, repo.id);
    const closed_at = state === "closed" ? timestamp() : null;

    const row = gh.milestones.insert({
      node_id: "",
      repo_id: repo.id,
      number: num,
      title,
      description,
      state,
      open_issues: 0,
      closed_issues: 0,
      due_on,
      closed_at,
      creator_id: actor.id,
    } as Omit<GitHubMilestone, "id" | "created_at" | "updated_at">);
    gh.milestones.update(row.id, { node_id: generateNodeId("Milestone", row.id) });
    let m = recalcMilestoneIssueCounts(gh, repo.id, row.id)!;

    const ownerLogin = ownerLoginOf(gh, repo);
    webhooks.dispatch(
      "milestone",
      state === "closed" ? "closed" : "created",
      {
        action: state === "closed" ? "closed" : "created",
        milestone: formatMilestone(m, repo, gh, baseUrl),
        repository: formatRepo(repo, gh, baseUrl),
        sender: formatUser(actor, baseUrl),
      },
      ownerLogin,
      repo.name
    );

    return c.json(formatMilestone(m, repo, gh, baseUrl), 201);
  });

  app.get("/repos/:owner/:repo/milestones/:milestone_number", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoRead(gh, c.get("authUser"), repo);
    if (!repo.has_issues) throw notFoundResponse();

    const n = parseInt(c.req.param("milestone_number")!, 10);
    if (!Number.isFinite(n)) throw notFoundResponse();

    const raw = gh.milestones.findBy("repo_id", repo.id).find((m) => m.number === n);
    if (!raw) throw notFoundResponse();
    const m = recalcMilestoneIssueCounts(gh, repo.id, raw.id)!;
    return c.json(formatMilestone(m, repo, gh, baseUrl));
  });

  app.patch("/repos/:owner/:repo/milestones/:milestone_number", async (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    const actor = assertIssueWrite(gh, c.get("authUser"), repo);
    if (!repo.has_issues) throw notFoundResponse();

    const n = parseInt(c.req.param("milestone_number")!, 10);
    if (!Number.isFinite(n)) throw notFoundResponse();

    let m = gh.milestones.findBy("repo_id", repo.id).find((x) => x.number === n);
    if (!m) throw notFoundResponse();

    const body = await parseJsonBody(c);
    const patch: Partial<GitHubMilestone> = {};

    if (typeof body.title === "string") patch.title = body.title;
    if (body.state === "open" || body.state === "closed") {
      patch.state = body.state;
    }
    if ("description" in body) {
      patch.description =
        typeof body.description === "string" || body.description === null
          ? (body.description as string | null)
          : null;
    }
    if ("due_on" in body) {
      if (body.due_on === null) patch.due_on = null;
      else if (typeof body.due_on === "string") patch.due_on = body.due_on;
      else throw new ApiError(422, "Validation failed");
    }

    const prevState = m.state;
    if (patch.state === "closed" && prevState === "open") {
      patch.closed_at = m.closed_at ?? timestamp();
    } else if (patch.state === "open" && prevState === "closed") {
      patch.closed_at = null;
    }

    const updated = gh.milestones.update(m.id, patch);
    if (!updated) throw notFoundResponse();
    m = recalcMilestoneIssueCounts(gh, repo.id, updated.id)!;

    const ownerLogin = ownerLoginOf(gh, repo);
    if (patch.state === "closed" && prevState === "open") {
      webhooks.dispatch(
        "milestone",
        "closed",
        {
          action: "closed",
          milestone: formatMilestone(m, repo, gh, baseUrl),
          repository: formatRepo(repo, gh, baseUrl),
          sender: formatUser(actor, baseUrl),
        },
        ownerLogin,
        repo.name
      );
    } else if (patch.state === "open" && prevState === "closed") {
      webhooks.dispatch(
        "milestone",
        "opened",
        {
          action: "opened",
          milestone: formatMilestone(m, repo, gh, baseUrl),
          repository: formatRepo(repo, gh, baseUrl),
          sender: formatUser(actor, baseUrl),
        },
        ownerLogin,
        repo.name
      );
    } else {
      webhooks.dispatch(
        "milestone",
        "edited",
        {
          action: "edited",
          milestone: formatMilestone(m, repo, gh, baseUrl),
          repository: formatRepo(repo, gh, baseUrl),
          sender: formatUser(actor, baseUrl),
        },
        ownerLogin,
        repo.name
      );
    }

    return c.json(formatMilestone(m, repo, gh, baseUrl));
  });

  app.delete("/repos/:owner/:repo/milestones/:milestone_number", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    const actor = assertIssueWrite(gh, c.get("authUser"), repo);
    if (!repo.has_issues) throw notFoundResponse();

    const n = parseInt(c.req.param("milestone_number")!, 10);
    if (!Number.isFinite(n)) throw notFoundResponse();

    const m = gh.milestones.findBy("repo_id", repo.id).find((x) => x.number === n);
    if (!m) throw notFoundResponse();

    for (const i of gh.issues.findBy("repo_id", repo.id)) {
      if (i.milestone_id === m.id) gh.issues.update(i.id, { milestone_id: null });
    }
    for (const p of gh.pullRequests.findBy("repo_id", repo.id)) {
      if (p.milestone_id === m.id) gh.pullRequests.update(p.id, { milestone_id: null });
    }

    gh.milestones.delete(m.id);

    const ownerLogin = ownerLoginOf(gh, repo);
    webhooks.dispatch(
      "milestone",
      "deleted",
      {
        action: "deleted",
        milestone: formatMilestone(m, repo, gh, baseUrl),
        repository: formatRepo(repo, gh, baseUrl),
        sender: formatUser(actor, baseUrl),
      },
      ownerLogin,
      repo.name
    );

    return c.body(null, 204);
  });

  app.get("/repos/:owner/:repo/milestones/:milestone_number/labels", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoRead(gh, c.get("authUser"), repo);
    if (!repo.has_issues) throw notFoundResponse();

    const n = parseInt(c.req.param("milestone_number")!, 10);
    if (!Number.isFinite(n)) throw notFoundResponse();

    const ms = gh.milestones.findBy("repo_id", repo.id).find((m) => m.number === n);
    if (!ms) throw notFoundResponse();

    const { page, per_page } = parsePagination(c);

    const labelIdSet = new Set<number>();
    for (const i of gh.issues.findBy("repo_id", repo.id)) {
      if (i.milestone_id !== ms.id) continue;
      for (const lid of i.label_ids) labelIdSet.add(lid);
    }

    let labels = [...labelIdSet]
      .map((id) => gh.labels.get(id))
      .filter(Boolean) as GitHubLabel[];
    labels.sort((a, b) => a.name.localeCompare(b.name));

    const total = labels.length;
    setLinkHeader(c, total, page, per_page);
    const start = (page - 1) * per_page;
    const pageItems = labels.slice(start, start + per_page);
    return c.json(pageItems.map((l) => formatLabel(l, repo, baseUrl)));
  });
}
