import { describe, expect, it, vi } from "vitest";
import { Hono } from "@emulators/core";
import { Store, WebhookDispatcher } from "@emulators/core";
import { authMiddleware, createApiErrorHandler, createErrorHandler, type TokenMap } from "@emulators/core";
import { getGitHubStore, githubPlugin, seedFromConfig } from "../index.js";

const base = "http://localhost:4000";

function createTestApp() {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map();
  tokenMap.set("octocat-token", { login: "octocat", id: 1, scopes: ["repo", "user"] });
  tokenMap.set("outsider-token", { login: "outsider", id: 2, scopes: ["repo", "user"] });

  const app = new Hono();
  app.onError(createApiErrorHandler());
  app.use("*", createErrorHandler());
  app.use("*", authMiddleware(tokenMap));
  githubPlugin.register(app as any, store, webhooks, base, tokenMap);
  githubPlugin.seed?.(store, base);
  seedFromConfig(store, base, {
    users: [{ login: "octocat" }, { login: "outsider" }],
    repos: [
      { owner: "octocat", name: "hello-world" },
      { owner: "octocat", name: "public-canonical" },
      { owner: "octocat", name: "private-repo", private: true },
    ],
  });

  return { app, store, tokenMap, webhooks };
}

function headers(token = "octocat-token"): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

function addInstallationToken(
  store: Store,
  tokenMap: TokenMap,
  token: string,
  options: { permissions: Record<string, string>; repositorySelection: "all" | "selected"; repositoryIds: number[] },
) {
  const gh = getGitHubStore(store);
  const owner = gh.users.findOneBy("login", "octocat")!;
  tokenMap.set(token, {
    login: owner.login,
    id: owner.id,
    scopes: Object.entries(options.permissions).map(([name, level]) => `${name}:${level}`),
    installation: {
      installationId: 42,
      appId: 9,
      accountId: owner.id,
      accountType: "User",
      permissions: options.permissions,
      repositoryIds: options.repositoryIds,
      repositorySelection: options.repositorySelection,
    },
  });
}

async function graphql(
  app: Hono,
  query: string,
  variables?: Record<string, unknown>,
  operationName?: string,
  token?: string,
) {
  return app.request(`${base}/graphql`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({ query, variables, operationName }),
  });
}

interface GraphQLResponse {
  data?: {
    repository?: unknown;
    node?: unknown;
    rateLimit?: { limit: number; remaining: number; used: number; cost: number };
  };
  errors?: Array<{ message: string }>;
}

async function responseBody(response: Response): Promise<GraphQLResponse> {
  return (await response.json()) as GraphQLResponse;
}

async function createFixture(app: Hono) {
  const issueResponse = await app.request(`${base}/repos/octocat/hello-world/issues`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ title: "GraphQL issue", body: "Issue body" }),
  });
  expect(issueResponse.status).toBe(201);
  const issue = (await issueResponse.json()) as { node_id: string; number: number };

  const commentResponse = await app.request(`${base}/repos/octocat/hello-world/issues/${issue.number}/comments`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ body: "GraphQL comment" }),
  });
  expect(commentResponse.status).toBe(201);
  const comment = (await commentResponse.json()) as { node_id: string };

  const labelResponse = await app.request(`${base}/repos/octocat/hello-world/labels`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ name: "graphql", color: "5319E7" }),
  });
  expect(labelResponse.status).toBe(201);
  const label = (await labelResponse.json()) as { node_id: string };

  const repoResponse = await app.request(`${base}/repos/octocat/hello-world`, {
    headers: headers(),
  });
  expect(repoResponse.status).toBe(200);
  const repo = (await repoResponse.json()) as { node_id: string };

  return { issue, comment, label, repo };
}

describe("GitHub GraphQL read compatibility", () => {
  it("resolves repositories and issues through variables, aliases, named operations, and fragments", async () => {
    const { app } = createTestApp();
    const fixture = await createFixture(app);
    const response = await graphql(
      app,
      `
        query ReadIssue($owner: String!, $repository: String!, $issueNumber: Int!) {
          repositoryAlias: repository(owner: $owner, name: $repository) {
            id
            nameWithOwner
            issue(number: $issueNumber) {
              ...IssueFields
              ... on Issue {
                title
              }
            }
          }
        }
        fragment IssueFields on Issue {
          id
          number
          state
          stateReason(enableDuplicate: true)
          body
          updatedAt
          url
          repository {
            id
          }
          comments(first: 1) {
            nodes {
              id
              body
            }
            pageInfo {
              hasNextPage
              hasPreviousPage
              startCursor
              endCursor
            }
            totalCount
          }
        }
      `,
      { owner: "octocat", repository: "hello-world", issueNumber: fixture.issue.number },
      "ReadIssue",
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: {
        repositoryAlias: {
          id: string;
          nameWithOwner: string;
          issue: {
            id: string;
            number: number;
            state: string;
            stateReason: string | null;
            body: string;
            updatedAt: string;
            url: string;
            repository: { id: string };
            comments: { nodes: Array<{ id: string; body: string }>; totalCount: number };
          };
        };
      };
    };
    expect(body.data.repositoryAlias.id).toBe(fixture.repo.node_id);
    expect(body.data.repositoryAlias.nameWithOwner).toBe("octocat/hello-world");
    expect(body.data.repositoryAlias.issue.id).toBe(fixture.issue.node_id);
    expect(body.data.repositoryAlias.issue.number).toBe(fixture.issue.number);
    expect(body.data.repositoryAlias.issue.state).toBe("OPEN");
    expect(body.data.repositoryAlias.issue.stateReason).toBeNull();
    expect(body.data.repositoryAlias.issue.body).toBe("Issue body");
    expect(body.data.repositoryAlias.issue.repository.id).toBe(fixture.repo.node_id);
    expect(body.data.repositoryAlias.issue.comments.nodes[0]).toEqual({
      id: fixture.comment.node_id,
      body: "GraphQL comment",
    });
    expect(body.data.repositoryAlias.issue.comments.totalCount).toBe(1);
  });

  it("round-trips duplicate lifecycle and canonical issue identity between REST and GraphQL", async () => {
    const { app, store, webhooks } = createTestApp();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    webhooks.register({
      url: "https://hooks.example/duplicate",
      events: ["issues"],
      active: true,
      owner: "octocat",
      repo: "hello-world",
    });
    const canonicalResponse = await app.request(`${base}/repos/octocat/hello-world/issues`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ title: "Canonical issue" }),
    });
    const duplicateResponse = await app.request(`${base}/repos/octocat/hello-world/issues`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ title: "Duplicate issue" }),
    });
    const canonical = (await canonicalResponse.json()) as { id: number };
    const duplicate = (await duplicateResponse.json()) as { id: number; number: number };

    const closeResponse = await app.request(`${base}/repos/octocat/hello-world/issues/${duplicate.number}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ state: "closed", state_reason: "duplicate", duplicate_issue_id: canonical.id }),
    });
    expect(closeResponse.status).toBe(200);
    expect((await closeResponse.json()) as { state_reason: string; duplicate_issue_id: number }).toMatchObject({
      state_reason: "duplicate",
      duplicate_issue_id: canonical.id,
    });
    expect((store.collection("github.issue_events").all() as unknown as Array<{ event: string }>).at(-1)?.event).toBe(
      "marked_as_duplicate",
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchSpy).toHaveBeenCalledWith("https://hooks.example/duplicate", expect.anything());
    expect(JSON.parse(fetchSpy.mock.calls.at(-1)?.[1]?.body as string)).toMatchObject({
      action: "marked_as_duplicate",
    });
    fetchSpy.mockRestore();

    const completedResponse = await app.request(`${base}/repos/octocat/hello-world/issues`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ title: "Completed then duplicate" }),
    });
    const completed = (await completedResponse.json()) as { id: number; number: number; updated_at: string };
    await app.request(`${base}/repos/octocat/hello-world/issues/${completed.number}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ state: "closed" }),
    });
    const beforeDuplicate = (await app
      .request(`${base}/repos/octocat/hello-world/issues/${completed.number}`, {
        headers: headers(),
      })
      .then((response) => response.json())) as { updated_at: string };
    const eventCount = store.collection("github.issue_events").all().length;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const completedDuplicate = await app.request(`${base}/repos/octocat/hello-world/issues/${completed.number}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ state: "closed", state_reason: "duplicate", duplicate_issue_id: canonical.id }),
    });
    expect(completedDuplicate.status).toBe(200);
    const afterDuplicate = (await completedDuplicate.json()) as { updated_at: string };
    expect(afterDuplicate.updated_at).not.toBe(beforeDuplicate.updated_at);
    expect(store.collection("github.issue_events").all()).toHaveLength(eventCount + 1);
    const noOp = await app.request(`${base}/repos/octocat/hello-world/issues/${completed.number}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ state: "closed", state_reason: "duplicate", duplicate_issue_id: canonical.id }),
    });
    expect(noOp.status).toBe(200);
    expect(((await noOp.json()) as { updated_at: string }).updated_at).toBe(afterDuplicate.updated_at);
    expect(store.collection("github.issue_events").all()).toHaveLength(eventCount + 1);

    const graphResponse = await graphql(
      app,
      `query { repository(owner: "octocat", name: "hello-world") { issue(number: ${duplicate.number}) { state stateReason duplicateOf { id number } } } }`,
    );
    expect(graphResponse.status).toBe(200);
    const graphBody = (await graphResponse.json()) as {
      data: { repository: { issue: unknown } };
    };
    expect(graphBody.data.repository.issue).toMatchObject({
      state: "CLOSED",
      stateReason: "DUPLICATE",
      duplicateOf: { number: expect.any(Number) },
    });

    const reopenResponse = await app.request(`${base}/repos/octocat/hello-world/issues/${duplicate.number}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ state: "open" }),
    });
    expect(reopenResponse.status).toBe(200);
    expect(
      (await reopenResponse.json()) as { state_reason: string | null; duplicate_issue_id: number | null },
    ).toMatchObject({
      state_reason: "reopened",
      duplicate_issue_id: null,
    });
    expect((store.collection("github.issue_events").all() as unknown as Array<{ event: string }>).at(-1)?.event).toBe(
      "unmarked_as_duplicate",
    );
  });

  it("preserves existing lifecycle reasons when same-state reason is omitted", async () => {
    const { app, store } = createTestApp();
    const openResponse = await app.request(`${base}/repos/octocat/hello-world/issues`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ title: "Open no-op" }),
    });
    const openIssue = (await openResponse.json()) as { number: number; updated_at: string };
    const openEvents = store.collection("github.issue_events").all().length;
    const openNoOp = await app.request(`${base}/repos/octocat/hello-world/issues/${openIssue.number}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ state: "open" }),
    });
    expect(openNoOp.status).toBe(200);
    expect((await openNoOp.json()) as { state_reason: string | null; duplicate_issue_id: number | null }).toMatchObject(
      {
        state_reason: null,
        duplicate_issue_id: null,
      },
    );
    expect(store.collection("github.issue_events").all()).toHaveLength(openEvents);

    const closeResponse = await app.request(`${base}/repos/octocat/hello-world/issues`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ title: "Closed no-op" }),
    });
    const closeIssue = (await closeResponse.json()) as { number: number };
    const closed = await app.request(`${base}/repos/octocat/hello-world/issues/${closeIssue.number}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ state: "closed" }),
    });
    const closedBody = (await closed.json()) as { updated_at: string; state_reason: string | null };
    const closeEvents = store.collection("github.issue_events").all().length;
    const closedNoOp = await app.request(`${base}/repos/octocat/hello-world/issues/${closeIssue.number}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ state: "closed" }),
    });
    expect(closedNoOp.status).toBe(200);
    expect((await closedNoOp.json()) as { updated_at: string; state_reason: string | null }).toMatchObject({
      updated_at: closedBody.updated_at,
      state_reason: "completed",
    });
    expect(store.collection("github.issue_events").all()).toHaveLength(closeEvents);
  });

  it("rejects invalid and self duplicate targets without changing the issue", async () => {
    const { app, store } = createTestApp();
    const issueResponse = await app.request(`${base}/repos/octocat/hello-world/issues`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ title: "Duplicate candidate" }),
    });
    const issue = (await issueResponse.json()) as { id: number; number: number };
    const eventCount = store.collection("github.issue_events").all().length;

    for (const duplicateIssueId of [issue.id, 999999]) {
      const response = await app.request(`${base}/repos/octocat/hello-world/issues/${issue.number}`, {
        method: "PATCH",
        headers: headers(),
        body: JSON.stringify({ state: "closed", state_reason: "duplicate", duplicate_issue_id: duplicateIssueId }),
      });
      expect(response.status).toBe(422);
    }

    const unchangedResponse = await app.request(`${base}/repos/octocat/hello-world/issues/${issue.number}`, {
      headers: headers(),
    });
    const unchanged = (await unchangedResponse.json()) as { state: string; state_reason: string | null };
    expect(unchanged).toMatchObject({ state: "open", state_reason: null });
    expect(store.collection("github.issue_events").all()).toHaveLength(eventCount);

    const privateTargetResponse = await app.request(`${base}/repos/octocat/private-repo/issues`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ title: "Private canonical" }),
    });
    const privateTarget = (await privateTargetResponse.json()) as { id: number };
    const inaccessible = await app.request(`${base}/repos/octocat/hello-world/issues/${issue.number}`, {
      method: "PATCH",
      headers: headers("outsider-token"),
      body: JSON.stringify({ state: "closed", state_reason: "duplicate", duplicate_issue_id: privateTarget.id }),
    });
    expect(inaccessible.status).toBe(403);
  });

  it("enforces selected App visibility for public canonical duplicate targets", async () => {
    const { app, store, tokenMap } = createTestApp();
    const canonicalResponse = await app.request(`${base}/repos/octocat/public-canonical/issues`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ title: "Public canonical" }),
    });
    const sourceResponse = await app.request(`${base}/repos/octocat/hello-world/issues`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ title: "Public source" }),
    });
    const canonical = (await canonicalResponse.json()) as { id: number };
    const source = (await sourceResponse.json()) as { id: number; number: number };
    addInstallationToken(store, tokenMap, "selected-source", {
      permissions: { issues: "write" },
      repositorySelection: "selected",
      repositoryIds: [getGitHubStore(store).repos.findOneBy("full_name", "octocat/hello-world")!.id],
    });

    const response = await app.request(`${base}/repos/octocat/hello-world/issues/${source.number}`, {
      method: "PATCH",
      headers: headers("selected-source"),
      body: JSON.stringify({ state: "closed", state_reason: "duplicate", duplicate_issue_id: canonical.id }),
    });
    expect(response.status).toBe(403);
    const unchanged = await app.request(`${base}/repos/octocat/hello-world/issues/${source.number}`, {
      headers: headers(),
    });
    expect((await unchanged.json()) as { state: string; duplicate_issue_id: number | null }).toMatchObject({
      state: "open",
      duplicate_issue_id: null,
    });
  });

  it("resolves REST node IDs for repositories, issues, labels, and issue comments", async () => {
    const { app } = createTestApp();
    const fixture = await createFixture(app);
    const response = await graphql(
      app,
      `
        query Nodes($repo: ID!, $issue: ID!, $label: ID!, $comment: ID!) {
          repository: node(id: $repo) {
            ... on Repository {
              id
              nameWithOwner
            }
          }
          issue: node(id: $issue) {
            ... on Issue {
              id
              number
            }
          }
          label: node(id: $label) {
            ... on Label {
              id
              name
            }
          }
          comment: node(id: $comment) {
            ... on IssueComment {
              id
              body
            }
          }
        }
      `,
      {
        repo: fixture.repo.node_id,
        issue: fixture.issue.node_id,
        label: fixture.label.node_id,
        comment: fixture.comment.node_id,
      },
      "Nodes",
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: Record<string, Record<string, unknown>> };
    expect(body.data.repository).toEqual({ id: fixture.repo.node_id, nameWithOwner: "octocat/hello-world" });
    expect(body.data.issue).toEqual({ id: fixture.issue.node_id, number: fixture.issue.number });
    expect(body.data.label).toEqual({ id: fixture.label.node_id, name: "graphql" });
    expect(body.data.comment).toEqual({ id: fixture.comment.node_id, body: "GraphQL comment" });
  });

  it("conceals private repositories and their nodes from inaccessible users", async () => {
    const { app } = createTestApp();
    const issueResponse = await app.request(`${base}/repos/octocat/private-repo/issues`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ title: "Private issue" }),
    });
    const issue = (await issueResponse.json()) as { node_id: string };

    const repositoryResponse = await graphql(
      app,
      `
        query PrivateRepository {
          repository(owner: "octocat", name: "private-repo") {
            id
          }
        }
      `,
      undefined,
      "PrivateRepository",
      "outsider-token",
    );
    const nodeResponse = await graphql(
      app,
      `
        query PrivateNode($id: ID!) {
          node(id: $id) {
            id
          }
        }
      `,
      { id: issue.node_id },
      "PrivateNode",
      "outsider-token",
    );

    expect(repositoryResponse.status).toBe(200);
    expect((await responseBody(repositoryResponse)).data?.repository).toBeNull();
    expect(nodeResponse.status).toBe(200);
    expect((await responseBody(nodeResponse)).data?.node).toBeNull();
  });

  it("enforces installation issue permission for public GraphQL issue reads", async () => {
    const { app, store, tokenMap } = createTestApp();
    const fixture = await createFixture(app);
    const repo = getGitHubStore(store).repos.findOneBy("full_name", "octocat/hello-world")!;
    addInstallationToken(store, tokenMap, "app-no-issues", {
      permissions: { contents: "read" },
      repositorySelection: "all",
      repositoryIds: [],
    });

    const response = await graphql(
      app,
      `
        query AppIssue($number: Int!) {
          repository(owner: "octocat", name: "hello-world") {
            id
            issue(number: $number) {
              id
            }
            label(name: "graphql") {
              id
            }
          }
        }
      `,
      { number: fixture.issue.number },
      "AppIssue",
      "app-no-issues",
    );

    expect(repo.private).toBe(false);
    expect(response.status).toBe(200);
    expect((await responseBody(response)).data?.repository).toEqual({ id: repo.node_id, issue: null, label: null });
  });

  it("honors selected installation repositories even when they are public", async () => {
    const { app, store, tokenMap } = createTestApp();
    const fixture = await createFixture(app);
    const repo = getGitHubStore(store).repos.findOneBy("full_name", "octocat/hello-world")!;
    addInstallationToken(store, tokenMap, "app-public-selected", {
      permissions: { issues: "read" },
      repositorySelection: "selected",
      repositoryIds: [repo.id],
    });
    addInstallationToken(store, tokenMap, "app-public-excluded", {
      permissions: { issues: "read" },
      repositorySelection: "selected",
      repositoryIds: [],
    });

    const query = `query PublicSelection($number: Int!) { repository(owner: "octocat", name: "hello-world") { id issue(number: $number) { id } } }`;
    const selected = await graphql(
      app,
      query,
      { number: fixture.issue.number },
      "PublicSelection",
      "app-public-selected",
    );
    const excluded = await graphql(
      app,
      query,
      { number: fixture.issue.number },
      "PublicSelection",
      "app-public-excluded",
    );

    expect((await responseBody(selected)).data?.repository).toEqual({
      id: repo.node_id,
      issue: { id: fixture.issue.node_id },
    });
    expect((await responseBody(excluded)).data?.repository).toBeNull();
  });

  it("honors installation repository selection for private GraphQL reads", async () => {
    const { app, store, tokenMap } = createTestApp();
    const issueResponse = await app.request(`${base}/repos/octocat/private-repo/issues`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ title: "Selected issue" }),
    });
    const issue = (await issueResponse.json()) as { number: number };
    const privateRepo = getGitHubStore(store).repos.findOneBy("full_name", "octocat/private-repo")!;
    addInstallationToken(store, tokenMap, "app-selected", {
      permissions: { issues: "read" },
      repositorySelection: "selected",
      repositoryIds: [privateRepo.id],
    });
    addInstallationToken(store, tokenMap, "app-unselected", {
      permissions: { issues: "read" },
      repositorySelection: "selected",
      repositoryIds: [],
    });

    const query = `query SelectedIssue($number: Int!) { repository(owner: "octocat", name: "private-repo") { issue(number: $number) { id } } }`;
    const selected = await graphql(app, query, { number: issue.number }, "SelectedIssue", "app-selected");
    const unselected = await graphql(app, query, { number: issue.number }, "SelectedIssue", "app-unselected");

    const selectedBody = await responseBody(selected);
    expect((selectedBody.data?.repository as { issue?: unknown } | undefined)?.issue).toEqual({
      id: expect.any(String),
    });
    expect((await responseBody(unselected)).data?.repository).toBeNull();
  });

  it("returns explicit errors for malformed documents, unsupported fields, and malformed cursors", async () => {
    const { app } = createTestApp();
    const fixture = await createFixture(app);

    const malformed = await graphql(app, "query {");
    expect(malformed.status).toBe(400);
    expect((await responseBody(malformed)).errors?.[0]?.message).toContain("Syntax Error");

    const unsupported = await graphql(
      app,
      `
        query Unsupported {
          repository(owner: "octocat", name: "hello-world") {
            missingField
          }
        }
      `,
    );
    expect(unsupported.status).toBe(400);
    expect((await responseBody(unsupported)).errors?.[0]?.message).toContain("Cannot query field");

    const malformedCursor = await graphql(
      app,
      `
        query Cursor($id: ID!) {
          node(id: $id) {
            ... on Issue {
              comments(first: 1, after: "not-a-cursor") {
                nodes {
                  id
                }
              }
            }
          }
        }
      `,
      { id: fixture.issue.node_id },
      "Cursor",
    );
    expect(malformedCursor.status).toBe(200);
    expect((await responseBody(malformedCursor)).errors?.[0]?.message).toContain("Invalid cursor");
  });

  it("rejects malformed JSON, invalid operation selection, and variable coercion", async () => {
    const { app } = createTestApp();
    const malformedJson = await app.request(`${base}/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer octocat-token" },
      body: "{",
    });
    expect(malformedJson.status).toBe(400);
    expect((await responseBody(malformedJson)).errors?.[0]?.message).toBe("Problems parsing JSON");

    const multipleOperations = await graphql(
      app,
      `
        query First {
          rateLimit {
            limit
          }
        }
        query Second {
          rateLimit {
            limit
          }
        }
      `,
    );
    expect(multipleOperations.status).toBe(400);
    expect((await responseBody(multipleOperations)).errors?.[0]?.message).toContain("Must provide operation name");

    const unknownOperation = await graphql(
      app,
      `
        query Known {
          rateLimit {
            limit
          }
        }
      `,
      undefined,
      "Missing",
    );
    expect(unknownOperation.status).toBe(400);
    expect((await responseBody(unknownOperation)).errors?.[0]?.message).toContain("Unknown operation named");

    const nullVariable = await graphql(
      app,
      `
        query RequiredOwner($owner: String!) {
          repository(owner: $owner, name: "hello-world") {
            id
          }
        }
      `,
      { owner: null },
      "RequiredOwner",
    );
    expect(nullVariable.status).toBe(400);
    expect((await responseBody(nullVariable)).errors?.[0]?.message).toContain("not to be null");
  });

  it("supports forward and backward comment pagination with strict cursors", async () => {
    const { app } = createTestApp();
    const fixture = await createFixture(app);
    const secondCommentResponse = await app.request(
      `${base}/repos/octocat/hello-world/issues/${fixture.issue.number}/comments`,
      {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ body: "Second GraphQL comment" }),
      },
    );
    expect(secondCommentResponse.status).toBe(201);

    const query = `query Comments($id: ID!, $first: Int, $after: String, $last: Int, $before: String) {
      node(id: $id) { ... on Issue { comments(first: $first, after: $after, last: $last, before: $before) {
        nodes { body } edges { cursor } pageInfo { hasNextPage hasPreviousPage } totalCount
      } } }
    }`;
    const first = await graphql(app, query, { id: fixture.issue.node_id, first: 1 }, "Comments");
    const firstBody = (await first.json()) as {
      data: { node: { comments: { nodes: Array<{ body: string }>; edges: Array<{ cursor: string }> } } };
    };
    expect(firstBody.data.node.comments.nodes[0]?.body).toBe("GraphQL comment");
    const firstCursor = firstBody.data.node.comments.edges[0]!.cursor;

    const second = await graphql(app, query, { id: fixture.issue.node_id, first: 1, after: firstCursor }, "Comments");
    const secondBody = (await second.json()) as {
      data: { node: { comments: { nodes: Array<{ body: string }>; edges: Array<{ cursor: string }> } } };
    };
    expect(secondBody.data.node.comments.nodes[0]?.body).toBe("Second GraphQL comment");
    const secondCursor = secondBody.data.node.comments.edges[0]!.cursor;

    const last = await graphql(app, query, { id: fixture.issue.node_id, last: 1 }, "Comments");
    expect(((await last.json()) as typeof secondBody).data.node.comments.nodes[0]?.body).toBe("Second GraphQL comment");
    const before = await graphql(app, query, { id: fixture.issue.node_id, last: 1, before: secondCursor }, "Comments");
    expect(((await before.json()) as typeof firstBody).data.node.comments.nodes[0]?.body).toBe("GraphQL comment");

    for (const cursor of [
      `${firstCursor}=`,
      `${firstCursor}!`,
      Buffer.from("github:graphql:v1:wrong:0").toString("base64"),
    ]) {
      const invalid = await graphql(app, query, { id: fixture.issue.node_id, first: 1, after: cursor }, "Comments");
      expect(invalid.status).toBe(200);
      expect((await responseBody(invalid)).errors?.[0]?.message).toContain("Invalid cursor");
    }
  });

  it("does not make outbound requests while serving GraphQL", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const { app } = createTestApp();
      const response = await graphql(
        app,
        `
          query {
            rateLimit {
              limit
            }
          }
        `,
      );
      expect(response.status).toBe(200);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("preserves nullable issue fields in the GraphQL projection", async () => {
    const { app } = createTestApp();
    const issueResponse = await app.request(`${base}/repos/octocat/hello-world/issues`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ title: "Nullable issue" }),
    });
    const issue = (await issueResponse.json()) as { number: number };
    const response = await graphql(
      app,
      `
        query NullableIssue($number: Int!) {
          repository(owner: "octocat", name: "hello-world") {
            issue(number: $number) {
              body
              author {
                login
              }
            }
          }
        }
      `,
      { number: issue.number },
      "NullableIssue",
    );

    expect(response.status).toBe(200);
    const body = await responseBody(response);
    expect(body.data?.repository).toEqual({ issue: { body: null, author: expect.any(Object) } });
  });

  it("maintains a consistent GraphQL rate-limit bucket", async () => {
    const { app } = createTestApp();
    const response = await graphql(
      app,
      `
        query RateLimit {
          rateLimit {
            limit
            remaining
            used
            resetAt
            cost
          }
        }
      `,
      undefined,
      "RateLimit",
    );
    expect(response.status).toBe(200);
    const body = await responseBody(response);
    expect(body.data?.rateLimit?.limit).toBe(5000);
    expect(body.data!.rateLimit!.remaining + body.data!.rateLimit!.used).toBe(body.data!.rateLimit!.limit);
    expect(body.data?.rateLimit?.cost).toBe(1);
  });

  it("requires authentication before executing any GraphQL document", async () => {
    const { app } = createTestApp();
    for (const query of [
      `query { repository(owner: "octocat", name: "hello-world") { id } }`,
      `{ __typename }`,
      `{ __schema { queryType { name } } }`,
    ]) {
      const response = await app.request(`${base}/graphql`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });
      expect(response.status).toBe(401);
      expect((await responseBody(response)).errors?.[0]?.message).toBe("Requires authentication");
    }
  });
});
