import type { Context } from "hono";
import type { RouteContext } from "@emulators/core";
import { ApiError, parseJsonBody, parsePagination, setLinkHeader } from "@emulators/core";
import { getGitHubStore } from "../store.js";
import {
  assertIssueWrite,
  assertRepoRead,
  notFoundResponse,
  ownerLoginOf,
} from "../route-helpers.js";
import type { GitHubStore } from "../store.js";
import type { GitHubIssue, GitHubIssueEvent, GitHubLabel, GitHubRepo, GitHubUser } from "../entities.js";
import {
  formatIssue,
  formatRepo,
  formatUser,
  generateNodeId,
  getNextIssueNumber,
  lookupRepo,
  timestamp,
} from "../helpers.js";

function findIssueForRepo(
  gh: GitHubStore,
  repoId: number,
  issueNumber: number
): GitHubIssue | undefined {
  return gh.issues
    .findBy("repo_id", repoId)
    .find((i) => i.number === issueNumber && !i.is_pull_request);
}

function adjustRepoOpenIssues(gh: GitHubStore, repoId: number, delta: number) {
  const repo = gh.repos.get(repoId);
  if (!repo) return;
  gh.repos.update(repoId, { open_issues_count: Math.max(0, repo.open_issues_count + delta) });
}

function getOrCreateLabel(gh: GitHubStore, repo: GitHubRepo, name: string): GitHubLabel {
  const existing = gh.labels.findBy("repo_id", repo.id).find((l) => l.name === name);
  if (existing) return existing;
  const label = gh.labels.insert({
    node_id: "",
    repo_id: repo.id,
    name,
    description: null,
    color: "ededed",
    default: false,
  } as Omit<GitHubLabel, "id" | "created_at" | "updated_at">);
  gh.labels.update(label.id, { node_id: generateNodeId("Label", label.id) });
  return gh.labels.get(label.id)!;
}

function resolveLabelIds(
  gh: GitHubStore,
  repo: GitHubRepo,
  raw: unknown,
  createMissing: boolean
): number[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new ApiError(422, "Validation failed");
  }
  const ids: number[] = [];
  for (const item of raw) {
    if (typeof item === "number" && Number.isFinite(item)) {
      const label = gh.labels.get(item);
      if (!label || label.repo_id !== repo.id) {
        throw new ApiError(422, "Validation failed");
      }
      ids.push(item);
    } else if (typeof item === "string") {
      if (createMissing) {
        ids.push(getOrCreateLabel(gh, repo, item).id);
      } else {
        const label = gh.labels.findBy("repo_id", repo.id).find((l) => l.name === item);
        if (!label) throw new ApiError(422, "Validation failed");
        ids.push(label.id);
      }
    } else {
      throw new ApiError(422, "Validation failed");
    }
  }
  return [...new Set(ids)];
}

function lookupUserByLogin(gh: GitHubStore, login: string): GitHubUser {
  const u = gh.users.findOneBy("login", login);
  if (!u) throw new ApiError(422, "Validation failed");
  return u;
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

function formatIssueEventApi(
  ev: GitHubIssueEvent,
  gh: GitHubStore,
  repo: GitHubRepo,
  issue: GitHubIssue,
  baseUrl: string
) {
  const actor = gh.users.get(ev.actor_id);
  const issueJson = formatIssue(issue, gh, baseUrl);
  return {
    id: ev.id,
    node_id: ev.node_id,
    url: `${baseUrl}/repos/${repo.full_name}/issues/events/${ev.id}`,
    actor: actor ? formatUser(actor, baseUrl) : null,
    event: ev.event,
    commit_id: ev.commit_id,
    commit_url: ev.commit_url,
    created_at: ev.created_at,
    label:
      ev.label_name !== null
        ? gh.labels
            .findBy("repo_id", repo.id)
            .find((l) => l.name === ev.label_name)
            ? {
                name: ev.label_name,
                color: gh.labels.findBy("repo_id", repo.id).find((l) => l.name === ev.label_name)!.color,
              }
            : { name: ev.label_name, color: "ededed" }
        : null,
    assignee:
      ev.assignee_id !== null && gh.users.get(ev.assignee_id)
        ? formatUser(gh.users.get(ev.assignee_id)!, baseUrl)
        : null,
    milestone: null,
    rename: ev.rename,
    issue: issueJson,
  };
}

function sortIssues(
  issues: GitHubIssue[],
  sort: "created" | "updated" | "comments",
  direction: "asc" | "desc"
): GitHubIssue[] {
  const mul = direction === "asc" ? 1 : -1;
  const field = sort === "created" ? "created_at" : sort === "updated" ? "updated_at" : "comments";
  const sorted = [...issues];
  sorted.sort((a, b) => {
    const av = a[field];
    const bv = b[field];
    if (typeof av === "number" && typeof bv === "number") {
      return av < bv ? -1 * mul : av > bv ? 1 * mul : 0;
    }
    const as = String(av);
    const bs = String(bv);
    if (as < bs) return -1 * mul;
    if (as > bs) return 1 * mul;
    return 0;
  });
  return sorted;
}

function parseIssueListFilters(c: Context) {
  const stateQ = c.req.query("state") ?? "open";
  const state: "open" | "closed" | "all" =
    stateQ === "closed" || stateQ === "all" || stateQ === "open" ? stateQ : "open";

  const labelsParam = c.req.query("labels");
  const labelNames = labelsParam
    ? labelsParam
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  const sortRaw = c.req.query("sort") ?? "created";
  const sort: "created" | "updated" | "comments" =
    sortRaw === "updated" || sortRaw === "comments" ? sortRaw : "created";

  const dirRaw = c.req.query("direction") ?? "desc";
  const direction: "asc" | "desc" = dirRaw === "asc" ? "asc" : "desc";

  const milestoneQ = c.req.query("milestone");
  const assigneeQ = c.req.query("assignee");
  const creatorQ = c.req.query("creator");
  const sinceQ = c.req.query("since");

  return {
    state,
    labelNames,
    sort,
    direction,
    milestoneQ,
    assigneeQ,
    creatorQ,
    sinceQ,
  };
}

export function issuesRoutes({ app, store, webhooks, baseUrl }: RouteContext): void {
  const gh = getGitHubStore(store);

  app.get("/repos/:owner/:repo/issues", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoRead(gh, c.get("authUser"), repo);
    if (!repo.has_issues) throw notFoundResponse();

    const { page, per_page } = parsePagination(c);
    const { state, labelNames, sort, direction, milestoneQ, assigneeQ, creatorQ, sinceQ } =
      parseIssueListFilters(c);

    let list = gh.issues.findBy("repo_id", repo.id).filter((i) => !i.is_pull_request);

    if (state === "open") list = list.filter((i) => i.state === "open");
    else if (state === "closed") list = list.filter((i) => i.state === "closed");

    if (labelNames.length > 0) {
      const labelIds = labelNames
        .map((name) => gh.labels.findBy("repo_id", repo.id).find((l) => l.name === name)?.id)
        .filter((x): x is number => x !== undefined);
      if (labelIds.length !== labelNames.length) {
        return c.json([]);
      }
      list = list.filter((i) => labelIds.every((lid) => i.label_ids.includes(lid)));
    }

    if (milestoneQ !== undefined && milestoneQ !== "") {
      if (milestoneQ === "none") {
        list = list.filter((i) => i.milestone_id === null);
      } else if (milestoneQ === "*") {
        list = list.filter((i) => i.milestone_id !== null);
      } else {
        const n = parseInt(milestoneQ, 10);
        if (!Number.isFinite(n)) {
          list = [];
        } else {
          const ms = gh.milestones.findBy("repo_id", repo.id).find((m) => m.number === n);
          if (!ms) list = [];
          else list = list.filter((i) => i.milestone_id === ms.id);
        }
      }
    }

    if (assigneeQ !== undefined && assigneeQ !== "") {
      if (assigneeQ === "none") {
        list = list.filter((i) => i.assignee_ids.length === 0);
      } else if (assigneeQ === "*") {
        list = list.filter((i) => i.assignee_ids.length > 0);
      } else {
        const u = gh.users.findOneBy("login", assigneeQ);
        if (!u) list = [];
        else list = list.filter((i) => i.assignee_ids.includes(u.id));
      }
    }

    if (creatorQ !== undefined && creatorQ !== "") {
      const u = gh.users.findOneBy("login", creatorQ);
      if (!u) list = [];
      else list = list.filter((i) => i.user_id === u.id);
    }

    if (sinceQ) {
      list = list.filter((i) => i.updated_at >= sinceQ);
    }

    list = sortIssues(list, sort, direction);
    const total = list.length;
    setLinkHeader(c, total, page, per_page);
    const start = (page - 1) * per_page;
    const pageItems = list.slice(start, start + per_page);
    const body = pageItems
      .map((i) => formatIssue(i, gh, baseUrl))
      .filter((x): x is NonNullable<typeof x> => x !== null);
    return c.json(body);
  });

  app.post("/repos/:owner/:repo/issues", async (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    if (!repo.has_issues) throw notFoundResponse();

    const actor = assertIssueWrite(gh, c.get("authUser"), repo);
    const body = await parseJsonBody(c);

    const title = body.title;
    if (typeof title !== "string" || !title.trim()) {
      throw new ApiError(422, "Validation failed");
    }

    const issueBody = typeof body.body === "string" || body.body === null ? (body.body as string | null) : null;

    const assigneeLogins = Array.isArray(body.assignees)
      ? body.assignees.filter((x): x is string => typeof x === "string")
      : [];
    const assigneeIds = assigneeLogins.map((login) => lookupUserByLogin(gh, login).id);

    const labelIds = body.labels !== undefined ? resolveLabelIds(gh, repo, body.labels, true) : [];

    let milestoneId: number | null = null;
    if (body.milestone !== undefined && body.milestone !== null) {
      const mn = typeof body.milestone === "number" ? body.milestone : parseInt(String(body.milestone), 10);
      if (!Number.isFinite(mn)) throw new ApiError(422, "Validation failed");
      const ms = gh.milestones.findBy("repo_id", repo.id).find((m) => m.number === mn);
      if (!ms) throw new ApiError(422, "Validation failed");
      milestoneId = ms.id;
    }

    const num = getNextIssueNumber(gh, repo.id);
    const row = gh.issues.insert({
      node_id: "",
      number: num,
      repo_id: repo.id,
      title: title.trim(),
      body: issueBody,
      state: "open",
      state_reason: null,
      locked: false,
      active_lock_reason: null,
      user_id: actor.id,
      assignee_ids: assigneeIds,
      label_ids: labelIds,
      milestone_id: milestoneId,
      comments: 0,
      closed_at: null,
      closed_by_id: null,
      is_pull_request: false,
    } as Omit<GitHubIssue, "id" | "created_at" | "updated_at">);
    gh.issues.update(row.id, { node_id: generateNodeId("Issue", row.id) });
    const issue = gh.issues.get(row.id)!;

    adjustRepoOpenIssues(gh, repo.id, 1);

    insertIssueEvent(gh, repo, issue.number, "opened", actor.id);

    const ownerLogin = ownerLoginOf(gh, repo);
    const issueFmt = formatIssue(issue, gh, baseUrl)!;
    webhooks.dispatch(
      "issues",
      "opened",
      {
        action: "opened",
        issue: issueFmt,
        repository: formatRepo(repo, gh, baseUrl),
        sender: formatUser(actor, baseUrl),
      },
      ownerLogin,
      repo.name
    );

    return c.json(issueFmt, 201);
  });

  app.get("/repos/:owner/:repo/issues/:issue_number", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoRead(gh, c.get("authUser"), repo);
    if (!repo.has_issues) throw notFoundResponse();

    const issueNumber = parseInt(c.req.param("issue_number")!, 10);
    if (!Number.isFinite(issueNumber)) throw notFoundResponse();

    const issue = findIssueForRepo(gh, repo.id, issueNumber);
    if (!issue || issue.is_pull_request) throw notFoundResponse();

    const json = formatIssue(issue, gh, baseUrl);
    if (!json) throw notFoundResponse();
    return c.json(json);
  });

  app.patch("/repos/:owner/:repo/issues/:issue_number", async (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    if (!repo.has_issues) throw notFoundResponse();

    const actor = assertIssueWrite(gh, c.get("authUser"), repo);

    const issueNumber = parseInt(c.req.param("issue_number")!, 10);
    if (!Number.isFinite(issueNumber)) throw notFoundResponse();

    let issue = findIssueForRepo(gh, repo.id, issueNumber);
    if (!issue || issue.is_pull_request) throw notFoundResponse();

    const beforePatch = issue;

    const body = await parseJsonBody(c);
    const patch: Partial<GitHubIssue> = {};

    if (typeof body.title === "string") patch.title = body.title;
    if ("body" in body) {
      patch.body = body.body === null ? null : String(body.body);
    }

    const oldState = issue.state;
    if (body.state === "open" || body.state === "closed") {
      patch.state = body.state;
    }

    if ("state_reason" in body) {
      if (body.state_reason === null) {
        patch.state_reason = null;
      } else if (
        body.state_reason === "completed" ||
        body.state_reason === "not_planned" ||
        body.state_reason === "reopened"
      ) {
        patch.state_reason = body.state_reason;
      }
    }

    if (Array.isArray(body.labels)) {
      patch.label_ids = resolveLabelIds(gh, repo, body.labels, true);
    }

    if (Array.isArray(body.assignees)) {
      const logins = body.assignees.filter((x): x is string => typeof x === "string");
      patch.assignee_ids = logins.map((login) => lookupUserByLogin(gh, login).id);
    }

    if ("milestone" in body) {
      if (body.milestone === null) {
        patch.milestone_id = null;
      } else {
        const mn =
          typeof body.milestone === "number"
            ? body.milestone
            : parseInt(String(body.milestone), 10);
        if (!Number.isFinite(mn)) throw new ApiError(422, "Validation failed");
        const ms = gh.milestones.findBy("repo_id", repo.id).find((m) => m.number === mn);
        if (!ms) throw new ApiError(422, "Validation failed");
        patch.milestone_id = ms.id;
      }
    }

    const prevLabelIds = new Set(issue.label_ids);
    const prevAssigneeIds = new Set(issue.assignee_ids);
    const prevMilestoneId = issue.milestone_id;

    const updated = gh.issues.update(issue.id, patch);
    if (!updated) throw notFoundResponse();
    issue = updated;

    let statePatch: Partial<GitHubIssue> = {};
    if (patch.state === "closed" && oldState === "open") {
      statePatch = {
        closed_at: timestamp(),
        closed_by_id: actor.id,
        ...(patch.state_reason === undefined ? { state_reason: "completed" as const } : {}),
      };
    } else if (patch.state === "open" && oldState === "closed") {
      statePatch = {
        closed_at: null,
        closed_by_id: null,
        ...(patch.state_reason === undefined ? { state_reason: "reopened" as const } : {}),
      };
    } else if (patch.state === "closed" && oldState === "closed") {
      if (patch.state_reason !== undefined) statePatch.state_reason = patch.state_reason;
    }

    if (Object.keys(statePatch).length > 0) {
      const again = gh.issues.update(issue.id, statePatch);
      if (again) issue = again;
    }

    const ownerLogin = ownerLoginOf(gh, repo);

    if (patch.state === "closed" && oldState === "open") {
      adjustRepoOpenIssues(gh, repo.id, -1);
      insertIssueEvent(gh, repo, issue.number, "closed", actor.id);
      webhooks.dispatch(
        "issues",
        "closed",
        {
          action: "closed",
          issue: formatIssue(issue, gh, baseUrl)!,
          repository: formatRepo(repo, gh, baseUrl),
          sender: formatUser(actor, baseUrl),
        },
        ownerLogin,
        repo.name
      );
    } else if (patch.state === "open" && oldState === "closed") {
      adjustRepoOpenIssues(gh, repo.id, 1);
      insertIssueEvent(gh, repo, issue.number, "reopened", actor.id);
      webhooks.dispatch(
        "issues",
        "reopened",
        {
          action: "reopened",
          issue: formatIssue(issue, gh, baseUrl)!,
          repository: formatRepo(repo, gh, baseUrl),
          sender: formatUser(actor, baseUrl),
        },
        ownerLogin,
        repo.name
      );
    }

    if (Array.isArray(body.labels)) {
      const newIds = new Set(issue.label_ids);
      for (const id of prevLabelIds) {
        if (!newIds.has(id)) {
          const label = gh.labels.get(id);
          insertIssueEvent(gh, repo, issue.number, "unlabeled", actor.id, {
            label_name: label?.name ?? null,
          });
          webhooks.dispatch(
            "issues",
            "unlabeled",
            {
              action: "unlabeled",
              issue: formatIssue(issue, gh, baseUrl)!,
              label: label ? { name: label.name, color: label.color } : null,
              repository: formatRepo(repo, gh, baseUrl),
              sender: formatUser(actor, baseUrl),
            },
            ownerLogin,
            repo.name
          );
        }
      }
      for (const id of newIds) {
        if (!prevLabelIds.has(id)) {
          const label = gh.labels.get(id);
          if (label) {
            insertIssueEvent(gh, repo, issue.number, "labeled", actor.id, { label_name: label.name });
            webhooks.dispatch(
              "issues",
              "labeled",
              {
                action: "labeled",
                issue: formatIssue(issue, gh, baseUrl)!,
                label: { name: label.name, color: label.color },
                repository: formatRepo(repo, gh, baseUrl),
                sender: formatUser(actor, baseUrl),
              },
              ownerLogin,
              repo.name
            );
          }
        }
      }
    }

    if (Array.isArray(body.assignees)) {
      const newAssignees = new Set(issue.assignee_ids);
      for (const id of prevAssigneeIds) {
        if (!newAssignees.has(id)) {
          insertIssueEvent(gh, repo, issue.number, "unassigned", actor.id, { assignee_id: id });
          const u = gh.users.get(id);
          webhooks.dispatch(
            "issues",
            "unassigned",
            {
              action: "unassigned",
              issue: formatIssue(issue, gh, baseUrl)!,
              assignee: u ? formatUser(u, baseUrl) : null,
              repository: formatRepo(repo, gh, baseUrl),
              sender: formatUser(actor, baseUrl),
            },
            ownerLogin,
            repo.name
          );
        }
      }
      for (const id of newAssignees) {
        if (!prevAssigneeIds.has(id)) {
          insertIssueEvent(gh, repo, issue.number, "assigned", actor.id, { assignee_id: id });
          const u = gh.users.get(id);
          webhooks.dispatch(
            "issues",
            "assigned",
            {
              action: "assigned",
              issue: formatIssue(issue, gh, baseUrl)!,
              assignee: u ? formatUser(u, baseUrl) : null,
              repository: formatRepo(repo, gh, baseUrl),
              sender: formatUser(actor, baseUrl),
            },
            ownerLogin,
            repo.name
          );
        }
      }
    }

    if ("milestone" in body) {
      const newMs = issue.milestone_id;
      if (prevMilestoneId !== newMs) {
        const oldTitle = prevMilestoneId ? gh.milestones.get(prevMilestoneId)?.title ?? null : null;
        const newTitle = newMs ? gh.milestones.get(newMs)?.title ?? null : null;
        if (prevMilestoneId !== null) {
          insertIssueEvent(gh, repo, issue.number, "demilestoned", actor.id, {
            milestone_title: oldTitle,
          });
          webhooks.dispatch(
            "issues",
            "demilestoned",
            {
              action: "demilestoned",
              issue: formatIssue(issue, gh, baseUrl)!,
              milestone: oldTitle ? { title: oldTitle } : null,
              repository: formatRepo(repo, gh, baseUrl),
              sender: formatUser(actor, baseUrl),
            },
            ownerLogin,
            repo.name
          );
        }
        if (newMs !== null) {
          insertIssueEvent(gh, repo, issue.number, "milestoned", actor.id, {
            milestone_title: newTitle,
          });
          webhooks.dispatch(
            "issues",
            "milestoned",
            {
              action: "milestoned",
              issue: formatIssue(issue, gh, baseUrl)!,
              milestone: newTitle ? { title: newTitle } : null,
              repository: formatRepo(repo, gh, baseUrl),
              sender: formatUser(actor, baseUrl),
            },
            ownerLogin,
            repo.name
          );
        }
      }
    }

    const titleEdited = typeof body.title === "string" && body.title !== beforePatch.title;
    const bodyEdited =
      "body" in body &&
      (body.body === null ? beforePatch.body !== null : String(body.body) !== (beforePatch.body ?? ""));
    if (titleEdited || bodyEdited) {
      insertIssueEvent(gh, repo, issue.number, "edited", actor.id);
      webhooks.dispatch(
        "issues",
        "edited",
        {
          action: "edited",
          issue: formatIssue(issue, gh, baseUrl)!,
          repository: formatRepo(repo, gh, baseUrl),
          sender: formatUser(actor, baseUrl),
          changes: {
            title: titleEdited,
            body: bodyEdited,
          },
        },
        ownerLogin,
        repo.name
      );
    }

    const json = formatIssue(issue, gh, baseUrl);
    if (!json) throw notFoundResponse();
    return c.json(json);
  });

  app.put("/repos/:owner/:repo/issues/:issue_number/lock", async (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    if (!repo.has_issues) throw notFoundResponse();

    const actor = assertIssueWrite(gh, c.get("authUser"), repo);
    const issueNumber = parseInt(c.req.param("issue_number")!, 10);
    if (!Number.isFinite(issueNumber)) throw notFoundResponse();

    let issue = findIssueForRepo(gh, repo.id, issueNumber);
    if (!issue || issue.is_pull_request) throw notFoundResponse();

    const body = await parseJsonBody(c);
    const lockReason =
      typeof body.lock_reason === "string"
        ? body.lock_reason
        : typeof body.active_lock_reason === "string"
          ? body.active_lock_reason
          : "resolved";

    issue = gh.issues.update(issue.id, {
      locked: true,
      active_lock_reason: lockReason,
    })!;

    insertIssueEvent(gh, repo, issue.number, "locked", actor.id);
    const ownerLogin = ownerLoginOf(gh, repo);
    webhooks.dispatch(
      "issues",
      "locked",
      {
        action: "locked",
        issue: formatIssue(issue, gh, baseUrl)!,
        repository: formatRepo(repo, gh, baseUrl),
        sender: formatUser(actor, baseUrl),
      },
      ownerLogin,
      repo.name
    );

    return c.body(null, 204);
  });

  app.delete("/repos/:owner/:repo/issues/:issue_number/lock", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    if (!repo.has_issues) throw notFoundResponse();

    const actor = assertIssueWrite(gh, c.get("authUser"), repo);
    const issueNumber = parseInt(c.req.param("issue_number")!, 10);
    if (!Number.isFinite(issueNumber)) throw notFoundResponse();

    let issue = findIssueForRepo(gh, repo.id, issueNumber);
    if (!issue || issue.is_pull_request) throw notFoundResponse();

    issue = gh.issues.update(issue.id, { locked: false, active_lock_reason: null })!;

    insertIssueEvent(gh, repo, issue.number, "unlocked", actor.id);
    const ownerLogin = ownerLoginOf(gh, repo);
    webhooks.dispatch(
      "issues",
      "unlocked",
      {
        action: "unlocked",
        issue: formatIssue(issue, gh, baseUrl)!,
        repository: formatRepo(repo, gh, baseUrl),
        sender: formatUser(actor, baseUrl),
      },
      ownerLogin,
      repo.name
    );

    return c.body(null, 204);
  });

  function listIssueEventsForIssue(c: Context) {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoRead(gh, c.get("authUser"), repo);
    if (!repo.has_issues) throw notFoundResponse();

    const issueNumber = parseInt(c.req.param("issue_number")!, 10);
    if (!Number.isFinite(issueNumber)) throw notFoundResponse();

    const issue = findIssueForRepo(gh, repo.id, issueNumber);
    if (!issue || issue.is_pull_request) throw notFoundResponse();

    const { page, per_page } = parsePagination(c);
    let events = gh.issueEvents
      .findBy("repo_id", repo.id)
      .filter((e) => e.issue_number === issueNumber);
    events.sort((a, b) => a.created_at.localeCompare(b.created_at));
    const total = events.length;
    setLinkHeader(c, total, page, per_page);
    const start = (page - 1) * per_page;
    events = events.slice(start, start + per_page);

    const payload = events.map((ev) => formatIssueEventApi(ev, gh, repo, issue, baseUrl));
    return c.json(payload);
  }

  app.get("/repos/:owner/:repo/issues/:issue_number/timeline", (c) => listIssueEventsForIssue(c));
  app.get("/repos/:owner/:repo/issues/:issue_number/events", (c) => listIssueEventsForIssue(c));

  app.post("/repos/:owner/:repo/issues/:issue_number/assignees", async (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    if (!repo.has_issues) throw notFoundResponse();

    const actor = assertIssueWrite(gh, c.get("authUser"), repo);
    const issueNumber = parseInt(c.req.param("issue_number")!, 10);
    if (!Number.isFinite(issueNumber)) throw notFoundResponse();

    let issue = findIssueForRepo(gh, repo.id, issueNumber);
    if (!issue || issue.is_pull_request) throw notFoundResponse();

    const body = await parseJsonBody(c) as { assignees?: unknown };
    const logins = Array.isArray(body.assignees)
      ? body.assignees.filter((x): x is string => typeof x === "string")
      : [];
    const addIds = logins.map((login) => lookupUserByLogin(gh, login).id);
    const prevAssigneeSet = new Set(issue.assignee_ids);
    const merged = [...new Set([...issue.assignee_ids, ...addIds])];
    issue = gh.issues.update(issue.id, { assignee_ids: merged })!;

    const ownerLogin = ownerLoginOf(gh, repo);
    for (const id of addIds) {
      if (prevAssigneeSet.has(id)) continue;
      insertIssueEvent(gh, repo, issue.number, "assigned", actor.id, { assignee_id: id });
      const u = gh.users.get(id);
      webhooks.dispatch(
        "issues",
        "assigned",
        {
          action: "assigned",
          issue: formatIssue(issue, gh, baseUrl)!,
          assignee: u ? formatUser(u, baseUrl) : null,
          repository: formatRepo(repo, gh, baseUrl),
          sender: formatUser(actor, baseUrl),
        },
        ownerLogin,
        repo.name
      );
    }

    const json = formatIssue(issue, gh, baseUrl);
    if (!json) throw notFoundResponse();
    return c.json(json);
  });

  app.delete("/repos/:owner/:repo/issues/:issue_number/assignees", async (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    if (!repo.has_issues) throw notFoundResponse();

    const actor = assertIssueWrite(gh, c.get("authUser"), repo);
    const issueNumber = parseInt(c.req.param("issue_number")!, 10);
    if (!Number.isFinite(issueNumber)) throw notFoundResponse();

    let issue = findIssueForRepo(gh, repo.id, issueNumber);
    if (!issue || issue.is_pull_request) throw notFoundResponse();

    const body = await parseJsonBody(c) as { assignees?: unknown };
    const logins = Array.isArray(body.assignees)
      ? body.assignees.filter((x): x is string => typeof x === "string")
      : [];
    const removeIds = new Set(logins.map((login) => lookupUserByLogin(gh, login).id));
    const prevAssignees = new Set(issue.assignee_ids);
    const merged = issue.assignee_ids.filter((id) => !removeIds.has(id));
    issue = gh.issues.update(issue.id, { assignee_ids: merged })!;

    const ownerLogin = ownerLoginOf(gh, repo);
    for (const id of removeIds) {
      if (prevAssignees.has(id)) {
        insertIssueEvent(gh, repo, issue.number, "unassigned", actor.id, { assignee_id: id });
        const u = gh.users.get(id);
        webhooks.dispatch(
          "issues",
          "unassigned",
          {
            action: "unassigned",
            issue: formatIssue(issue, gh, baseUrl)!,
            assignee: u ? formatUser(u, baseUrl) : null,
            repository: formatRepo(repo, gh, baseUrl),
            sender: formatUser(actor, baseUrl),
          },
          ownerLogin,
          repo.name
        );
      }
    }

    const json = formatIssue(issue, gh, baseUrl);
    if (!json) throw notFoundResponse();
    return c.json(json);
  });
}
