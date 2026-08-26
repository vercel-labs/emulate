import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "@emulators/core";
import { Store } from "@emulators/core";
import { WebhookDispatcher } from "@emulators/core";
import { authMiddleware, createApiErrorHandler, createErrorHandler, type TokenMap } from "@emulators/core";
import { getGitHubStore, githubPlugin, seedFromConfig } from "../index.js";
import { deleteIssue as deleteIssueOperation, transitionIssueLifecycle } from "../operations/issues.js";

const base = "http://localhost:4000";

function createTestApp() {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map();
  tokenMap.set("test-token", { login: "octocat", id: 1, scopes: ["repo", "user", "admin:org"] });

  const app = new Hono();
  app.onError(createApiErrorHandler());
  app.use("*", createErrorHandler());
  app.use("*", authMiddleware(tokenMap));
  githubPlugin.register(app as any, store, webhooks, base, tokenMap);
  githubPlugin.seed?.(store, base);
  seedFromConfig(store, base, {
    users: [{ login: "octocat" }],
    repos: [{ owner: "octocat", name: "hello-world" }],
  });

  return { app, store, webhooks, tokenMap };
}

function authHeaders(): Record<string, string> {
  return { Authorization: "Bearer test-token" };
}

describe("GitHub issues routes", () => {
  let app: Hono;
  let store: Store;

  beforeEach(() => {
    const testApp = createTestApp();
    app = testApp.app;
    store = testApp.store;
  });

  it("creates an issue", async () => {
    const res = await app.request(`${base}/repos/octocat/hello-world/issues`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Test issue" }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { title: string; number: number };
    expect(body.title).toBe("Test issue");
    expect(body.number).toBe(1);
  });

  it("lists issues", async () => {
    await app.request(`${base}/repos/octocat/hello-world/issues`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Listed issue" }),
    });

    const res = await app.request(`${base}/repos/octocat/hello-world/issues`, {
      method: "GET",
      headers: authHeaders(),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown[];
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThanOrEqual(1);
  });

  it("gets an issue by number", async () => {
    await app.request(`${base}/repos/octocat/hello-world/issues`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Issue one" }),
    });

    const res = await app.request(`${base}/repos/octocat/hello-world/issues/1`, {
      method: "GET",
      headers: authHeaders(),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { number: number; title: string };
    expect(body.number).toBe(1);
    expect(body.title).toBe("Issue one");
  });

  it("updates an issue", async () => {
    await app.request(`${base}/repos/octocat/hello-world/issues`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Original" }),
    });

    const res = await app.request(`${base}/repos/octocat/hello-world/issues/1`, {
      method: "PATCH",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Updated title" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { title: string };
    expect(body.title).toBe("Updated title");
  });

  it("does not create labels when a duplicate transition is rejected", async () => {
    const createResponse = await app.request(`${base}/repos/octocat/hello-world/issues`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Issue with rejected transition" }),
    });
    expect(createResponse.status).toBe(201);
    const issue = (await createResponse.json()) as { number: number };
    const gh = getGitHubStore(store);
    const before = JSON.stringify(store.snapshot());

    const response = await app.request(`${base}/repos/octocat/hello-world/issues/${issue.number}`, {
      method: "PATCH",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ state: "closed", state_reason: "duplicate", labels: ["created-after-validation"] }),
    });

    expect(response.status).toBe(422);
    const afterIssue = await app.request(`${base}/repos/octocat/hello-world/issues/${issue.number}`, {
      headers: authHeaders(),
    });
    expect(await afterIssue.json()).toMatchObject({ state: "open", state_reason: null });
    expect(gh.labels.count()).toBe(0);
    expect(JSON.stringify(store.snapshot())).toBe(before);
  });

  it.each(["completed", "not_planned"] as const)(
    "rejects %s for an open issue without changing lifecycle state or events",
    async (stateReason) => {
      const testApp = createTestApp();
      const response = await testApp.app.request(`${base}/repos/octocat/hello-world/issues`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ title: `Incompatible ${stateReason}` }),
      });
      expect(response.status).toBe(201);

      const gh = getGitHubStore(testApp.store);
      const repo = gh.repos.findOneBy("full_name", "octocat/hello-world")!;
      const issue = gh.issues.findOneBy("number", 1)!;
      const actor = gh.users.findOneBy("login", "octocat")!;
      const beforeEvents = gh.issueEvents.all().map((event) => event.id);

      expect(() =>
        transitionIssueLifecycle(
          { gh, webhooks: testApp.webhooks, baseUrl: base },
          { repo, issue, actor, state: "open", stateReason },
        ),
      ).toThrow("Open issues must use state_reason reopened or null");
      const routeResponse = await testApp.app.request(`${base}/repos/octocat/hello-world/issues/${issue.number}`, {
        method: "PATCH",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ state: "open", state_reason: stateReason }),
      });
      expect(routeResponse.status).toBe(422);
      expect(gh.issues.get(issue.id)).toMatchObject({ state: "open", state_reason: null, duplicate_issue_id: null });
      expect(gh.issueEvents.all().map((event) => event.id)).toEqual(beforeEvents);
    },
  );

  it("rejects invalid duplicate lifecycle variants without mutating the issue", async () => {
    const createIssue = async (title: string) => {
      const response = await app.request(`${base}/repos/octocat/hello-world/issues`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      expect(response.status).toBe(201);
      return (await response.json()) as { id: number; number: number };
    };

    const canonical = await createIssue("Canonical duplicate target");
    const source = await createIssue("Invalid duplicate source");
    const gh = getGitHubStore(store);
    const before = JSON.stringify(store.snapshot());

    const openDuplicate = await app.request(`${base}/repos/octocat/hello-world/issues/${source.number}`, {
      method: "PATCH",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ state: "open", state_reason: "duplicate", duplicate_issue_id: canonical.id }),
    });
    expect(openDuplicate.status).toBe(422);

    const unexpectedReference = await app.request(`${base}/repos/octocat/hello-world/issues/${source.number}`, {
      method: "PATCH",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ duplicate_issue_id: canonical.id }),
    });
    expect(unexpectedReference.status).toBe(422);
    expect(gh.issues.get(source.id)).toMatchObject({ state: "open", state_reason: null, duplicate_issue_id: null });
    expect(JSON.stringify(store.snapshot())).toBe(before);
  });

  it("does not emit a lifecycle event for a same-state non-duplicate reason change", async () => {
    const testApp = createTestApp();
    const response = await testApp.app.request(`${base}/repos/octocat/hello-world/issues`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Reason change" }),
    });
    expect(response.status).toBe(201);
    const gh = getGitHubStore(testApp.store);
    const repo = gh.repos.findOneBy("full_name", "octocat/hello-world")!;
    const actor = gh.users.findOneBy("login", "octocat")!;
    const issue = gh.issues.findOneBy("number", 1)!;

    const closed = transitionIssueLifecycle(
      { gh, webhooks: testApp.webhooks, baseUrl: base },
      { repo, issue, actor, state: "closed" },
    );
    const beforeEvents = gh.issueEvents.all().map((event) => event.id);
    const changed = transitionIssueLifecycle(
      { gh, webhooks: testApp.webhooks, baseUrl: base },
      { repo, issue: closed.issue, actor, state: "closed", stateReason: "not_planned" },
    );

    expect(changed.changed).toBe(true);
    expect(changed.issue.state_reason).toBe("not_planned");
    expect(gh.issueEvents.all().map((event) => event.id)).toEqual(beforeEvents);
  });

  it("deletes relationship events across repositories and normalizes orphaned duplicate issues", async () => {
    const testApp = createTestApp();
    seedFromConfig(testApp.store, base, { repos: [{ owner: "octocat", name: "second-repo" }] });
    const create = async (repoName: string, title: string) => {
      const response = await testApp.app.request(`${base}/repos/octocat/${repoName}/issues`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      expect(response.status).toBe(201);
      return (await response.json()) as { id: number; number: number };
    };

    const target = await create("hello-world", "Canonical target");
    const peer = await create("second-repo", "Duplicate peer");
    const duplicate = await testApp.app.request(`${base}/repos/octocat/second-repo/issues/${peer.number}`, {
      method: "PATCH",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ state: "closed", state_reason: "duplicate", duplicate_issue_id: target.id }),
    });
    expect(duplicate.status).toBe(200);

    const addSubIssue = await testApp.app.request(
      `${base}/repos/octocat/second-repo/issues/${peer.number}/sub_issues`,
      {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ sub_issue_id: target.id }),
      },
    );
    expect(addSubIssue.status).toBe(201);
    const addDependency = await testApp.app.request(
      `${base}/repos/octocat/hello-world/issues/${target.number}/dependencies/blocked_by`,
      {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ issue_id: peer.id }),
      },
    );
    expect(addDependency.status).toBe(201);

    const gh = getGitHubStore(testApp.store);
    const targetRow = gh.issues.get(target.id)!;
    const targetRepo = gh.repos.findOneBy("full_name", "octocat/hello-world")!;
    const peerRepo = gh.repos.findOneBy("full_name", "octocat/second-repo")!;
    const peerOpenedEvent = gh.issueEvents
      .findBy("repo_id", peerRepo.id)
      .find((event) => event.issue_number === peer.number && event.event === "opened")!;
    const incidentEventIds = gh.issueEvents
      .all()
      .filter((event) => {
        return (
          (event.repo_id === targetRepo.id && event.issue_number === target.number) ||
          event.parent_issue_id === target.id ||
          event.sub_issue_id === target.id ||
          event.blocked_issue_id === target.id ||
          event.blocking_issue_id === target.id
        );
      })
      .map((event) => event.id);

    deleteIssueOperation({ gh, webhooks: testApp.webhooks, baseUrl: base }, { repo: targetRepo, issue: targetRow });

    expect(gh.issues.get(target.id)).toBeUndefined();
    expect(gh.issues.get(peer.id)).toMatchObject({
      state: "closed",
      state_reason: "completed",
      duplicate_issue_id: null,
    });
    expect(incidentEventIds.every((id) => !gh.issueEvents.get(id))).toBe(true);
    expect(gh.issueEvents.get(peerOpenedEvent.id)).toBeDefined();
  });
});
