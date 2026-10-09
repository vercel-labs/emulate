import { createServer } from "node:http";
import { once } from "node:events";
import { describe, it, expect, beforeEach } from "vitest";
import {
  Hono,
  Store,
  WebhookDispatcher,
  authMiddleware,
  createApiErrorHandler,
  createErrorHandler,
  type AppEnv,
  type TokenMap,
} from "@emulators/core";
import { getGitHubStore, githubPlugin, seedFromConfig } from "../index.js";

const base = "http://localhost:4000";
const repoPath = "/repos/octocat/hello-world";

function createTestApp() {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map();
  const app = new Hono<AppEnv>();
  app.onError(createApiErrorHandler());
  app.use("*", createErrorHandler());
  app.use("*", authMiddleware(tokenMap));
  githubPlugin.register(app, store, webhooks, base, tokenMap);
  seedFromConfig(store, base, {
    users: [{ login: "octocat" }, { login: "hubot" }],
    repos: [
      { owner: "octocat", name: "hello-world", auto_init: true },
      { owner: "octocat", name: "private-repo", private: true },
    ],
  });
  const gh = getGitHubStore(store);
  for (const user of gh.users.all()) {
    tokenMap.set(user.login, { login: user.login, id: user.id, scopes: ["repo", "delete_repo"] });
  }
  return { app, gh, webhooks, tokenMap };
}

describe("GitHub reactions routes", () => {
  let context: ReturnType<typeof createTestApp>;
  let targets: Record<string, string>;

  function request(path: string, method = "GET", body?: unknown, token: string | null = "octocat") {
    return context.app.request(`${base}${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  beforeEach(async () => {
    context = createTestApp();
    const issue = await request(`${repoPath}/issues`, "POST", { title: "Issue" });
    expect(issue.status).toBe(201);
    const issueBody = (await issue.json()) as { number: number };
    const branch = await request(`${repoPath}/branches/main`);
    const { commit } = (await branch.json()) as { commit: { sha: string } };
    const ref = await request(`${repoPath}/git/refs`, "POST", { ref: "refs/heads/feature", sha: commit.sha });
    expect(ref.status).toBe(201);
    const changed = await request(`${repoPath}/contents/review.md`, "PUT", {
      branch: "feature",
      message: "Add reviewed file",
      content: Buffer.from("Review this\n").toString("base64"),
    });
    expect(changed.status).toBe(201);
    const head = (await changed.json()) as { commit: { sha: string } };
    const pull = await request(`${repoPath}/pulls`, "POST", { title: "Pull request", head: "feature", base: "main" });
    expect(pull.status).toBe(201);
    const pullBody = (await pull.json()) as { number: number };
    const comment = await request(`${repoPath}/issues/${pullBody.number}/comments`, "POST", { body: "Discussion" });
    expect(comment.status).toBe(201);
    const commentBody = (await comment.json()) as { id: number };
    const review = await request(`${repoPath}/pulls/${pullBody.number}/comments`, "POST", {
      body: "Review",
      path: "review.md",
      line: 1,
      side: "RIGHT",
      commit_id: head.commit.sha,
    });
    expect(review.status).toBe(201);
    const reviewBody = (await review.json()) as { id: number };
    targets = {
      issue: `${repoPath}/issues/${issueBody.number}`,
      pull: `${repoPath}/issues/${pullBody.number}`,
      issueComment: `${repoPath}/issues/comments/${commentBody.id}`,
      reviewComment: `${repoPath}/pulls/comments/${reviewBody.id}`,
    };
  });

  it.each(["issue", "pull", "issueComment", "reviewComment"])(
    "creates, lists, and deletes %s reactions",
    async (target) => {
      const path = `${targets[target]}/reactions`;
      const created = await request(path, "POST", { content: "heart" });
      expect(created.status).toBe(201);
      const reaction = (await created.json()) as { id: number };
      expect(reaction).toMatchObject({
        id: expect.any(Number),
        node_id: expect.any(String),
        user: { login: "octocat" },
        content: "heart",
        created_at: expect.any(String),
      });
      const duplicate = await request(path, "POST", { content: "heart" });
      expect(duplicate.status).toBe(200);
      expect(await duplicate.json()).toEqual(reaction);
      const otherUser = await request(path, "POST", { content: "heart" }, "hubot");
      expect(otherUser.status).toBe(201);
      const otherReaction = await otherUser.json();
      const list = await request(path, "GET", undefined, null);
      expect(list.status).toBe(200);
      expect(await list.json()).toEqual([reaction, otherReaction]);

      if (target !== "pull") {
        const subject = await request(targets[target]);
        expect(await subject.json()).toMatchObject({
          reactions: { url: `${base}${path}`, total_count: 2, heart: 2, eyes: 0 },
        });
      }
      const removed = await request(`${path}/${reaction.id}`, "DELETE");
      expect(removed.status).toBe(204);
      expect(await removed.text()).toBe("");
      expect(await (await request(path)).json()).toEqual([otherReaction]);
      if (target !== "pull") {
        expect(await (await request(targets[target])).json()).toMatchObject({
          reactions: { total_count: 1, heart: 1 },
        });
      }
    },
  );

  it("filters before paginating and preserves the query in Link headers", async () => {
    const path = `${targets.issueComment}/reactions`;
    await request(path, "POST", { content: "heart" });
    await request(path, "POST", { content: "eyes" });
    await request(path, "POST", { content: "heart" }, "hubot");
    const first = await request(`${path}?content=heart&per_page=1`);
    expect(await first.json()).toMatchObject([{ content: "heart", user: { login: "octocat" } }]);
    expect(first.headers.get("link")).toContain("content=heart");
    expect(first.headers.get("link")).toContain('rel="next"');
    const second = await request(`${path}?content=heart&per_page=1&page=2`);
    expect(await second.json()).toMatchObject([{ content: "heart", user: { login: "hubot" } }]);
    expect(await (await request(`${path}?page=3&per_page=1&content=heart`)).json()).toEqual([]);
  });

  it("validates content and confines reactions to their subject, repository, and author", async () => {
    const path = `${targets.issue}/reactions`;
    expect((await request(path, "POST", { content: "invalid" })).status).toBe(422);
    expect((await request(path, "POST", {})).status).toBe(422);
    expect((await request(`${path}?content=invalid`)).status).toBe(422);
    expect((await request(path, "POST", { content: "heart" }, null)).status).toBe(401);
    expect((await request(`${repoPath}/issues/999/reactions`)).status).toBe(404);
    expect(
      (await request(targets.issueComment.replace("/issues/comments/", "/pulls/comments/") + "/reactions")).status,
    ).toBe(404);
    expect((await request(targets.issueComment.replace("hello-world", "private-repo") + "/reactions")).status).toBe(
      404,
    );
    const created = await request(path, "POST", { content: "heart" });
    const reaction = (await created.json()) as { id: number };
    expect((await request(`${targets.pull}/reactions/${reaction.id}`, "DELETE")).status).toBe(404);
    expect((await request(`${path}/${reaction.id}`, "DELETE", undefined, "hubot")).status).toBe(403);
    expect(await (await request(`${targets.pull}/reactions`)).json()).toEqual([]);
    expect(await (await request(path)).json()).toHaveLength(1);
  });

  it("enforces repository and installation permissions and attributes App reactions to the bot", async () => {
    const privatePath = "/repos/octocat/private-repo/issues";
    await request(privatePath, "POST", { title: "Private issue" });
    const repo = context.gh.repos.findOneBy("full_name", "octocat/private-repo")!;
    const user = context.gh.users.findOneBy("login", "octocat")!;
    for (const [token, permissions, repositoryIds] of [
      ["reader", { issues: "read" }, [repo.id]],
      ["writer", { issues: "write" }, [repo.id]],
      ["wrong-permission", { pull_requests: "write" }, [repo.id]],
      ["wrong-repo", { issues: "write" }, []],
    ] as const) {
      context.tokenMap.set(token, {
        login: "app",
        id: 42,
        scopes: [],
        installation: {
          appId: 42,
          installationId: 99,
          accountId: user.id,
          accountType: "User",
          permissions: { ...permissions },
          repositoryIds: [...repositoryIds],
          repositorySelection: "selected",
        },
      });
    }
    const path = `${privatePath}/1/reactions`;
    expect((await request(path, "GET", undefined, "hubot")).status).toBe(403);
    expect((await request(path, "GET", undefined, "reader")).status).toBe(200);
    expect((await request(path, "POST", { content: "eyes" }, "reader")).status).toBe(403);
    expect((await request(path, "POST", { content: "eyes" }, "wrong-permission")).status).toBe(403);
    expect((await request(path, "POST", { content: "eyes" }, "wrong-repo")).status).toBe(403);
    const created = await request(path, "POST", { content: "eyes" }, "writer");
    expect(created.status).toBe(201);
    const reaction = (await created.json()) as { id: number };
    expect(reaction).toMatchObject({ user: { login: "app-42[bot]", type: "Bot" } });
    expect((await request(`${path}/${reaction.id}`, "DELETE", undefined, "reader")).status).toBe(403);
    expect((await request(`${path}/${reaction.id}`, "DELETE", undefined, "writer")).status).toBe(204);
  });

  it("removes stored reactions when their comment or repository is deleted", async () => {
    for (const target of Object.values(targets)) await request(`${target}/reactions`, "POST", { content: "+1" });
    expect(context.gh.reactions.all()).toHaveLength(4);
    expect((await request(targets.issueComment, "DELETE")).status).toBe(204);
    expect((await request(targets.reviewComment, "DELETE")).status).toBe(204);
    expect(context.gh.reactions.all()).toHaveLength(2);
    expect((await request(repoPath, "DELETE")).status).toBe(204);
    expect(context.gh.reactions.all()).toHaveLength(0);
  });

  it("identifies pull-request issue comments in webhook payloads, including reaction summaries", async () => {
    const payloads: Array<{ issue: unknown; comment: unknown }> = [];
    const receiver = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      payloads.push(JSON.parse(Buffer.concat(chunks).toString()));
      res.writeHead(200).end();
    });
    receiver.listen(0, "127.0.0.1");
    await once(receiver, "listening");
    const address = receiver.address();
    if (!address || typeof address === "string") throw new Error("Missing webhook address");
    context.webhooks.register({
      url: `http://127.0.0.1:${address.port}`,
      active: true,
      events: ["*"],
      owner: "octocat",
      repo: "hello-world",
    });
    try {
      await request(`${targets.pull}/reactions`, "POST", { content: "heart" });
      const comment = await request(`${targets.pull}/comments`, "POST", { body: "Pull request discussion" });
      expect(comment.status).toBe(201);
      const commentBody = (await comment.json()) as { id: number };
      await expect.poll(() => context.webhooks.getDeliveries().length).toBe(1);
      expect(payloads).toHaveLength(1);
      expect(payloads[0]).toMatchObject({
        issue: {
          html_url: `${base}/octocat/hello-world/pull/2`,
          pull_request: { url: `${base}${repoPath}/pulls/2`, html_url: `${base}/octocat/hello-world/pull/2` },
          reactions: { heart: 1, total_count: 1 },
        },
        comment: { html_url: `${base}/octocat/hello-world/pull/2#issuecomment-${commentBody.id}` },
      });
      await request(`${targets.issue}/comments`, "POST", { body: "Issue discussion" });
      await expect.poll(() => context.webhooks.getDeliveries().length).toBe(2);
      expect(payloads[1].issue).not.toHaveProperty("pull_request");
      expect(payloads[1].issue).toMatchObject({ html_url: `${base}/octocat/hello-world/issues/1` });
    } finally {
      await new Promise<void>((resolve, reject) => receiver.close((error) => (error ? reject(error) : resolve())));
    }
  });
});
