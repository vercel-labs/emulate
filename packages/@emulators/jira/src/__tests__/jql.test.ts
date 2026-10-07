import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_DEV_EMAIL, getJiraStore, type JiraStore } from "../index.js";
import { JqlError, parseJql, searchIssues } from "../jql.js";
import { adf, api, createJiraTestApp, type JiraTestApp } from "./helpers.js";

describe("JQL parser", () => {
  it("parses clauses, boolean logic, and ORDER BY", () => {
    const q = parseJql(
      'project = EMU AND (status = "In Progress" OR labels IN (a, b)) AND NOT assignee IS EMPTY ORDER BY created DESC, key',
    );
    expect(q.where).not.toBeNull();
    expect(q.orderBy).toEqual([
      { field: "created", direction: "DESC" },
      { field: "key", direction: "ASC" },
    ]);
  });

  it("parses an empty query and an ORDER BY only query", () => {
    expect(parseJql("").where).toBeNull();
    const orderOnly = parseJql("order by updated asc");
    expect(orderOnly.where).toBeNull();
    expect(orderOnly.orderBy).toEqual([{ field: "updated", direction: "ASC" }]);
  });

  it("reports syntax errors", () => {
    expect(() => parseJql("project =")).toThrow(JqlError);
    expect(() => parseJql("project = EMU AND")).toThrow(/Error in the JQL Query/);
    expect(() => parseJql('summary ~ "unterminated')).toThrow(JqlError);
    expect(() => parseJql("(project = EMU")).toThrow(JqlError);
  });
});

describe("JQL evaluation", () => {
  let t: JiraTestApp;
  let js: JiraStore;
  let devId: string;

  const keys = (jql: string, userEmail = "admin@jira.local") => {
    const user = js.users.findOneBy("email", userEmail)!;
    return searchIssues(js, jql, user).map((issue) => issue.key);
  };

  beforeEach(async () => {
    t = createJiraTestApp();
    js = getJiraStore(t.store);
    devId = js.users.findOneBy("email", DEFAULT_DEV_EMAIL)!.account_id;
    await api(t.app, "/rest/api/3/project", {
      method: "POST",
      body: { key: "OPS", name: "Operations", projectTypeKey: "software" },
    });
    const create = (fields: Record<string, unknown>) =>
      api(t.app, "/rest/api/3/issue", {
        method: "POST",
        body: { fields: { project: { key: "EMU" }, issuetype: { name: "Task" }, ...fields } },
      });
    await create({
      summary: "Login page crashes",
      issuetype: { name: "Bug" },
      priority: { name: "High" },
      labels: ["frontend"],
    }); // EMU-2
    await create({
      summary: "Add dark mode",
      description: adf("Users want a dark theme"),
      labels: ["frontend", "ux"],
      duedate: "2026-10-15",
    }); // EMU-3
    await create({
      summary: "Database migration",
      assignee: { accountId: devId },
      customfield_10016: 8,
      priority: { name: "Low" },
    }); // EMU-4
    await create({ summary: "Ops runbook", project: { key: "OPS" } }); // OPS-1
    await create({ summary: "Child task", issuetype: { name: "Subtask" }, parent: { key: "EMU-2" } }); // EMU-5
    const done = (await api(t.app, "/rest/api/3/issue/EMU-4/transitions")).json.transitions.find(
      (tr: any) => tr.name === "Done",
    );
    await api(t.app, "/rest/api/3/issue/EMU-4/transitions", { method: "POST", body: { transition: { id: done.id } } });
  });

  it("filters by project, key, and id", () => {
    expect(keys("project = OPS")).toEqual(["OPS-1"]);
    expect(keys("project in (EMU, OPS) AND key = OPS-1")).toEqual(["OPS-1"]);
    expect(keys("issuekey in (EMU-2, EMU-3) ORDER BY key ASC")).toEqual(["EMU-2", "EMU-3"]);
    expect(keys("id = 10000")).toEqual(["EMU-1"]);
    expect(keys('project = "Operations"')).toEqual(["OPS-1"]);
  });

  it("filters by status, status category, and resolution", () => {
    expect(keys('status = "Done"')).toEqual(["EMU-4"]);
    expect(keys("status != Done AND project = EMU ORDER BY key ASC")).toEqual(["EMU-1", "EMU-2", "EMU-3", "EMU-5"]);
    expect(keys("statusCategory = Done")).toEqual(["EMU-4"]);
    expect(keys("statusCategory != done AND project = OPS")).toEqual(["OPS-1"]);
    expect(keys("resolution = Unresolved AND project = OPS")).toEqual(["OPS-1"]);
    expect(keys("resolution is not EMPTY")).toEqual(["EMU-4"]);
  });

  it("filters by users with currentUser() and EMPTY", () => {
    expect(keys("assignee = currentUser() ORDER BY key", DEFAULT_DEV_EMAIL)).toEqual(["EMU-1", "EMU-4"]);
    expect(keys(`assignee = "${devId}" ORDER BY key`)).toEqual(["EMU-1", "EMU-4"]);
    expect(keys(`assignee = "${DEFAULT_DEV_EMAIL}" ORDER BY key`)).toEqual(["EMU-1", "EMU-4"]);
    expect(keys("assignee is EMPTY AND project = OPS")).toEqual(["OPS-1"]);
    expect(keys("reporter = currentUser() AND project = OPS")).toEqual(["OPS-1"]);
    expect(keys("watcher = currentUser() AND project = OPS")).toEqual(["OPS-1"]);
  });

  it("filters by text with ~ and !~", () => {
    expect(keys('summary ~ "crash"')).toEqual(["EMU-2"]);
    expect(keys('summary ~ "login crash*"')).toEqual(["EMU-2"]);
    expect(keys('description ~ "dark theme"')).toEqual(["EMU-3"]);
    expect(keys('text ~ "dark" ORDER BY key')).toEqual(["EMU-3"]);
    expect(keys('project = EMU AND summary !~ "task" ORDER BY key')).toEqual(["EMU-1", "EMU-2", "EMU-3", "EMU-4"]);
    expect(keys('summary ~ "\\"dark mode\\""')).toEqual(["EMU-3"]);
    expect(keys('comment ~ "seeded"')).toEqual(["EMU-1"]);
  });

  it("filters by labels, issue type, priority, and parent", () => {
    expect(keys("labels = frontend ORDER BY key")).toEqual(["EMU-2", "EMU-3"]);
    expect(keys("labels in (ux, emulate) ORDER BY key")).toEqual(["EMU-1", "EMU-3"]);
    expect(keys("labels is EMPTY AND project = EMU ORDER BY key")).toEqual(["EMU-4", "EMU-5"]);
    expect(keys("issuetype = Bug")).toEqual(["EMU-2"]);
    expect(keys("type in subTaskIssueTypes()")).toEqual(["EMU-5"]);
    expect(keys("priority = High")).toEqual(["EMU-2"]);
    expect(keys("priority > Medium")).toEqual(["EMU-2"]);
    expect(keys("priority <= Low")).toEqual(["EMU-4"]);
    expect(keys("parent = EMU-2")).toEqual(["EMU-5"]);
  });

  it("filters by dates, relative dates, and date functions", () => {
    expect(keys('duedate = "2026-10-15"')).toEqual(["EMU-3"]);
    expect(keys('duedate < "2026-10-16" AND duedate >= 2026-10-15')).toEqual(["EMU-3"]);
    expect(keys("created >= -1d AND project = OPS")).toEqual(["OPS-1"]);
    expect(keys("created < -1d")).toEqual([]);
    expect(keys("created >= startOfDay() AND project = OPS")).toEqual(["OPS-1"]);
    expect(keys("updated <= now() AND project = OPS")).toEqual(["OPS-1"]);
    expect(keys("resolutiondate >= startOfDay(-1d)")).toEqual(["EMU-4"]);
    expect(keys("created >= startOfMonth(-1) AND project = OPS")).toEqual(["OPS-1"]);
    expect(keys("created >= startOfYear(-1y) AND project = OPS")).toEqual(["OPS-1"]);
    expect(keys("created > -1M AND project = OPS")).toEqual(["OPS-1"]);
    expect(keys("created < startOfMonth(-1)")).toEqual([]);
    expect(keys("created < -1y")).toEqual([]);
  });

  it("filters by sprint and custom fields", () => {
    expect(keys("sprint in openSprints()")).toEqual(["EMU-1"]);
    expect(keys('sprint = "EMU Sprint 1"')).toEqual(["EMU-1"]);
    expect(keys("sprint = 1")).toEqual(["EMU-1"]);
    expect(keys("sprint is EMPTY AND project = OPS")).toEqual(["OPS-1"]);
    expect(keys("cf[10016] > 5")).toEqual(["EMU-4"]);
    expect(keys('"Story point estimate" = 8')).toEqual(["EMU-4"]);
  });

  it("supports NOT, OR, and parentheses", () => {
    expect(keys("project = EMU AND NOT (labels = frontend OR status = Done) ORDER BY key")).toEqual(["EMU-1", "EMU-5"]);
    expect(keys("issuetype = Bug OR project = OPS ORDER BY key")).toEqual(["EMU-2", "OPS-1"]);
  });

  it("orders results", () => {
    expect(keys("project = EMU ORDER BY key DESC")).toEqual(["EMU-5", "EMU-4", "EMU-3", "EMU-2", "EMU-1"]);
    expect(keys("project = EMU AND priority is not EMPTY ORDER BY priority DESC, key ASC")[0]).toBe("EMU-2");
    expect(keys("project = EMU ORDER BY summary ASC")[0]).toBe("EMU-3");
    expect(keys("project = EMU ORDER BY rank ASC")).toEqual(["EMU-1", "EMU-2", "EMU-3", "EMU-4", "EMU-5"]);
    expect(() => searchIssues(js, "project = EMU ORDER BY bogus", js.users.all()[0])).toThrow(
      "Field 'bogus' does not exist or you do not have permission to view it.",
    );
  });

  it("accepts every clause name for a field", () => {
    expect(keys("type = Bug")).toEqual(keys("issuetype = Bug"));
    expect(keys("label = frontend ORDER BY key")).toEqual(keys("labels = frontend ORDER BY key"));
    expect(keys("issue = EMU-2")).toEqual(["EMU-2"]);
    expect(keys("id = EMU-2")).toEqual(["EMU-2"]);
    expect(keys("watchers = currentUser() AND project = OPS")).toEqual(["OPS-1"]);
    expect(() => searchIssues(js, "rank = 1", js.users.all()[0])).toThrow(JqlError);
  });

  it("finds linked issues", async () => {
    await api(t.app, "/rest/api/3/issueLink", {
      method: "POST",
      body: { type: { name: "Blocks" }, inwardIssue: { key: "EMU-1" }, outwardIssue: { key: "EMU-3" } },
    });
    expect(keys("issue in linkedIssues(EMU-1)")).toEqual(["EMU-3"]);
    expect(keys('issue in linkedIssues(EMU-3, "is blocked by")')).toEqual([]);
    expect(keys('issue in linkedIssues(EMU-3, "blocks")')).toEqual(["EMU-1"]);
  });

  it("rejects unknown fields, values, and functions", () => {
    const user = js.users.all()[0];
    expect(() => searchIssues(js, "bogus = 1", user)).toThrow(
      "Field 'bogus' does not exist or you do not have permission to view it.",
    );
    expect(() => searchIssues(js, "project = NOPE", user)).toThrow(
      "The value 'NOPE' does not exist for the field 'project'.",
    );
    expect(() => searchIssues(js, "status = Blocked", user)).toThrow(
      "The value 'Blocked' does not exist for the field 'status'.",
    );
    expect(() => searchIssues(js, "assignee = noSuchFn()", user)).toThrow("Unable to find JQL function 'noSuchFn()'.");
  });
});

describe("search endpoints", () => {
  let t: JiraTestApp;

  beforeEach(async () => {
    t = createJiraTestApp();
    for (const summary of ["one", "two", "three"]) {
      await api(t.app, "/rest/api/3/issue", {
        method: "POST",
        body: { fields: { project: { key: "EMU" }, issuetype: { name: "Task" }, summary } },
      });
    }
  });

  it("paginates /search/jql with nextPageToken and requested fields", async () => {
    const first = await api(
      t.app,
      "/rest/api/3/search/jql?jql=project%3DEMU%20ORDER%20BY%20key%20ASC&maxResults=3&fields=summary,status",
    );
    expect(first.status).toBe(200);
    expect(first.json.issues.map((i: any) => i.key)).toEqual(["EMU-1", "EMU-2", "EMU-3"]);
    expect(Object.keys(first.json.issues[0].fields).sort()).toEqual(["status", "summary"]);
    expect(first.json.isLast).toBe(false);
    expect(first.json.nextPageToken).toBeTruthy();

    const second = await api(t.app, "/rest/api/3/search/jql", {
      method: "POST",
      body: { jql: "project = EMU ORDER BY key ASC", maxResults: 3, nextPageToken: first.json.nextPageToken },
    });
    expect(second.json.issues.map((i: any) => i.key)).toEqual(["EMU-4"]);
    expect(second.json.isLast).toBe(true);
    expect(second.json.nextPageToken).toBeUndefined();
  });

  it("returns only ids by default from /search/jql", async () => {
    const res = await api(t.app, "/rest/api/3/search/jql?jql=project%3DEMU");
    expect(res.json.issues[0].id).toBeTruthy();
    expect(res.json.issues[0].fields).toEqual({});
  });

  it("rejects unbounded /search/jql queries and bad JQL", async () => {
    const unbounded = await api(t.app, "/rest/api/3/search/jql", { method: "POST", body: { jql: "order by created" } });
    expect(unbounded.status).toBe(400);
    expect(unbounded.json.errorMessages[0]).toContain("Unbounded JQL queries are not allowed");

    const bad = await api(t.app, "/rest/api/3/search/jql", { method: "POST", body: { jql: "project = NOPE" } });
    expect(bad.status).toBe(400);
    expect(bad.json.errorMessages).toEqual(["The value 'NOPE' does not exist for the field 'project'."]);
  });

  it("serves the legacy /search endpoint with startAt and total", async () => {
    const res = await api(
      t.app,
      "/rest/api/2/search?jql=project%3DEMU%20ORDER%20BY%20key%20ASC&startAt=1&maxResults=2",
    );
    expect(res.status).toBe(200);
    expect(res.json.total).toBe(4);
    expect(res.json.startAt).toBe(1);
    expect(res.json.issues.map((i: any) => i.key)).toEqual(["EMU-2", "EMU-3"]);
    expect(res.json.issues[0].fields.summary).toBe("one");

    const post = await api(t.app, "/rest/api/3/search", {
      method: "POST",
      body: { jql: "summary ~ two", fields: ["summary"], expand: ["names"] },
    });
    expect(post.json.total).toBe(1);
    expect(post.json.names.summary).toBe("Summary");
  });

  it("returns an approximate count", async () => {
    const res = await api(t.app, "/rest/api/3/search/approximate-count", {
      method: "POST",
      body: { jql: "project = EMU" },
    });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ count: 4 });
  });

  it("serves the issue picker", async () => {
    const res = await api(t.app, "/rest/api/3/issue/picker?query=thr");
    expect(res.status).toBe(200);
    expect(res.json.sections[0].issues.map((i: any) => i.key)).toEqual(["EMU-4"]);
  });
});
