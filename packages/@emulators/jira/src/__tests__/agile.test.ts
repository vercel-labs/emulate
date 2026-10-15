import { beforeEach, describe, expect, it } from "vitest";
import { api, createJiraTestApp, jiraTestBaseUrl, type JiraTestApp } from "./helpers.js";

const A = "/rest/agile/1.0";

describe("Jira Agile API", () => {
  let t: JiraTestApp;

  beforeEach(async () => {
    t = createJiraTestApp();
    for (const summary of ["Backlog item", "Another item"]) {
      await api(t.app, "/rest/api/3/issue", {
        method: "POST",
        body: { fields: { project: { key: "EMU" }, issuetype: { name: "Story" }, summary } },
      });
    }
  });

  it("lists and reads boards", async () => {
    const list = await api(t.app, `${A}/board?projectKeyOrId=EMU`);
    expect(list.status).toBe(200);
    expect(list.json.total).toBe(1);
    const board = list.json.values[0];
    expect(board).toMatchObject({ id: 1, name: "EMU board", type: "scrum" });
    expect(board.self).toBe(`${jiraTestBaseUrl}${A}/board/1`);
    expect(board.location.projectKey).toBe("EMU");

    const one = await api(t.app, `${A}/board/1`);
    expect(one.json.name).toBe("EMU board");
    expect((await api(t.app, `${A}/board/99`)).status).toBe(404);

    const config = await api(t.app, `${A}/board/1/configuration`);
    expect(config.json.columnConfig.columns.map((c: any) => c.name)).toEqual(["To Do", "In Progress", "Done"]);
  });

  it("creates and deletes boards", async () => {
    const created = await api(t.app, `${A}/board`, {
      method: "POST",
      body: { name: "Kanban", type: "kanban", location: { type: "project", projectKeyOrId: "EMU" } },
    });
    expect(created.status).toBe(201);
    expect(created.json.type).toBe("kanban");
    const deleted = await api(t.app, `${A}/board/${created.json.id}`, { method: "DELETE" });
    expect(deleted.status).toBe(204);
  });

  it("lists board issues, backlog, and sprints", async () => {
    const issues = await api(t.app, `${A}/board/1/issue?fields=summary`);
    expect(issues.status).toBe(200);
    expect(issues.json.total).toBe(3);

    const backlog = await api(t.app, `${A}/board/1/backlog`);
    expect(backlog.json.issues.map((i: any) => i.key).sort()).toEqual(["EMU-2", "EMU-3"]);

    const sprints = await api(t.app, `${A}/board/1/sprint?state=active`);
    expect(sprints.json.values).toHaveLength(1);
    expect(sprints.json.values[0]).toMatchObject({ id: 1, name: "EMU Sprint 1", state: "active", originBoardId: 1 });

    const filtered = await api(t.app, `${A}/board/1/issue?jql=summary~another`);
    expect(filtered.json.issues.map((i: any) => i.key)).toEqual(["EMU-3"]);
  });

  it("creates a sprint, moves issues into it, and runs its lifecycle", async () => {
    const created = await api(t.app, `${A}/sprint`, {
      method: "POST",
      body: { name: "Sprint 2", originBoardId: 1, goal: "Polish" },
    });
    expect(created.status).toBe(201);
    expect(created.json.state).toBe("future");
    const id = created.json.id;

    const move = await api(t.app, `${A}/sprint/${id}/issue`, { method: "POST", body: { issues: ["EMU-2", "EMU-3"] } });
    expect(move.status).toBe(204);
    const sprintIssues = await api(t.app, `${A}/sprint/${id}/issue`);
    expect(sprintIssues.json.issues.map((i: any) => i.key).sort()).toEqual(["EMU-2", "EMU-3"]);

    const issue = (await api(t.app, "/rest/api/3/issue/EMU-2")).json;
    expect(issue.fields.customfield_10020[0].name).toBe("Sprint 2");

    const longName = await api(t.app, `${A}/sprint/${id}`, { method: "POST", body: { name: "x".repeat(31) } });
    expect(longName.status).toBe(400);
    const badDate = await api(t.app, `${A}/sprint/${id}`, { method: "POST", body: { startDate: "soon" } });
    expect(badDate.status).toBe(400);

    const startWithoutDates = await api(t.app, `${A}/sprint/${id}`, { method: "POST", body: { state: "active" } });
    expect(startWithoutDates.status).toBe(400);

    const started = await api(t.app, `${A}/sprint/${id}`, {
      method: "POST",
      body: { state: "active", startDate: "2026-10-01T09:00:00.000Z", endDate: "2026-10-14T17:00:00.000Z" },
    });
    expect(started.status).toBe(200);
    expect(started.json.state).toBe("active");

    const done = (await api(t.app, "/rest/api/3/issue/EMU-2/transitions")).json.transitions.find(
      (tr: any) => tr.name === "Done",
    );
    await api(t.app, "/rest/api/3/issue/EMU-2/transitions", { method: "POST", body: { transition: { id: done.id } } });

    const closed = await api(t.app, `${A}/sprint/${id}`, { method: "POST", body: { state: "closed" } });
    expect(closed.json.state).toBe("closed");
    expect(closed.json.completeDate).toBeTruthy();

    // Completed issues stay in the closed sprint; open issues go back to the backlog.
    const backlog = await api(t.app, `${A}/board/1/backlog`);
    expect(backlog.json.issues.map((i: any) => i.key)).toEqual(["EMU-3"]);
    const changelog = await api(t.app, "/rest/api/3/issue/EMU-3/changelog");
    expect(changelog.json.values.at(-1).items[0]).toMatchObject({ field: "Sprint", fromString: "Sprint 2", to: null });
    const search = await api(t.app, "/rest/api/3/search/jql", {
      method: "POST",
      body: { jql: `sprint = ${id} ORDER BY key`, fields: ["summary"] },
    });
    expect(search.json.issues.map((i: any) => i.key)).toEqual(["EMU-2", "EMU-3"]);
    const open = await api(t.app, "/rest/api/3/search/jql", {
      method: "POST",
      body: { jql: "sprint in openSprints() ORDER BY key" },
    });
    expect(open.json.issues.map((i: any) => i.key)).toEqual(["EMU-1"]);

    const reopen = await api(t.app, `${A}/sprint/${id}`, { method: "POST", body: { state: "future" } });
    expect(reopen.status).toBe(400);
  });

  it("moves issues back to the backlog", async () => {
    const res = await api(t.app, `${A}/backlog/issue`, { method: "POST", body: { issues: ["EMU-1"] } });
    expect(res.status).toBe(204);
    const backlog = await api(t.app, `${A}/board/1/backlog`);
    expect(backlog.json.issues.map((i: any) => i.key)).toContain("EMU-1");
  });

  it("updates and deletes sprints", async () => {
    const created = await api(t.app, `${A}/sprint`, { method: "POST", body: { name: "Tmp", originBoardId: 1 } });
    const put = await api(t.app, `${A}/sprint/${created.json.id}`, {
      method: "PUT",
      body: { name: "Renamed", state: "future", goal: "New goal" },
    });
    expect(put.json.name).toBe("Renamed");
    expect(put.json.goal).toBe("New goal");
    expect((await api(t.app, `${A}/sprint/${created.json.id}`)).json.name).toBe("Renamed");
    expect((await api(t.app, `${A}/sprint/${created.json.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await api(t.app, `${A}/sprint/${created.json.id}`)).status).toBe(404);
  });

  it("reads issues and epic children through the agile API", async () => {
    const epic = await api(t.app, "/rest/api/3/issue", {
      method: "POST",
      body: { fields: { project: { key: "EMU" }, issuetype: { name: "Epic" }, summary: "Big epic" } },
    });
    await api(t.app, "/rest/api/3/issue/EMU-2", {
      method: "PUT",
      body: { fields: { parent: { key: epic.json.key } } },
    });

    const issue = await api(t.app, `${A}/issue/EMU-2`);
    expect(issue.json.key).toBe("EMU-2");
    const children = await api(t.app, `${A}/epic/${epic.json.key}/issue`);
    expect(children.json.issues.map((i: any) => i.key)).toEqual(["EMU-2"]);
    const board = await api(t.app, `${A}/board/1/epic`);
    expect(board.json.values.map((e: any) => e.key)).toEqual([epic.json.key]);
  });

  it("serves the same endpoints under the /rest/software/1.0 alias", async () => {
    const sprintIssues = await api(t.app, "/rest/software/1.0/sprint/1/issue");
    expect(sprintIssues.status).toBe(200);
    expect(sprintIssues.json.issues.map((i: any) => i.key)).toEqual(["EMU-1"]);
    const backlog = await api(t.app, "/rest/software/1.0/board/1/backlog");
    expect(backlog.json.total).toBe(2);
    const move = await api(t.app, "/rest/agile/1.0/backlog/1/issue", { method: "POST", body: { issues: ["EMU-1"] } });
    expect(move.status).toBe(204);
  });
});
