import { describe, it, expect, beforeEach } from "vitest";
import { createServer, type Hono } from "@emulators/core";
import { githubPlugin, seedFromConfig, getGitHubStore } from "../index.js";

const base = "http://localhost:4000";
const REPO = "/repos/octocat/hello-world";

const installation = (appId: number, accountId: number) => ({
  installationId: appId,
  appId,
  accountId,
  accountType: "User" as const,
  permissions: { metadata: "read", checks: "write", pull_requests: "write", contents: "write" },
  repositoryIds: [],
  repositorySelection: "all" as const,
});

describe("GitHub GraphQL fidelity", () => {
  let app: Hono<any>;
  let gh: ReturnType<typeof getGitHubStore>;

  beforeEach(() => {
    const server = createServer(githubPlugin, {
      baseUrl: base,
      tokens: {
        "test-token": { login: "octocat", id: 1 },
        "hubot-token": { login: "hubot", id: 2 },
        "outsider-token": { login: "outsider", id: 3 },
      },
    });
    app = server.app;
    githubPlugin.seed?.(server.store, base);
    seedFromConfig(server.store, base, {
      users: [{ login: "octocat" }, { login: "hubot" }, { login: "outsider" }],
      repos: [{ owner: "octocat", name: "hello-world" }],
    });
    gh = getGitHubStore(server.store);
    const repo = gh.repos.findOneBy("full_name", "octocat/hello-world")!;
    gh.collaborators.insert({
      repo_id: repo.id,
      user_id: gh.users.findOneBy("login", "hubot")!.id,
      permission: "push",
    });
    const owner = gh.users.findOneBy("login", "octocat")!;
    for (const appId of [11, 12]) {
      server.tokenMap.set(`app-${appId}-token`, {
        login: owner.login,
        id: owner.id,
        scopes: [],
        installation: installation(appId, owner.id),
      });
    }
  });

  async function send(method: string, path: string, body?: unknown, token = "test-token") {
    const res = await app.request(`${base}${path}`, {
      method,
      headers: { Authorization: `token ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { res, status: res.status, body: text ? JSON.parse(text) : null };
  }

  async function graphql(query: string, variables: Record<string, unknown> = {}, token = "test-token") {
    const { res, body } = await send("POST", "/graphql", { query, variables }, token);
    return { res, ...(body as { data?: any; errors?: any[] }) };
  }

  async function seedPr(branch = "feature") {
    const main = await send("GET", `${REPO}/git/ref/heads/main`);
    await send("POST", `${REPO}/git/refs`, { ref: `refs/heads/${branch}`, sha: main.body.object.sha });
    await send("PUT", `${REPO}/contents/${branch}.txt`, {
      message: branch,
      content: Buffer.from(branch).toString("base64"),
      branch,
    });
    const pr = await send("POST", `${REPO}/pulls`, { title: branch, head: branch, base: "main" });
    return pr.body as { number: number; node_id: string; head: { sha: string } };
  }

  const prQuery = (fields: string) =>
    `{ repository(owner: "octocat", name: "hello-world") { pullRequest(number: 1) { ${fields} } } }`;

  describe("mergeability", () => {
    it("reports UNKNOWN while mergeability has not been computed", async () => {
      const pr = await seedPr();
      gh.pullRequests.update(gh.pullRequests.findOneBy("node_id", pr.node_id)!.id, { mergeable: null });
      const { data } = await graphql(prQuery("mergeable mergeStateStatus"));
      expect(data.repository.pullRequest).toEqual({ mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" });
    });
  });

  describe("review decision", () => {
    it("ignores reviews from users without write access", async () => {
      await seedPr();
      await send("POST", `${REPO}/pulls/1/reviews`, { event: "REQUEST_CHANGES", body: "no" }, "outsider-token");
      await send("POST", `${REPO}/pulls/1/reviews`, { event: "APPROVE" }, "outsider-token");
      expect((await graphql(prQuery("reviewDecision"))).data.repository.pullRequest.reviewDecision).toBeNull();

      await send("POST", `${REPO}/pulls/1/reviews`, { event: "REQUEST_CHANGES", body: "fix" }, "hubot-token");
      expect((await graphql(prQuery("reviewDecision"))).data.repository.pullRequest.reviewDecision).toBe(
        "CHANGES_REQUESTED",
      );
    });

    it("keeps an outsider's approval from satisfying a required review, in GraphQL and on merge", async () => {
      await seedPr();
      await send("PUT", `${REPO}/branches/main/protection`, {
        required_status_checks: null,
        enforce_admins: false,
        required_pull_request_reviews: { required_approving_review_count: 1 },
        restrictions: null,
      });
      await send("POST", `${REPO}/pulls/1/reviews`, { event: "APPROVE" }, "outsider-token");
      const { data } = await graphql(prQuery("reviewDecision mergeStateStatus"));
      expect(data.repository.pullRequest).toEqual({ reviewDecision: "REVIEW_REQUIRED", mergeStateStatus: "BLOCKED" });
      expect((await send("PUT", `${REPO}/pulls/1/merge`, {})).status).toBe(422);
    });
  });

  describe("reviews and check runs", () => {
    it("reports latestReviews ids and commit oids", async () => {
      const pr = await seedPr();
      await send("POST", `${REPO}/pulls/1/reviews`, { event: "COMMENT", body: "hi" }, "hubot-token");
      const { data } = await graphql(prQuery("latestReviews(first: 5) { nodes { id commit { oid } } }"));
      const review = gh.reviews.all()[0];
      expect(data.repository.pullRequest.latestReviews.nodes).toEqual([
        { id: review.node_id, commit: { oid: pr.head.sha } },
      ]);
    });

    it("stamps startedAt at creation and reports no workflow for app check runs", async () => {
      const pr = await seedPr();
      await send("POST", `${REPO}/check-runs`, { name: "ci", head_sha: pr.head.sha, status: "queued" }, "app-11-token");
      const { data } = await graphql(
        prQuery(
          `commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 5) { nodes { ... on CheckRun {
            startedAt checkSuite { workflowRun { workflow { name } } } } } } } } } }`,
        ),
      );
      const [run] = data.repository.pullRequest.commits.nodes[0].commit.statusCheckRollup.contexts.nodes;
      expect(run.startedAt).not.toBeNull();
      expect(run.startedAt).toBe(gh.checkRuns.all()[0].started_at);
      expect(run.checkSuite.workflowRun).toBeNull();
    });

    it("keeps each app's result when two apps publish the same check name", async () => {
      const pr = await seedPr();
      const check = (token: string, conclusion: string) =>
        send(
          "POST",
          `${REPO}/check-runs`,
          { name: "ci", head_sha: pr.head.sha, status: "completed", conclusion },
          token,
        );
      await check("app-11-token", "failure");
      await check("app-12-token", "success");
      const { data } = await graphql(
        prQuery(
          `mergeStateStatus commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 5) { checkRunCount } } } } }`,
        ),
      );
      const rollup = data.repository.pullRequest.commits.nodes[0].commit.statusCheckRollup;
      expect(rollup).toEqual({ state: "FAILURE", contexts: { checkRunCount: 2 } });
      expect(data.repository.pullRequest.mergeStateStatus).toBe("UNSTABLE");
    });
  });

  describe("installation tokens", () => {
    it("act as the App bot for viewer and pending reviews", async () => {
      const pr = await seedPr();
      const viewer = await graphql(
        `
          {
            viewer {
              login
            }
          }
        `,
        {},
        "app-11-token",
      );
      const bot = gh.users.all().find((u) => u.type === "Bot")!;
      expect(viewer.data.viewer.login).toBe(bot.login);

      const pending = await graphql(
        `
          mutation ($input: AddPullRequestReviewInput!) {
            addPullRequestReview(input: $input) {
              pullRequestReview {
                state
                author {
                  login
                }
                viewerDidAuthor
              }
            }
          }
        `,
        { input: { pullRequestId: pr.node_id, body: "draft" } },
        "app-11-token",
      );
      expect(pending.data.addPullRequestReview.pullRequestReview).toEqual({
        state: "PENDING",
        author: { login: bot.login },
        viewerDidAuthor: true,
      });

      const submitted = await graphql(
        `
          mutation ($input: SubmitPullRequestReviewInput!) {
            submitPullRequestReview(input: $input) {
              pullRequestReview {
                state
              }
            }
          }
        `,
        { input: { pullRequestId: pr.node_id, event: "COMMENT" } },
        "app-11-token",
      );
      expect(submitted.errors).toBeUndefined();
      expect(submitted.data.submitPullRequestReview.pullRequestReview.state).toBe("COMMENTED");
    });
  });
});
