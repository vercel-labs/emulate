import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_ADMIN_EMAIL, DEFAULT_API_TOKEN } from "../index.js";
import { api, basicAuth, createJiraTestApp, jiraTestBaseUrl, type JiraTestApp } from "./helpers.js";

describe("Jira platform basics", () => {
  let t: JiraTestApp;

  beforeEach(() => {
    t = createJiraTestApp();
  });

  it("serves serverInfo without authentication", async () => {
    const res = await api(t.app, "/rest/api/3/serverInfo", { auth: null });
    expect(res.status).toBe(200);
    expect(res.json.baseUrl).toBe(jiraTestBaseUrl);
    expect(res.json.deploymentType).toBe("Cloud");
    expect(Array.isArray(res.json.versionNumbers)).toBe(true);
  });

  it("rejects unauthenticated REST calls with a Jira error body", async () => {
    const res = await api(t.app, "/rest/api/3/myself", { auth: null });
    expect(res.status).toBe(401);
    expect(res.json.errorMessages).toEqual(["Client must be authenticated to access this resource."]);
    expect(res.json.errors).toEqual({});
  });

  it("rejects basic auth with a wrong API token", async () => {
    const res = await api(t.app, "/rest/api/3/myself", { auth: basicAuth(DEFAULT_ADMIN_EMAIL, "wrong") });
    expect(res.status).toBe(401);
  });

  it("returns the current user for basic auth with email and API token", async () => {
    const res = await api(t.app, "/rest/api/3/myself");
    expect(res.status).toBe(200);
    expect(res.json.emailAddress).toBe(DEFAULT_ADMIN_EMAIL);
    expect(res.json.accountType).toBe("atlassian");
    expect(res.json.active).toBe(true);
    expect(typeof res.json.accountId).toBe("string");
    expect(res.json.self).toBe(`${jiraTestBaseUrl}/rest/api/3/user?accountId=${res.json.accountId}`);
    expect(res.json.avatarUrls["48x48"]).toBeTruthy();
  });

  it("accepts the API token as a bearer token", async () => {
    const res = await api(t.app, "/rest/api/3/myself", { auth: `Bearer ${DEFAULT_API_TOKEN}` });
    expect(res.status).toBe(200);
    expect(res.json.emailAddress).toBe(DEFAULT_ADMIN_EMAIL);
  });

  it("serves the same resources under REST API v2", async () => {
    const res = await api(t.app, "/rest/api/2/myself");
    expect(res.status).toBe(200);
    expect(res.json.self).toContain("/rest/api/2/user?accountId=");
  });

  it("returns Jira shaped 404s for unknown REST routes", async () => {
    const res = await api(t.app, "/rest/api/3/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.json.errorMessages.length).toBeGreaterThan(0);
  });
});
