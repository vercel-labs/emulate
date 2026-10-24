import type { RouteContext } from "@emulators/core";
import { JiraError, listParam, makeHandler, pageParams, READ, readJson, WRITE, type JiraRequest } from "../context.js";
import { avatarUrls, formatStatus, projectStatuses } from "../formatters.js";
import { formatIssue, formatSprint, parseFieldSelection } from "../issue-format.js";
import { editIssue } from "../issue-service.js";
import { compileJql, JqlError } from "../jql.js";
import { findIssue, findProject, paginate, requireIssue } from "../lookup.js";
import { emitEditEvents } from "../webhooks.js";
import { deleteBoardRecord, deleteSprintRecord } from "../services.js";
import type { JiraBoard, JiraIssue, JiraSprint, JiraSprintState } from "../entities.js";

const A = "/rest/agile/1.0";
const PREFIXES = [A, "/rest/software/1.0"];

function sprintName(value: unknown): string {
  const name = String(value ?? "").trim();
  if (!name) throw new JiraError(400, [], { name: "Sprint name is required." });
  if (name.length > 30) throw new JiraError(400, [], { name: "Sprint name must be 30 characters or fewer." });
  return name;
}

/** Reads an optional sprint date (an ISO 8601 date-time) and stores it normalized. */
function sprintDate(field: string, value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  const time = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(time)) throw new JiraError(400, [], { [field]: `Invalid date '${String(value)}'.` });
  return new Date(time).toISOString();
}

export function agileRoutes({ app, store, baseUrl }: RouteContext): void {
  const handle = makeHandler(store, baseUrl);

  const agileUrl = (r: JiraRequest, path: string) => `${r.siteUrl}${A}${path}`;

  const formatBoard = (r: JiraRequest, board: JiraBoard) => {
    const project = r.js.projects.get(board.project_id);
    return {
      id: board.id,
      self: agileUrl(r, `/board/${board.id}`),
      name: board.name,
      type: board.type,
      location: project
        ? {
            projectId: project.id,
            displayName: `${project.name} (${project.key})`,
            projectName: project.name,
            projectKey: project.key,
            projectTypeKey: project.project_type_key,
            avatarURI: avatarUrls(`project-${project.key}`)["48x48"],
            name: `${project.name} (${project.key})`,
          }
        : undefined,
    };
  };

  const requireBoard = (r: JiraRequest) => {
    const board = r.js.boards.get(Number(r.c.req.param("boardId")));
    if (!board) throw new JiraError(404, [`Board does not exist or you do not have permission to see it.`]);
    return board;
  };

  const requireSprint = (r: JiraRequest) => {
    const sprint = r.js.sprints.get(Number(r.c.req.param("sprintId")));
    if (!sprint)
      throw new JiraError(404, [
        `Sprint with id ${r.c.req.param("sprintId")} does not exist or you do not have permission to see it.`,
      ]);
    return sprint;
  };

  const sprintFieldId = (r: JiraRequest) =>
    r.js.customFields.all().find((field) => field.type === "sprint")?.field_id ?? "customfield_10020";

  /** Filters issues by an optional `jql` param, then pages and formats them the Agile way. */
  const issuePage = (r: JiraRequest, candidates: JiraIssue[]) => {
    let issues = candidates;
    const jql = r.c.req.query("jql");
    if (jql) {
      try {
        issues = issues.filter(compileJql(r.js, jql, r.user));
      } catch (err) {
        if (err instanceof JqlError) throw new JiraError(400, [err.message]);
        throw err;
      }
    }
    issues = [...issues].sort((a, b) => a.id - b.id);
    const { startAt, maxResults } = pageParams(r.c, 50, 100);
    const options = { fields: parseFieldSelection(listParam(r.c, "fields"), true), expand: listParam(r.c, "expand") };
    return {
      expand: "schema,names",
      startAt,
      maxResults,
      total: issues.length,
      isLast: startAt + maxResults >= issues.length,
      issues: issues.slice(startAt, startAt + maxResults).map((issue) => formatIssue(r, issue, options)),
    };
  };

  /** Moves issues into a sprint (or the backlog when sprintId is null) through the normal edit path. */
  const moveIssues = async (r: JiraRequest, refs: unknown, sprintId: number | null) => {
    if (!Array.isArray(refs) || refs.length === 0) throw new JiraError(400, ["At least one issue must be specified."]);
    if (refs.length > 50) throw new JiraError(400, ["At most 50 issues can be moved at once."]);
    const issues = refs.map((ref) => {
      const issue = findIssue(r.js, String(ref));
      if (!issue)
        throw new JiraError(400, [`Issue '${String(ref)}' does not exist or you do not have permission to see it.`]);
      return issue;
    });
    for (const issue of issues) {
      await emitEditEvents(r, editIssue(r, issue, { fields: { [sprintFieldId(r)]: sprintId } }));
    }
  };

  // Jira Cloud serves the Agile API under both prefixes.
  for (const P of PREFIXES) {
    // Boards

    app.get(
      `${P}/board`,
      handle(
        (r) => {
          const project = r.c.req.query("projectKeyOrId");
          const type = r.c.req.query("type");
          const name = r.c.req.query("name")?.toLowerCase();
          const projectId = project ? findProject(r.js, project)?.id : undefined;
          if (project && projectId === undefined) {
            throw new JiraError(400, [`No project could be found with key or id '${project}'.`]);
          }
          const boards = r.js.boards
            .all()
            .filter(
              (board) =>
                (projectId === undefined || board.project_id === projectId) &&
                (!type || type.split(",").includes(board.type)) &&
                (!name || board.name.toLowerCase().includes(name)),
            );
          const page = paginate(boards, pageParams(r.c, 50));
          return r.c.json({ ...page, values: page.values.map((board) => formatBoard(r, board)) });
        },
        { scopes: READ },
      ),
    );

    app.post(
      `${P}/board`,
      handle(
        async (r) => {
          const body = await readJson(r.c);
          const name = String(body.name ?? "").trim();
          if (!name) throw new JiraError(400, [], { name: "Board name is required." });
          if (body.type !== "scrum" && body.type !== "kanban") {
            throw new JiraError(400, [], { type: "Board type must be 'scrum' or 'kanban'." });
          }
          const project = findProject(r.js, body.location?.projectKeyOrId);
          if (!project) {
            throw new JiraError(400, ["A board must have a project location with a valid projectKeyOrId."]);
          }
          const board = r.js.boards.insert({ name, type: body.type, project_id: project.id });
          return r.c.json(formatBoard(r, board), 201);
        },
        { scopes: WRITE },
      ),
    );

    app.get(
      `${P}/board/:boardId`,
      handle((r) => r.c.json(formatBoard(r, requireBoard(r))), { scopes: READ }),
    );

    app.delete(
      `${P}/board/:boardId`,
      handle(
        (r) => {
          deleteBoardRecord(r.js, requireBoard(r));
          return r.c.body(null, 204);
        },
        { scopes: WRITE },
      ),
    );

    app.get(
      `${P}/board/:boardId/configuration`,
      handle(
        (r) => {
          const board = requireBoard(r);
          const project = r.js.projects.get(board.project_id);
          const statuses = project ? projectStatuses(r, project) : [];
          return r.c.json({
            id: board.id,
            name: board.name,
            type: board.type,
            self: agileUrl(r, `/board/${board.id}/configuration`),
            location: { type: "project", key: project?.key, id: project ? String(project.id) : undefined },
            filter: { id: String(board.id), self: `${r.siteUrl}/rest/api/3/filter/${board.id}` },
            columnConfig: {
              columns: statuses.map((status) => ({
                name: status.name,
                statuses: [{ id: String(status.id), self: formatStatus(r, status)!.self }],
              })),
              constraintType: "none",
            },
            ranking: { rankCustomFieldId: 10019 },
          });
        },
        { scopes: READ },
      ),
    );

    app.get(
      `${P}/board/:boardId/issue`,
      handle((r) => r.c.json(issuePage(r, r.js.issues.findBy("project_id", requireBoard(r).project_id))), {
        scopes: READ,
      }),
    );

    app.get(
      `${P}/board/:boardId/backlog`,
      handle(
        (r) => {
          const board = requireBoard(r);
          const backlog = r.js.issues
            .findBy("project_id", board.project_id)
            .filter((issue) => issue.sprint_id === null);
          return r.c.json(issuePage(r, backlog));
        },
        { scopes: READ },
      ),
    );

    app.get(
      `${P}/board/:boardId/sprint`,
      handle(
        (r) => {
          const board = requireBoard(r);
          const states = listParam(r.c, "state");
          const sprints = r.js.sprints
            .findBy("board_id", board.id)
            .filter((sprint) => states.length === 0 || states.includes(sprint.state))
            .sort((a, b) => a.id - b.id);
          const page = paginate(sprints, pageParams(r.c, 50));
          return r.c.json({ ...page, values: page.values.map((sprint) => formatSprint(r, sprint)) });
        },
        { scopes: READ },
      ),
    );

    app.get(
      `${P}/board/:boardId/epic`,
      handle(
        (r) => {
          const board = requireBoard(r);
          const epics = r.js.issues
            .findBy("project_id", board.project_id)
            .filter((issue) => r.js.issueTypes.get(issue.issue_type_id)?.hierarchy_level === 1)
            .sort((a, b) => a.id - b.id);
          const page = paginate(epics, pageParams(r.c, 50));
          return r.c.json({
            ...page,
            values: page.values.map((epic) => ({
              id: epic.id,
              key: epic.key,
              self: agileUrl(r, `/epic/${epic.id}`),
              name: epic.summary,
              summary: epic.summary,
              color: { key: "color_1" },
              done: r.js.statuses.get(epic.status_id)?.category === "done",
            })),
          });
        },
        { scopes: READ },
      ),
    );

    // Sprints

    app.post(
      `${P}/sprint`,
      handle(
        async (r) => {
          const body = await readJson(r.c);
          const name = sprintName(body.name);
          const board = r.js.boards.get(Number(body.originBoardId));
          if (!board)
            throw new JiraError(400, [], {
              originBoardId: "Board does not exist or you do not have permission to see it.",
            });
          if (board.type !== "scrum") throw new JiraError(400, ["Sprints can only be created on scrum boards."]);
          const sprint = r.js.sprints.insert({
            board_id: board.id,
            name,
            state: "future",
            goal: body.goal ?? "",
            start_date: sprintDate("startDate", body.startDate),
            end_date: sprintDate("endDate", body.endDate),
            complete_date: null,
          });
          return r.c.json(formatSprint(r, sprint), 201);
        },
        { scopes: WRITE },
      ),
    );

    app.get(
      `${P}/sprint/:sprintId`,
      handle((r) => r.c.json(formatSprint(r, requireSprint(r))), { scopes: READ }),
    );

    const updateSprint = () =>
      handle(
        async (r) => {
          const sprint = requireSprint(r);
          const body = await readJson(r.c);
          const next: JiraSprint = {
            ...sprint,
            name: body.name !== undefined ? sprintName(body.name) : sprint.name,
            goal: typeof body.goal === "string" ? body.goal : sprint.goal,
            start_date: body.startDate !== undefined ? sprintDate("startDate", body.startDate) : sprint.start_date,
            end_date: body.endDate !== undefined ? sprintDate("endDate", body.endDate) : sprint.end_date,
          };
          const target = (body.state ?? sprint.state) as JiraSprintState;
          if (target !== sprint.state) {
            const allowed: Record<JiraSprintState, JiraSprintState[]> = {
              future: ["active"],
              active: ["closed"],
              closed: [],
            };
            if (!allowed[sprint.state].includes(target)) {
              throw new JiraError(400, [`Cannot change the sprint state from ${sprint.state} to ${target}.`]);
            }
            if (target === "active" && (!next.start_date || !next.end_date)) {
              throw new JiraError(400, ["The sprint must have a start date and an end date before it can be started."]);
            }
            next.state = target;
            if (target === "closed") next.complete_date = new Date().toISOString();
          }
          const { id, created_at: _c, updated_at: _u, ...data } = next;
          const updated = r.js.sprints.update(id, data)!;
          if (sprint.state !== "closed" && updated.state === "closed") await closeSprintIssues(r, updated);
          return r.c.json(formatSprint(r, updated));
        },
        { scopes: WRITE },
      );
    app.post(`${P}/sprint/:sprintId`, updateSprint());
    app.put(`${P}/sprint/:sprintId`, updateSprint());

    app.delete(
      `${P}/sprint/:sprintId`,
      handle(
        (r) => {
          const sprint = requireSprint(r);
          if (sprint.state === "closed") throw new JiraError(400, ["Closed sprints cannot be deleted."]);
          deleteSprintRecord(r.js, sprint);
          return r.c.body(null, 204);
        },
        { scopes: WRITE },
      ),
    );

    app.get(
      `${P}/sprint/:sprintId/issue`,
      handle(
        (r) => {
          const sprint = requireSprint(r);
          const issues = r.js.issues
            .all()
            .filter((issue) => issue.sprint_id === sprint.id || issue.closed_sprint_ids.includes(sprint.id));
          return r.c.json(issuePage(r, issues));
        },
        { scopes: READ },
      ),
    );

    app.post(
      `${P}/sprint/:sprintId/issue`,
      handle(
        async (r) => {
          const sprint = requireSprint(r);
          if (sprint.state === "closed") throw new JiraError(400, ["Issues cannot be moved to a closed sprint."]);
          const body = await readJson(r.c);
          await moveIssues(r, body.issues, sprint.id);
          return r.c.body(null, 204);
        },
        { scopes: WRITE },
      ),
    );

    const moveToBacklog = handle(
      async (r) => {
        const body = await readJson(r.c);
        await moveIssues(r, body.issues, null);
        return r.c.body(null, 204);
      },
      { scopes: WRITE },
    );
    app.post(`${P}/backlog/issue`, moveToBacklog);
    app.post(`${P}/backlog/:boardId/issue`, moveToBacklog);

    // Issues and epics

    app.get(
      `${P}/issue/:key`,
      handle(
        (r) =>
          r.c.json(
            formatIssue(r, requireIssue(r.js, r.c.req.param("key")), {
              fields: parseFieldSelection(listParam(r.c, "fields"), true),
              expand: listParam(r.c, "expand"),
            }),
          ),
        { scopes: READ },
      ),
    );

    app.get(
      `${P}/epic/:key/issue`,
      handle(
        (r) => {
          const epic = requireIssue(r.js, r.c.req.param("key"));
          return r.c.json(issuePage(r, r.js.issues.findBy("parent_id", epic.id)));
        },
        { scopes: READ },
      ),
    );
  }
}

/**
 * Completed issues stay in the closed sprint. Everything else goes back to the backlog through the normal
 * edit path, so the move is recorded in the changelog and sent to webhooks.
 */
async function closeSprintIssues(r: JiraRequest, sprint: JiraSprint): Promise<void> {
  for (const issue of r.js.issues.findBy("sprint_id", sprint.id)) {
    if (r.js.statuses.get(issue.status_id)?.category === "done") continue;
    const result = editIssue(r, issue, {}, (draft) => {
      draft.sprint_id = null;
      draft.closed_sprint_ids = [...new Set([...draft.closed_sprint_ids, sprint.id])];
    });
    await emitEditEvents(r, result);
  }
}
