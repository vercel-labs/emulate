import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgileClient, createCloudClient } from "jira.js";
import { DEFAULT_ADMIN_EMAIL, DEFAULT_API_TOKEN, DEFAULT_CLOUD_ID, getJiraStore } from "../index.js";
import { adf, startJiraTestEmulator, type JiraTestEmulator } from "./helpers.js";

/**
 * Drives the emulator through jira.js over a real local server with `onSchemaMismatch: "throw"`,
 * so every response is validated against the client's Jira Cloud schemas.
 */
describe("jira.js conformance", () => {
  let t: JiraTestEmulator;
  let config: {
    host: string;
    auth: { type: "basic"; email: string; apiToken: string };
    onSchemaMismatch: "throw";
    retry: { maxAttempts: number };
  };

  beforeEach(async () => {
    t = await startJiraTestEmulator();
    config = {
      host: t.url,
      auth: { type: "basic", email: DEFAULT_ADMIN_EMAIL, apiToken: DEFAULT_API_TOKEN },
      onSchemaMismatch: "throw",
      retry: { maxAttempts: 1 },
    };
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await t.close();
  });

  it("covers the core issue workflow with basic auth", async () => {
    const client = createCloudClient(config);

    const me = await client.myself.getCurrentUser();
    expect(me.emailAddress).toBe(DEFAULT_ADMIN_EMAIL);

    const info = await client.serverInfo.getServerInfo();
    expect(info.deploymentType).toBe("Cloud");

    const projects = await client.projects.searchProjects();
    expect(projects.values?.[0]?.key).toBe("EMU");

    const types = await client.issues.getCreateIssueMetaIssueTypes({ projectIdOrKey: "EMU" });
    const bug = types.issueTypes?.find((type) => type.name === "Bug");
    expect(bug).toBeTruthy();
    const meta = await client.issues.getCreateIssueMetaIssueTypeId({ projectIdOrKey: "EMU", issueTypeId: bug!.id! });
    expect(meta.fields?.some((field) => field.fieldId === "summary")).toBe(true);

    const created = await client.issues.createIssue({
      fields: {
        project: { key: "EMU" },
        issuetype: { name: "Bug" },
        summary: "Created through jira.js",
        description: adf("SDK description"),
        labels: ["sdk"],
      },
    });
    expect(created.key).toBe("EMU-2");

    const issue = await client.issues.getIssue({ issueIdOrKey: created.key! });
    expect(issue.fields!.summary).toBe("Created through jira.js");
    expect(issue.fields!.labels).toEqual(["sdk"]);

    await client.issues.editIssue({ issueIdOrKey: created.key!, fields: { summary: "Edited through jira.js" } });

    const transitions = await client.issues.getTransitions({ issueIdOrKey: created.key! });
    const done = transitions.transitions?.find((transition) => transition.name === "Done");
    await client.issues.doTransition({ issueIdOrKey: created.key!, transition: { id: done!.id } });

    await client.issues.assignIssue({ issueIdOrKey: created.key!, accountId: me.accountId });

    const comment = await client.issueComments.addComment({ issueIdOrKey: created.key!, body: adf("SDK comment") });
    expect(comment.id).toBeTruthy();
    const comments = await client.issueComments.getComments({ issueIdOrKey: created.key! });
    expect(comments.total).toBe(1);

    await client.issueLinks.linkIssues({
      type: { name: "Relates" },
      inwardIssue: { key: "EMU-1" },
      outwardIssue: { key: created.key },
    });

    const worklog = await client.issueWorklogs.addWorklog({ issueIdOrKey: created.key!, timeSpent: "2h" });
    expect(worklog.timeSpentSeconds).toBe(7200);

    const changelog = await client.issues.getChangeLogs({ issueIdOrKey: created.key! });
    expect(changelog.values?.length).toBeGreaterThan(0);

    const search = await client.issueSearch.searchAndReconsileIssuesUsingJqlPost({
      jql: "project = EMU AND status = Done",
      fields: ["summary", "status", "assignee"],
    });
    expect(search.issues?.map((result) => result.key)).toEqual([created.key]);
    expect(search.issues?.[0].fields?.summary).toBe("Edited through jira.js");

    const count = await client.issueSearch.countIssues({ jql: "project = EMU" });
    expect(count.count).toBe(2);

    const fields = await client.issueFields.getFields();
    expect(fields.some((field) => field.id === "summary")).toBe(true);
    await client.issuePriorities.searchPriorities();
    await client.issueTypes.getIssueAllTypes();
    await client.workflowStatuses.getStatuses();
    await client.issueLinkTypes.getIssueLinkTypes();
    await client.userSearch.findUsers({ query: "dev" });
    await client.issueWatchers.getIssueWatchers({ issueIdOrKey: created.key! });

    await client.issues.deleteIssue({ issueIdOrKey: created.key! });
    expect(getJiraStore(t.store).issues.findOneBy("key", created.key!)).toBeUndefined();
  });

  it("maps Jira errors to typed jira.js errors", async () => {
    const client = createCloudClient(config);
    await expect(client.issues.getIssue({ issueIdOrKey: "EMU-404" })).rejects.toMatchObject({ status: 404 });

    const badAuth = createCloudClient({ ...config, auth: { ...config.auth, apiToken: "wrong" } });
    await expect(badAuth.myself.getCurrentUser()).rejects.toMatchObject({ status: 401 });
  });

  it("drives boards and sprints through the agile client", async () => {
    const agile = createAgileClient(config);
    const boards = await agile.board.getAllBoards();
    const boardId = boards.values?.[0]?.id;
    expect(boardId).toBe(1);

    const sprints = await agile.board.getAllSprints({ boardId: boardId! });
    expect(sprints.values?.[0]?.state).toBe("active");

    const sprint = await agile.sprint.createSprint({ name: "SDK sprint", originBoardId: boardId! });
    expect(sprint.state).toBe("future");
    await agile.sprint.moveIssuesToSprintAndRank({ sprintId: sprint.id!, issues: ["EMU-1"] });
    const sprintIssues = await agile.sprint.getIssuesForSprint({ sprintId: sprint.id! });
    expect(sprintIssues.issues?.map((issue) => issue.key)).toEqual(["EMU-1"]);

    await agile.backlog.moveIssuesToBacklog({ issues: ["EMU-1"] });
    const backlog = await agile.board.getIssuesForBacklog({ boardId: boardId! });
    expect(backlog.issues?.map((issue) => issue.key)).toEqual(["EMU-1"]);
  });

  it("works over OAuth 2.0 through the api.atlassian.com gateway", async () => {
    const js = getJiraStore(t.store);
    const admin = js.users.findOneBy("email", DEFAULT_ADMIN_EMAIL)!;
    js.oauthTokens.insert({
      token: "jira_sdk_oauth",
      type: "access",
      account_id: admin.account_id,
      client_id: "jira_example_client_id",
      scopes: ["read:jira-work", "write:jira-work", "read:jira-user"],
      expires_at: null,
      revoked: false,
    });
    // jira.js hardcodes https://api.atlassian.com/ex/jira/{cloudId} for OAuth 2.0, so only that host is
    // rerouted to the local server. The request still goes over HTTP through the full middleware stack.
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.hostname !== "api.atlassian.com") return realFetch(request);
      return realFetch(new Request(`${t.url}${url.pathname}${url.search}`, request));
    });
    const client = createCloudClient({
      auth: { type: "oauth2", accessToken: "jira_sdk_oauth", cloudId: DEFAULT_CLOUD_ID },
      onSchemaMismatch: "throw",
      retry: { maxAttempts: 1 },
    });
    const me = await client.myself.getCurrentUser();
    expect(me.emailAddress).toBe(DEFAULT_ADMIN_EMAIL);
    const issue = await client.issues.getIssue({ issueIdOrKey: "EMU-1" });
    expect(issue.self).toContain(`/ex/jira/${DEFAULT_CLOUD_ID}/rest/api/3/issue/`);
  });
});
