import { describe, it, expect, beforeEach, vi } from "vitest";
import { graphql as octokitGraphql, GraphqlResponseError } from "@octokit/graphql";
import { Hono, Store, WebhookDispatcher } from "@emulators/core";
import { authMiddleware, createApiErrorHandler, createErrorHandler, type TokenMap } from "@emulators/core";
import { githubPlugin, seedFromConfig, getGitHubStore } from "../index.js";

const base = "http://localhost:4000";

function createTestApp() {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map();
  tokenMap.set("test-token", { login: "octocat", id: 1, scopes: ["repo", "user"] });
  tokenMap.set("hubot-token", { login: "hubot", id: 2, scopes: ["repo", "user"] });
  tokenMap.set("outsider-token", { login: "outsider", id: 3, scopes: ["repo", "user"] });

  const app = new Hono();
  app.onError(createApiErrorHandler());
  app.use("*", createErrorHandler());
  app.use("*", authMiddleware(tokenMap));
  githubPlugin.register(app as any, store, webhooks, base, tokenMap);
  githubPlugin.seed?.(store, base);
  seedFromConfig(store, base, {
    users: [{ login: "octocat", name: "The Octocat" }, { login: "hubot" }, { login: "outsider" }],
    repos: [
      { owner: "octocat", name: "hello-world" },
      { owner: "octocat", name: "secret", private: true },
    ],
  });
  const gh = getGitHubStore(store);
  const repo = gh.repos.findOneBy("full_name", "octocat/hello-world")!;
  gh.collaborators.insert({ repo_id: repo.id, user_id: gh.users.findOneBy("login", "hubot")!.id, permission: "push" });
  return { app, store, webhooks, gh };
}

describe("GitHub GraphQL API", () => {
  let app: Hono;
  let webhooks: WebhookDispatcher;
  let gh: ReturnType<typeof getGitHubStore>;

  const client = (token = "test-token") =>
    octokitGraphql.defaults({
      baseUrl: base,
      headers: { authorization: `token ${token}` },
      request: { fetch: (url: string, init: RequestInit) => app.request(url, init) },
    });
  const gql = <T = any>(query: string, variables: Record<string, unknown> = {}, token?: string) =>
    client(token)<T>(query, variables);

  async function rest(method: string, path: string, body?: unknown, token = "test-token") {
    const res = await app.request(`${base}${path}`, {
      method,
      headers: { Authorization: `token ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as any };
  }

  async function pushFile(branch: string, path: string, content: string) {
    const created = await rest("PUT", `/repos/octocat/hello-world/contents/${path}`, {
      message: `Add ${path}`,
      content: Buffer.from(content).toString("base64"),
      branch,
    });
    expect(created.status).toBe(201);
    return created.body.commit.sha as string;
  }

  async function seedBranch(name: string) {
    const main = await rest("GET", "/repos/octocat/hello-world/git/ref/heads/main");
    await rest("POST", "/repos/octocat/hello-world/git/refs", { ref: `refs/heads/${name}`, sha: main.body.object.sha });
    return pushFile(name, `${name}.txt`, `content of ${name}\n`);
  }

  async function repositoryId() {
    const data = await gql(`{ repository(owner: "octocat", name: "hello-world") { id } }`);
    return data.repository.id as string;
  }

  async function createPr(head: string, extra: Record<string, unknown> = {}) {
    const data = await gql(
      `mutation($input: CreatePullRequestInput!) { createPullRequest(input: $input) { pullRequest { id number url } } }`,
      {
        input: {
          repositoryId: await repositoryId(),
          baseRefName: "main",
          headRefName: head,
          title: `PR ${head}`,
          ...extra,
        },
      },
    );
    return data.createPullRequest.pullRequest as { id: string; number: number; url: string };
  }

  beforeEach(() => {
    const setup = createTestApp();
    app = setup.app;
    webhooks = setup.webhooks;
    gh = setup.gh;
  });

  it("returns the viewer and rate limit", async () => {
    const data = await gql(`{ viewer { login name isViewer } rateLimit { limit remaining cost } }`);
    expect(data.viewer).toEqual({ login: "octocat", name: "The Octocat", isViewer: true });
    expect(data.rateLimit).toMatchObject({ limit: 5000, cost: 1 });
  });

  it("requires authentication", async () => {
    const res = await app.request(`${base}/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "{ viewer { login } }" }),
    });
    expect(res.status).toBe(401);
  });

  it("serves the same endpoint at /api/graphql and accepts GET", async () => {
    const post = await app.request(`${base}/api/graphql`, {
      method: "POST",
      headers: { Authorization: "token test-token", "Content-Type": "application/json" },
      body: JSON.stringify({ query: "{ viewer { login } }" }),
    });
    expect(((await post.json()) as any).data.viewer.login).toBe("octocat");

    const get = await app.request(`${base}/graphql?query=${encodeURIComponent("{ viewer { login } }")}`, {
      headers: { Authorization: "token test-token" },
    });
    expect(((await get.json()) as any).data.viewer.login).toBe("octocat");
  });

  it("reports unknown fields in GitHub's wording so gh can ignore optional ones", async () => {
    const error = await gql(`{ viewer { projectItems { totalCount } } }`).catch((e) => e);
    expect(error.errors[0].message).toBe("Field 'projectItems' doesn't exist on type 'User'");
  });

  it("accepts fragments whose fields differ only in nullability, as GitHub does", async () => {
    await seedBranch("feature");
    const pr = await createPr("feature");
    const hubot = gh.users.findOneBy("login", "hubot")!;
    await rest("POST", "/repos/octocat/hello-world/pulls/1/requested_reviewers", { reviewers: [hubot.login] });
    const data = await gql(
      `query($id: ID!) { node(id: $id) { ... on PullRequest { reviewRequests(first: 5) { nodes { requestedReviewer {
        ... on User { name } ... on Team { name }
      } } } } } }`,
      { id: pr.id },
    );
    expect(data.node.reviewRequests.nodes).toEqual([{ requestedReviewer: { name: null } }]);
  });

  it("aliases /api/v3 to the REST API", async () => {
    const res = await app.request(`${base}/api/v3/repos/octocat/hello-world`, {
      headers: { Authorization: "token test-token" },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).full_name).toBe("octocat/hello-world");
  });

  it("reads repository fields used by gh", async () => {
    const data = await gql(`{
      repository(owner: "octocat", name: "hello-world") {
        id databaseId name nameWithOwner owner { login } viewerPermission
        defaultBranchRef { name target { ... on Commit { oid } } }
        mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed isPrivate visibility
        pullRequests(states: OPEN) { totalCount }
        assignableUsers(first: 10) { nodes { login } }
      }
    }`);
    expect(data.repository).toMatchObject({
      name: "hello-world",
      nameWithOwner: "octocat/hello-world",
      owner: { login: "octocat" },
      viewerPermission: "ADMIN",
      defaultBranchRef: { name: "main" },
      mergeCommitAllowed: true,
      isPrivate: false,
      visibility: "PUBLIC",
      pullRequests: { totalCount: 0 },
    });
    expect(data.repository.defaultBranchRef.target.oid).toMatch(/^[0-9a-f]{40}$/);
    expect(data.repository.assignableUsers.nodes.map((u: any) => u.login)).toEqual(["hubot", "octocat"]);
  });

  it("returns NOT_FOUND for unknown and private repositories", async () => {
    for (const [name, token] of [
      ["missing", "test-token"],
      ["secret", "outsider-token"],
    ]) {
      const error = await gql(`{ repository(owner: "octocat", name: "${name}") { id } }`, {}, token).catch((e) => e);
      expect(error).toBeInstanceOf(GraphqlResponseError);
      expect(error.errors[0]).toMatchObject({
        type: "NOT_FOUND",
        message: `Could not resolve to a Repository with the name 'octocat/${name}'.`,
        path: ["repository"],
      });
    }
  });

  it("creates a pull request and reads it back with the fields gh pr view uses", async () => {
    const sha = await seedBranch("feature");
    const dispatch = vi.spyOn(webhooks, "dispatch");
    const pr = await createPr("feature", { body: "Feature body" });
    expect(pr.number).toBe(1);
    expect(pr.url).toBe(`${base}/octocat/hello-world/pull/1`);
    expect(dispatch).toHaveBeenCalledWith(
      "pull_request",
      "opened",
      expect.objectContaining({ action: "opened" }),
      "octocat",
      "hello-world",
    );

    const data = await gql(
      `query($n: Int!) { repository(owner: "octocat", name: "hello-world") { pullRequest(number: $n) {
        id number title body state isDraft closed merged url author { login ... on User { name } }
        baseRefName headRefName headRefOid isCrossRepository headRepositoryOwner { login } headRepository { nameWithOwner }
        mergeable mergeStateStatus reviewDecision additions deletions changedFiles
        files(first: 10) { nodes { path additions deletions changeType } }
        commits(first: 10) { totalCount nodes { commit { oid messageHeadline authors(first: 5) { nodes { name email } } } } }
        lastCommit: commits(last: 1) { nodes { commit { oid } } }
        labels(first: 10) { totalCount } assignees(first: 10) { totalCount }
        comments(first: 10) { totalCount } reviews(first: 10) { totalCount }
        reviewRequests(first: 10) { totalCount } statusCheckRollup { state }
      } } }`,
      { n: 1 },
    );
    expect(data.repository.pullRequest).toMatchObject({
      id: pr.id,
      title: "PR feature",
      body: "Feature body",
      state: "OPEN",
      isDraft: false,
      closed: false,
      merged: false,
      author: { login: "octocat", name: "The Octocat" },
      baseRefName: "main",
      headRefName: "feature",
      headRefOid: sha,
      isCrossRepository: false,
      headRepositoryOwner: { login: "octocat" },
      headRepository: { nameWithOwner: "octocat/hello-world" },
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      reviewDecision: null,
      additions: 1,
      deletions: 0,
      changedFiles: 1,
      files: { nodes: [{ path: "feature.txt", additions: 1, deletions: 0, changeType: "ADDED" }] },
      commits: { totalCount: 1, nodes: [{ commit: { oid: sha, messageHeadline: "Add feature.txt" } }] },
      lastCommit: { nodes: [{ commit: { oid: sha } }] },
      statusCheckRollup: null,
    });
  });

  it("returns a typed NOT_FOUND error for a missing pull request", async () => {
    const error = await gql(
      `{ repository(owner: "octocat", name: "hello-world") { pullRequest(number: 99) { id } } }`,
    ).catch((e) => e);
    expect(error.errors[0]).toMatchObject({
      type: "NOT_FOUND",
      message: "Could not resolve to a PullRequest with the number of 99.",
    });
  });

  it("lists pull requests with state, head, base filters, ordering, and cursor pagination", async () => {
    for (const name of ["a", "b", "c"]) {
      await seedBranch(name);
      await createPr(name);
    }
    await rest("PATCH", "/repos/octocat/hello-world/pulls/2", { state: "closed" });

    const open = await gql(`{ repository(owner: "octocat", name: "hello-world") {
      pullRequests(states: [OPEN], first: 10, orderBy: { field: CREATED_AT, direction: DESC }) { totalCount nodes { number } }
    } }`);
    expect(open.repository.pullRequests).toEqual({ totalCount: 2, nodes: [{ number: 3 }, { number: 1 }] });

    const head = await gql(`{ repository(owner: "octocat", name: "hello-world") {
      pullRequests(headRefName: "b", baseRefName: "main", states: [CLOSED], first: 5) { nodes { number state } }
    } }`);
    expect(head.repository.pullRequests.nodes).toEqual([{ number: 2, state: "CLOSED" }]);

    const pages: number[] = [];
    let after: string | null = null;
    for (;;) {
      const page: any = await gql(
        `query($after: String) { repository(owner: "octocat", name: "hello-world") {
          pullRequests(first: 1, after: $after, states: [OPEN, CLOSED, MERGED]) { nodes { number } pageInfo { hasNextPage endCursor } }
        } }`,
        { after },
      );
      pages.push(...page.repository.pullRequests.nodes.map((n: any) => n.number));
      if (!page.repository.pullRequests.pageInfo.hasNextPage) break;
      after = page.repository.pullRequests.pageInfo.endCursor;
      expect(after).not.toMatch(/^\d+$/);
    }
    expect(pages).toEqual([1, 2, 3]);
  });

  it("resolves node ids for pull requests, repositories, users, and comments", async () => {
    await seedBranch("feature");
    const pr = await createPr("feature");
    const comment = await rest("POST", "/repos/octocat/hello-world/issues/1/comments", { body: "hi" });
    const data = await gql(
      `query($ids: [ID!]!) { nodes(ids: $ids) { __typename id ... on PullRequest { number } ... on IssueComment { body } } }`,
      { ids: [pr.id, comment.body.node_id, gh.repos.findOneBy("full_name", "octocat/hello-world")!.node_id] },
    );
    expect(data.nodes).toEqual([
      { __typename: "PullRequest", id: pr.id, number: 1 },
      { __typename: "IssueComment", id: comment.body.node_id, body: "hi" },
      { __typename: "Repository", id: gh.repos.findOneBy("full_name", "octocat/hello-world")!.node_id },
    ]);
    const missing = await gql(`{ node(id: "bm9wZQ") { id } }`);
    expect(missing.node).toBeNull();
  });

  it("sees REST writes and REST sees GraphQL writes", async () => {
    await seedBranch("feature");
    const created = await rest("POST", "/repos/octocat/hello-world/pulls", {
      title: "From REST",
      head: "feature",
      base: "main",
    });
    const view = await gql(`query($id: ID!) { node(id: $id) { ... on PullRequest { title state } } }`, {
      id: created.body.node_id,
    });
    expect(view.node).toEqual({ title: "From REST", state: "OPEN" });

    await gql(
      `mutation($input: UpdatePullRequestInput!) { updatePullRequest(input: $input) { pullRequest { title body } } }`,
      { input: { pullRequestId: created.body.node_id, title: "From GraphQL", body: "edited" } },
    );
    const restView = await rest("GET", "/repos/octocat/hello-world/pulls/1");
    expect(restView.body).toMatchObject({ title: "From GraphQL", body: "edited" });
  });

  it("updates labels, assignees, and milestone through updatePullRequest", async () => {
    await seedBranch("feature");
    const pr = await createPr("feature");
    const label = await rest("POST", "/repos/octocat/hello-world/labels", { name: "bug", color: "d73a4a" });
    const milestone = await rest("POST", "/repos/octocat/hello-world/milestones", { title: "v1" });
    const hubot = gh.users.findOneBy("login", "hubot")!;

    const data = await gql(
      `mutation($input: UpdatePullRequestInput!) { updatePullRequest(input: $input) { pullRequest {
        labels(first: 5) { nodes { name } } assignees(first: 5) { nodes { login } } milestone { title }
      } } }`,
      {
        input: {
          pullRequestId: pr.id,
          labelIds: [label.body.node_id],
          assigneeIds: [hubot.node_id],
          milestoneId: milestone.body.node_id,
        },
      },
    );
    expect(data.updatePullRequest.pullRequest).toEqual({
      labels: { nodes: [{ name: "bug" }] },
      assignees: { nodes: [{ login: "hubot" }] },
      milestone: { title: "v1" },
    });
    const issue = await rest("GET", "/repos/octocat/hello-world/pulls/1");
    expect(issue.body.labels.map((l: any) => l.name)).toEqual(["bug"]);
    expect(issue.body.assignees.map((u: any) => u.login)).toEqual(["hubot"]);
  });

  it("closes, reopens, and toggles draft state", async () => {
    await seedBranch("feature");
    const pr = await createPr("feature", { draft: true });
    const input = { pullRequestId: pr.id };
    const run = async (mutation: string) =>
      (
        await gql(
          `mutation($input: ${mutation[0].toUpperCase()}${mutation.slice(1)}Input!) { ${mutation}(input: $input) { pullRequest { state isDraft } } }`,
          { input },
        )
      )[mutation].pullRequest;

    expect(await run("markPullRequestReadyForReview")).toEqual({ state: "OPEN", isDraft: false });
    expect(await run("convertPullRequestToDraft")).toEqual({ state: "OPEN", isDraft: true });
    expect(await run("closePullRequest")).toEqual({ state: "CLOSED", isDraft: true });
    expect(await run("reopenPullRequest")).toEqual({ state: "OPEN", isDraft: true });
  });

  it("merges a pull request and refuses drafts like REST does", async () => {
    await seedBranch("feature");
    const pr = await createPr("feature", { draft: true });
    const merge = (input: Record<string, unknown>) =>
      gql(
        `mutation($input: MergePullRequestInput!) { mergePullRequest(input: $input) { pullRequest {
          state merged mergedAt mergedBy { login } mergeCommit { oid messageHeadline }
        } } }`,
        { input: { pullRequestId: pr.id, ...input } },
      );

    const refused = await merge({}).catch((e) => e);
    expect(refused.errors[0]).toMatchObject({
      type: "UNPROCESSABLE",
      message: "Draft pull requests cannot be merged.",
    });

    await rest("PATCH", "/repos/octocat/hello-world/pulls/1", { draft: false });
    const dispatch = vi.spyOn(webhooks, "dispatch");
    const data = await merge({ mergeMethod: "SQUASH", commitHeadline: "Squashed feature" });
    expect(data.mergePullRequest.pullRequest).toMatchObject({
      state: "MERGED",
      merged: true,
      mergedBy: { login: "octocat" },
      mergeCommit: { messageHeadline: "Squashed feature" },
    });
    expect(dispatch).toHaveBeenCalledWith(
      "pull_request",
      "closed",
      expect.objectContaining({ pull_request: expect.objectContaining({ merged: true }) }),
      "octocat",
      "hello-world",
    );
    const main = await rest("GET", "/repos/octocat/hello-world/branches/main");
    expect(main.body.commit.sha).toBe(data.mergePullRequest.pullRequest.mergeCommit.oid);
  });

  it("adds comments and returns the comment edge", async () => {
    await seedBranch("feature");
    const pr = await createPr("feature");
    const data = await gql(
      `mutation($input: AddCommentInput!) { addComment(input: $input) {
        commentEdge { cursor node { body url author { login } } } subject { id }
      } }`,
      { input: { subjectId: pr.id, body: "Looks like a great feature!" } },
    );
    expect(data.addComment.commentEdge.node).toEqual({
      body: "Looks like a great feature!",
      url: expect.stringMatching(/\/octocat\/hello-world\/pull\/1#issuecomment-\d+$/),
      author: { login: "octocat" },
    });
    expect(data.addComment.subject.id).toBe(pr.id);

    const comments = await rest("GET", "/repos/octocat/hello-world/issues/1/comments");
    expect(comments.body.map((c: any) => c.body)).toEqual(["Looks like a great feature!"]);
  });

  it("records reviews and derives reviewDecision and latestReviews", async () => {
    await seedBranch("feature");
    const pr = await createPr("feature");
    const review = (event: string, body: string) =>
      gql(
        `mutation($input: AddPullRequestReviewInput!) { addPullRequestReview(input: $input) { pullRequestReview { state body } } }`,
        { input: { pullRequestId: pr.id, event, body } },
        "hubot-token",
      );

    expect((await review("REQUEST_CHANGES", "needs work")).addPullRequestReview.pullRequestReview).toEqual({
      state: "CHANGES_REQUESTED",
      body: "needs work",
    });
    await review("APPROVE", "ship it");

    const data = await gql(
      `query($id: ID!) { node(id: $id) { ... on PullRequest {
      reviewDecision latestReviews(first: 10) { nodes { state author { login } } }
      reviews(first: 10) { totalCount nodes { state } }
    } } }`,
      { id: pr.id },
    );
    expect(data.node).toEqual({
      reviewDecision: "APPROVED",
      latestReviews: { nodes: [{ state: "APPROVED", author: { login: "hubot" } }] },
      reviews: { totalCount: 2, nodes: [{ state: "CHANGES_REQUESTED" }, { state: "APPROVED" }] },
    });
  });

  it("submits a pending review", async () => {
    await seedBranch("feature");
    const pr = await createPr("feature");
    const pending = await gql(
      `mutation($input: AddPullRequestReviewInput!) { addPullRequestReview(input: $input) { pullRequestReview { id state } } }`,
      { input: { pullRequestId: pr.id, body: "draft" } },
      "hubot-token",
    );
    expect(pending.addPullRequestReview.pullRequestReview.state).toBe("PENDING");

    const submitted = await gql(
      `mutation($input: SubmitPullRequestReviewInput!) { submitPullRequestReview(input: $input) { pullRequestReview { state body } } }`,
      { input: { pullRequestReviewId: pending.addPullRequestReview.pullRequestReview.id, event: "COMMENT" } },
      "hubot-token",
    );
    expect(submitted.submitPullRequestReview.pullRequestReview).toEqual({ state: "COMMENTED", body: "draft" });
  });

  it("requests reviewers by id and by login", async () => {
    await seedBranch("feature");
    const pr = await createPr("feature");
    const hubot = gh.users.findOneBy("login", "hubot")!;
    await gql(`mutation($input: RequestReviewsInput!) { requestReviews(input: $input) { clientMutationId } }`, {
      input: { pullRequestId: pr.id, userIds: [hubot.node_id] },
    });
    const byId = await gql(
      `query($id: ID!) { node(id: $id) { ... on PullRequest {
      reviewRequests(first: 5) { nodes { requestedReviewer { __typename ... on User { login } } } }
    } } }`,
      { id: pr.id },
    );
    expect(byId.node.reviewRequests.nodes).toEqual([{ requestedReviewer: { __typename: "User", login: "hubot" } }]);

    await gql(
      `mutation($input: RequestReviewsByLoginInput!) { requestReviewsByLogin(input: $input) { clientMutationId } }`,
      {
        input: { pullRequestId: pr.id, userLogins: [], union: false },
      },
    );
    const rest1 = await rest("GET", "/repos/octocat/hello-world/pulls/1");
    expect(rest1.body.requested_reviewers).toEqual([]);
  });

  it("reports check runs through statusCheckRollup", async () => {
    const sha = await seedBranch("feature");
    const pr = await createPr("feature");
    await rest("POST", "/repos/octocat/hello-world/check-runs", {
      name: "build",
      head_sha: sha,
      status: "completed",
      conclusion: "success",
    });
    await rest("POST", "/repos/octocat/hello-world/check-runs", { name: "lint", head_sha: sha, status: "in_progress" });

    const data = await gql(
      `query($id: ID!) { node(id: $id) { ... on PullRequest {
      mergeStateStatus
      statusCheckRollup: commits(last: 1) { nodes { commit { statusCheckRollup {
        state
        contexts(first: 100) {
          checkRunCount
          nodes { __typename ... on CheckRun { name status conclusion } }
          pageInfo { hasNextPage }
        }
      } } } }
    } } }`,
      { id: pr.id },
    );
    const rollup = data.node.statusCheckRollup.nodes[0].commit.statusCheckRollup;
    expect(data.node.mergeStateStatus).toBe("UNSTABLE");
    expect(rollup).toEqual({
      state: "PENDING",
      contexts: {
        checkRunCount: 2,
        nodes: [
          { __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "SUCCESS" },
          { __typename: "CheckRun", name: "lint", status: "IN_PROGRESS", conclusion: null },
        ],
        pageInfo: { hasNextPage: false },
      },
    });
  });

  it("searches pull requests the way gh pr status does", async () => {
    await seedBranch("feature");
    await createPr("feature");
    const data = await gql(`{
      viewerCreated: search(query: "repo:octocat/hello-world state:open is:pr author:@me", type: ISSUE, first: 10) {
        issueCount edges { node { ... on PullRequest { number } } }
      }
      reviewRequested: search(query: "repo:octocat/hello-world state:open review-requested:@me", type: ISSUE, first: 10) {
        issueCount
      }
    }`);
    expect(data.viewerCreated).toEqual({ issueCount: 1, edges: [{ node: { number: 1 } }] });
    expect(data.reviewRequested.issueCount).toBe(0);
  });

  it("rejects writes from users without access", async () => {
    await seedBranch("feature");
    const pr = await createPr("feature");
    const error = await gql(
      `mutation($input: ClosePullRequestInput!) { closePullRequest(input: $input) { pullRequest { state } } }`,
      { input: { pullRequestId: pr.id } },
      "missing-token",
    ).catch((e) => e);
    expect(error.status).toBe(401);
  });
});
