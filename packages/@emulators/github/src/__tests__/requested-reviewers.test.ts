import { createServer } from "node:http";
import { once } from "node:events";
import { beforeEach, describe, expect, it } from "vitest";
import {
  Hono,
  Store,
  WebhookDispatcher,
  authMiddleware,
  createApiErrorHandler,
  type AppEnv,
  type TokenMap,
} from "@emulators/core";
import { getGitHubStore, githubPlugin, seedFromConfig } from "../index.js";

const base = "http://localhost:4000";
const repoPath = "/repos/acme/knowledge";

describe("requested reviewers", () => {
  let app: Hono<AppEnv>;
  let gh: ReturnType<typeof getGitHubStore>;
  let webhooks: WebhookDispatcher;
  let pull: { number: number };

  const request = (path: string, method = "GET", body?: unknown, token = "octocat-token") =>
    app.request(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const reviewersPath = () => `${repoPath}/pulls/${pull.number}/requested_reviewers`;

  beforeEach(async () => {
    const store = new Store();
    webhooks = new WebhookDispatcher();
    const tokens: TokenMap = new Map();
    app = new Hono<AppEnv>();
    app.onError(createApiErrorHandler());
    app.use("*", authMiddleware(tokens));
    githubPlugin.register(app, store, webhooks, base, tokens);
    seedFromConfig(store, base, {
      users: [{ login: "octocat" }, { login: "reviewer" }],
      orgs: [{ login: "acme", members: [{ login: "octocat", role: "admin" }, { login: "reviewer" }] }],
      repos: [{ owner: "acme", name: "knowledge", auto_init: true }],
    });
    gh = getGitHubStore(store);
    for (const user of gh.users.all())
      tokens.set(`${user.login}-token`, { id: user.id, login: user.login, scopes: ["repo"] });
    const created = await request(`${repoPath}/pulls`, "POST", { title: "Review", head: "feature", base: "main" });
    expect(created.status).toBe(201);
    pull = (await created.json()) as typeof pull;
  });

  it("reads current user identities and rejects requesting the pull request author", async () => {
    const reviewer = gh.users.findOneBy("login", "reviewer")!;
    gh.users.update(reviewer.id, { login: "renamed-reviewer" });
    expect(await (await request(`/user/${reviewer.id}`)).json()).toMatchObject({
      id: reviewer.id,
      login: "renamed-reviewer",
    });
    expect((await request("/user/999999")).status).toBe(404);
    expect((await request(reviewersPath(), "POST", { reviewers: ["octocat", "renamed-reviewer"] })).status).toBe(422);
    expect(await (await request(reviewersPath())).json()).toEqual({ users: [], teams: [] });
    expect((await request(reviewersPath(), "POST", { reviewers: ["renamed-reviewer"] })).status).toBe(200);
    expect(await (await request(reviewersPath())).json()).toMatchObject({
      users: [{ id: reviewer.id, login: "renamed-reviewer" }],
      teams: [],
    });
  });

  it("emits removals only for stored user and team requests", async () => {
    const created = await request("/orgs/acme/teams", "POST", { name: "Reviewers" });
    const team = (await created.json()) as { id: number; slug: string };
    expect(
      (await request(reviewersPath(), "POST", { reviewers: ["reviewer"], team_reviewers: [team.slug] })).status,
    ).toBe(200);
    const receiver = createServer((_req, response) => response.writeHead(200).end());
    receiver.listen(0, "127.0.0.1");
    await once(receiver, "listening");
    const address = receiver.address();
    if (!address || typeof address === "string") throw new Error("Missing receiver address");
    webhooks.register({
      url: `http://127.0.0.1:${address.port}`,
      active: true,
      events: ["pull_request"],
      owner: "acme",
      repo: "knowledge",
    });
    try {
      expect(await (await request(reviewersPath())).json()).toMatchObject({
        users: [{ login: "reviewer" }],
        teams: [{ id: team.id, slug: team.slug }],
      });
      for (let attempt = 0; attempt < 2; attempt++)
        expect(
          (await request(reviewersPath(), "DELETE", { reviewers: ["reviewer"], team_reviewers: [team.slug] })).status,
        ).toBe(200);
      expect(await (await request(reviewersPath())).json()).toEqual({ users: [], teams: [] });
      await expect.poll(() => webhooks.getDeliveries().filter((delivery) => delivery.success)).toHaveLength(2);
      const removed = webhooks.getDeliveries();
      expect(removed.map(({ action }) => action)).toEqual(["review_request_removed", "review_request_removed"]);
      expect(removed[0]?.payload).toMatchObject({
        requested_reviewer: { login: "reviewer" },
        pull_request: { requested_reviewers: [], requested_teams: [] },
      });
      expect(removed[1]?.payload).toMatchObject({
        requested_team: { id: team.id },
        pull_request: { requested_reviewers: [], requested_teams: [] },
      });
    } finally {
      await new Promise<void>((resolve, reject) => receiver.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("retains a pending review request until submission and clears immediate submissions", async () => {
    const path = `${repoPath}/pulls/${pull.number}/reviews`;
    expect((await request(reviewersPath(), "POST", { reviewers: ["reviewer"] })).status).toBe(200);
    const pending = await request(path, "POST", { body: "Draft" }, "reviewer-token");
    expect(pending.status).toBe(201);
    const review = (await pending.json()) as { id: number };
    expect(await (await request(reviewersPath())).json()).toMatchObject({ users: [{ login: "reviewer" }] });
    expect((await request(`${path}/${review.id}/events`, "POST", { event: "COMMENT" }, "reviewer-token")).status).toBe(
      200,
    );
    expect(await (await request(reviewersPath())).json()).toEqual({ users: [], teams: [] });
    expect((await request(reviewersPath(), "POST", { reviewers: ["reviewer"] })).status).toBe(200);
    expect((await request(path, "POST", { body: "Approved", event: "APPROVE" }, "reviewer-token")).status).toBe(201);
    expect(await (await request(reviewersPath())).json()).toEqual({ users: [], teams: [] });
  });
});
