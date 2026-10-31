import { describe, it, expect, beforeEach, vi } from "vitest";
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
  let server: ReturnType<typeof createServer>;

  beforeEach(() => {
    server = createServer(githubPlugin, {
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

  describe("pagination", () => {
    it("rejects page sizes outside 0..100 with GitHub's errors", async () => {
      await seedPr();
      const cases: Array<[string, string, string]> = [
        [
          "first: 101",
          "EXCESSIVE_PAGINATION",
          "Requesting 101 records on the `pullRequests` connection exceeds the `first` limit of 100 records.",
        ],
        [
          "last: 101",
          "EXCESSIVE_PAGINATION",
          "Requesting 101 records on the `pullRequests` connection exceeds the `last` limit of 100 records.",
        ],
        ["first: -1", "INVALID_PAGINATION", "`first` on the `pullRequests` connection cannot be less than zero."],
      ];
      for (const [args, type, message] of cases) {
        const { data, errors } = await graphql(
          `{ repository(owner: "octocat", name: "hello-world") { pullRequests(${args}) { nodes { number } } } }`,
        );
        expect(data).toEqual({ repository: null });
        expect(errors).toEqual([expect.objectContaining({ type, message, path: ["repository", "pullRequests"] })]);
      }
    });

    it("rejects first and last together", async () => {
      const { errors } = await graphql(`
        {
          repository(owner: "octocat", name: "hello-world") {
            pullRequests(first: 1, last: 1) {
              totalCount
            }
          }
        }
      `);
      expect(errors![0].message).toBe(
        "Passing both `first` and `last` to paginate the `pullRequests` connection is not supported.",
      );
      expect(errors![0].type).toBeUndefined();
    });

    it("requires first or last to read a page, but not to count", async () => {
      await seedPr();
      const counted = await graphql(`
        {
          repository(owner: "octocat", name: "hello-world") {
            pullRequests {
              totalCount
            }
          }
        }
      `);
      expect(counted.errors).toBeUndefined();
      expect(counted.data.repository.pullRequests.totalCount).toBe(1);

      const paged = await graphql(
        prQuery(`labels { ...Page }`) + ` fragment Page on LabelConnection { nodes { name } }`,
      );
      expect(paged.data).toEqual({ repository: { pullRequest: { labels: null } } });
      expect(paged.errors).toEqual([
        expect.objectContaining({
          type: "MISSING_PAGINATION_BOUNDARIES",
          message: "You must provide a `first` or `last` value to properly paginate the `labels` connection.",
          path: ["repository", "pullRequest", "labels"],
        }),
      ]);
    });

    it("reports an invalid cursor instead of restarting from the first item", async () => {
      await seedPr();
      const { data, errors } = await graphql(`
        {
          repository(owner: "octocat", name: "hello-world") {
            pullRequests(first: 1, after: "garbage") {
              totalCount
              nodes {
                number
              }
            }
          }
        }
      `);
      expect(data).toEqual({ repository: { pullRequests: { totalCount: 1, nodes: null } } });
      expect(errors).toEqual([
        expect.objectContaining({
          type: "INVALID_CURSOR_ARGUMENTS",
          message: "`garbage` does not appear to be a valid cursor.",
          path: ["repository", "pullRequests", "nodes"],
        }),
      ]);
    });
  });

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

  describe("rate limit", () => {
    it("charges GraphQL to the graphql resource and reports it in rateLimit", async () => {
      const first = await graphql(`
        {
          viewer {
            login
          }
        }
      `);
      expect(first.res.headers.get("X-RateLimit-Resource")).toBe("graphql");
      expect(first.res.headers.get("X-RateLimit-Used")).toBe("1");

      const { res, data } = await graphql(`
        {
          viewer {
            login
          }
          rateLimit {
            cost
            limit
            used
            remaining
            resetAt
          }
        }
      `);
      expect(data.rateLimit).toMatchObject({ cost: 1, limit: 5000, used: 2, remaining: 4998 });
      expect(data.rateLimit.resetAt).toBe(
        new Date(Number(res.headers.get("X-RateLimit-Reset")) * 1000).toISOString().replace(".000Z", "Z"),
      );

      const rest = await send("GET", "/rate_limit");
      expect(rest.body.resources.graphql).toMatchObject({ used: 2, resource: "graphql" });
      expect(rest.body.resources.core.used).toBe(0);
      expect(rest.res.headers.get("X-RateLimit-Resource")).toBe("core");
      expect((await send("GET", "/api/v3/rate_limit")).body.resources.core.used).toBe(0);
    });

    it("charges by connection size like GitHub, and not for rateLimit-only or dry-run queries", async () => {
      const cost = async (query: string) =>
        (await graphql(`{ rateLimit(dryRun: true) { cost } ${query} }`)).data.rateLimit.cost;
      const repo = `repository(owner: "octocat", name: "hello-world")`;
      expect(
        await cost(`${repo} { pullRequests(first: 100) { nodes { labels(first: 100) { nodes { name } } } } }`),
      ).toBe(1);
      expect(
        await cost(
          `${repo} { pullRequests(first: 100) { nodes { labels(first: 100) { nodes { name } } comments(first: 100) { nodes { id } } } } }`,
        ),
      ).toBe(2);
      expect(
        await cost(
          `${repo} { pullRequests(first: 50) { nodes { commits(first: 20) { nodes { commit { authors(first: 5) { nodes { name } } } } } } } }`,
        ),
      ).toBe(11);

      expect(
        (
          await graphql(`
            {
              rateLimit {
                used
              }
            }
          `)
        ).data.rateLimit.used,
      ).toBe(0);
      const charged = await graphql(`
        {
          repository(owner: "octocat", name: "hello-world") {
            pullRequests(first: 100) {
              nodes {
                labels(first: 100) {
                  nodes {
                    name
                  }
                }
                comments(first: 100) {
                  nodes {
                    id
                  }
                }
              }
            }
          }
        }
      `);
      expect(charged.res.headers.get("X-RateLimit-Used")).toBe("2");
    });

    it("charges a mutation once, however many REST calls it makes", async () => {
      await seedPr();
      const label = await send("POST", `${REPO}/labels`, { name: "triaged", color: "ff0000" });
      const pullRequestId = (await send("GET", `${REPO}/pulls/1`)).body.node_id;
      const coreUsed = async () => Number((await send("GET", REPO)).res.headers.get("X-RateLimit-Used"));
      const before = await coreUsed();
      const { res, errors } = await graphql(
        `
          mutation ($input: UpdatePullRequestInput!) {
            updatePullRequest(input: $input) {
              pullRequest {
                title
              }
            }
          }
        `,
        { input: { pullRequestId, title: "x", labelIds: [label.body.node_id] } },
      );
      expect(errors).toBeUndefined();
      expect(res.headers.get("X-RateLimit-Used")).toBe("1");
      expect((await coreUsed()) - before).toBe(1);
    });

    it("charges /api/v3 once, like the plain REST route", async () => {
      const res = (await send("GET", "/api/v3/repos/octocat/hello-world")).res;
      expect(res.headers.get("X-RateLimit-Used")).toBe("1");
      expect(res.headers.get("X-RateLimit-Resource")).toBe("core");
      expect((await send("GET", REPO)).res.headers.get("X-RateLimit-Used")).toBe("2");
    });

    it("rejects queries over 500,000 possible nodes without charging them", async () => {
      const repo = `repository(owner: "octocat", name: "hello-world")`;
      const deep = await graphql(
        `{ ${repo} { pullRequests(first: 100) { nodes { commits(first: 100) { nodes { commit { authors(first: 100) { totalCount } } } } } } } }`,
      );
      expect(deep.res.status).toBe(200);
      expect(deep.data).toBeUndefined();
      expect(deep.errors).toEqual([
        {
          type: "MAX_NODE_LIMIT_EXCEEDED",
          locations: [{ line: 1, column: 129 }],
          message:
            "By the time this query traverses to the authors connection, it is requesting up to 1,000,000 possible nodes which exceeds the maximum limit of 500,000.",
        },
      ]);
      expect(deep.res.headers.get("X-RateLimit-Used")).toBe("0");

      const wide = await graphql(
        `{ ${repo} { pullRequests(first: 100) { nodes { commits(first: 100) { nodes { commit { authors(first: 49) { nodes { name } } } } } } } } }`,
      );
      expect(wide.errors).toEqual([
        {
          type: "MAX_NODE_LIMIT_EXCEEDED",
          message: "This query requests up to 500,100 possible nodes which exceeds the maximum limit of 500,000.",
        },
      ]);

      const fits = await graphql(
        `{ rateLimit { nodeCount } ${repo} { pullRequests(first: 100) { nodes { commits(first: 100) { nodes { commit { authors(first: 48) { nodes { name } } } } } } } } }`,
      );
      expect(fits.errors).toBeUndefined();
      expect(fits.data.rateLimit.nodeCount).toBe(490_100);
    });

    it("answers RATE_LIMITED once the graphql budget is spent", async () => {
      const expensive = `repository(owner: "octocat", name: "hello-world") { pullRequests(first: 100) { nodes {
        commits(first: 100) { nodes { commit { authors(first: 40) { nodes { name } } } } }
        labels(first: 100) { nodes { name } } comments(first: 100) { nodes { id } } } } }`;
      const dryRun = await graphql(`{ rateLimit(dryRun: true) { cost } ${expensive} }`, {}, "hubot-token");
      expect(dryRun.data.rateLimit.cost).toBe(103);
      for (let i = 0; i < 50; i++)
        await graphql(
          `
            {
              viewer {
                login
              }
            }
          `,
          {},
          "hubot-token",
        );
      for (let i = 0; i < 48; i++)
        expect((await graphql(`{ ${expensive} }`, {}, "hubot-token")).errors).toBeUndefined();

      const limited = await graphql(`{ ${expensive} }`, {}, "hubot-token");
      expect(limited.res.status).toBe(200);
      expect(limited.errors).toEqual([
        { type: "RATE_LIMITED", message: "API rate limit already exceeded for user ID 2." },
      ]);
      expect(limited.res.headers.get("X-RateLimit-Used")).toBe("4994");
      expect(
        (
          await graphql(
            `
              {
                viewer {
                  login
                }
              }
            `,
            {},
            "hubot-token",
          )
        ).errors,
      ).toBeUndefined();
    });
  });

  describe("errors from delegated REST calls", () => {
    it("reports REST's validation detail as GitHub's GraphQL message", async () => {
      const repositoryId = gh.repos.findOneBy("full_name", "octocat/hello-world")!.node_id;
      const { errors } = await graphql(
        `
          mutation ($input: CreatePullRequestInput!) {
            createPullRequest(input: $input) {
              pullRequest {
                number
              }
            }
          }
        `,
        { input: { repositoryId, baseRefName: "main", headRefName: "main", title: "x" } },
      );
      expect(errors![0]).toMatchObject({ type: "UNPROCESSABLE", message: "No commits between main and main" });
    });

    it("validates every step of updatePullRequest before writing", async () => {
      const pr = await seedPr();
      const label = await send("POST", `${REPO}/labels`, { name: "triaged", color: "ff0000" });
      const repo = gh.repos.findOneBy("full_name", "octocat/hello-world")!;
      gh.repos.update(repo.id, { has_issues: false });
      const { errors } = await graphql(
        `
          mutation ($input: UpdatePullRequestInput!) {
            updatePullRequest(input: $input) {
              pullRequest {
                title
              }
            }
          }
        `,
        { input: { pullRequestId: pr.node_id, title: "renamed", labelIds: [label.body.node_id] } },
      );
      expect(errors![0].type).toBe("NOT_FOUND");
      expect(gh.pullRequests.findOneBy("node_id", pr.node_id)!.title).toBe("feature");
    });

    it("validates requested reviewers before removing the current ones", async () => {
      const pr = await seedPr();
      await send("POST", `${REPO}/pulls/1/requested_reviewers`, { reviewers: ["hubot"] });
      const { errors } = await graphql(
        `
          mutation ($input: RequestReviewsByLoginInput!) {
            requestReviewsByLogin(input: $input) {
              clientMutationId
            }
          }
        `,
        { input: { pullRequestId: pr.node_id, userLogins: ["nobody"], union: false } },
      );
      expect(errors![0].type).toBe("UNPROCESSABLE");
      const hubot = gh.users.findOneBy("login", "hubot")!;
      expect(gh.pullRequests.findOneBy("node_id", pr.node_id)!.requested_reviewer_ids).toEqual([hubot.id]);
    });

    it("ignores labels that are not on the pull request when removing labels", async () => {
      const pr = await seedPr();
      const bug = await send("POST", `${REPO}/labels`, { name: "triaged", color: "ff0000" });
      const docs = await send("POST", `${REPO}/labels`, { name: "wontfix-later", color: "0000ff" });
      await send("POST", `${REPO}/issues/1/labels`, { labels: ["triaged"] });
      const { data, errors } = await graphql(
        `
          mutation ($input: RemoveLabelsFromLabelableInput!) {
            removeLabelsFromLabelable(input: $input) {
              labelable {
                ... on PullRequest {
                  labels(first: 10) {
                    nodes {
                      name
                    }
                  }
                }
              }
            }
          }
        `,
        { input: { labelableId: pr.node_id, labelIds: [docs.body.node_id, bug.body.node_id] } },
      );
      expect(errors).toBeUndefined();
      expect(data.removeLabelsFromLabelable.labelable.labels.nodes).toEqual([]);
    });
  });

  describe("/api/v3", () => {
    it("prefixes REST API URLs and leaves web URLs alone", async () => {
      await seedPr();
      const { body } = await send("GET", "/api/v3/repos/octocat/hello-world/pulls/1");
      expect(body.url).toBe(`${base}/api/v3/repos/octocat/hello-world/pulls/1`);
      expect(body.user.url).toBe(`${base}/api/v3/users/octocat`);
      expect(body.html_url).toBe(`${base}/octocat/hello-world/pull/1`);
      expect(body._links.self.href).toBe(`${base}/api/v3/repos/octocat/hello-world/pulls/1`);
      expect(body._links.html.href).toBe(`${base}/octocat/hello-world/pull/1`);
    });

    it("prefixes Link headers", async () => {
      await seedPr("one");
      await seedPr("two");
      const { res } = await send("GET", "/api/v3/repos/octocat/hello-world/pulls?per_page=1");
      expect(res.headers.get("Link")).toContain(`<${base}/api/v3/repos/octocat/hello-world/pulls?`);
    });

    it("serves the API root document at /api/v3", async () => {
      const { status, body } = await send("GET", "/api/v3");
      expect(status).toBe(200);
      expect(body.current_user_url).toBe(`${base}/api/v3/user`);
      expect(body.repository_url).toBe(`${base}/api/v3/repos/{owner}/{repo}`);
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

  describe("issue search", () => {
    beforeEach(async () => {
      await send("POST", `${REPO}/labels`, { name: "bug", color: "d73a4a" });
      const one = await seedPr("one");
      await send("POST", `${REPO}/issues/${one.number}/labels`, { labels: ["bug"] });
      const two = await seedPr("two");
      await graphql(
        `
          mutation ($id: ID!) {
            convertPullRequestToDraft(input: { pullRequestId: $id }) {
              clientMutationId
            }
          }
        `,
        {
          id: two.node_id,
        },
      );
      await seedPr("three");
      await send("POST", `${REPO}/issues`, { title: "an issue", labels: ["bug"] });
    });

    const count = async (query: string, type = "ISSUE_ADVANCED") => {
      const { data, errors } = await graphql(
        `
          query ($q: String!, $t: SearchType!) {
            search(query: $q, type: $t, first: 10) {
              issueCount
            }
          }
        `,
        { q: query, t: type },
      );
      expect(errors).toBeUndefined();
      return data.search.issueCount;
    };
    const rest = (query: string, advanced: boolean) =>
      send("GET", `/search/issues?q=${encodeURIComponent(query)}${advanced ? "&advanced_search=true" : ""}`);
    const scope = "repo:octocat/hello-world";

    it("groups terms with parentheses, AND, OR, and NOT in the advanced syntax", async () => {
      expect(await count(`( is:open ) ${scope} type:pr`)).toBe(3);
      expect(await count(`( label:bug ) ${scope} type:pr`)).toBe(1);
      expect(await count(`${scope} ( label:bug OR is:draft ) type:pr`)).toBe(2);
      expect(await count(`${scope} label:bug OR is:draft`)).toBe(3);
      expect(await count(`${scope} type:pr is:open AND label:bug`)).toBe(1);
      expect(await count(`${scope} type:pr NOT three`)).toBe(2);
      expect(await count(`${scope} type:pr NOT label:bug`)).toBe(0);
      expect(await count(`${scope} type:pr ( is:open`)).toBe(0);
    });

    it("treats parentheses as text in the legacy syntax, as GitHub does", async () => {
      expect(await count(`is:open ${scope} type:pr`, "ISSUE")).toBe(3);
      expect(await count(`( is:open ) ${scope} type:pr`, "ISSUE")).toBe(0);
      expect((await rest(`( is:open ) ${scope} type:pr`, false)).body.total_count).toBe(0);
      expect((await rest(`( is:open ) ${scope} type:pr`, true)).body.total_count).toBe(3);
    });

    it("rejects unbalanced parentheses in REST advanced search", async () => {
      const { status, body } = await rest(`${scope} type:pr ( is:open`, true);
      expect(status).toBe(422);
      expect(body.errors).toEqual([
        { message: "The search query contains invalid syntax.", resource: "Search", field: "q", code: "invalid" },
      ]);
    });

    it("returns REST search hits in GitHub's issue shape", async () => {
      const { body } = await rest(`${scope} is:open sort:created-asc`, false);
      const origin = `${base}/repos/octocat/hello-world`;
      const pr = body.items.find((item: { number: number }) => item.number === 2);
      expect(pr).toMatchObject({
        url: `${origin}/issues/2`,
        repository_url: origin,
        html_url: `${base}/octocat/hello-world/pull/2`,
        draft: true,
        score: 1,
        pull_request: {
          url: `${origin}/pulls/2`,
          html_url: `${base}/octocat/hello-world/pull/2`,
          diff_url: `${base}/octocat/hello-world/pull/2.diff`,
          patch_url: `${base}/octocat/hello-world/pull/2.patch`,
          merged_at: null,
        },
      });
      expect(pr).not.toHaveProperty("head");
      const issue = body.items.find((item: { number: number }) => item.number === 4);
      expect(issue).toMatchObject({
        repository_url: origin,
        html_url: `${base}/octocat/hello-world/issues/4`,
        score: 1,
      });
      expect(issue).not.toHaveProperty("pull_request");
      expect(issue).not.toHaveProperty("draft");
    });

    it("filters by draft:true, draft:false, and is:draft", async () => {
      for (const type of ["ISSUE", "ISSUE_ADVANCED"]) {
        expect(await count(`draft:true ${scope} state:open type:pr`, type)).toBe(1);
        expect(await count(`draft:false ${scope} state:open type:pr`, type)).toBe(2);
        expect(await count(`is:draft ${scope} state:open type:pr`, type)).toBe(1);
        expect(await count(`-is:draft ${scope} state:open type:pr`, type)).toBe(2);
        expect(await count(`-draft:true ${scope} type:pr`, type)).toBe(2);
        expect(await count(`draft:true ${scope} type:issue`, type)).toBe(0);
        expect(await count(`draft:false ${scope} type:issue`, type)).toBe(0);
      }
    });
  });

  describe("public repository permissions", () => {
    const close = (id: string, token: string) =>
      graphql(
        `
          mutation ($id: ID!) {
            closePullRequest(input: { pullRequestId: $id }) {
              pullRequest {
                state
              }
            }
          }
        `,
        { id },
        token,
      );

    beforeEach(() => {
      const repo = gh.repos.findOneBy("full_name", "octocat/hello-world")!;
      const { id: _id, created_at: _c, updated_at: _u, ...outsider } = gh.users.findOneBy("login", "outsider")!;
      const triager = gh.users.insert({ ...outsider, login: "triager" });
      gh.collaborators.insert({ repo_id: repo.id, user_id: triager.id, permission: "triage" });
    });

    it("lets anyone open and comment, and authors change only their own work over REST", async () => {
      await send("POST", `${REPO}/labels`, { name: "bug", color: "d73a4a" });
      const opened = await send("POST", `${REPO}/issues`, { title: "mine", labels: ["bug"] }, "outsider-token");
      expect(opened.status).toBe(201);
      expect(opened.body.labels).toEqual([]);
      const theirs = await send("POST", `${REPO}/issues`, { title: "theirs" });

      const comment = await send(
        "POST",
        `${REPO}/issues/${theirs.body.number}/comments`,
        { body: "hi" },
        "outsider-token",
      );
      expect(comment.status).toBe(201);
      const ownerComment = await send("POST", `${REPO}/issues/${theirs.body.number}/comments`, { body: "owner" });

      const denied = { message: "Must have admin rights to Repository." };
      expect(
        await send("PATCH", `${REPO}/issues/comments/${comment.body.id}`, { body: "edited" }, "outsider-token"),
      ).toMatchObject({ status: 200 });
      expect(
        await send("PATCH", `${REPO}/issues/comments/${ownerComment.body.id}`, { body: "x" }, "outsider-token"),
      ).toMatchObject({ status: 403, body: denied });
      expect(
        await send("DELETE", `${REPO}/issues/comments/${ownerComment.body.id}`, undefined, "outsider-token"),
      ).toMatchObject({ status: 403, body: denied });

      expect(
        await send("PATCH", `${REPO}/issues/${opened.body.number}`, { state: "closed" }, "outsider-token"),
      ).toMatchObject({ status: 200 });
      expect(
        await send("PATCH", `${REPO}/issues/${theirs.body.number}`, { state: "closed" }, "outsider-token"),
      ).toMatchObject({ status: 403, body: denied });
      expect(
        await send("POST", `${REPO}/issues/${theirs.body.number}/labels`, { labels: ["bug"] }, "outsider-token"),
      ).toMatchObject({ status: 403, body: denied });
      expect(
        await send(
          "POST",
          `${REPO}/issues/${theirs.body.number}/assignees`,
          { assignees: ["outsider"] },
          "outsider-token",
        ),
      ).toMatchObject({ status: 403, body: denied });
      expect(await send("PUT", `${REPO}/issues/${theirs.body.number}/lock`, {}, "outsider-token")).toMatchObject({
        status: 403,
        body: denied,
      });
      expect(await send("POST", `${REPO}/labels`, { name: "x", color: "ffffff" }, "outsider-token")).toMatchObject({
        status: 404,
      });
      expect(await send("POST", `${REPO}/milestones`, { title: "v1" }, "outsider-token")).toMatchObject({
        status: 404,
      });
      expect((await send("GET", `${REPO}/issues/${theirs.body.number}`)).body).toMatchObject({
        state: "open",
        labels: [],
      });
    });

    it("keeps pull request triage and writes to collaborators over REST", async () => {
      const pr = await seedPr();
      const main = await send("GET", `${REPO}/git/ref/heads/main`);
      await send("POST", `${REPO}/git/refs`, { ref: "refs/heads/outside", sha: main.body.object.sha });
      await send("PUT", `${REPO}/contents/outside.txt`, { message: "o", content: "bw==", branch: "outside" });
      const own = await send(
        "POST",
        `${REPO}/pulls`,
        { title: "outside", head: "outside", base: "main" },
        "outsider-token",
      );
      expect(own.status).toBe(201);
      expect(
        await send("PATCH", `${REPO}/pulls/${own.body.number}`, { title: "renamed" }, "outsider-token"),
      ).toMatchObject({ status: 200 });
      const review = await send(
        "POST",
        `${REPO}/pulls/${pr.number}/reviews`,
        { event: "COMMENT", body: "looks fine" },
        "outsider-token",
      );
      expect(review.body).toMatchObject({ state: "COMMENTED", user: { login: "outsider" } });

      const notFound = { status: 404, body: { message: "Not Found" } };
      expect(await send("PATCH", `${REPO}/pulls/${pr.number}`, { state: "closed" }, "outsider-token")).toMatchObject(
        notFound,
      );
      expect(await send("PATCH", `${REPO}/pulls/${pr.number}`, { title: "x" }, "outsider-token")).toMatchObject(
        notFound,
      );
      expect(await send("PUT", `${REPO}/pulls/${pr.number}/merge`, {}, "outsider-token")).toMatchObject(notFound);
      expect(
        await send(
          "POST",
          `${REPO}/pulls/${pr.number}/requested_reviewers`,
          { reviewers: ["hubot"] },
          "outsider-token",
        ),
      ).toMatchObject(notFound);

      const triager = gh.users.findOneBy("login", "triager")!;
      server.tokenMap.set("triager-token", { login: triager.login, id: triager.id, scopes: ["repo"] });
      expect(await send("PATCH", `${REPO}/pulls/${pr.number}`, { title: "x" }, "triager-token")).toMatchObject(
        notFound,
      );
      expect(await send("PUT", `${REPO}/pulls/${pr.number}/merge`, {}, "triager-token")).toMatchObject(notFound);
      const requested = await send(
        "POST",
        `${REPO}/pulls/${pr.number}/requested_reviewers`,
        { reviewers: ["hubot"] },
        "triager-token",
      );
      expect(requested.body.requested_reviewers).toMatchObject([{ login: "hubot" }]);
      expect(await send("PATCH", `${REPO}/pulls/${pr.number}`, { state: "closed" }, "triager-token")).toMatchObject({
        status: 200,
      });
      expect(gh.pullRequests.findOneBy("node_id", pr.node_id)!.title).toBe("feature");
    });

    it("refuses GraphQL mutations an outsider may not run, with GitHub's error", async () => {
      const pr = await seedPr();
      const forbidden = (name: string) => [
        {
          type: "FORBIDDEN",
          path: [name],
          locations: expect.any(Array),
          message: `outsider does not have the correct permissions to execute \`${name[0]!.toUpperCase()}${name.slice(1)}\``,
        },
      ];
      expect((await close(pr.node_id, "outsider-token")).errors).toEqual(forbidden("closePullRequest"));
      const update = await graphql(
        `
          mutation ($id: ID!) {
            updatePullRequest(input: { pullRequestId: $id, title: "x" }) {
              clientMutationId
            }
          }
        `,
        { id: pr.node_id },
        "outsider-token",
      );
      expect(update.errors).toEqual(forbidden("updatePullRequest"));
      const merge = await graphql(
        `
          mutation ($id: ID!) {
            mergePullRequest(input: { pullRequestId: $id }) {
              clientMutationId
            }
          }
        `,
        { id: pr.node_id },
        "outsider-token",
      );
      expect(merge.errors).toEqual(forbidden("mergePullRequest"));
      const stored = gh.pullRequests.findOneBy("node_id", pr.node_id)!;
      expect(stored).toMatchObject({ state: "open", title: "feature", merged: false });

      const triager = gh.users.findOneBy("login", "triager")!;
      server.tokenMap.set("triager-token", { login: triager.login, id: triager.id, scopes: ["repo"] });
      expect((await close(pr.node_id, "triager-token")).data.closePullRequest.pullRequest.state).toBe("CLOSED");
    });
  });

  it("lists repository-wide issue and review comments", async () => {
    const pr = await seedPr();
    await send("POST", `${REPO}/issues/${pr.number}/comments`, { body: "issue comment" });
    const issueComments = await send("GET", `${REPO}/issues/comments`);
    expect(issueComments.status).toBe(200);
    expect(issueComments.body.map((comment: { body: string }) => comment.body)).toEqual(["issue comment"]);
    expect(await send("GET", `${REPO}/pulls/comments`)).toMatchObject({ status: 200, body: [] });
    expect(await send("GET", `${REPO}/pulls/${pr.number}`)).toMatchObject({ status: 200 });
  });

  it("answers an unknown token with GitHub's Bad credentials 401 on every API route", async () => {
    const badCredentials = {
      message: "Bad credentials",
      documentation_url: "https://docs.github.com/rest",
      status: "401",
    };
    for (const [method, path, body] of [
      ["GET", "/user"],
      ["GET", REPO],
      ["GET", "/api/v3/user"],
      ["POST", "/graphql", { query: "{ viewer { login } }" }],
    ] as const) {
      expect(await send(method, path, body, "not-a-seeded-token")).toMatchObject({ status: 401, body: badCredentials });
    }
    expect(await send("GET", "/user")).toMatchObject({ status: 200, body: { login: "octocat" } });
    const raw = await app.request(`${base}/octocat/hello-world/raw/main/README.md`, {
      headers: { Authorization: "token not-a-seeded-token" },
    });
    expect(raw.status).toBe(200);
    const login = await app.request(`${base}/login/oauth/authorize?client_id=none`, {
      headers: { Authorization: "token not-a-seeded-token" },
    });
    expect(login.status).not.toBe(401);
  });

  it("reads a token from Basic credentials only where GitHub does", async () => {
    const basic = async (path: string, credentials: string) => {
      const res = await app.request(`${base}${path}`, {
        headers: { Authorization: `Basic ${Buffer.from(credentials).toString("base64")}` },
      });
      return { status: res.status, body: await res.json() };
    };
    const badCredentials = { status: 401, body: { message: "Bad credentials" } };
    const unknownToken = `ghp_${"0".repeat(36)}`;

    expect(await basic(REPO, "octocat:definitely-wrong")).toMatchObject({ status: 200 });
    expect(await basic(REPO, "octocat:")).toMatchObject({ status: 200 });
    expect(await basic(REPO, `${unknownToken}:wrong`)).toMatchObject({ status: 200 });
    expect(await basic("/user", "octocat:definitely-wrong")).toMatchObject({
      status: 401,
      body: { message: "Requires authentication" },
    });
    expect(await basic(REPO, `octocat:${unknownToken}`)).toMatchObject(badCredentials);
    expect(await basic(REPO, `${unknownToken}:`)).toMatchObject(badCredentials);
    expect(await basic(REPO, `${unknownToken}:x-oauth-basic`)).toMatchObject(badCredentials);
    expect(await basic(REPO, `x:gho_${"a".repeat(36)}`)).toMatchObject(badCredentials);
    expect(await basic(REPO, `x:${"0123456789abcdef".repeat(2)}01234567`)).toMatchObject(badCredentials);
    expect(await basic("/graphql", `x:${unknownToken}`)).toMatchObject(badCredentials);
    const malformed = await app.request(`${base}${REPO}`, { headers: { Authorization: "Basic !!!notbase64" } });
    expect(malformed.status).toBe(401);

    expect(await basic("/user", "octocat:test-token")).toMatchObject({ status: 200, body: { login: "octocat" } });
    expect(await basic("/user", "test-token:x-oauth-basic")).toMatchObject({ status: 200, body: { login: "octocat" } });
  });

  it("serves and edits a pull request through the issue routes, as GitHub does", async () => {
    const pr = await seedPr();
    const issue = await send("GET", `${REPO}/issues/${pr.number}`);
    expect(issue).toMatchObject({
      status: 200,
      body: {
        number: pr.number,
        node_id: pr.node_id,
        html_url: `${base}/octocat/hello-world/pull/${pr.number}`,
        draft: false,
        pull_request: { url: `${base}${REPO}/pulls/${pr.number}`, merged_at: null },
      },
    });
    const list = await send("GET", `${REPO}/issues?state=all`);
    expect(list.body.map((i: { number: number }) => i.number)).toContain(pr.number);

    const dispatch = vi.spyOn(server.webhooks, "dispatch");
    expect(await send("PATCH", `${REPO}/issues/${pr.number}`, { title: "Renamed", state: "closed" })).toMatchObject({
      status: 200,
      body: { title: "Renamed", state: "closed", pull_request: expect.any(Object) },
    });
    expect(await send("GET", `${REPO}/pulls/${pr.number}`)).toMatchObject({
      body: { title: "Renamed", state: "closed" },
    });
    expect(dispatch).toHaveBeenCalledWith(
      "pull_request",
      "closed",
      expect.objectContaining({ number: pr.number, pull_request: expect.objectContaining({ state: "closed" }) }),
      "octocat",
      "hello-world",
    );
    expect(dispatch.mock.calls.some(([event]) => event === "issues")).toBe(false);

    expect(await send("POST", `${REPO}/issues/${pr.number}/assignees`, { assignees: ["hubot"] })).toMatchObject({
      status: 201,
    });
    expect(await send("PUT", `${REPO}/issues/${pr.number}/lock`, {})).toMatchObject({ status: 204 });
    const pull = await send("GET", `${REPO}/pulls/${pr.number}`);
    expect(pull.body).toMatchObject({ locked: true, assignees: [{ login: "hubot" }] });
    expect(await send("DELETE", `${REPO}/issues/${pr.number}/lock`)).toMatchObject({ status: 204 });
    expect(await send("GET", `${REPO}/issues/${pr.number}/events`)).toMatchObject({ status: 200 });
    expect(await send("POST", `${REPO}/issues/${pr.number}/labels`, { labels: ["bug"] })).toMatchObject({
      status: 200,
    });
    expect(dispatch).toHaveBeenCalledWith("pull_request", "labeled", expect.anything(), "octocat", "hello-world");
    dispatch.mockRestore();
  });

  it("reports a pull request's lock reason on the pull request route and webhook", async () => {
    const pr = await seedPr();
    expect((await send("GET", `${REPO}/pulls/${pr.number}`)).body).toMatchObject({ active_lock_reason: null });
    const dispatch = vi.spyOn(server.webhooks, "dispatch");
    await send("PUT", `${REPO}/issues/${pr.number}/lock`, { lock_reason: "too heated" });
    expect((await send("GET", `${REPO}/pulls/${pr.number}`)).body).toMatchObject({
      locked: true,
      active_lock_reason: "too heated",
    });
    expect((await send("GET", `${REPO}/issues/${pr.number}`)).body.active_lock_reason).toBe("too heated");
    expect(dispatch).toHaveBeenCalledWith(
      "pull_request",
      "locked",
      expect.objectContaining({ pull_request: expect.objectContaining({ active_lock_reason: "too heated" }) }),
      "octocat",
      "hello-world",
    );
    dispatch.mockRestore();
    await send("DELETE", `${REPO}/issues/${pr.number}/lock`);
    expect((await send("GET", `${REPO}/pulls/${pr.number}`)).body).toMatchObject({
      locked: false,
      active_lock_reason: null,
    });
  });

  it("sends a pull request in the issue shape with issue_comment webhooks", async () => {
    const pr = await seedPr();
    const dispatch = vi.spyOn(server.webhooks, "dispatch");
    const created = await send("POST", `${REPO}/issues/${pr.number}/comments`, { body: "hi" });
    expect(created.body.html_url).toBe(`${base}/octocat/hello-world/pull/${pr.number}#issuecomment-${created.body.id}`);
    await send("PATCH", `${REPO}/issues/comments/${created.body.id}`, { body: "edited" });
    await send("DELETE", `${REPO}/issues/comments/${created.body.id}`);
    const issuePayloads = dispatch.mock.calls
      .filter(([event]) => event === "issue_comment")
      .map(([, action, payload]) => [action, (payload as { issue: Record<string, unknown> }).issue] as const);
    expect(issuePayloads.map(([action]) => action)).toEqual(["created", "edited", "deleted"]);
    expect(issuePayloads.map(([, issue]) => issue.comments)).toEqual([1, 1, 1]);
    for (const [, issue] of issuePayloads) {
      expect(issue).toMatchObject({
        number: pr.number,
        html_url: `${base}/octocat/hello-world/pull/${pr.number}`,
        pull_request: { url: `${base}${REPO}/pulls/${pr.number}` },
      });
    }
    dispatch.mockRestore();
  });

  it("locks without a reason and rejects an unknown reason, as GitHub does", async () => {
    const issue = await send("POST", `${REPO}/issues`, { title: "locked" });
    const lock = (body?: unknown) => send("PUT", `${REPO}/issues/${issue.body.number}/lock`, body);

    expect(await lock({ lock_reason: "x" })).toMatchObject({
      status: 422,
      body: { message: 'Invalid request.\n\nx is not a member of ["off-topic", "too heated", "resolved", "spam"].' },
    });
    expect((await send("GET", `${REPO}/issues/${issue.body.number}`)).body.locked).toBe(false);
    expect(await send("PUT", `${REPO}/issues/9999/lock`, { lock_reason: "x" })).toMatchObject({ status: 404 });

    expect(await lock()).toMatchObject({ status: 204 });
    expect((await send("GET", `${REPO}/issues/${issue.body.number}`)).body).toMatchObject({
      locked: true,
      active_lock_reason: null,
    });
  });

  it("counts a pull request's comments the same on every route", async () => {
    const pr = await seedPr();
    const first = await send("POST", `${REPO}/issues/${pr.number}/comments`, { body: "one" });
    await send("POST", `${REPO}/issues/${pr.number}/comments`, { body: "two" });
    await send("DELETE", `${REPO}/issues/comments/${first.body.id}`);
    await send("POST", `${REPO}/pulls/${pr.number}/comments`, {
      body: "line",
      commit_id: pr.head.sha,
      path: "feature.txt",
      line: 1,
    });
    await send("POST", `${REPO}/pulls/${pr.number}/reviews`, {
      event: "COMMENT",
      comments: [{ path: "feature.txt", line: 1, body: "in review" }],
    });

    expect((await send("GET", `${REPO}/issues/${pr.number}`)).body.comments).toBe(1);
    expect((await send("GET", `${REPO}/pulls/${pr.number}`)).body).toMatchObject({ comments: 1, review_comments: 2 });
    const query = `query($n: Int!) { repository(owner: "octocat", name: "hello-world") {
      pullRequest(number: $n) { comments(first: 10) { totalCount } } } }`;
    expect((await graphql(query, { n: pr.number })).data.repository.pullRequest.comments.totalCount).toBe(1);

    const issue = await send("POST", `${REPO}/issues`, { title: "plain" });
    await send("POST", `${REPO}/issues/${issue.body.number}/comments`, { body: "a" });
    await send("POST", `${REPO}/issues/${issue.body.number}/comments`, { body: "b" });
    expect((await send("GET", `${REPO}/issues/${issue.body.number}`)).body.comments).toBe(2);
    const byComments = await send("GET", `${REPO}/issues?state=all&sort=comments&direction=desc`);
    expect(byComments.body.map((i: { number: number }) => i.number)).toEqual([issue.body.number, pr.number]);
  });

  describe("organization repository roles", () => {
    const ORG_REPO = "/repos/acme/widgets";
    const tokens = ["owner", "member", "writer", "teammate"] as const;

    async function seedOrg(basePermission: "read" | "write" | "none") {
      seedFromConfig(server.store, base, {
        users: tokens.map((login) => ({ login })),
        orgs: [
          {
            login: "acme",
            default_repository_permission: basePermission,
            members: [
              { login: "owner", role: "admin" },
              { login: "member" },
              { login: "writer" },
              { login: "teammate" },
            ],
            teams: [{ name: "Devs", permission: "push", members: ["teammate"], repos: ["widgets"] }],
          },
        ],
        repos: [{ owner: "acme", name: "widgets" }],
      });
      const repo = gh.repos.findOneBy("full_name", "acme/widgets")!;
      gh.collaborators.insert({
        repo_id: repo.id,
        user_id: gh.users.findOneBy("login", "writer")!.id,
        permission: "push",
      });
      for (const login of tokens) {
        const user = gh.users.findOneBy("login", login)!;
        server.tokenMap.set(`${login}-token`, { login, id: user.id, scopes: ["repo"] });
      }
      const main = await send("GET", `${ORG_REPO}/git/ref/heads/main`, undefined, "owner-token");
      await send(
        "POST",
        `${ORG_REPO}/git/refs`,
        { ref: "refs/heads/feature", sha: main.body.object.sha },
        "owner-token",
      );
      await send(
        "PUT",
        `${ORG_REPO}/contents/feature.txt`,
        { message: "f", content: "Zg==", branch: "feature" },
        "owner-token",
      );
      await send("POST", `${ORG_REPO}/labels`, { name: "bug", color: "d73a4a" }, "owner-token");
      const pr = await send(
        "POST",
        `${ORG_REPO}/pulls`,
        { title: "feature", head: "feature", base: "main" },
        "owner-token",
      );
      const issue = await send("POST", `${ORG_REPO}/issues`, { title: "owner issue" }, "owner-token");
      return { pr: pr.body as { number: number; node_id: string }, issue: issue.body as { number: number } };
    }

    const mergeMutation = `mutation($id: ID!) { mergePullRequest(input: { pullRequestId: $id }) { pullRequest { state } } }`;

    it("gives members with the default read base permission only read access", async () => {
      const { pr, issue } = await seedOrg("read");
      const notFound = { status: 404, body: { message: "Not Found" } };
      const denied = { status: 403, body: { message: "Must have admin rights to Repository." } };

      expect(await send("PATCH", `${ORG_REPO}/pulls/${pr.number}`, { state: "closed" }, "member-token")).toMatchObject(
        notFound,
      );
      expect(await send("PUT", `${ORG_REPO}/pulls/${pr.number}/merge`, {}, "member-token")).toMatchObject(notFound);
      expect(
        await send("POST", `${ORG_REPO}/issues/${issue.number}/labels`, { labels: ["bug"] }, "member-token"),
      ).toMatchObject(denied);
      expect(
        await send("PATCH", `${ORG_REPO}/issues/${issue.number}`, { state: "closed" }, "member-token"),
      ).toMatchObject(denied);
      const close = await graphql(
        `
          mutation ($id: ID!) {
            closePullRequest(input: { pullRequestId: $id }) {
              clientMutationId
            }
          }
        `,
        { id: pr.node_id },
        "member-token",
      );
      expect(close.errors?.[0]).toMatchObject({
        type: "FORBIDDEN",
        message: "member does not have the correct permissions to execute `ClosePullRequest`",
      });
      const viewer = await graphql(
        `
          {
            repository(owner: "acme", name: "widgets") {
              viewerPermission
            }
          }
        `,
        {},
        "member-token",
      );
      expect(viewer.data.repository.viewerPermission).toBe("READ");
      expect(gh.pullRequests.findOneBy("node_id", pr.node_id)!.state).toBe("open");
    });

    it("lets org owners, write collaborators, and push teams triage and merge", async () => {
      const { pr, issue } = await seedOrg("read");
      expect(
        await send("POST", `${ORG_REPO}/issues/${issue.number}/labels`, { labels: ["bug"] }, "teammate-token"),
      ).toMatchObject({ status: 200 });
      expect(
        await send("PATCH", `${ORG_REPO}/issues/${issue.number}`, { state: "closed" }, "writer-token"),
      ).toMatchObject({ status: 200 });
      const owner = await graphql(
        `
          {
            repository(owner: "acme", name: "widgets") {
              viewerPermission
            }
          }
        `,
        {},
        "owner-token",
      );
      expect(owner.data.repository.viewerPermission).toBe("ADMIN");
      const merged = await graphql(mergeMutation, { id: pr.node_id }, "teammate-token");
      expect(merged.errors).toBeUndefined();
      expect(merged.data.mergePullRequest.pullRequest.state).toBe("MERGED");
    });

    it("gives every member write access when the base permission is write", async () => {
      const { pr } = await seedOrg("write");
      const viewer = await graphql(
        `
          {
            repository(owner: "acme", name: "widgets") {
              viewerPermission
            }
          }
        `,
        {},
        "member-token",
      );
      expect(viewer.data.repository.viewerPermission).toBe("WRITE");
      expect(await send("PUT", `${ORG_REPO}/pulls/${pr.number}/merge`, {}, "member-token")).toMatchObject({
        status: 200,
      });
    });

    const viewerPermissionQuery = (name: string) =>
      `{ repository(owner: "acme", name: "${name}") { viewerPermission } }`;
    const ROLE = {
      read: { admin: false, maintain: false, push: false, triage: false, pull: true },
      write: { admin: false, maintain: false, push: true, triage: true, pull: true },
      admin: { admin: true, maintain: true, push: true, triage: true, pull: true },
    };

    it("makes a member who creates or forks an organization repository its admin", async () => {
      await seedOrg("none");
      const created = await send("POST", "/orgs/acme/repos", { name: "tool", private: true }, "member-token");
      expect(created).toMatchObject({ status: 201, body: { permissions: ROLE.admin } });
      expect(await send("GET", "/repos/acme/tool", undefined, "member-token")).toMatchObject({ status: 200 });
      expect((await graphql(viewerPermissionQuery("tool"), {}, "member-token")).data.repository.viewerPermission).toBe(
        "ADMIN",
      );
      expect(await send("PATCH", "/repos/acme/tool", { description: "mine" }, "member-token")).toMatchObject({
        status: 200,
      });
      expect(
        await send("PUT", "/repos/acme/tool/contents/a.txt", { message: "a", content: "YQ==" }, "member-token"),
      ).toMatchObject({ status: 201 });
      const direct = await send("GET", "/repos/acme/tool/collaborators?affiliation=direct", undefined, "member-token");
      expect(direct.body.map((u: { login: string; role_name: string }) => [u.login, u.role_name])).toEqual([
        ["member", "admin"],
      ]);

      const forked = await send(
        "POST",
        `${ORG_REPO}/forks`,
        { organization: "acme", name: "widgets-fork" },
        "writer-token",
      );
      expect(forked).toMatchObject({ status: 202, body: { permissions: ROLE.admin } });
      expect(await send("PATCH", "/repos/acme/widgets-fork", { description: "fork" }, "writer-token")).toMatchObject({
        status: 200,
      });
    });

    it("reports the caller's role as permissions on repository responses", async () => {
      await seedOrg("read");
      expect((await send("GET", ORG_REPO, undefined, "member-token")).body.permissions).toEqual(ROLE.read);
      expect((await send("GET", ORG_REPO, undefined, "teammate-token")).body.permissions).toEqual(ROLE.write);
      expect((await send("GET", ORG_REPO, undefined, "owner-token")).body.permissions).toEqual(ROLE.admin);
      expect((await send("GET", ORG_REPO, undefined, "outsider-token")).body.permissions).toEqual(ROLE.read);
      const search = await send("GET", "/search/repositories?q=widgets", undefined, "member-token");
      expect(search.body.items[0].permissions).toEqual(ROLE.read);
      const forks = await send("POST", `${REPO}/forks`, {}, "member-token");
      expect(forks.body.permissions).toEqual(ROLE.admin);
      expect((await send("GET", "/user/repos", undefined, "member-token")).body[0].permissions).toEqual(ROLE.admin);

      const anonymous = await app.request(`${base}${ORG_REPO}`);
      expect(await anonymous.json()).not.toHaveProperty("permissions");
      expect((await send("GET", REPO, undefined, "app-11-token")).body).not.toHaveProperty("permissions");
    });

    it("answers collaborator permission checks with the computed role", async () => {
      await seedOrg("read");
      const check = async (login: string, token = "owner-token") =>
        send("GET", `${ORG_REPO}/collaborators/${login}/permission`, undefined, token);

      expect((await check("member")).body).toMatchObject({
        permission: "read",
        role_name: "read",
        user: { login: "member", role_name: "read", permissions: ROLE.read },
      });
      expect((await check("teammate")).body).toMatchObject({ permission: "write", role_name: "write" });
      expect((await check("owner")).body).toMatchObject({ permission: "admin", role_name: "admin" });
      expect((await check("outsider")).body).toMatchObject({ permission: "read", role_name: "read" });
      gh.repos.update(gh.repos.findOneBy("full_name", "acme/widgets")!.id, { private: true });
      expect((await check("outsider")).body).toMatchObject({
        permission: "none",
        role_name: "",
        user: { login: "outsider", role_name: "", permissions: { pull: false } },
      });
      expect(await check("nobody")).toMatchObject({ status: 404, body: { message: "nobody is not a user" } });
      expect(await check("owner", "member-token")).toMatchObject({
        status: 403,
        body: { message: "Must have push access to view collaborator permission." },
      });

      const all = await send("GET", `${ORG_REPO}/collaborators`, undefined, "teammate-token");
      expect(all.body.map((u: { login: string; role_name: string }) => [u.login, u.role_name])).toEqual([
        ["owner", "admin"],
        ["member", "read"],
        ["writer", "write"],
        ["teammate", "write"],
      ]);
      const pushers = await send("GET", `${ORG_REPO}/collaborators?permission=push`, undefined, "teammate-token");
      expect(pushers.body.map((u: { login: string }) => u.login)).toEqual(["owner", "writer", "teammate"]);
      const outside = await send("GET", `${ORG_REPO}/collaborators?affiliation=outside`, undefined, "owner-token");
      expect(outside.body).toEqual([]);
      expect(await send("GET", `${ORG_REPO}/collaborators?permission=read`, undefined, "owner-token")).toMatchObject({
        status: 422,
        body: {
          message: "The permission 'read' is not valid. Supported values are: pull, triage, push, maintain, admin.",
        },
      });
    });

    it("counts team members and repositories", async () => {
      await seedOrg("read");
      expect((await send("GET", "/orgs/acme/teams/devs", undefined, "owner-token")).body).toMatchObject({
        members_count: 1,
        repos_count: 1,
        organization: { login: "acme" },
      });
      await send("PUT", "/orgs/acme/teams/devs/memberships/member", {}, "owner-token");
      expect((await send("GET", "/orgs/acme/teams/devs", undefined, "owner-token")).body.members_count).toBe(2);
    });

    it("grants a team the permission sent when adding a repository", async () => {
      await seedOrg("read");
      const grant = (body?: unknown) => send("PUT", `/orgs/acme/teams/devs/repos/acme/widgets`, body, "owner-token");
      const teammateRole = async () =>
        (await graphql(viewerPermissionQuery("widgets"), {}, "teammate-token")).data.repository.viewerPermission;

      expect(await grant({ permission: "triage" })).toMatchObject({ status: 204 });
      expect(await teammateRole()).toBe("TRIAGE");
      const repos = await send("GET", "/orgs/acme/teams/devs/repos", undefined, "owner-token");
      expect(repos.body[0]).toMatchObject({ role_name: "triage", permissions: { triage: true, push: false } });

      expect(await grant({ permission: "admin" })).toMatchObject({ status: 204 });
      expect(await teammateRole()).toBe("ADMIN");
      expect(await grant()).toMatchObject({ status: 204 });
      expect(await teammateRole()).toBe("WRITE");
      expect(await grant({ permission: "owner" })).toMatchObject({ status: 422 });
    });

    it("invites a user outside the organization to a team, as GitHub does", async () => {
      await seedOrg("read");
      seedFromConfig(server.store, base, { users: [{ login: "outsider" }] });
      const outsider = gh.users.findOneBy("login", "outsider")!;
      server.tokenMap.set("outsider-token", { login: "outsider", id: outsider.id, scopes: ["repo"] });
      await send("PUT", "/orgs/acme/teams/devs/memberships/teammate", { role: "maintainer" }, "owner-token");

      expect(
        await send("PUT", "/orgs/acme/teams/devs/memberships/member", { role: "lead" }, "owner-token"),
      ).toMatchObject({
        status: 422,
        body: { message: 'Invalid request.\n\nlead is not a member of ["member", "maintainer"].' },
      });
      expect(await send("PUT", "/orgs/acme/teams/devs/memberships/outsider", {}, "teammate-token")).toMatchObject({
        status: 403,
        body: { message: "You must be an organization owner or team maintainer to add a team membership." },
      });

      const invited = await send("PUT", "/orgs/acme/teams/devs/memberships/outsider", {}, "owner-token");
      expect(invited).toMatchObject({ status: 200, body: { role: "member", state: "pending" } });
      expect(
        (await send("GET", "/orgs/acme/teams/devs/memberships/outsider", undefined, "owner-token")).body,
      ).toMatchObject({ state: "pending" });
      expect((await send("GET", "/orgs/acme/teams/devs", undefined, "owner-token")).body.members_count).toBe(1);
      expect(await send("GET", "/orgs/acme/members/outsider", undefined, "owner-token")).toMatchObject({
        status: 404,
      });
      expect(await send("GET", `${ORG_REPO}/issues`, undefined, "outsider-token")).toMatchObject({ status: 200 });
      expect(await send("POST", `${ORG_REPO}/labels`, { name: "x" }, "outsider-token")).toMatchObject({
        status: 404,
      });
      const listed = await send("GET", "/orgs/acme/teams/devs/invitations", undefined, "owner-token");
      expect(listed.body).toMatchObject([{ login: "outsider", role: "direct_member", team_count: 1 }]);
      expect(await send("GET", "/orgs/acme/invitations", undefined, "member-token")).toMatchObject({
        status: 403,
        body: { message: "You must be an admin to view organization pending invitations." },
      });
      expect((await send("GET", "/user/memberships/orgs/acme", undefined, "outsider-token")).body).toMatchObject({
        state: "pending",
        role: "member",
      });

      expect(await send("PATCH", "/user/memberships/orgs/acme", { state: "active" }, "outsider-token")).toMatchObject({
        status: 200,
        body: { state: "active", role: "member" },
      });
      expect(
        (await send("GET", "/orgs/acme/teams/devs/memberships/outsider", undefined, "owner-token")).body,
      ).toMatchObject({ state: "active", role: "member" });
      expect((await send("GET", "/orgs/acme/invitations", undefined, "owner-token")).body).toEqual([]);
      expect(
        (await graphql(viewerPermissionQuery("widgets"), {}, "outsider-token")).data.repository.viewerPermission,
      ).toBe("WRITE");

      expect((await send("PUT", "/orgs/acme/memberships/hubot", { role: "admin" }, "owner-token")).body).toMatchObject({
        state: "pending",
        role: "admin",
      });
      expect(await send("PUT", "/orgs/acme/memberships/hubot", { role: "owner" }, "owner-token")).toMatchObject({
        status: 422,
      });
      expect(await send("DELETE", "/orgs/acme/memberships/hubot", undefined, "owner-token")).toMatchObject({
        status: 204,
      });
      expect(await send("GET", "/orgs/acme/memberships/hubot", undefined, "owner-token")).toMatchObject({
        status: 404,
      });
    });

    it("sends GitHub's organization and membership webhooks for invitations and team changes", async () => {
      await seedOrg("read");
      seedFromConfig(server.store, base, { users: [{ login: "outsider" }] });
      const outsider = gh.users.findOneBy("login", "outsider")!;
      server.tokenMap.set("outsider-token", { login: "outsider", id: outsider.id, scopes: ["repo"] });
      const dispatch = vi.spyOn(server.webhooks, "dispatch");
      const orgEvents = () =>
        dispatch.mock.calls
          .filter(([event]) => event === "organization" || event === "membership")
          .map(([event, action, payload, owner, repo]) => ({ event, action, payload: payload as any, owner, repo }));

      await send("PUT", "/orgs/acme/teams/devs/memberships/outsider", {}, "owner-token");
      await send("PUT", "/orgs/acme/teams/devs/memberships/outsider", { role: "maintainer" }, "owner-token");
      expect(orgEvents()).toMatchObject([
        {
          event: "organization",
          action: "member_invited",
          owner: "acme",
          repo: undefined,
          payload: {
            action: "member_invited",
            invitation: { login: "outsider", role: "direct_member", team_count: 1, inviter: { login: "owner" } },
            user: { login: "outsider" },
            organization: { login: "acme" },
            sender: { login: "owner" },
          },
        },
      ]);

      dispatch.mockClear();
      await send("PATCH", "/user/memberships/orgs/acme", { state: "active" }, "outsider-token");
      expect(orgEvents()).toMatchObject([
        {
          event: "organization",
          action: "member_added",
          payload: {
            membership: { state: "active", role: "member", user: { login: "outsider" } },
            organization: { login: "acme" },
            sender: { login: "outsider" },
          },
        },
        {
          event: "membership",
          action: "added",
          payload: {
            scope: "team",
            member: { login: "outsider" },
            team: { slug: "devs" },
            sender: { login: "outsider" },
          },
        },
      ]);
      expect(orgEvents()[0]!.payload.membership).not.toHaveProperty("organization");

      dispatch.mockClear();
      await send("PUT", "/orgs/acme/teams/devs/memberships/member", {}, "owner-token");
      await send("PUT", "/orgs/acme/teams/devs/memberships/member", { role: "maintainer" }, "owner-token");
      await send("DELETE", "/orgs/acme/teams/devs/memberships/member", undefined, "owner-token");
      await send("DELETE", "/orgs/acme/members/outsider", undefined, "owner-token");
      expect(orgEvents().map(({ event, action, payload }) => [event, action, payload.member?.login])).toEqual([
        ["membership", "added", "member"],
        ["membership", "removed", "member"],
        ["organization", "member_removed", undefined],
      ]);
      expect(orgEvents()[2]!.payload.membership).toMatchObject({ user: { login: "outsider" }, role: "member" });
      dispatch.mockRestore();
    });

    it("keeps team management to org owners, team maintainers, and repository admins", async () => {
      await seedOrg("read");
      seedFromConfig(server.store, base, {
        users: [{ login: "outsider" }],
        orgs: [{ login: "acme", teams: [{ name: "QA", permission: "pull" }] }],
        repos: [{ owner: "acme", name: "vault", private: true }],
      });
      server.tokenMap.set("outsider-token", {
        login: "outsider",
        id: gh.users.findOneBy("login", "outsider")!.id,
        scopes: ["repo"],
      });
      const vaultAdmin = { permission: "admin" };
      const notFound = { status: 404, body: { message: "Not Found" } };
      const noRepoAdmin = { status: 403, body: { message: "You must have administrative rights on this repository." } };

      expect(await send("PUT", "/orgs/acme/teams/qa/repos/acme/vault", vaultAdmin, "member-token")).toMatchObject(
        noRepoAdmin,
      );
      expect(await send("PATCH", "/repos/acme/vault", { description: "taken" }, "member-token")).toMatchObject(
        notFound,
      );
      expect(await send("PUT", "/orgs/acme/teams/devs/repos/acme/vault", vaultAdmin, "outsider-token")).toMatchObject(
        notFound,
      );
      expect(await send("PUT", "/orgs/acme/teams/devs/memberships/outsider", {}, "outsider-token")).toMatchObject(
        notFound,
      );
      expect(
        await send("DELETE", "/orgs/acme/teams/devs/memberships/teammate", undefined, "teammate-token"),
      ).toMatchObject({
        status: 403,
        body: { message: "You must be an organization owner or team maintainer to remove a team membership." },
      });
      expect(await send("PUT", "/orgs/acme/teams/devs/memberships/member", {}, "teammate-token")).toMatchObject({
        status: 403,
        body: { message: "You must be an organization owner or team maintainer to add a team membership." },
      });
      expect(
        await send("DELETE", "/orgs/acme/teams/devs/memberships/teammate", undefined, "member-token"),
      ).toMatchObject({
        status: 403,
        body: { message: "You must be an organization owner or team maintainer to remove a team membership." },
      });
      expect(await send("PATCH", "/orgs/acme/teams/devs", { permission: "admin" }, "teammate-token")).toMatchObject(
        notFound,
      );
      expect(await send("DELETE", "/orgs/acme/teams/devs", undefined, "member-token")).toMatchObject(notFound);
      expect(await send("DELETE", "/orgs/acme/teams/devs/repos/acme/widgets", undefined, "member-token")).toMatchObject(
        {
          status: 403,
          body: {
            message:
              "You must have administrative rights on a repository or team in order to remove the repository from that team",
          },
        },
      );
      expect(await send("GET", "/orgs/acme/teams", undefined, "outsider-token")).toMatchObject({
        status: 403,
        body: { message: "Must have admin rights to Repository." },
      });
      expect(await send("GET", "/orgs/acme/teams/devs", undefined, "outsider-token")).toMatchObject(notFound);
      expect((await app.request(`${base}/orgs/acme/teams/devs`)).status).toBe(401);
      expect(gh.teamRepos.all().map((link) => link.repo_id)).toEqual([
        gh.repos.findOneBy("full_name", "acme/widgets")!.id,
      ]);

      const created = await send("POST", "/orgs/acme/teams", { name: "Docs" }, "member-token");
      expect(created).toMatchObject({ status: 201, body: { slug: "docs", members_count: 1 } });
      const added = await app.request(`${base}/orgs/acme/teams/docs/memberships/writer`, {
        method: "PUT",
        headers: { Authorization: "token member-token" },
      });
      expect(added.status).toBe(200);
      expect(await added.json()).toMatchObject({ role: "member", state: "active" });
      expect((await send("GET", "/orgs/acme/memberships/member", undefined, "member-token")).body.role).toBe("member");
      expect(await send("PATCH", "/orgs/acme", { description: "taken" }, "member-token")).toMatchObject({
        status: 403,
      });
      expect(await send("PATCH", "/orgs/acme/teams/docs", { description: "d" }, "member-token")).toMatchObject({
        status: 200,
      });
      expect(await send("PUT", "/orgs/acme/teams/docs/repos/acme/widgets", {}, "member-token")).toMatchObject(
        noRepoAdmin,
      );
      expect(await send("POST", "/orgs/acme/teams", { name: "Rogue" }, "outsider-token")).toMatchObject({
        status: 403,
        body: { message: "Must have admin rights to Repository." },
      });
      expect(await send("PUT", "/orgs/acme/teams/qa/repos/acme/vault", vaultAdmin, "owner-token")).toMatchObject({
        status: 204,
      });
      expect(await send("DELETE", "/orgs/acme/teams/docs", undefined, "member-token")).toMatchObject({ status: 204 });
    });

    it("drops team grants when a repository is deleted or leaves the organization", async () => {
      await seedOrg("read");
      await send("POST", "/orgs/acme/repos", { name: "gadgets" }, "owner-token");
      await send("PUT", "/orgs/acme/teams/devs/repos/acme/gadgets", {}, "owner-token");
      const reposCount = async () =>
        (await send("GET", "/orgs/acme/teams/devs", undefined, "owner-token")).body.repos_count;
      expect(await reposCount()).toBe(2);

      expect(await send("DELETE", "/repos/acme/gadgets", undefined, "owner-token")).toMatchObject({ status: 204 });
      expect(await reposCount()).toBe(1);

      expect(await send("POST", `${ORG_REPO}/transfer`, { new_owner: "owner" }, "owner-token")).toMatchObject({
        status: 200,
      });
      expect(await reposCount()).toBe(0);
      expect(gh.teamRepos.all()).toEqual([]);
    });

    it("keeps admin-only actions from maintainers and maintainer actions from writers", async () => {
      await seedOrg("read");
      seedFromConfig(server.store, base, { repos: [{ owner: "acme", name: "vault", private: true }] });
      const vault = gh.repos.findOneBy("full_name", "acme/vault")!;
      gh.collaborators.insert({
        repo_id: vault.id,
        user_id: gh.users.findOneBy("login", "member")!.id,
        permission: "maintain",
      });
      gh.collaborators.insert({
        repo_id: vault.id,
        user_id: gh.users.findOneBy("login", "writer")!.id,
        permission: "push",
      });
      const workflow = gh.workflows.insert({
        node_id: "W_1",
        repo_id: vault.id,
        name: "CI",
        path: ".github/workflows/ci.yml",
        state: "active",
        badge_url: "",
      });
      const notFound = { status: 404, body: { message: "Not Found" } };
      const noAdmin = { status: 403, body: { message: "Must have admin rights to Repository." } };
      const V = "/repos/acme/vault";

      expect(await send("POST", "/orgs/acme/teams", { name: "Mine" }, "member-token")).toMatchObject({ status: 201 });
      expect(
        await send("PUT", `/orgs/acme/teams/mine/repos/acme/vault`, { permission: "admin" }, "member-token"),
      ).toMatchObject({
        status: 403,
        body: { message: "You must have administrative rights on this repository." },
      });
      expect((await send("GET", V, undefined, "member-token")).body.permissions).toMatchObject({
        admin: false,
        maintain: true,
      });
      expect(await send("DELETE", V, undefined, "member-token")).toMatchObject(noAdmin);
      expect(await send("POST", `${V}/transfer`, { new_owner: "member" }, "member-token")).toMatchObject(noAdmin);
      expect(await send("PATCH", V, { description: "mine" }, "member-token")).toMatchObject(notFound);
      expect(await send("PUT", `${V}/collaborators/outsider`, { permission: "admin" }, "member-token")).toMatchObject(
        notFound,
      );
      expect(await send("DELETE", `${V}/collaborators/writer`, undefined, "member-token")).toMatchObject(notFound);
      expect(await send("GET", `${V}/hooks`, undefined, "member-token")).toMatchObject(notFound);
      expect(await send("PUT", `${V}/branches/main/protection`, {}, "member-token")).toMatchObject(notFound);
      expect(await send("PUT", `${V}/topics`, { names: ["mine"] }, "member-token")).toMatchObject({
        status: 200,
        body: { names: ["mine"] },
      });

      expect(await send("PUT", `${V}/topics`, { names: ["w"] }, "writer-token")).toMatchObject(notFound);
      expect(
        await send("PUT", `${V}/actions/workflows/${workflow.id}/disable`, undefined, "writer-token"),
      ).toMatchObject({ status: 204 });
      expect(await send("PUT", `${V}/actions/secrets/TOKEN`, {}, "writer-token")).toMatchObject({ status: 201 });
      expect(await send("DELETE", `${V}/collaborators/writer`, undefined, "writer-token")).toMatchObject({
        status: 204,
      });
      expect(
        await send("PUT", `${V}/actions/workflows/${workflow.id}/enable`, undefined, "teammate-token"),
      ).toMatchObject(noAdmin);
      expect(await send("DELETE", `${V}/actions/secrets/TOKEN`, undefined, "teammate-token")).toMatchObject({
        status: 403,
        body: {
          message: "You must have repository write permissions or have the repository secrets fine-grained permission.",
        },
      });

      expect(await send("PATCH", V, { description: "owned" }, "owner-token")).toMatchObject({ status: 200 });
      expect(await send("DELETE", V, undefined, "owner-token")).toMatchObject({ status: 204 });
    });

    it("accepts an empty body where GitHub's request body is optional", async () => {
      await seedOrg("read");
      const request = (method: string, path: string, body?: string) =>
        app.request(`${base}${path}`, { method, headers: { Authorization: "token owner-token" }, body });

      const membership = await request("PUT", "/orgs/acme/teams/devs/memberships/member");
      expect(membership.status).toBe(200);
      expect(await membership.json()).toMatchObject({ role: "member" });
      expect((await request("PATCH", ORG_REPO)).status).toBe(200);
      expect((await request("PUT", "/orgs/acme/teams/devs/repos/acme/widgets")).status).toBe(204);
      expect((await request("PATCH", "/orgs/acme/teams/devs")).status).toBe(200);
      const invalid = await request("PUT", "/orgs/acme/teams/devs/memberships/member", "{bad");
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toMatchObject({ message: "Problems parsing JSON" });
    });

    it("treats a stored team grant without a permission as the team's permission", async () => {
      await seedOrg("read");
      const link = gh.teamRepos.all()[0]!;
      const { permission: _dropped, ...legacy } = link;
      gh.teamRepos.delete(link.id);
      gh.teamRepos.insert({ team_id: legacy.team_id, repo_id: legacy.repo_id });

      expect(
        (await graphql(viewerPermissionQuery("widgets"), {}, "teammate-token")).data.repository.viewerPermission,
      ).toBe("WRITE");
      const repos = await send("GET", "/orgs/acme/teams/devs/repos", undefined, "owner-token");
      expect(repos.body[0]).toMatchObject({ role_name: "write", permissions: { push: true, maintain: false } });
    });
  });
});
