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
const repoPath = "/repos/octocat/hello-world";

describe("GitHub review comment locations", () => {
  let app: Hono<AppEnv>;
  let webhooks: WebhookDispatcher;
  let pull: { number: number; node_id: string; head: { sha: string } };

  function request(path: string, method = "GET", body?: unknown, token: string | null = "test-token") {
    return app.request(`${base}${repoPath}${path}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  beforeEach(async () => {
    const store = new Store();
    webhooks = new WebhookDispatcher();
    const tokenMap: TokenMap = new Map();
    app = new Hono<AppEnv>();
    app.onError(createApiErrorHandler());
    app.use("*", authMiddleware(tokenMap));
    githubPlugin.register(app, store, webhooks, base, tokenMap);
    seedFromConfig(store, base, {
      users: [{ login: "octocat" }, { login: "reader" }],
      repos: [{ owner: "octocat", name: "hello-world", auto_init: true }],
    });
    const user = getGitHubStore(store).users.findOneBy("login", "octocat")!;
    tokenMap.set("test-token", { id: user.id, login: user.login, scopes: ["repo"] });
    const reader = getGitHubStore(store).users.findOneBy("login", "reader")!;
    tokenMap.set("reader-token", { id: reader.id, login: reader.login, scopes: ["repo"] });
    const branch = (await (await request("/branches/main")).json()) as { commit: { sha: string } };
    expect((await request("/git/refs", "POST", { ref: "refs/heads/feature", sha: branch.commit.sha })).status).toBe(
      201,
    );
    expect(
      (
        await request("/contents/scenario.md", "PUT", {
          branch: "feature",
          message: "Add scenario",
          content: Buffer.from("First line\n").toString("base64"),
        })
      ).status,
    ).toBe(201);
    const response = await request("/pulls", "POST", { title: "Review", head: "feature", base: "main" });
    expect(response.status).toBe(201);
    pull = (await response.json()) as typeof pull;
  });

  async function pushChanges() {
    const head = (await (await request(`/git/commits/${pull.head.sha}`)).json()) as { tree: { sha: string } };
    const tree = (await (
      await request("/git/trees", "POST", {
        base_tree: head.tree.sha,
        tree: [
          { path: "scenario.md", mode: "100644", type: "blob", content: "First line\nAdded line\n" },
          { path: "new.md", mode: "100644", type: "blob", content: "New file\n" },
        ],
      })
    ).json()) as { sha: string };
    const commit = (await (
      await request("/git/commits", "POST", {
        message: "Push the commented changes",
        tree: tree.sha,
        parents: [pull.head.sha],
      })
    ).json()) as { sha: string };
    expect((await request("/git/refs/heads/feature", "PATCH", { sha: commit.sha })).status).toBe(200);
    return commit.sha;
  }

  it("validates a review's comments before creating it and permits submitted summary edits", async () => {
    const input = {
      body: "Summary",
      event: "COMMENT",
      comments: [{ path: "new.md", line: 1, side: "RIGHT", body: "Inline" }],
    };
    expect((await request(`/pulls/${pull.number}/reviews`, "POST", input)).status).toBe(422);
    expect(await (await request(`/pulls/${pull.number}/reviews`)).json()).toEqual([]);
    await pushChanges();
    const response = await request(`/pulls/${pull.number}/reviews`, "POST", input);
    expect(response.status).toBe(201);
    const review = (await response.json()) as { id: number };
    expect(await (await request(`/pulls/${pull.number}/reviews/${review.id}/comments`)).json()).toMatchObject([
      { body: "Inline", line: 1 },
    ]);
    const edited = await request(`/pulls/${pull.number}/reviews/${review.id}`, "PUT", { body: "Revised summary" });
    expect(edited.status).toBe(200);
    expect(await edited.json()).toMatchObject({ body: "Revised summary", state: "COMMENTED" });
  });

  it("adds draft comments incrementally before submission and deletes discarded pending reviews", async () => {
    const reviewsPath = `/pulls/${pull.number}/reviews`;
    const created = await request(reviewsPath, "POST", { body: "Draft" });
    expect(created.status).toBe(201);
    const review = (await created.json()) as { id: number; node_id: string };
    expect((await request(reviewsPath, "POST", { body: "Another pending review" })).status).toBe(422);
    async function addComment(path: string) {
      const response = await app.request(`${base}/graphql`, {
        method: "POST",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({
          query:
            "mutation($input: AddPullRequestReviewThreadInput!) { addPullRequestReviewThread(input: $input) { thread { comments(first: 1) { nodes { databaseId body url } } } } }",
          variables: {
            input: { pullRequestReviewId: review.node_id, body: "Inline draft", path, line: 1, side: "RIGHT" },
          },
        }),
      });
      return response.json() as Promise<{ data?: unknown; errors?: unknown[] }>;
    }
    expect((await addComment("new.md")).errors).toBeDefined();
    expect(await (await request(`${reviewsPath}/${review.id}/comments`)).json()).toEqual([]);
    expect((await addComment("scenario.md")).errors).toBeUndefined();
    expect(await (await request(`${reviewsPath}/${review.id}`)).json()).toMatchObject({ state: "PENDING" });
    expect(await (await request(`${reviewsPath}/${review.id}/comments`)).json()).toMatchObject([
      { body: "Inline draft", pull_request_review_id: review.id },
    ]);
    expect((await request(`${reviewsPath}/${review.id}/events`, "POST", { event: "COMMENT" })).status).toBe(200);
    expect((await request(`${reviewsPath}/${review.id}`, "DELETE")).status).toBe(422);
    expect((await addComment("scenario.md")).errors).toBeDefined();
    const discarded = await request(reviewsPath, "POST", {
      comments: [{ path: "scenario.md", line: 1, side: "RIGHT", body: "Discard this" }],
    });
    const draft = (await discarded.json()) as { id: number };
    expect((await request(`${reviewsPath}/${draft.id}`, "DELETE")).status).toBe(200);
    expect((await request(`${reviewsPath}/${draft.id}/comments`)).status).toBe(404);
  });

  it("keeps pending review comments private on individual and repository-wide reads until submission", async () => {
    const reviewsPath = `/pulls/${pull.number}/reviews`;
    const created = await request(reviewsPath, "POST", {
      body: "Draft",
      comments: [{ path: "scenario.md", line: 1, side: "RIGHT", body: "Private draft" }],
    });
    expect(created.status).toBe(201);
    const review = (await created.json()) as { id: number };
    const [draft] = (await (await request(`${reviewsPath}/${review.id}/comments`)).json()) as { id: number }[];
    const published = await request(`/pulls/${pull.number}/comments`, "POST", {
      body: "Published comment",
      path: "scenario.md",
      line: 1,
      side: "RIGHT",
      commit_id: pull.head.sha,
    });
    expect(published.status).toBe(201);
    const comment = (await published.json()) as { id: number };

    expect(await (await request(`/pulls/comments/${draft.id}`)).json()).toMatchObject({ body: "Private draft" });
    expect(await (await request("/pulls/comments")).json()).toMatchObject([{ id: draft.id }, { id: comment.id }]);
    for (const token of ["reader-token", null]) {
      expect((await request(`/pulls/comments/${draft.id}`, "GET", undefined, token)).status).toBe(404);
      const listed = await request("/pulls/comments?per_page=1", "GET", undefined, token);
      expect(await listed.json()).toMatchObject([{ id: comment.id }]);
      expect(listed.headers.get("Link")).toBeNull();
      expect(await (await request(`/pulls/${pull.number}/comments`, "GET", undefined, token)).json()).toMatchObject([
        { id: comment.id },
      ]);
      expect((await request(`/pulls/comments/${comment.id}`, "GET", undefined, token)).status).toBe(200);
    }

    expect((await request(`${reviewsPath}/${review.id}/events`, "POST", { event: "COMMENT" })).status).toBe(200);
    for (const token of ["reader-token", null]) {
      expect(await (await request(`/pulls/comments/${draft.id}`, "GET", undefined, token)).json()).toMatchObject({
        body: "Private draft",
      });
      expect(await (await request("/pulls/comments", "GET", undefined, token)).json()).toMatchObject([
        { id: draft.id },
        { id: comment.id },
      ]);
    }
  });

  it("shares draft and thread resolution state between GraphQL and REST", async () => {
    async function query(query: string, variables: Record<string, unknown>) {
      const response = await app.request(`${base}/graphql`, {
        method: "POST",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables }),
      });
      expect(response.status).toBe(200);
      const result = (await response.json()) as { data: Record<string, any>; errors?: unknown[] };
      expect(result.errors).toBeUndefined();
      return result.data;
    }
    await query(
      "mutation($id: ID!) { convertPullRequestToDraft(input: {pullRequestId: $id}) { pullRequest { isDraft } } }",
      { id: pull.node_id },
    );
    expect(await (await request(`/pulls/${pull.number}`)).json()).toMatchObject({ draft: true });
    await query(
      "mutation($id: ID!) { markPullRequestReadyForReview(input: {pullRequestId: $id}) { pullRequest { isDraft } } }",
      { id: pull.node_id },
    );
    expect(await (await request(`/pulls/${pull.number}`)).json()).toMatchObject({ draft: false });
    const created = await request(`/pulls/${pull.number}/comments`, "POST", {
      body: "Review this",
      path: "scenario.md",
      line: 1,
      side: "RIGHT",
      commit_id: pull.head.sha,
    });
    const comment = (await created.json()) as { id: number };
    const data = await query(
      'query($number: Int!) { repository(owner: "octocat", name: "hello-world") { pullRequest(number: $number) { reviewThreads(first: 1) { nodes { id isResolved comments(first: 1) { nodes { databaseId } } } pageInfo { hasNextPage } } } } }',
      { number: pull.number },
    );
    const thread = data.repository.pullRequest.reviewThreads.nodes[0];
    expect(thread).toMatchObject({ isResolved: false, comments: { nodes: [{ databaseId: comment.id }] } });
    for (const resolved of [true, false]) {
      const mutation = resolved ? "resolveReviewThread" : "unresolveReviewThread";
      const result = await query(
        `mutation($id: ID!) { ${mutation}(input: {threadId: $id}) { thread { id isResolved } } }`,
        { id: thread.id },
      );
      expect(result[mutation].thread).toEqual({ id: thread.id, isResolved: resolved });
    }
  });

  it("rejects missing files and out-of-diff lines until their changes are pushed", async () => {
    const create = (path: string, line: number, sha = pull.head.sha, extra = {}) =>
      request(`/pulls/${pull.number}/comments`, "POST", {
        body: "Review this",
        path,
        line,
        side: "RIGHT",
        commit_id: sha,
        ...extra,
      });
    expect((await create("new.md", 1)).status).toBe(422);
    expect((await create("scenario.md", 2)).status).toBe(422);
    expect((await create("README.md", 1)).status).toBe(422);
    expect((await create("scenario.md", 1, "missing-commit")).status).toBe(422);
    expect((await create("scenario.md", 1)).status).toBe(201);

    const sha = await pushChanges();
    expect(await (await request(`/pulls/${pull.number}`)).json()).toMatchObject({ head: { sha } });
    expect((await create("new.md", 1, sha)).status).toBe(201);
    expect((await create("scenario.md", 2, sha)).status).toBe(201);
    expect((await create("scenario.md", 3, sha)).status).toBe(422);
    expect((await create("scenario.md", 2, sha, { start_line: 3, start_side: "RIGHT" })).status).toBe(422);
    expect((await create("scenario.md", 2)).status).toBe(422);
  });

  it("keeps review replies on their parent location and rejects missing or nested parents", async () => {
    const response = await request(`/pulls/${pull.number}/comments`, "POST", {
      body: "Parent",
      path: "scenario.md",
      line: 1,
      side: "RIGHT",
      commit_id: pull.head.sha,
    });
    expect(response.status).toBe(201);
    const parent = (await response.json()) as { id: number };
    const reply = await request(`/pulls/${pull.number}/comments/${parent.id}/replies`, "POST", { body: "Reply" });
    expect(reply.status).toBe(201);
    const body = (await reply.json()) as { id: number };
    expect(body).toMatchObject({
      body: "Reply",
      in_reply_to_id: parent.id,
      path: "scenario.md",
      line: 1,
      side: "RIGHT",
      commit_id: pull.head.sha,
    });
    expect(
      (await request(`/pulls/${pull.number}/comments`, "POST", { body: "Another reply", in_reply_to: parent.id }))
        .status,
    ).toBe(201);
    expect((await request(`/pulls/${pull.number}/comments/999999/replies`, "POST", { body: "Missing" })).status).toBe(
      422,
    );
    expect(
      (await request(`/pulls/${pull.number}/comments/${body.id}/replies`, "POST", { body: "Nested" })).status,
    ).toBe(422);
  });

  it("emits an edited webhook with the new base snapshot when only the target branch changes", async () => {
    const main = (await (await request("/branches/main")).json()) as { commit: { sha: string } };
    expect((await request("/git/refs", "POST", { ref: "refs/heads/release", sha: main.commit.sha })).status).toBe(201);
    const added = await request("/contents/release.md", "PUT", {
      branch: "release",
      message: "Prepare release",
      content: Buffer.from("Release\n").toString("base64"),
    });
    expect(added.status).toBe(201);
    const release = (await added.json()) as { commit: { sha: string } };
    const receiver = createServer((_req, res) => res.writeHead(200).end());
    receiver.listen(0, "127.0.0.1");
    await once(receiver, "listening");
    const address = receiver.address();
    if (!address || typeof address === "string") throw new Error("Missing webhook address");
    webhooks.register({
      url: `http://127.0.0.1:${address.port}`,
      active: true,
      events: ["pull_request"],
      owner: "octocat",
      repo: "hello-world",
    });
    try {
      const updated = await request(`/pulls/${pull.number}`, "PATCH", { base: "release" });
      expect(updated.status).toBe(200);
      const snapshot = { base: { ref: "release", sha: release.commit.sha }, head: { sha: pull.head.sha } };
      expect(await updated.json()).toMatchObject(snapshot);
      expect(await (await request(`/pulls/${pull.number}`)).json()).toMatchObject(snapshot);
      await expect.poll(() => webhooks.getDeliveries().filter((delivery) => delivery.success)).toHaveLength(1);
      expect(webhooks.getDeliveries()[0]).toMatchObject({
        event: "pull_request",
        action: "edited",
        payload: {
          action: "edited",
          pull_request: { number: pull.number, ...snapshot },
          repository: { full_name: "octocat/hello-world" },
          sender: { login: "octocat" },
        },
      });
    } finally {
      await new Promise<void>((resolve, reject) => receiver.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("emits synchronize webhooks for ref and contents writes, but not unchanged or closed heads", async () => {
    const receiver = createServer((_req, res) => res.writeHead(200).end());
    receiver.listen(0, "127.0.0.1");
    await once(receiver, "listening");
    const address = receiver.address();
    if (!address || typeof address === "string") throw new Error("Missing webhook address");
    webhooks.register({
      url: `http://127.0.0.1:${address.port}`,
      active: true,
      events: ["pull_request"],
      owner: "octocat",
      repo: "hello-world",
    });
    const synchronizations = () =>
      webhooks.getDeliveries().filter((delivery) => delivery.action === "synchronize" && delivery.success);
    try {
      const sha = await pushChanges();
      await expect.poll(() => synchronizations().length).toBe(1);
      expect(synchronizations()[0].payload).toMatchObject({
        action: "synchronize",
        before: pull.head.sha,
        after: sha,
        number: pull.number,
        pull_request: { head: { sha } },
        repository: { full_name: "octocat/hello-world" },
        sender: { login: "octocat" },
      });
      expect((await request("/git/refs/heads/feature", "PATCH", { sha })).status).toBe(200);
      const added = await request("/contents/next.md", "PUT", {
        branch: "feature",
        message: "Add next",
        content: Buffer.from("Next\n").toString("base64"),
      });
      expect(added.status).toBe(201);
      const addedBody = (await added.json()) as { content: { sha: string }; commit: { sha: string } };
      await expect.poll(() => synchronizations().length).toBe(2);
      expect(synchronizations()[1].payload).toMatchObject({ before: sha, after: addedBody.commit.sha });
      const removed = await request("/contents/next.md", "DELETE", {
        branch: "feature",
        message: "Remove next",
        sha: addedBody.content.sha,
      });
      expect(removed.status).toBe(200);
      const removedBody = (await removed.json()) as { commit: { sha: string } };
      await expect.poll(() => synchronizations().length).toBe(3);
      expect(synchronizations()[2].payload).toMatchObject({
        before: addedBody.commit.sha,
        after: removedBody.commit.sha,
      });
      expect((await request(`/pulls/${pull.number}`, "PATCH", { state: "closed" })).status).toBe(200);
      expect(
        (
          await request("/contents/closed.md", "PUT", {
            branch: "feature",
            message: "Closed change",
            content: Buffer.from("Closed\n").toString("base64"),
          })
        ).status,
      ).toBe(201);
      expect(await (await request(`/pulls/${pull.number}`)).json()).toMatchObject({
        head: { sha: removedBody.commit.sha },
      });
      expect(synchronizations()).toHaveLength(3);
    } finally {
      await new Promise<void>((resolve, reject) => receiver.close((error) => (error ? reject(error) : resolve())));
    }
  });
});
