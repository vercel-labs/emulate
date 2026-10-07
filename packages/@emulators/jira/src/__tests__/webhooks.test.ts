import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getJiraStore } from "../index.js";
import { adf, api, createJiraTestApp, type JiraTestApp } from "./helpers.js";

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: string;
  json: any;
}

describe("Jira webhooks", () => {
  let t: JiraTestApp;
  let originalFetch: typeof fetch;
  let captured: Captured[];

  beforeEach(() => {
    t = createJiraTestApp();
    originalFetch = globalThis.fetch;
    captured = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const body = String(init?.body ?? "");
      captured.push({
        url,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body,
        json: body ? JSON.parse(body) : undefined,
      });
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const register = (body: Record<string, unknown>) =>
    api(t.app, "/rest/webhooks/1.0/webhook", { method: "POST", body });

  const createIssue = (summary: string, project = "EMU") =>
    api(t.app, "/rest/api/3/issue", {
      method: "POST",
      body: { fields: { project: { key: project }, issuetype: { name: "Task" }, summary } },
    });

  it("manages admin webhooks", async () => {
    const created = await register({
      name: "My hook",
      url: "https://example.test/hook",
      events: ["jira:issue_created"],
      filters: { "issue-related-events-section": "project = EMU" },
    });
    expect(created.status).toBe(201);
    expect(created.json.name).toBe("My hook");
    expect(created.json.enabled).toBe(true);
    expect(created.json.self).toMatch(/\/rest\/webhooks\/1\.0\/webhook\/\d+$/);
    const id = created.json.self.split("/").pop();

    const list = await api(t.app, "/rest/webhooks/1.0/webhook");
    expect(list.json).toHaveLength(1);

    const updated = await api(t.app, `/rest/webhooks/1.0/webhook/${id}`, {
      method: "PUT",
      body: { name: "Renamed", url: "https://example.test/hook2", events: ["jira:issue_updated"], enabled: false },
    });
    expect(updated.json.name).toBe("Renamed");
    expect(updated.json.enabled).toBe(false);

    const deleted = await api(t.app, `/rest/webhooks/1.0/webhook/${id}`, { method: "DELETE" });
    expect(deleted.status).toBe(204);
    expect((await api(t.app, `/rest/webhooks/1.0/webhook/${id}`)).status).toBe(404);
  });

  it("validates webhook registrations", async () => {
    const noUrl = await register({ name: "x", events: ["jira:issue_created"] });
    expect(noUrl.status).toBe(400);
    const badEvent = await register({ name: "x", url: "https://example.test", events: ["jira:bogus"] });
    expect(badEvent.status).toBe(400);
    const badJql = await register({
      name: "x",
      url: "https://example.test",
      events: ["jira:issue_created"],
      filters: { "issue-related-events-section": "project = NOPE" },
    });
    expect(badJql.status).toBe(400);
  });

  it("delivers signed issue_created payloads that match the JQL filter", async () => {
    await register({
      name: "Signed",
      url: "https://example.test/hook",
      events: ["jira:issue_created"],
      filters: { "issue-related-events-section": "project = EMU" },
      secret: "s3cret",
    });
    await api(t.app, "/rest/api/3/project", {
      method: "POST",
      body: { key: "OPS", name: "Ops", projectTypeKey: "software" },
    });
    await createIssue("Ignored", "OPS");
    expect(captured).toHaveLength(0);

    const res = await createIssue("Delivered");
    expect(captured).toHaveLength(1);
    const delivery = captured[0];
    expect(delivery.url).toBe("https://example.test/hook");
    expect(delivery.json.webhookEvent).toBe("jira:issue_created");
    expect(delivery.json.issue_event_type_name).toBe("issue_created");
    expect(delivery.json.issue.key).toBe(res.json.key);
    expect(delivery.json.issue.fields.summary).toBe("Delivered");
    expect(delivery.json.user.emailAddress).toBe("admin@jira.local");
    expect(typeof delivery.json.timestamp).toBe("number");
    const expected = createHmac("sha256", "s3cret").update(delivery.body).digest("hex");
    expect(delivery.headers["x-hub-signature"]).toBe(`sha256=${expected}`);
    expect(delivery.headers["x-atlassian-webhook-identifier"]).toBeTruthy();

    const stored = getJiraStore(t.store).webhookDeliveries.all();
    expect(stored).toHaveLength(1);
    expect(stored[0].status).toBe(200);
  });

  it("delivers issue_updated with changelog and transition event types", async () => {
    await register({ name: "Updates", url: "https://example.test/u", events: ["jira:issue_updated"] });

    await api(t.app, "/rest/api/3/issue/EMU-1", { method: "PUT", body: { fields: { summary: "Changed" } } });
    expect(captured).toHaveLength(1);
    expect(captured[0].json.issue_event_type_name).toBe("issue_updated");
    expect(captured[0].json.changelog.items[0]).toMatchObject({ field: "summary", toString: "Changed" });

    const done = (await api(t.app, "/rest/api/3/issue/EMU-1/transitions")).json.transitions.find(
      (tr: any) => tr.name === "Done",
    );
    await api(t.app, "/rest/api/3/issue/EMU-1/transitions", { method: "POST", body: { transition: { id: done.id } } });
    expect(captured[1].json.issue_event_type_name).toBe("issue_generic");
    expect(captured[1].json.issue.fields.status.name).toBe("Done");

    const me = (await api(t.app, "/rest/api/3/myself")).json;
    await api(t.app, "/rest/api/3/issue/EMU-1/assignee", { method: "PUT", body: { accountId: me.accountId } });
    expect(captured[2].json.issue_event_type_name).toBe("issue_assigned");
  });

  it("sends one issue_updated for an edit that changes a field and adds a comment", async () => {
    await register({
      name: "Edits",
      url: "https://example.test/e",
      events: ["comment_created", "jira:issue_updated"],
    });
    await api(t.app, "/rest/api/3/issue/EMU-1", {
      method: "PUT",
      body: { fields: { summary: "Changed" }, update: { comment: [{ add: { body: adf("Why") } }] } },
    });
    expect(captured.map((c) => c.json.webhookEvent)).toEqual(["comment_created", "jira:issue_updated"]);
    expect(captured[1].json.issue_event_type_name).toBe("issue_updated");
    expect(captured[1].json.changelog.items[0]).toMatchObject({ field: "summary", toString: "Changed" });
    expect(captured[1].json.comment.body).toBe("Why");
  });

  it("delivers comment events and the matching issue_commented update", async () => {
    await register({
      name: "Comments",
      url: "https://example.test/c",
      events: ["comment_created", "comment_updated", "comment_deleted", "jira:issue_updated"],
    });
    const created = await api(t.app, "/rest/api/3/issue/EMU-1/comment", { method: "POST", body: { body: adf("Hi") } });
    const events = captured.map((c) => c.json.webhookEvent);
    expect(events).toEqual(["comment_created", "jira:issue_updated"]);
    expect(captured[0].json.comment.id).toBe(created.json.id);
    expect(captured[0].json.issue.key).toBe("EMU-1");
    expect(captured[1].json.issue_event_type_name).toBe("issue_commented");

    await api(t.app, `/rest/api/3/issue/EMU-1/comment/${created.json.id}`, {
      method: "PUT",
      body: { body: adf("Edit") },
    });
    await api(t.app, `/rest/api/3/issue/EMU-1/comment/${created.json.id}`, { method: "DELETE" });
    expect(captured.map((c) => c.json.webhookEvent).slice(2)).toEqual(["comment_updated", "comment_deleted"]);
  });

  it("delivers issue_deleted and skips disabled webhooks", async () => {
    await register({ name: "Deletes", url: "https://example.test/d", events: ["jira:issue_deleted"] });
    await register({ name: "Off", url: "https://example.test/off", events: ["jira:issue_deleted"], enabled: false });
    await api(t.app, "/rest/api/3/issue/EMU-1", { method: "DELETE" });
    expect(captured).toHaveLength(1);
    expect(captured[0].json.webhookEvent).toBe("jira:issue_deleted");
    expect(captured[0].json.issue.key).toBe("EMU-1");
  });

  it("omits the body when excludeBody is set", async () => {
    await register({
      name: "NoBody",
      url: "https://example.test/n",
      events: ["jira:issue_created"],
      excludeBody: true,
    });
    await createIssue("x");
    expect(captured).toHaveLength(1);
    expect(captured[0].body).toBe("");
  });

  it("records failed deliveries", async () => {
    globalThis.fetch = (async () => {
      throw new Error("connection refused");
    }) as typeof fetch;
    await register({ name: "Down", url: "https://example.test/down", events: ["jira:issue_created"] });
    const res = await createIssue("still created");
    expect(res.status).toBe(201);
    const [delivery] = getJiraStore(t.store).webhookDeliveries.all();
    expect(delivery.status).toBeNull();
    expect(delivery.error).toContain("connection refused");
  });

  describe("dynamic webhooks", () => {
    const oauth = "Bearer jira_oauth_dynamic";

    beforeEach(() => {
      const js = getJiraStore(t.store);
      const admin = js.users.findOneBy("email", "admin@jira.local")!;
      js.oauthTokens.insert({
        token: "jira_oauth_dynamic",
        type: "access",
        account_id: admin.account_id,
        client_id: "jira_example_client_id",
        scopes: ["read:jira-work", "manage:jira-webhook"],
        expires_at: null,
        revoked: false,
      });
    });

    it("registers, lists, refreshes, and deletes webhooks for OAuth apps", async () => {
      const created = await api(t.app, "/rest/api/3/webhook", {
        method: "POST",
        auth: oauth,
        body: {
          url: "https://app.test/webhook",
          webhooks: [
            { events: ["jira:issue_created"], jqlFilter: "project = EMU" },
            { events: ["jira:bogus"], jqlFilter: "project = EMU" },
          ],
        },
      });
      expect(created.status).toBe(200);
      const [ok, failed] = created.json.webhookRegistrationResult;
      expect(ok.createdWebhookId).toBeTruthy();
      expect(failed.errors.length).toBeGreaterThan(0);

      const list = await api(t.app, "/rest/api/3/webhook", { auth: oauth });
      expect(list.json.total).toBe(1);
      expect(list.json.values[0]).toMatchObject({
        id: ok.createdWebhookId,
        jqlFilter: "project = EMU",
        events: ["jira:issue_created"],
      });
      expect(list.json.values[0].expirationDate).toBeTruthy();

      await createIssue("dynamic");
      expect(captured).toHaveLength(1);
      expect(captured[0].url).toBe("https://app.test/webhook");
      expect(captured[0].json.matchedWebhookIds).toEqual([ok.createdWebhookId]);

      const refreshed = await api(t.app, "/rest/api/3/webhook/refresh", {
        method: "PUT",
        auth: oauth,
        body: { webhookIds: [ok.createdWebhookId] },
      });
      expect(refreshed.json.expirationDate).toBeTruthy();

      const deleted = await api(t.app, "/rest/api/3/webhook", {
        method: "DELETE",
        auth: oauth,
        body: { webhookIds: [ok.createdWebhookId] },
      });
      expect(deleted.status).toBe(202);
      expect((await api(t.app, "/rest/api/3/webhook", { auth: oauth })).json.total).toBe(0);
    });

    it("rejects dynamic webhook registration from API token users", async () => {
      const res = await api(t.app, "/rest/api/3/webhook", {
        method: "POST",
        body: {
          url: "https://app.test/webhook",
          webhooks: [{ events: ["jira:issue_created"], jqlFilter: "project = EMU" }],
        },
      });
      expect(res.status).toBe(403);
    });
  });
});
