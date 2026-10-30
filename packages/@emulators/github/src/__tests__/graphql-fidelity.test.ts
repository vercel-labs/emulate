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
});
