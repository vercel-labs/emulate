import type { RouteContext } from "@emulators/core";
import {
  API_V,
  JiraError,
  listParam,
  makeHandler,
  pageParams,
  READ,
  readJson,
  WRITE,
  type JiraRequest,
} from "../context.js";
import {
  formatComponent,
  formatIssueType,
  formatPriority,
  formatVersion,
  projectIssueTypes,
  restUrl,
} from "../formatters.js";
import {
  formatChangelog,
  formatIssue,
  formatTransition,
  issueSelf,
  issueTransitions,
  parseFieldSelection,
} from "../issue-format.js";
import { createIssue, editIssue, transitionIssue } from "../issue-service.js";
import { allFields, type FieldDef } from "../fields.js";
import { findIssueType, findUser, paginate, requireIssue, requireProject } from "../lookup.js";
import { deleteIssueRecord } from "../services.js";
import { emitEditEvents, emitIssueEvent } from "../webhooks.js";
import type { JiraProject } from "../entities.js";

export function readIssueOptions(r: JiraRequest, defaultAll = true) {
  return {
    fields: parseFieldSelection(listParam(r.c, "fields"), defaultAll),
    expand: listParam(r.c, "expand"),
  };
}

export function issueRoutes({ app, store, baseUrl }: RouteContext): void {
  const handle = makeHandler(store, baseUrl);

  // Static paths first so they win over /issue/:key.
  app.get(
    `${API_V}/issue/createmeta/:project/issuetypes`,
    handle(
      (r) => {
        const project = requireProject(r.js, r.c.req.param("project"));
        const types = projectIssueTypes(r, project).map((type) => formatIssueType(r, type));
        const page = paginate(types, pageParams(r.c, 50, 200));
        return r.c.json({
          issueTypes: page.values,
          maxResults: page.maxResults,
          startAt: page.startAt,
          total: page.total,
        });
      },
      { scopes: WRITE },
    ),
  );

  app.get(
    `${API_V}/issue/createmeta/:project/issuetypes/:typeId`,
    handle(
      (r) => {
        const project = requireProject(r.js, r.c.req.param("project"));
        const type = findIssueType(r.js, r.c.req.param("typeId"));
        if (!type || !project.issue_type_ids.includes(type.id)) {
          throw new JiraError(404, [
            "Issue type with given ID does not exist or you do not have permission to see it.",
          ]);
        }
        const fields = createFieldMeta(r, project, type.subtask);
        const page = paginate(fields, pageParams(r.c, 50, 200));
        return r.c.json({ fields: page.values, maxResults: page.maxResults, startAt: page.startAt, total: page.total });
      },
      { scopes: WRITE },
    ),
  );

  app.post(
    `${API_V}/issue/bulk`,
    handle(
      async (r) => {
        const body = await readJson(r.c);
        const updates: unknown[] = Array.isArray(body.issueUpdates) ? body.issueUpdates : [];
        const issues: unknown[] = [];
        const errors: unknown[] = [];
        for (const [index, update] of updates.entries()) {
          try {
            const { issue, comments } = createIssue(r, update as { fields?: Record<string, unknown> });
            issues.push({ id: String(issue.id), key: issue.key, self: issueSelf(r, issue) });
            await emitIssueEvent(r, "jira:issue_created", issue, { comments });
          } catch (err) {
            if (!(err instanceof JiraError)) throw err;
            errors.push({
              status: err.status,
              elementErrors: { errorMessages: err.errorMessages, errors: err.errors },
              failedElementNumber: index,
            });
          }
        }
        return r.c.json({ issues, errors }, issues.length > 0 || updates.length === 0 ? 201 : 400);
      },
      { scopes: WRITE },
    ),
  );

  app.post(
    `${API_V}/issue`,
    handle(
      async (r) => {
        const { issue, comments } = createIssue(r, await readJson(r.c));
        await emitIssueEvent(r, "jira:issue_created", issue, { comments });
        return r.c.json({ id: String(issue.id), key: issue.key, self: issueSelf(r, issue) }, 201);
      },
      { scopes: WRITE },
    ),
  );

  app.get(
    `${API_V}/issue/:key`,
    handle((r) => r.c.json(formatIssue(r, requireIssue(r.js, r.c.req.param("key")), readIssueOptions(r))), {
      scopes: READ,
    }),
  );

  app.put(
    `${API_V}/issue/:key`,
    handle(
      async (r) => {
        const issue = requireIssue(r.js, r.c.req.param("key"));
        const result = editIssue(r, issue, await readJson(r.c));
        await emitEditEvents(r, result);
        if (r.c.req.query("returnIssue") === "true") {
          return r.c.json(formatIssue(r, result.issue, readIssueOptions(r)));
        }
        return r.c.body(null, 204);
      },
      { scopes: WRITE },
    ),
  );

  app.delete(
    `${API_V}/issue/:key`,
    handle(
      async (r) => {
        const issue = requireIssue(r.js, r.c.req.param("key"));
        const subtasks = r.js.issues
          .findBy("parent_id", issue.id)
          .filter((child) => r.js.issueTypes.get(child.issue_type_id)?.subtask);
        if (subtasks.length > 0 && r.c.req.query("deleteSubtasks") !== "true") {
          throw new JiraError(400, [
            `The issue '${issue.key}' has subtasks. You must specify the 'deleteSubtasks' parameter to delete this issue and all its subtasks.`,
          ]);
        }
        await emitIssueEvent(r, "jira:issue_deleted", issue);
        deleteIssueRecord(r.js, issue);
        return r.c.body(null, 204);
      },
      { scopes: WRITE },
    ),
  );

  app.put(
    `${API_V}/issue/:key/assignee`,
    handle(
      async (r) => {
        const issue = requireIssue(r.js, r.c.req.param("key"));
        const body = await readJson(r.c);
        const ref = body.accountId ?? body.name ?? null;
        if (ref !== null && ref !== "-1" && !findUser(r.js, String(ref))) {
          throw new JiraError(400, [], { assignee: `User '${ref}' cannot be assigned issues.` });
        }
        const result = editIssue(r, issue, { fields: { assignee: ref === null ? null : { accountId: String(ref) } } });
        await emitEditEvents(r, result);
        return r.c.body(null, 204);
      },
      { scopes: WRITE },
    ),
  );

  app.get(
    `${API_V}/issue/:key/transitions`,
    handle(
      (r) => {
        const issue = requireIssue(r.js, r.c.req.param("key"));
        const only = r.c.req.query("transitionId");
        const transitions = issueTransitions(r, issue)
          .filter((transition) => !only || transition.id === only)
          .map((transition) => formatTransition(r, transition));
        return r.c.json({ expand: "transitions", transitions });
      },
      { scopes: READ },
    ),
  );

  app.post(
    `${API_V}/issue/:key/transitions`,
    handle(
      async (r) => {
        const issue = requireIssue(r.js, r.c.req.param("key"));
        const result = transitionIssue(r, issue, await readJson(r.c));
        await emitEditEvents(r, result);
        return r.c.body(null, 204);
      },
      { scopes: WRITE },
    ),
  );

  app.get(
    `${API_V}/issue/:key/changelog`,
    handle(
      (r) => {
        const issue = requireIssue(r.js, r.c.req.param("key"));
        const entries = r.js.changelogs.findBy("issue_id", issue.id).sort((a, b) => a.id - b.id);
        const { startAt, maxResults } = pageParams(r.c, 100, 100);
        const page = paginate(entries, { startAt, maxResults });
        return r.c.json({
          self: restUrl(r, `/issue/${issue.key}/changelog?maxResults=${maxResults}&startAt=${startAt}`),
          ...page,
          values: page.values.map((entry) => formatChangelog(r, entry)),
        });
      },
      { scopes: READ },
    ),
  );

  app.get(
    `${API_V}/issue/:key/editmeta`,
    handle(
      (r) => {
        const issue = requireIssue(r.js, r.c.req.param("key"));
        const project = r.js.projects.get(issue.project_id)!;
        const subtask = r.js.issueTypes.get(issue.issue_type_id)?.subtask ?? false;
        const fields = createFieldMeta(r, project, subtask).filter((field) => field.fieldId !== "project");
        return r.c.json({ fields: Object.fromEntries(fields.map((field) => [field.fieldId, field])) });
      },
      { scopes: READ },
    ),
  );
}

const OPERATIONS: Record<string, string[]> = {
  labels: ["add", "set", "remove"],
  components: ["add", "set", "remove"],
  fixVersions: ["add", "set", "remove"],
  comment: ["add"],
};

function createFieldMeta(r: JiraRequest, project: JiraProject, subtask: boolean) {
  const editable = new Set([
    "summary",
    "issuetype",
    "project",
    "description",
    "environment",
    "priority",
    "assignee",
    "reporter",
    "labels",
    "duedate",
    "parent",
    "components",
    "fixVersions",
  ]);
  const required = new Set(["summary", "issuetype", "project", ...(subtask ? ["parent"] : [])]);
  const allowed: Record<string, () => unknown[]> = {
    priority: () => r.js.priorities.all().map((priority) => formatPriority(r, priority)),
    issuetype: () => projectIssueTypes(r, project).map((type) => formatIssueType(r, type)),
    project: () => [
      { id: String(project.id), key: project.key, name: project.name, self: restUrl(r, `/project/${project.id}`) },
    ],
    components: () =>
      r.js.components.findBy("project_id", project.id).map((component) => formatComponent(r, component)),
    fixVersions: () => r.js.versions.findBy("project_id", project.id).map((version) => formatVersion(r, version)),
  };
  return allFields(r.js)
    .filter((field: FieldDef) => field.custom || editable.has(field.id))
    .map((field) => ({
      required: required.has(field.id),
      schema: field.schema,
      name: field.name,
      key: field.id,
      fieldId: field.id,
      hasDefaultValue: field.id === "priority" || field.id === "reporter",
      operations: OPERATIONS[field.id] ?? ["set"],
      ...(allowed[field.id] ? { allowedValues: allowed[field.id]() } : {}),
    }));
}
