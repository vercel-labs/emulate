import { describe, expect, it } from "vitest";
import { Hono } from "@emulators/core";
import { Store } from "@emulators/core";
import { WebhookDispatcher } from "@emulators/core";
import { authMiddleware, createApiErrorHandler, createErrorHandler, type TokenMap } from "@emulators/core";
import { githubPlugin, seedFromConfig } from "../index.js";

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

  return { app, store, webhooks };
}

const headers = {
  Authorization: "Bearer test-token",
  "Content-Type": "application/json",
};

describe("shared GitHub mutation behavior", () => {
  it("does not leave auto-created labels behind when issue validation fails", async () => {
    const { app, store } = createTestApp();

    const response = await app.request(`${base}/repos/octocat/hello-world/issues`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "Invalid issue", labels: ["created-during-validation"], milestone: 999 }),
    });

    expect(response.status).toBe(422);
    expect(store.collection("github.issues").all()).toHaveLength(0);
    expect(store.collection("github.labels").all()).toHaveLength(0);

    const repositoryResponse = await app.request(`${base}/repos/octocat/hello-world`, {
      headers: { Authorization: headers.Authorization },
    });
    const repository = (await repositoryResponse.json()) as { open_issues_count: number };
    expect(repository.open_issues_count).toBe(0);
  });

  it("records issue comment creation in the issue count without changing timeline behavior", async () => {
    const { app } = createTestApp();

    const issueResponse = await app.request(`${base}/repos/octocat/hello-world/issues`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "Commented issue" }),
    });
    expect(issueResponse.status).toBe(201);

    const commentResponse = await app.request(`${base}/repos/octocat/hello-world/issues/1/comments`, {
      method: "POST",
      headers,
      body: JSON.stringify({ body: "A comment" }),
    });
    expect(commentResponse.status).toBe(201);

    const issueRead = await app.request(`${base}/repos/octocat/hello-world/issues/1`, {
      headers: { Authorization: headers.Authorization },
    });
    const issue = (await issueRead.json()) as { comments: number };
    expect(issue.comments).toBe(1);
  });

  it("keeps lifecycle counters and events consistent while cleaning deleted labels", async () => {
    const { app, store } = createTestApp();

    const issueResponse = await app.request(`${base}/repos/octocat/hello-world/issues`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "Lifecycle issue", labels: ["triage"] }),
    });
    expect(issueResponse.status).toBe(201);

    const closeResponse = await app.request(`${base}/repos/octocat/hello-world/issues/1`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ state: "closed" }),
    });
    expect(closeResponse.status).toBe(200);

    const closedRepositoryResponse = await app.request(`${base}/repos/octocat/hello-world`, {
      headers: { Authorization: headers.Authorization },
    });
    const closedRepository = (await closedRepositoryResponse.json()) as { open_issues_count: number };
    expect(closedRepository.open_issues_count).toBe(0);

    const reopenResponse = await app.request(`${base}/repos/octocat/hello-world/issues/1`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ state: "open" }),
    });
    expect(reopenResponse.status).toBe(200);

    const events = store.collection("github.issue_events").all() as unknown as Array<{
      event: string;
      actor_id: number;
    }>;
    expect(events.map((event) => event.event)).toEqual(["opened", "closed", "reopened"]);
    const actor = (store.collection("github.users").all() as unknown as Array<{ login: string; id: number }>).find(
      (user) => user.login === "octocat",
    );
    expect(actor).toBeDefined();
    expect(events.every((event) => event.actor_id === actor!.id)).toBe(true);

    const deleteLabelResponse = await app.request(`${base}/repos/octocat/hello-world/labels/triage`, {
      method: "DELETE",
      headers: { Authorization: headers.Authorization },
    });
    expect(deleteLabelResponse.status).toBe(204);

    const remainingLabels = store.collection("github.labels").all() as unknown as Array<{ name: string }>;
    expect(remainingLabels).toHaveLength(0);
    const labelsResponse = await app.request(`${base}/repos/octocat/hello-world/issues/1/labels`, {
      headers: { Authorization: headers.Authorization },
    });
    expect(await labelsResponse.json()).toEqual([]);
  });
});
