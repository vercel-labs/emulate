import { describe, expect, it, vi } from "vitest";
import { Hono } from "@emulators/core";
import { Store, WebhookDispatcher } from "@emulators/core";
import { authMiddleware, createApiErrorHandler, createErrorHandler, type TokenMap } from "@emulators/core";
import { getGitHubStore, githubPlugin, seedFromConfig } from "../index.js";

const base = "http://localhost:4000";
let testDefaultToken = "octocat-token";

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
  token = testDefaultToken,
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

async function createIssue(app: Hono, title: string) {
  const response = await app.request(`${base}/repos/octocat/hello-world/issues`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ title }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { id: number; node_id: string; number: number };
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

  it("returns partial data for resolver errors with HTTP 200", async () => {
    const { app, store } = createTestApp();
    const repositoryId = getGitHubStore(store).repos.findOneBy("full_name", "octocat/hello-world")!.node_id;
    const response = await graphql(
      app,
      `
        mutation Partial($bad: CreateIssueInput!, $good: CreateIssueInput!) {
          bad: createIssue(input: $bad) {
            issue {
              id
            }
          }
          good: createIssue(input: $good) {
            issue {
              number
            }
          }
        }
      `,
      {
        bad: { repositoryId, title: "" },
        good: { repositoryId, title: "Partial success" },
      },
      "Partial",
    );
    expect(response.status).toBe(200);
    const body = (await responseBody(response)) as any;
    expect(body.data).toBeNull();
    expect(body.errors?.[0]?.message).toContain("Validation failed");
    const partial = await graphql(
      app,
      `
        query Partial {
          repository(owner: "octocat", name: "hello-world") {
            id
          }
          node(id: "missing") {
            id
          }
        }
      `,
      undefined,
      "Partial",
    );
    expect(partial.status).toBe(200);
    expect(((await responseBody(partial)) as any).data).toEqual({
      repository: { id: repositoryId },
      node: null,
    });
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
    const second = await graphql(
      app,
      `
        query RateAgain {
          rateLimit {
            remaining
            used
          }
        }
      `,
      undefined,
      "RateAgain",
    );
    const secondBody = await responseBody(second);
    expect(secondBody.data!.rateLimit!.used).toBe(body.data!.rateLimit!.used + 1);
    expect(secondBody.data!.rateLimit!.remaining).toBe(body.data!.rateLimit!.remaining - 1);
    const rest = await app.request(`${base}/rate_limit`, { headers: headers() });
    expect(rest.status).toBe(200);
    const restBody = (await rest.json()) as { resources: { graphql: { used: number; remaining: number } } };
    expect(restBody.resources.graphql.used).toBe(secondBody.data!.rateLimit!.used);
    expect(restBody.resources.graphql.remaining).toBe(secondBody.data!.rateLimit!.remaining);
  });

  it("returns a resolver error with partial sibling data at the public boundary", async () => {
    const { app } = createTestApp();
    const issue = await createIssue(app, "Resolver boundary");
    const response = await graphql(
      app,
      `
        query ResolverBoundary($id: ID!) {
          repository(owner: "octocat", name: "hello-world") {
            id
          }
          node(id: $id) {
            ... on Issue {
              comments(first: 1, after: "bad-cursor") {
                nodes {
                  id
                }
              }
            }
          }
          rateLimit {
            limit
          }
        }
      `,
      { id: issue.node_id },
      "ResolverBoundary",
    );
    expect(response.status).toBe(200);
    const body = (await responseBody(response)) as any;
    expect(body.data.repository.id).toEqual(expect.any(String));
    expect(body.data.rateLimit.limit).toBe(5000);
    expect(body.data.node).toBeNull();
    expect(body.errors?.[0]?.path).toEqual(["node", "comments"]);
    expect(body.errors?.[0]?.message).toContain("Invalid cursor");
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

  it("reads REST-created parent, sub-issue, and blocked-by relationships with Relay pagination", async () => {
    const { app } = createTestApp();
    const parent = await createIssue(app, "GraphQL parent");
    const childOne = await createIssue(app, "GraphQL child one");
    const childTwo = await createIssue(app, "GraphQL child two");
    const blocker = await createIssue(app, "GraphQL blocker");
    const blocked = await createIssue(app, "GraphQL blocked");
    const relationship = (path: string, body: object) =>
      app.request(`${base}${path}`, { method: "POST", headers: headers(), body: JSON.stringify(body) });
    expect(
      (
        await relationship(`/repos/octocat/hello-world/issues/${parent.number}/sub_issues`, {
          sub_issue_id: childOne.id,
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await relationship(`/repos/octocat/hello-world/issues/${parent.number}/sub_issues`, {
          sub_issue_id: childTwo.id,
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await relationship(`/repos/octocat/hello-world/issues/${blocked.number}/dependencies/blocked_by`, {
          issue_id: blocker.id,
        })
      ).status,
    ).toBe(201);

    const query = `query Relationships($id: ID!, $first: Int, $after: String) {
      node(id: $id) { ... on Issue {
        parent { id }
        subIssues(first: $first, after: $after) { nodes { id number } edges { cursor } pageInfo { hasNextPage hasPreviousPage } totalCount }
        blockedBy(first: $first) { nodes { id number } totalCount }
      } }
    }`;
    const first = await graphql(app, query, { id: childOne.node_id, first: 1 }, "Relationships");
    const firstBody = (await responseBody(first)) as any;
    expect(firstBody.data.node.parent.id).toBe(parent.node_id);
    expect(firstBody.data.node.subIssues.totalCount).toBe(0);

    const parentPage = await graphql(app, query, { id: parent.node_id, first: 1 }, "Relationships");
    const parentBody = (await responseBody(parentPage)) as any;
    expect(parentBody.data.node.subIssues.nodes.map((issue: any) => issue.id)).toEqual([childOne.node_id]);
    expect(parentBody.data.node.subIssues.pageInfo.hasNextPage).toBe(true);
    const cursor = parentBody.data.node.subIssues.edges[0].cursor;
    const secondPage = await graphql(app, query, { id: parent.node_id, first: 100, after: cursor }, "Relationships");
    expect(((await responseBody(secondPage)) as any).data.node.subIssues.nodes.map((issue: any) => issue.id)).toEqual([
      childTwo.node_id,
    ]);

    const blockedPage = await graphql(app, query, { id: blocked.node_id, first: 0 }, "Relationships");
    expect(((await responseBody(blockedPage)) as any).data.node.blockedBy.nodes).toEqual([]);
    const blockedFull = await graphql(app, query, { id: blocked.node_id, first: 100 }, "Relationships");
    expect(((await responseBody(blockedFull)) as any).data.node.blockedBy.nodes.map((issue: any) => issue.id)).toEqual([
      blocker.node_id,
    ]);
  });

  it("writes relationships through GraphQL and exposes them through REST with client IDs", async () => {
    const { app } = createTestApp();
    const parent = await createIssue(app, "Mutation parent");
    const child = await createIssue(app, "Mutation child");
    const blocker = await createIssue(app, "Mutation blocker");
    const blocked = await createIssue(app, "Mutation blocked");
    const mutation = `mutation Add($sub: AddSubIssueInput!, $dependency: AddBlockedByInput!) {
      addSubIssue(input: $sub) { parentIssue { id } subIssue { id } clientMutationId }
      addBlockedBy(input: $dependency) { issue { id } blockedBy { id } clientMutationId }
    }`;
    const response = await graphql(
      app,
      mutation,
      {
        sub: { parentIssueId: parent.node_id, childIssueId: child.node_id, clientMutationId: "sub-client" },
        dependency: { issueId: blocked.node_id, blockingIssueId: blocker.node_id, clientMutationId: "dep-client" },
      },
      "Add",
    );
    expect(response.status).toBe(200);
    expect(((await responseBody(response)) as any).data).toEqual({
      addSubIssue: {
        parentIssue: { id: parent.node_id },
        subIssue: { id: child.node_id },
        clientMutationId: "sub-client",
      },
      addBlockedBy: {
        issue: { id: blocked.node_id },
        blockedBy: { id: blocker.node_id },
        clientMutationId: "dep-client",
      },
    });

    const subRest = await app.request(`${base}/repos/octocat/hello-world/issues/${parent.number}/sub_issues`, {
      headers: headers(),
    });
    expect(((await subRest.json()) as Array<{ id: number }>).map((issue) => issue.id)).toEqual([child.id]);
    const dependencyRest = await app.request(
      `${base}/repos/octocat/hello-world/issues/${blocked.number}/dependencies/blocked_by`,
      { headers: headers() },
    );
    expect(((await dependencyRest.json()) as Array<{ id: number }>).map((issue) => issue.id)).toEqual([blocker.id]);
  });

  it("rejects unauthorized and cyclic GraphQL relationship mutations atomically", async () => {
    const { app } = createTestApp();
    const first = await createIssue(app, "Atomic first");
    const second = await createIssue(app, "Atomic second");
    const mutation = `mutation Add($input: AddSubIssueInput!) { addSubIssue(input: $input) { subIssue { id } } }`;
    const created = await graphql(
      app,
      mutation,
      { input: { parentIssueId: first.node_id, childIssueId: second.node_id } },
      "Add",
    );
    expect(((await responseBody(created)) as any).data.addSubIssue.subIssue.id).toBe(second.node_id);
    const cycle = await graphql(
      app,
      mutation,
      { input: { parentIssueId: second.node_id, childIssueId: first.node_id } },
      "Add",
    );
    expect(((await responseBody(cycle)) as any).errors[0].message).toContain("cycle");
    const parentRest = await app.request(`${base}/repos/octocat/hello-world/issues/${first.number}/sub_issues`, {
      headers: headers(),
    });
    expect(((await parentRest.json()) as Array<{ id: number }>).map((issue) => issue.id)).toEqual([second.id]);
  });

  it("preserves exact 100-item and multipage connection boundaries", async () => {
    const { app } = createTestApp();
    const parent = await createIssue(app, "Boundary parent");
    const children = [];
    for (let index = 0; index < 101; index++) children.push(await createIssue(app, `Boundary child ${index}`));
    for (const child of children) {
      const response = await app.request(`${base}/repos/octocat/hello-world/issues/${parent.number}/sub_issues`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ sub_issue_id: child.id }),
      });
      expect(response.status).toBe(201);
    }
    const query = `query Boundaries($id: ID!, $first: Int, $after: String) { node(id: $id) { ... on Issue { subIssues(first: $first, after: $after) { nodes { id } edges { cursor } pageInfo { hasNextPage hasPreviousPage } totalCount } } } }`;
    const first = await graphql(app, query, { id: parent.node_id, first: 100 }, "Boundaries");
    expect(first.status).toBe(200);
    const firstBody = ((await responseBody(first)) as any).data.node.subIssues;
    expect(firstBody.nodes).toHaveLength(100);
    expect(firstBody.totalCount).toBe(101);
    expect(firstBody.pageInfo.hasNextPage).toBe(true);
    expect(firstBody.pageInfo.hasPreviousPage).toBe(false);
    const next = await graphql(
      app,
      query,
      { id: parent.node_id, first: 100, after: firstBody.edges[99].cursor },
      "Boundaries",
    );
    const nextBody = ((await responseBody(next)) as any).data.node.subIssues;
    expect(next.status).toBe(200);
    expect(nextBody.nodes).toHaveLength(1);
    expect(nextBody.pageInfo.hasNextPage).toBe(false);
    expect(nextBody.pageInfo.hasPreviousPage).toBe(true);
    const empty = await graphql(app, query, { id: parent.node_id, first: 0 }, "Boundaries");
    expect(((await responseBody(empty)) as any).data.node.subIssues.nodes).toEqual([]);
  });

  it("traverses empty, one, exact-100, and 101-item comment and blocker connections", async () => {
    const { app } = createTestApp();
    const empty = await createIssue(app, "Empty connection");
    const commentTarget = await createIssue(app, "Comment boundary");
    const commentPath = `/repos/octocat/hello-world/issues/${commentTarget.number}/comments`;
    for (let index = 0; index < 101; index++) {
      expect(
        (
          await app.request(`${base}${commentPath}`, {
            method: "POST",
            headers: headers(),
            body: JSON.stringify({ body: `comment-${index}` }),
          })
        ).status,
      ).toBe(201);
    }
    const commentQuery = `query Boundary($id: ID!, $first: Int, $after: String) { node(id: $id) { ... on Issue { comments(first: $first, after: $after) { nodes { body } edges { cursor } totalCount pageInfo { hasNextPage hasPreviousPage } } } } }`;
    const emptyBody = (await responseBody(
      await graphql(app, commentQuery, { id: empty.node_id, first: 1 }, "Boundary"),
    )) as any;
    expect(emptyBody.data.node.comments.nodes).toEqual([]);
    const first = (await responseBody(
      await graphql(app, commentQuery, { id: commentTarget.node_id, first: 100 }, "Boundary"),
    )) as any;
    expect(first.data.node.comments.nodes).toHaveLength(100);
    expect(first.data.node.comments.totalCount).toBe(101);
    expect(first.data.node.comments.pageInfo.hasNextPage).toBe(true);
    expect(first.data.node.comments.pageInfo.hasPreviousPage).toBe(false);
    expect(first.data.node.comments.nodes.map((comment: { body: string }) => comment.body)).toEqual(
      Array.from({ length: 100 }, (_, index) => `comment-${index}`),
    );
    const second = (await responseBody(
      await graphql(
        app,
        commentQuery,
        { id: commentTarget.node_id, first: 100, after: first.data.node.comments.edges.at(-1).cursor },
        "Boundary",
      ),
    )) as any;
    expect(second.data.node.comments.nodes).toHaveLength(1);
    expect(second.data.node.comments.pageInfo.hasNextPage).toBe(false);
    expect(second.data.node.comments.pageInfo.hasPreviousPage).toBe(true);
    expect(second.data.node.comments.nodes[0].body).toBe("comment-100");
    expect(
      new Set([...first.data.node.comments.nodes, ...second.data.node.comments.nodes].map((comment) => comment.body))
        .size,
    ).toBe(101);

    const blocked = await createIssue(app, "Blocker boundary");
    for (let index = 0; index < 101; index++) {
      const blocker = await createIssue(app, `blocker-${index}`);
      expect(
        (
          await app.request(`${base}/repos/octocat/hello-world/issues/${blocked.number}/dependencies/blocked_by`, {
            method: "POST",
            headers: headers(),
            body: JSON.stringify({ issue_id: blocker.id }),
          })
        ).status,
      ).toBe(201);
    }
    const blockerQuery = `query Boundary($id: ID!, $first: Int, $after: String) { node(id: $id) { ... on Issue { blockedBy(first: $first, after: $after) { nodes { id } edges { cursor } totalCount pageInfo { hasNextPage hasPreviousPage } } } } }`;
    const blockerFirst = (await responseBody(
      await graphql(app, blockerQuery, { id: blocked.node_id, first: 100 }, "Boundary"),
    )) as any;
    expect(blockerFirst.data.node.blockedBy.nodes).toHaveLength(100);
    expect(blockerFirst.data.node.blockedBy.totalCount).toBe(101);
    expect(blockerFirst.data.node.blockedBy.pageInfo.hasNextPage).toBe(true);
    expect(blockerFirst.data.node.blockedBy.pageInfo.hasPreviousPage).toBe(false);
    const blockerSecond = (await responseBody(
      await graphql(
        app,
        blockerQuery,
        { id: blocked.node_id, first: 100, after: blockerFirst.data.node.blockedBy.edges.at(-1).cursor },
        "Boundary",
      ),
    )) as any;
    expect(blockerSecond.data.node.blockedBy.nodes).toHaveLength(1);
    expect(blockerSecond.data.node.blockedBy.pageInfo.hasNextPage).toBe(false);
    expect(blockerSecond.data.node.blockedBy.pageInfo.hasPreviousPage).toBe(true);
    expect(
      new Set(
        [...blockerFirst.data.node.blockedBy.nodes, ...blockerSecond.data.node.blockedBy.nodes].map(
          (issue) => issue.id,
        ),
      ).size,
    ).toBe(101);
  });

  it("covers the GraphQL projection matrix through public GraphQL", async () => {
    const { app } = createTestApp();
    const fixture = await createFixture(app);
    const parent = await createIssue(app, "Matrix parent");
    const child = await createIssue(app, "Matrix child");
    const blocker = await createIssue(app, "Matrix blocker");
    const relation = (path: string, body: object) =>
      app.request(`${base}${path}`, { method: "POST", headers: headers(), body: JSON.stringify(body) });
    expect(
      (await relation(`/repos/octocat/hello-world/issues/${parent.number}/sub_issues`, { sub_issue_id: child.id }))
        .status,
    ).toBe(201);
    expect(
      (
        await relation(`/repos/octocat/hello-world/issues/${parent.number}/dependencies/blocked_by`, {
          issue_id: blocker.id,
        })
      ).status,
    ).toBe(201);

    const rows: Array<{
      name: string;
      query: string;
      variables?: Record<string, unknown>;
      check: (data: any) => void;
    }> = [
      {
        name: "repository",
        query: `query Repository($owner: String!, $name: String!) { repo: repository(owner: $owner, name: $name) { id } }`,
        variables: { owner: "octocat", name: "hello-world" },
        check: (data) => expect(data.repo.id).toBe(fixture.repo.node_id),
      },
      {
        name: "repositoryIssue",
        query: `query Issue($owner: String!, $name: String!, $number: Int!) { repo: repository(owner: $owner, name: $name) { issue(number: $number) { ...IssueIdentity } } } fragment IssueIdentity on Issue { id number }`,
        variables: { owner: "octocat", name: "hello-world", number: fixture.issue.number },
        check: (data) => expect(data.repo.issue.number).toBe(fixture.issue.number),
      },
      {
        name: "repositoryLabel",
        query: `query Label($owner: String!, $name: String!, $label: String!) { repo: repository(owner: $owner, name: $name) { label(name: $label) { id } } }`,
        variables: { owner: "octocat", name: "hello-world", label: "graphql" },
        check: (data) => expect(data.repo.label.id).toBe(fixture.label.node_id),
      },
      {
        name: "nodeIssueInline",
        query: `query NodeIssue($id: ID!) { value: node(id: $id) { ... on Issue { id number } } }`,
        variables: { id: fixture.issue.node_id },
        check: (data) => expect(data.value.id).toBe(fixture.issue.node_id),
      },
      {
        name: "nodeRepository",
        query: `query NodeRepo($id: ID!) { value: node(id: $id) { ... on Repository { id nameWithOwner } } }`,
        variables: { id: fixture.repo.node_id },
        check: (data) => expect(data.value.nameWithOwner).toBe("octocat/hello-world"),
      },
      {
        name: "nodeLabel",
        query: `query NodeLabel($id: ID!) { value: node(id: $id) { ... on Label { id name } } }`,
        variables: { id: fixture.label.node_id },
        check: (data) => expect(data.value.name).toBe("graphql"),
      },
      {
        name: "nodeComment",
        query: `query NodeComment($id: ID!) { value: node(id: $id) { ... on IssueComment { id body } } }`,
        variables: { id: fixture.comment.node_id },
        check: (data) => expect(data.value.body).toBe("GraphQL comment"),
      },
      {
        name: "issueComments",
        query: `query Comments($id: ID!) { value: node(id: $id) { ... on Issue { comments(first: 1) { nodes { body } } } } }`,
        variables: { id: fixture.issue.node_id },
        check: (data) => expect(data.value.comments.nodes).toHaveLength(1),
      },
      {
        name: "issueParent",
        query: `query Parent($id: ID!) { value: node(id: $id) { ... on Issue { parent { id } } } }`,
        variables: { id: child.node_id },
        check: (data) => expect(data.value.parent.id).toBe(parent.node_id),
      },
      {
        name: "issueSubIssues",
        query: `query SubIssues($id: ID!) { value: node(id: $id) { ... on Issue { subIssues(first: 1) { nodes { id } } } } }`,
        variables: { id: parent.node_id },
        check: (data) => expect(data.value.subIssues.nodes[0].id).toBe(child.node_id),
      },
      {
        name: "issueBlockedBy",
        query: `query BlockedBy($id: ID!) { value: node(id: $id) { ... on Issue { blockedBy(first: 1) { nodes { id } } } } }`,
        variables: { id: parent.node_id },
        check: (data) => expect(data.value.blockedBy.nodes[0].id).toBe(blocker.node_id),
      },
      {
        name: "issueRepository",
        query: `query IssueRepository($id: ID!) { value: node(id: $id) { ... on Issue { repository { id } } } }`,
        variables: { id: fixture.issue.node_id },
        check: (data) => expect(data.value.repository.id).toBe(fixture.repo.node_id),
      },
      {
        name: "issueAuthor",
        query: `query IssueAuthor($id: ID!) { value: node(id: $id) { ... on Issue { author { login } } } }`,
        variables: { id: fixture.issue.node_id },
        check: (data) => expect(data.value.author.login).toBe("octocat"),
      },
      {
        name: "commentIssue",
        query: `query CommentIssue($id: ID!) { value: node(id: $id) { ... on IssueComment { issue { id } } } }`,
        variables: { id: fixture.comment.node_id },
        check: (data) => expect(data.value.issue.id).toBe(fixture.issue.node_id),
      },
      {
        name: "labelRepository",
        query: `query LabelRepository($id: ID!) { value: node(id: $id) { ... on Label { repository { id } } } }`,
        variables: { id: fixture.label.node_id },
        check: (data) => expect(data.value.repository.id).toBe(fixture.repo.node_id),
      },
      {
        name: "rateLimit",
        query: `query Rate { limits: rateLimit { limit remaining used } }`,
        check: (data) => expect(data.limits.limit).toBeGreaterThan(0),
      },
    ];
    for (const row of rows) {
      const operationName = row.query.match(/(?:query|mutation)\s+(\w+)/)?.[1];
      const response = await graphql(app, row.query, row.variables, operationName);
      expect(response.status, row.name).toBe(200);
      const body = (await responseBody(response)) as any;
      expect(body.errors, row.name).toBeUndefined();
      row.check(body.data);
    }
  });

  it("covers the exact initial 16 consumer operations through public GraphQL", async () => {
    const { app } = createTestApp();
    const fixture = await createFixture(app);
    const parent = await createIssue(app, "Exact matrix parent");
    const child = await createIssue(app, "Exact matrix child");
    const blocker = await createIssue(app, "Exact matrix blocker");
    const standalone = await createIssue(app, "Exact matrix standalone");
    const relation = (path: string, body: object) =>
      app.request(`${base}${path}`, { method: "POST", headers: headers(), body: JSON.stringify(body) });
    expect(
      (await relation(`/repos/octocat/hello-world/issues/${parent.number}/sub_issues`, { sub_issue_id: child.id }))
        .status,
    ).toBe(201);
    expect(
      (
        await relation(`/repos/octocat/hello-world/issues/${parent.number}/dependencies/blocked_by`, {
          issue_id: blocker.id,
        })
      ).status,
    ).toBe(201);

    const rows: Array<{ name: string; run: () => Promise<void> }> = [
      {
        name: "repository resolution",
        run: async () => {
          const response = await graphql(
            app,
            `
              query Repository($owner: String!, $name: String!) {
                repo: repository(owner: $owner, name: $name) {
                  id
                }
              }
            `,
            { owner: "octocat", name: "hello-world" },
            "Repository",
          );
          expect(response.status).toBe(200);
          expect(((await responseBody(response)) as any).data.repo.id).toBe(fixture.repo.node_id);
        },
      },
      {
        name: "repository issue resolution",
        run: async () => {
          const response = await graphql(
            app,
            `
              query RepositoryIssue($owner: String!, $name: String!, $number: Int!) {
                repo: repository(owner: $owner, name: $name) {
                  issue(number: $number) {
                    id
                  }
                }
              }
            `,
            { owner: "octocat", name: "hello-world", number: fixture.issue.number },
            "RepositoryIssue",
          );
          expect(response.status).toBe(200);
          expect(((await responseBody(response)) as any).data.repo.issue.id).toBe(fixture.issue.node_id);
        },
      },
      {
        name: "node issue read",
        run: async () => {
          const response = await graphql(
            app,
            `
              query NodeIssue($id: ID!) {
                value: node(id: $id) {
                  ... on Issue {
                    id
                    number
                  }
                }
              }
            `,
            { id: fixture.issue.node_id },
            "NodeIssue",
          );
          expect(response.status).toBe(200);
          expect(((await responseBody(response)) as any).data.value.id).toBe(fixture.issue.node_id);
        },
      },
      {
        name: "issue detail projection",
        run: async () => {
          const response = await graphql(
            app,
            `
              query IssueDetail($id: ID!) {
                value: node(id: $id) {
                  ...IssueDetails
                }
              }
              fragment IssueDetails on Issue {
                id
                title
                state
                repository {
                  id
                }
              }
            `,
            { id: fixture.issue.node_id },
            "IssueDetail",
          );
          expect(response.status).toBe(200);
          expect(((await responseBody(response)) as any).data.value.repository.id).toBe(fixture.repo.node_id);
        },
      },
      {
        name: "paginated subIssues",
        run: async () => {
          const response = await graphql(
            app,
            `
              query SubIssues($id: ID!, $first: Int!) {
                value: node(id: $id) {
                  ... on Issue {
                    subIssues(first: $first) {
                      nodes {
                        id
                      }
                    }
                  }
                }
              }
            `,
            { id: parent.node_id, first: 1 },
            "SubIssues",
          );
          expect(response.status).toBe(200);
          expect(((await responseBody(response)) as any).data.value.subIssues.nodes[0].id).toBe(child.node_id);
        },
      },
      {
        name: "paginated blockedBy",
        run: async () => {
          const response = await graphql(
            app,
            `
              query BlockedBy($id: ID!, $first: Int!) {
                value: node(id: $id) {
                  ... on Issue {
                    blockedBy(first: $first) {
                      nodes {
                        id
                      }
                    }
                  }
                }
              }
            `,
            { id: parent.node_id, first: 1 },
            "BlockedBy",
          );
          expect(response.status).toBe(200);
          expect(((await responseBody(response)) as any).data.value.blockedBy.nodes[0].id).toBe(blocker.node_id);
        },
      },
      {
        name: "createIssue",
        run: async () => {
          const response = await graphql(
            app,
            `
              mutation Create($input: CreateIssueInput!) {
                created: createIssue(input: $input) {
                  ...CreatedIssue
                }
              }
              fragment CreatedIssue on CreateIssuePayload {
                clientMutationId
                issue {
                  id
                }
              }
            `,
            {
              input: {
                repositoryId: fixture.repo.node_id,
                title: "Exact matrix created",
                clientMutationId: "matrix-create",
              },
            },
            "Create",
          );
          const body = (await responseBody(response)) as any;
          expect(response.status).toBe(200);
          expect(body.data.created.clientMutationId).toBe("matrix-create");
        },
      },
      {
        name: "deleteIssue",
        run: async () => {
          const response = await graphql(
            app,
            `
              mutation Delete($input: DeleteIssueInput!) {
                deleted: deleteIssue(input: $input) {
                  ...DeletedIssue
                }
              }
              fragment DeletedIssue on DeleteIssuePayload {
                clientMutationId
                repository {
                  id
                }
              }
            `,
            { input: { issueId: standalone.node_id, clientMutationId: "matrix-delete" } },
            "Delete",
          );
          const body = (await responseBody(response)) as any;
          expect(response.status).toBe(200);
          expect(body.data.deleted.repository.id).toBe(fixture.repo.node_id);
        },
      },
      {
        name: "addComment",
        run: async () => {
          const response = await graphql(
            app,
            `
              mutation Comment($input: AddCommentInput!) {
                added: addComment(input: $input) {
                  ...AddedComment
                }
              }
              fragment AddedComment on AddCommentPayload {
                clientMutationId
                comment {
                  body
                }
              }
            `,
            {
              input: {
                subjectId: fixture.issue.node_id,
                body: "Exact matrix comment",
                clientMutationId: "matrix-comment",
              },
            },
            "Comment",
          );
          const body = (await responseBody(response)) as any;
          expect(response.status).toBe(200);
          expect(body.data.added.comment.body).toBe("Exact matrix comment");
        },
      },
      {
        name: "addSubIssue",
        run: async () => {
          const extra = await createIssue(app, "Exact matrix extra child");
          const response = await graphql(
            app,
            `
              mutation Sub($input: AddSubIssueInput!) {
                added: addSubIssue(input: $input) {
                  ...AddedSub
                }
              }
              fragment AddedSub on AddSubIssuePayload {
                clientMutationId
                subIssue {
                  id
                }
              }
            `,
            {
              input: {
                parentIssueId: fixture.issue.node_id,
                childIssueId: extra.node_id,
                clientMutationId: "matrix-sub",
              },
            },
            "Sub",
          );
          const body = (await responseBody(response)) as any;
          expect(response.status).toBe(200);
          expect(body.data.added.subIssue.id).toBe(extra.node_id);
        },
      },
      {
        name: "addBlockedBy",
        run: async () => {
          const extra = await createIssue(app, "Exact matrix extra blocker");
          const response = await graphql(
            app,
            `
              mutation Block($input: AddBlockedByInput!) {
                added: addBlockedBy(input: $input) {
                  ...AddedBlock
                }
              }
              fragment AddedBlock on AddBlockedByPayload {
                clientMutationId
                blockedBy {
                  id
                }
              }
            `,
            {
              input: {
                issueId: fixture.issue.node_id,
                blockingIssueId: extra.node_id,
                clientMutationId: "matrix-block",
              },
            },
            "Block",
          );
          const body = (await responseBody(response)) as any;
          expect(response.status).toBe(200);
          expect(body.data.added.blockedBy.id).toBe(extra.node_id);
        },
      },
      {
        name: "closeIssue",
        run: async () => {
          const response = await graphql(
            app,
            `
              mutation Close($input: CloseIssueInput!) {
                closed: closeIssue(input: $input) {
                  ...ClosedIssue
                }
              }
              fragment ClosedIssue on CloseIssuePayload {
                clientMutationId
                issue {
                  state
                }
              }
            `,
            { input: { issueId: parent.node_id, clientMutationId: "matrix-close" } },
            "Close",
          );
          const body = (await responseBody(response)) as any;
          expect(response.status).toBe(200);
          expect(body.data.closed.issue.state).toBe("CLOSED");
        },
      },
      {
        name: "reopenIssue",
        run: async () => {
          const response = await graphql(
            app,
            `
              mutation Reopen($input: ReopenIssueInput!) {
                reopened: reopenIssue(input: $input) {
                  ...ReopenedIssue
                }
              }
              fragment ReopenedIssue on ReopenIssuePayload {
                clientMutationId
                issue {
                  state
                }
              }
            `,
            { input: { issueId: parent.node_id, clientMutationId: "matrix-reopen" } },
            "Reopen",
          );
          const body = (await responseBody(response)) as any;
          expect(response.status).toBe(200);
          expect(body.data.reopened.issue.state).toBe("OPEN");
        },
      },
      {
        name: "repository label lookup",
        run: async () => {
          const response = await graphql(
            app,
            `
              query LabelLookup($owner: String!, $name: String!, $label: String!) {
                repo: repository(owner: $owner, name: $name) {
                  label(name: $label) {
                    id
                  }
                }
              }
            `,
            { owner: "octocat", name: "hello-world", label: "graphql" },
            "LabelLookup",
          );
          expect(response.status).toBe(200);
          expect(((await responseBody(response)) as any).data.repo.label.id).toBe(fixture.label.node_id);
        },
      },
      {
        name: "createLabel",
        run: async () => {
          const response = await graphql(
            app,
            `
              mutation Label($input: CreateLabelInput!) {
                created: createLabel(input: $input) {
                  ...CreatedLabel
                }
              }
              fragment CreatedLabel on CreateLabelPayload {
                clientMutationId
                label {
                  id
                }
              }
            `,
            {
              input: {
                repositoryId: fixture.repo.node_id,
                name: "exact-matrix-label",
                clientMutationId: "matrix-label",
              },
            },
            "Label",
          );
          const body = (await responseBody(response)) as any;
          expect(response.status).toBe(200);
          expect(body.data.created.label.id).toEqual(expect.any(String));
        },
      },
      {
        name: "deleteLabel",
        run: async () => {
          const created = await graphql(
            app,
            `
              mutation Label($input: CreateLabelInput!) {
                createLabel(input: $input) {
                  label {
                    id
                  }
                }
              }
            `,
            { input: { repositoryId: fixture.repo.node_id, name: "exact-matrix-delete-label" } },
            "Label",
          );
          const labelId = ((await responseBody(created)) as any).data.createLabel.label.id;
          const response = await graphql(
            app,
            `
              mutation DeleteLabel($input: DeleteLabelInput!) {
                deleted: deleteLabel(input: $input) {
                  ...DeletedLabel
                }
              }
              fragment DeletedLabel on DeleteLabelPayload {
                clientMutationId
                label {
                  id
                }
              }
            `,
            { input: { id: labelId, clientMutationId: "matrix-delete-label" } },
            "DeleteLabel",
          );
          const body = (await responseBody(response)) as any;
          expect(response.status).toBe(200);
          expect(body.data.deleted.label.id).toBe(labelId);
        },
      },
    ];
    expect(rows.map((row) => row.name)).toEqual([
      "repository resolution",
      "repository issue resolution",
      "node issue read",
      "issue detail projection",
      "paginated subIssues",
      "paginated blockedBy",
      "createIssue",
      "deleteIssue",
      "addComment",
      "addSubIssue",
      "addBlockedBy",
      "closeIssue",
      "reopenIssue",
      "repository label lookup",
      "createLabel",
      "deleteLabel",
    ]);
    for (const row of rows) await row.run();
  });

  it("rejects relationship duplicates, self references, conflicts, and inaccessible dependencies without mutation", async () => {
    const { app } = createTestApp();
    const parent = await createIssue(app, "Validation parent");
    const child = await createIssue(app, "Validation child");
    const blocker = await createIssue(app, "Validation blocker");
    const blocked = await createIssue(app, "Validation blocked");
    const mutation = `mutation Add($sub: AddSubIssueInput!, $dep: AddBlockedByInput!) { addSubIssue(input: $sub) { clientMutationId } addBlockedBy(input: $dep) { clientMutationId } }`;
    const variables = {
      sub: { parentIssueId: parent.node_id, childIssueId: child.node_id, clientMutationId: "same" },
      dep: { issueId: blocked.node_id, blockingIssueId: blocker.node_id, clientMutationId: "same" },
    };
    expect(((await responseBody(await graphql(app, mutation, variables, "Add"))) as any).data).toEqual({
      addSubIssue: { clientMutationId: "same" },
      addBlockedBy: { clientMutationId: "same" },
    });
    const duplicate = await graphql(app, mutation, variables, "Add");
    expect(((await responseBody(duplicate)) as any).errors[0].message).toContain("already");
    const self = await graphql(
      app,
      `
        mutation Self($input: AddBlockedByInput!) {
          addBlockedBy(input: $input) {
            clientMutationId
          }
        }
      `,
      { input: { issueId: blocked.node_id, blockingIssueId: blocked.node_id } },
      "Self",
    );
    expect(((await responseBody(self)) as any).errors[0].message).toContain("itself");
    const conflict = await graphql(
      app,
      `
        mutation Conflict($input: AddSubIssueInput!) {
          addSubIssue(input: $input) {
            clientMutationId
          }
        }
      `,
      { input: { parentIssueId: blocker.node_id, childIssueId: child.node_id } },
      "Conflict",
    );
    expect(((await responseBody(conflict)) as any).errors[0].message).toContain("parent");
    const rest = await app.request(`${base}/repos/octocat/hello-world/issues/${parent.number}/sub_issues`, {
      headers: headers(),
    });
    expect(((await rest.json()) as Array<{ id: number }>).map((issue) => issue.id)).toEqual([child.id]);

    const privateIssueResponse = await app.request(`${base}/repos/octocat/private-repo/issues`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ title: "Hidden relationship target" }),
    });
    const privateIssue = (await privateIssueResponse.json()) as { node_id: string };
    const inaccessible = await graphql(
      app,
      `
        mutation Hidden($input: AddSubIssueInput!) {
          addSubIssue(input: $input) {
            clientMutationId
          }
        }
      `,
      { input: { parentIssueId: parent.node_id, childIssueId: privateIssue.node_id } },
      "Hidden",
      "outsider-token",
    );
    expect(((await responseBody(inaccessible)) as any).errors[0].message).toContain("Issue not found");
    const invalidDependency = await graphql(
      app,
      `
        mutation Invalid($input: AddBlockedByInput!) {
          addBlockedBy(input: $input) {
            clientMutationId
          }
        }
      `,
      { input: { issueId: blocked.node_id, blockingIssueId: "missing-node" } },
      "Invalid",
    );
    expect(((await responseBody(invalidDependency)) as any).errors[0].message).toContain("Issue not found");
  });

  it("validates blocked-issue aliases while accepting equal or single fields", async () => {
    const { app } = createTestApp();
    const blocked = await createIssue(app, "Alias blocked");
    const other = await createIssue(app, "Alias other");
    const blocker = await createIssue(app, "Alias blocker");
    const mutation = `mutation Alias($input: AddBlockedByInput!) { addBlockedBy(input: $input) { issue { id } clientMutationId } }`;
    const conflicting = await graphql(
      app,
      mutation,
      { input: { issueId: blocked.node_id, blockedIssueId: other.node_id, blockingIssueId: blocker.node_id } },
      "Alias",
    );
    expect(((await responseBody(conflicting)) as any).errors[0].message).toContain("same issue");

    const equal = await graphql(
      app,
      mutation,
      {
        input: {
          issueId: blocked.node_id,
          blockedIssueId: blocked.node_id,
          blockingIssueId: blocker.node_id,
          clientMutationId: "equal",
        },
      },
      "Alias",
    );
    expect(((await responseBody(equal)) as any).data.addBlockedBy.clientMutationId).toBe("equal");

    const singleBlocked = await createIssue(app, "Alias single");
    const single = await graphql(
      app,
      mutation,
      {
        input: { blockedIssueId: singleBlocked.node_id, blockingIssueId: blocker.node_id, clientMutationId: "single" },
      },
      "Alias",
    );
    expect(((await responseBody(single)) as any).data.addBlockedBy.issue.id).toBe(singleBlocked.node_id);
  });
});

describe("GitHub GraphQL mutation compatibility", () => {
  it("runs the explicit user and App permission matrix across every issue-graph family", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { app, store, tokenMap } = createTestApp();
    const fixture = await createFixture(app);
    const parent = await createIssue(app, "Permission parent");
    const child = await createIssue(app, "Permission child");
    const blocker = await createIssue(app, "Permission blocker");
    const deletion = await createIssue(app, "Permission deletion");
    const privateIssueResponse = await app.request(`${base}/repos/octocat/private-repo/issues`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ title: "Private permission issue" }),
    });
    const privateIssue = (await privateIssueResponse.json()) as { node_id: string };
    const gh = getGitHubStore(store);
    const repo = gh.repos.findOneBy("full_name", "octocat/hello-world")!;
    expect(
      (
        await app.request(`${base}/repos/octocat/hello-world/issues/${parent.number}/sub_issues`, {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({ sub_issue_id: child.id }),
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await app.request(`${base}/repos/octocat/hello-world/issues/${parent.number}/dependencies/blocked_by`, {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({ issue_id: blocker.id }),
        })
      ).status,
    ).toBe(201);
    addInstallationToken(store, tokenMap, "matrix-read", {
      permissions: { issues: "read" },
      repositorySelection: "selected",
      repositoryIds: [repo.id],
    });
    addInstallationToken(store, tokenMap, "matrix-write", {
      permissions: { issues: "write" },
      repositorySelection: "selected",
      repositoryIds: [repo.id],
    });
    addInstallationToken(store, tokenMap, "matrix-excluded", {
      permissions: { issues: "write" },
      repositorySelection: "selected",
      repositoryIds: [],
    });
    const rows: Array<{
      name: string;
      token: string;
      expected: number;
      run: () => Promise<Response>;
      check?: (body: any) => void;
    }> = [
      {
        name: "user repository read",
        token: "octocat-token",
        expected: 200,
        run: () =>
          graphql(
            app,
            `
              query UserRepo {
                repo: repository(owner: "octocat", name: "hello-world") {
                  id
                }
              }
            `,
            undefined,
            "UserRepo",
          ) as Promise<Response>,
        check: (body) => expect(body.data.repo.id).toBe(repo.node_id),
      },
      {
        name: "App read-only repository read selected",
        token: "matrix-read",
        expected: 200,
        run: () =>
          graphql(
            app,
            `
              query AppRepo {
                repo: repository(owner: "octocat", name: "hello-world") {
                  id
                }
              }
            `,
            undefined,
            "AppRepo",
          ) as Promise<Response>,
        check: (body) => expect(body.data.repo.id).toBe(repo.node_id),
      },
      {
        name: "App selected excluded public repository",
        token: "matrix-excluded",
        expected: 200,
        run: () =>
          graphql(
            app,
            `
              query ExcludedRepo {
                repo: repository(owner: "octocat", name: "hello-world") {
                  id
                }
              }
            `,
            undefined,
            "ExcludedRepo",
          ) as Promise<Response>,
        check: (body) => expect(body.data.repo).toBeNull(),
      },
      {
        name: "user private repository inaccessible",
        token: "outsider-token",
        expected: 200,
        run: () =>
          graphql(
            app,
            `
              query PrivateRepo {
                repo: repository(owner: "octocat", name: "private-repo") {
                  id
                }
              }
            `,
            undefined,
            "PrivateRepo",
          ) as Promise<Response>,
        check: (body) => expect(body.data.repo).toBeNull(),
      },
      {
        name: "issue read selected",
        token: "matrix-read",
        expected: 200,
        run: () =>
          graphql(
            app,
            `
              query IssueRead($id: ID!) {
                value: node(id: $id) {
                  ... on Issue {
                    id
                  }
                }
              }
            `,
            { id: fixture.issue.node_id },
            "IssueRead",
          ) as Promise<Response>,
        check: (body) => expect(body.data.value.id).toBe(fixture.issue.node_id),
      },
      {
        name: "node read excluded",
        token: "matrix-excluded",
        expected: 200,
        run: () =>
          graphql(
            app,
            `
              query NodeExcluded($id: ID!) {
                value: node(id: $id) {
                  id
                }
              }
            `,
            { id: fixture.issue.node_id },
            "NodeExcluded",
          ) as Promise<Response>,
        check: (body) => expect(body.data.value).toBeNull(),
      },
      {
        name: "private node inaccessible",
        token: "outsider-token",
        expected: 200,
        run: () =>
          graphql(
            app,
            `
              query PrivateNode($id: ID!) {
                value: node(id: $id) {
                  id
                }
              }
            `,
            { id: privateIssue.node_id },
            "PrivateNode",
          ) as Promise<Response>,
        check: (body) => expect(body.data.value).toBeNull(),
      },
      {
        name: "comments read",
        token: "matrix-read",
        expected: 200,
        run: () =>
          graphql(
            app,
            `
              query Comments($id: ID!) {
                value: node(id: $id) {
                  ... on Issue {
                    comments(first: 1) {
                      totalCount
                    }
                  }
                }
              }
            `,
            { id: fixture.issue.node_id },
            "Comments",
          ) as Promise<Response>,
        check: (body) => expect(body.data.value.comments.totalCount).toBe(1),
      },
      {
        name: "subIssues read",
        token: "matrix-read",
        expected: 200,
        run: () =>
          graphql(
            app,
            `
              query Subs($id: ID!) {
                value: node(id: $id) {
                  ... on Issue {
                    subIssues(first: 1) {
                      nodes {
                        id
                      }
                    }
                  }
                }
              }
            `,
            { id: parent.node_id },
            "Subs",
          ) as Promise<Response>,
        check: (body) => expect(body.data.value.subIssues.nodes[0].id).toBe(child.node_id),
      },
      {
        name: "blockedBy read",
        token: "matrix-read",
        expected: 200,
        run: () =>
          graphql(
            app,
            `
              query Blocks($id: ID!) {
                value: node(id: $id) {
                  ... on Issue {
                    blockedBy(first: 1) {
                      nodes {
                        id
                      }
                    }
                  }
                }
              }
            `,
            { id: parent.node_id },
            "Blocks",
          ) as Promise<Response>,
        check: (body) => expect(body.data.value.blockedBy.nodes[0].id).toBe(blocker.node_id),
      },
      {
        name: "create issue read-only denied",
        token: "matrix-read",
        expected: 403,
        run: () =>
          graphql(
            app,
            `
              mutation CreateDenied($input: CreateIssueInput!) {
                createIssue(input: $input) {
                  issue {
                    id
                  }
                }
              }
            `,
            { input: { repositoryId: repo.node_id, title: "denied" } },
            "CreateDenied",
          ) as Promise<Response>,
      },
      {
        name: "create issue write allowed",
        token: "matrix-write",
        expected: 200,
        run: () =>
          graphql(
            app,
            `
              mutation CreateAllowed($input: CreateIssueInput!) {
                created: createIssue(input: $input) {
                  issue {
                    id
                  }
                }
              }
            `,
            { input: { repositoryId: repo.node_id, title: "allowed" } },
            "CreateAllowed",
          ) as Promise<Response>,
      },
      {
        name: "delete issue read-only denied",
        token: "matrix-read",
        expected: 403,
        run: () =>
          graphql(
            app,
            `
              mutation DeleteDenied($input: DeleteIssueInput!) {
                deleteIssue(input: $input) {
                  repository {
                    id
                  }
                }
              }
            `,
            { input: { issueId: deletion.node_id } },
            "DeleteDenied",
          ) as Promise<Response>,
      },
      {
        name: "comment read-only denied",
        token: "matrix-read",
        expected: 403,
        run: () =>
          graphql(
            app,
            `
              mutation CommentDenied($input: AddCommentInput!) {
                addComment(input: $input) {
                  comment {
                    id
                  }
                }
              }
            `,
            { input: { subjectId: fixture.issue.node_id, body: "denied" } },
            "CommentDenied",
          ) as Promise<Response>,
      },
      {
        name: "comment App write bot actor",
        token: "matrix-write",
        expected: 200,
        run: () =>
          graphql(
            app,
            `
              mutation CommentAllowed($input: AddCommentInput!) {
                added: addComment(input: $input) {
                  comment {
                    author {
                      login
                    }
                  }
                }
              }
            `,
            { input: { subjectId: fixture.issue.node_id, body: "bot comment" } },
            "CommentAllowed",
          ) as Promise<Response>,
        check: (body) => expect(body.data.added.comment.author.login).toBe("app-9[bot]"),
      },
      {
        name: "lifecycle read-only denied",
        token: "matrix-read",
        expected: 403,
        run: () =>
          graphql(
            app,
            `
              mutation CloseDenied($input: CloseIssueInput!) {
                closeIssue(input: $input) {
                  issue {
                    id
                  }
                }
              }
            `,
            { input: { issueId: parent.node_id } },
            "CloseDenied",
          ) as Promise<Response>,
      },
      {
        name: "lifecycle App write allowed",
        token: "matrix-write",
        expected: 200,
        run: () =>
          graphql(
            app,
            `
              mutation CloseAllowed($input: CloseIssueInput!) {
                closeIssue(input: $input) {
                  issue {
                    state
                  }
                }
              }
            `,
            { input: { issueId: parent.node_id } },
            "CloseAllowed",
          ) as Promise<Response>,
      },
      {
        name: "create label read-only denied",
        token: "matrix-read",
        expected: 403,
        run: () =>
          graphql(
            app,
            `
              mutation LabelDenied($input: CreateLabelInput!) {
                createLabel(input: $input) {
                  label {
                    id
                  }
                }
              }
            `,
            { input: { repositoryId: repo.node_id, name: "denied-label" } },
            "LabelDenied",
          ) as Promise<Response>,
      },
      {
        name: "create label App write allowed",
        token: "matrix-write",
        expected: 200,
        run: () =>
          graphql(
            app,
            `
              mutation LabelAllowed($input: CreateLabelInput!) {
                createLabel(input: $input) {
                  label {
                    id
                  }
                }
              }
            `,
            { input: { repositoryId: repo.node_id, name: "allowed-label" } },
            "LabelAllowed",
          ) as Promise<Response>,
      },
      {
        name: "reopen lifecycle App write allowed",
        token: "matrix-write",
        expected: 200,
        run: () =>
          graphql(
            app,
            `
              mutation ReopenAllowed($input: ReopenIssueInput!) {
                reopenIssue(input: $input) {
                  issue {
                    state
                  }
                }
              }
            `,
            { input: { issueId: parent.node_id } },
            "ReopenAllowed",
          ) as Promise<Response>,
      },
      {
        name: "delete label read-only denied",
        token: "matrix-read",
        expected: 403,
        run: () =>
          graphql(
            app,
            `
              mutation DeleteLabelDenied($input: DeleteLabelInput!) {
                deleteLabel(input: $input) {
                  label {
                    id
                  }
                }
              }
            `,
            { input: { id: fixture.label.node_id } },
            "DeleteLabelDenied",
          ) as Promise<Response>,
      },
      {
        name: "delete label App write allowed",
        token: "matrix-write",
        expected: 200,
        run: () =>
          graphql(
            app,
            `
              mutation DeleteLabelAllowed($input: DeleteLabelInput!) {
                deleteLabel(input: $input) {
                  label {
                    id
                  }
                }
              }
            `,
            { input: { id: fixture.label.node_id } },
            "DeleteLabelAllowed",
          ) as Promise<Response>,
      },
      {
        name: "relationship read-only denied",
        token: "matrix-read",
        expected: 403,
        run: () =>
          graphql(
            app,
            `
              mutation RelationshipDenied($input: AddSubIssueInput!) {
                addSubIssue(input: $input) {
                  subIssue {
                    id
                  }
                }
              }
            `,
            { input: { parentIssueId: parent.node_id, childIssueId: child.node_id } },
            "RelationshipDenied",
          ) as Promise<Response>,
      },
      {
        name: "relationship App write allowed",
        token: "matrix-write",
        expected: 200,
        run: () =>
          graphql(
            app,
            `
              mutation RelationshipAllowed($input: AddBlockedByInput!) {
                addBlockedBy(input: $input) {
                  blockedBy {
                    id
                  }
                }
              }
            `,
            { input: { issueId: parent.node_id, blockingIssueId: blocker.node_id } },
            "RelationshipAllowed",
          ) as Promise<Response>,
      },
    ];
    for (const row of rows) {
      testDefaultToken = row.token;
      const response = await row.run();
      expect(response.status, row.name).toBe(row.expected);
      const body = (await responseBody(response)) as any;
      if (row.check) row.check(body);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    testDefaultToken = "octocat-token";
  });
  it("creates issues, transitions lifecycle, and echoes client mutation IDs", async () => {
    const { app, store } = createTestApp();
    const fixture = await createFixture(app);
    const createResponse = await graphql(
      app,
      `
        mutation Create($input: CreateIssueInput!) {
          createIssue(input: $input) {
            clientMutationId
            issue {
              id
              number
              state
              stateReason
            }
          }
        }
      `,
      {
        input: {
          repositoryId: fixture.repo.node_id,
          title: "GraphQL created",
          body: "Created body",
          clientMutationId: "create-1",
        },
      },
      "Create",
    );
    expect(createResponse.status).toBe(200);
    const created = (await createResponse.json()) as {
      data: {
        createIssue: {
          issue: { id: string; number: number; state: string; stateReason: string | null };
          clientMutationId: string;
        };
      };
    };
    expect(created.data.createIssue.clientMutationId).toBe("create-1");
    expect(created.data.createIssue.issue).toMatchObject({
      id: expect.any(String),
      number: 2,
      state: "OPEN",
      stateReason: null,
    });

    const closeResponse = await graphql(
      app,
      `
        mutation Close($input: CloseIssueInput!) {
          closeIssue(input: $input) {
            clientMutationId
            issue {
              state
              stateReason
            }
          }
        }
      `,
      { input: { issueId: created.data.createIssue.issue.id, clientMutationId: "close-1" } },
      "Close",
    );
    const closed = (await closeResponse.json()) as {
      data: { closeIssue: { clientMutationId: string; issue: { state: string; stateReason: string } } };
    };
    expect(closed.data.closeIssue.issue.stateReason).toBe("COMPLETED");

    const gh = getGitHubStore(store);
    const closedRow = gh.issues.findOneBy("number", 2)!;
    const closedUpdatedAt = closedRow.updated_at;
    const closedEventCount = gh.issueEvents.all().length;
    const closedAgain = await graphql(
      app,
      `
        mutation CloseAgain($input: CloseIssueInput!) {
          closeIssue(input: $input) {
            issue {
              state
              stateReason
            }
          }
        }
      `,
      { input: { issueId: created.data.createIssue.issue.id, clientMutationId: "close-1" } },
      "CloseAgain",
    );
    const closedAgainBody = (await closedAgain.json()) as {
      data: { closeIssue: { issue: { state: string; stateReason: string } } };
    };
    expect(closedAgainBody.data.closeIssue.issue.stateReason).toBe("COMPLETED");
    expect(gh.issues.get(closedRow.id)!.updated_at).toBe(closedUpdatedAt);
    expect(gh.issueEvents.all()).toHaveLength(closedEventCount);

    const restClosed = await app.request(`${base}/repos/octocat/hello-world/issues/2`, { headers: headers() });
    expect((await restClosed.json()) as { state: string; state_reason: string }).toMatchObject({
      state: "closed",
      state_reason: "completed",
    });
    expect(getGitHubStore(store).repos.findOneBy("full_name", "octocat/hello-world")!.open_issues_count).toBe(1);

    const reopenResponse = await graphql(
      app,
      `
        mutation Reopen($input: ReopenIssueInput!) {
          reopenIssue(input: $input) {
            clientMutationId
            issue {
              state
              stateReason
            }
          }
        }
      `,
      { input: { issueId: created.data.createIssue.issue.id, clientMutationId: "reopen-1" } },
      "Reopen",
    );
    const reopened = (await reopenResponse.json()) as {
      data: { reopenIssue: { clientMutationId: string; issue: { state: string; stateReason: string } } };
    };
    expect(reopened.data.reopenIssue).toMatchObject({
      clientMutationId: "reopen-1",
      issue: { state: "OPEN", stateReason: "REOPENED" },
    });

    const secondCreate = await graphql(
      app,
      `
        mutation CreateAgain($input: CreateIssueInput!) {
          createIssue(input: $input) {
            issue {
              id
              number
            }
            clientMutationId
          }
        }
      `,
      { input: { repositoryId: fixture.repo.node_id, title: "GraphQL created again", clientMutationId: "create-1" } },
      "CreateAgain",
    );
    const second = (await secondCreate.json()) as {
      data: { createIssue: { issue: { id: string; number: number }; clientMutationId: string } };
    };
    expect(second.data.createIssue.clientMutationId).toBe("create-1");
    expect(second.data.createIssue.issue).toMatchObject({ id: expect.any(String), number: 3 });
    expect(second.data.createIssue.issue.id).not.toBe(created.data.createIssue.issue.id);
  });

  it("creates comments and labels with REST-visible identity and cleanup", async () => {
    const { app } = createTestApp();
    const fixture = await createFixture(app);
    const commentResponse = await graphql(
      app,
      `
        mutation Comment($input: AddCommentInput!) {
          addComment(input: $input) {
            clientMutationId
            comment {
              id
              body
              issue {
                id
              }
            }
          }
        }
      `,
      { input: { subjectId: fixture.issue.node_id, body: "GraphQL mutation comment", clientMutationId: "comment-1" } },
      "Comment",
    );
    const comment = (await commentResponse.json()) as {
      data: { addComment: { clientMutationId: string; comment: { id: string; body: string; issue: { id: string } } } };
    };
    expect(comment.data.addComment).toMatchObject({
      clientMutationId: "comment-1",
      comment: { id: expect.any(String), body: "GraphQL mutation comment", issue: { id: fixture.issue.node_id } },
    });

    const connection = await graphql(
      app,
      `
        query Comments($id: ID!) {
          node(id: $id) {
            ... on Issue {
              comments(first: 10) {
                nodes {
                  id
                  body
                }
              }
            }
          }
        }
      `,
      { id: fixture.issue.node_id },
      "Comments",
    );
    const connectionBody = (await connection.json()) as {
      data: { node: { comments: { nodes: Array<{ id: string; body: string }> } } };
    };
    expect(connectionBody.data.node.comments.nodes.at(-1)?.id).toBe(comment.data.addComment.comment.id);
    const repeatedComment = await graphql(
      app,
      `
        mutation CommentAgain($input: AddCommentInput!) {
          addComment(input: $input) {
            comment {
              id
            }
          }
        }
      `,
      {
        input: {
          subjectId: fixture.issue.node_id,
          body: "GraphQL mutation comment again",
          clientMutationId: "comment-1",
        },
      },
      "CommentAgain",
    );
    const repeatedCommentBody = (await repeatedComment.json()) as {
      data: { addComment: { comment: { id: string } } };
    };
    expect(repeatedCommentBody.data.addComment.comment.id).not.toBe(comment.data.addComment.comment.id);
    const restComments = await app.request(`${base}/repos/octocat/hello-world/issues/1/comments`, {
      headers: headers(),
    });
    expect(((await restComments.json()) as Array<{ node_id: string; body: string }>).at(-1)).toMatchObject({
      node_id: repeatedCommentBody.data.addComment.comment.id,
      body: "GraphQL mutation comment again",
    });

    const labelResponse = await graphql(
      app,
      `
        mutation Label($input: CreateLabelInput!) {
          createLabel(input: $input) {
            clientMutationId
            label {
              id
              name
              description
              color
            }
          }
        }
      `,
      {
        input: {
          repositoryId: fixture.repo.node_id,
          name: "graphql-label",
          color: "5319E7",
          description: "GraphQL label",
          clientMutationId: "label-1",
        },
      },
      "Label",
    );
    const label = (await labelResponse.json()) as {
      data: { createLabel: { clientMutationId: string; label: { id: string; name: string; description: string } } };
    };
    expect(label.data.createLabel).toMatchObject({
      clientMutationId: "label-1",
      label: { name: "graphql-label", description: "GraphQL label" },
    });

    const duplicateLabel = await graphql(
      app,
      `
        mutation Duplicate($input: CreateLabelInput!) {
          createLabel(input: $input) {
            label {
              id
            }
          }
        }
      `,
      { input: { repositoryId: fixture.repo.node_id, name: "graphql-label" } },
      "Duplicate",
    );
    expect((await responseBody(duplicateLabel)).errors?.[0]?.message).toContain("Validation failed");

    const attach = await app.request(`${base}/repos/octocat/hello-world/issues/1/labels`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ labels: ["graphql-label"] }),
    });
    expect(attach.status).toBe(200);
    const deleteResponse = await graphql(
      app,
      `
        mutation Delete($input: DeleteLabelInput!) {
          deleteLabel(input: $input) {
            clientMutationId
            label {
              id
              name
            }
          }
        }
      `,
      { input: { id: label.data.createLabel.label.id, clientMutationId: "label-delete-1" } },
      "Delete",
    );
    const deleted = (await deleteResponse.json()) as {
      data: { deleteLabel: { clientMutationId: string; label: { id: string; name: string } } };
    };
    expect(deleted.data.deleteLabel.label.name).toBe("graphql-label");
    const remaining = await app.request(`${base}/repos/octocat/hello-world/issues/1/labels`, { headers: headers() });
    expect((await remaining.json()) as Array<unknown>).toEqual([]);
    const missingDelete = await graphql(
      app,
      `
        mutation MissingDelete($input: DeleteLabelInput!) {
          deleteLabel(input: $input) {
            label {
              id
            }
          }
        }
      `,
      { input: { id: label.data.createLabel.label.id, clientMutationId: "label-delete-2" } },
      "MissingDelete",
    );
    expect((await responseBody(missingDelete)).errors?.[0]?.message).toContain("Not Found");
  });

  it("enforces installation selection and permissions and rejects invalid creation atomically", async () => {
    const { app, store, tokenMap } = createTestApp();
    const fixture = await createFixture(app);
    const gh = getGitHubStore(store);
    addInstallationToken(store, tokenMap, "app-issue-write", {
      permissions: { issues: "write" },
      repositorySelection: "selected",
      repositoryIds: [gh.repos.findOneBy("full_name", "octocat/hello-world")!.id],
    });
    addInstallationToken(store, tokenMap, "app-issue-read", {
      permissions: { issues: "read" },
      repositorySelection: "selected",
      repositoryIds: [gh.repos.findOneBy("full_name", "octocat/hello-world")!.id],
    });
    const query = `mutation Create($input: CreateIssueInput!) { createIssue(input: $input) { issue { number author { login } } } }`;
    const allowed = await graphql(
      app,
      query,
      { input: { repositoryId: fixture.repo.node_id, title: "App issue" } },
      "Create",
      "app-issue-write",
    );
    expect(((await allowed.json()) as { data: { createIssue: unknown } }).data.createIssue).toMatchObject({
      issue: { author: { login: "app-9[bot]" } },
    });
    const denied = await graphql(
      app,
      query,
      { input: { repositoryId: fixture.repo.node_id, title: "Denied issue" } },
      "Create",
      "app-issue-read",
    );
    expect(denied.status).toBe(403);

    const beforeIssues = gh.issues.all().length;
    const beforeEvents = gh.issueEvents.all().length;
    const invalid = await graphql(app, query, { input: { repositoryId: fixture.repo.node_id, title: "" } }, "Create");
    expect((await responseBody(invalid)).errors?.[0]?.message).toContain("Validation failed");
    expect(gh.issues.all()).toHaveLength(beforeIssues);
    expect(gh.issueEvents.all()).toHaveLength(beforeEvents);
  });

  it("applies App permissions and selection to comments, lifecycle, and labels", async () => {
    const { app, store, tokenMap } = createTestApp();
    const fixture = await createFixture(app);
    const gh = getGitHubStore(store);
    const repo = gh.repos.findOneBy("full_name", "octocat/hello-world")!;
    addInstallationToken(store, tokenMap, "app-read-only", {
      permissions: { issues: "read" },
      repositorySelection: "selected",
      repositoryIds: [repo.id],
    });
    addInstallationToken(store, tokenMap, "app-excluded", {
      permissions: { issues: "write" },
      repositorySelection: "selected",
      repositoryIds: [],
    });
    addInstallationToken(store, tokenMap, "app-write", {
      permissions: { issues: "write" },
      repositorySelection: "selected",
      repositoryIds: [repo.id],
    });

    const commentMutation = `mutation Comment($input: AddCommentInput!) { addComment(input: $input) { comment { author { login } } } }`;
    const commentInput = { input: { subjectId: fixture.issue.node_id, body: "App comment" } };
    expect((await graphql(app, commentMutation, commentInput, "Comment", "app-read-only")).status).toBe(403);
    expect((await graphql(app, commentMutation, commentInput, "Comment", "app-excluded")).status).toBe(403);
    const appComment = await graphql(app, commentMutation, commentInput, "Comment", "app-write");
    const appCommentBody = (await appComment.json()) as {
      data: { addComment: { comment: { author: { login: string } } } };
    };
    expect(appCommentBody.data.addComment.comment.author.login).toBe("app-9[bot]");

    const lifecycleMutation = `mutation Close($input: CloseIssueInput!) { closeIssue(input: $input) { issue { state } } }`;
    const lifecycleInput = { input: { issueId: fixture.issue.node_id } };
    expect((await graphql(app, lifecycleMutation, lifecycleInput, "Close", "app-read-only")).status).toBe(403);
    expect((await graphql(app, lifecycleMutation, lifecycleInput, "Close", "app-excluded")).status).toBe(403);

    const labelMutation = `mutation Label($input: CreateLabelInput!) { createLabel(input: $input) { label { id } } }`;
    const labelInput = { input: { repositoryId: fixture.repo.node_id, name: "app-label" } };
    expect((await graphql(app, labelMutation, labelInput, "Label", "app-read-only")).status).toBe(403);
    expect((await graphql(app, labelMutation, labelInput, "Label", "app-excluded")).status).toBe(403);
    const createdLabel = (await graphql(app, labelMutation, labelInput, "Label", "app-write")).json();
    const labelId = ((await createdLabel) as { data: { createLabel: { label: { id: string } } } }).data.createLabel
      .label.id;
    const deleteMutation = `mutation Delete($input: DeleteLabelInput!) { deleteLabel(input: $input) { label { id } } }`;
    expect((await graphql(app, deleteMutation, { input: { id: labelId } }, "Delete", "app-read-only")).status).toBe(
      403,
    );
    expect((await graphql(app, deleteMutation, { input: { id: labelId } }, "Delete", "app-write")).status).toBe(200);
  });

  it("rejects wrong comment subjects and invalid bodies without mutation", async () => {
    const { app, store } = createTestApp();
    const fixture = await createFixture(app);
    const gh = getGitHubStore(store);
    const beforeComments = gh.comments.all().length;
    const mutation = `mutation Comment($input: AddCommentInput!) { addComment(input: $input) { comment { id } } }`;
    const wrongSubject = await graphql(
      app,
      mutation,
      { input: { subjectId: fixture.repo.node_id, body: "wrong" } },
      "Comment",
    );
    expect((await responseBody(wrongSubject)).errors?.[0]?.message).toContain("Not Found");
    const invalidBody = await graphql(
      app,
      mutation,
      { input: { subjectId: fixture.issue.node_id, body: "" } },
      "Comment",
    );
    expect((await responseBody(invalidBody)).errors?.[0]?.message).toContain("Validation failed");
    expect(gh.comments.all()).toHaveLength(beforeComments);
  });

  it("echoes repeated client IDs without idempotency across every mutation", async () => {
    const { app } = createTestApp();
    const fixture = await createFixture(app);
    const same = "repeated-client-id";
    const created = async (title: string) => {
      const result = await graphql(
        app,
        `
          mutation Create($input: CreateIssueInput!) {
            createIssue(input: $input) {
              clientMutationId
              issue {
                id
              }
            }
          }
        `,
        { input: { repositoryId: fixture.repo.node_id, title, clientMutationId: same } },
        "Create",
      );
      return ((await responseBody(result)) as any).data.createIssue;
    };
    const issueOne = await created("Repeated issue one");
    const issueTwo = await created("Repeated issue two");
    expect(issueOne.clientMutationId).toBe(same);
    expect(issueTwo.clientMutationId).toBe(same);
    expect(issueOne.issue.id).not.toBe(issueTwo.issue.id);

    const addComment = async (issueId: string, body: string) =>
      (
        (await responseBody(
          await graphql(
            app,
            `
              mutation Comment($input: AddCommentInput!) {
                addComment(input: $input) {
                  clientMutationId
                  comment {
                    body
                  }
                }
              }
            `,
            { input: { subjectId: issueId, body, clientMutationId: same } },
            "Comment",
          ),
        )) as any
      ).data.addComment;
    expect((await addComment(fixture.issue.node_id, "repeat comment one")).comment.body).toBe("repeat comment one");
    expect((await addComment(fixture.issue.node_id, "repeat comment two")).comment.body).toBe("repeat comment two");

    const childOne = await created("Repeated child one");
    const childTwo = await created("Repeated child two");
    for (const child of [childOne, childTwo]) {
      const result = (await responseBody(
        await graphql(
          app,
          `
            mutation Sub($input: AddSubIssueInput!) {
              addSubIssue(input: $input) {
                clientMutationId
                subIssue {
                  id
                }
              }
            }
          `,
          { input: { parentIssueId: fixture.issue.node_id, childIssueId: child.issue.id, clientMutationId: same } },
          "Sub",
        ),
      )) as any;
      expect(result.data.addSubIssue.clientMutationId).toBe(same);
    }
    const blockerOne = await created("Repeated blocker one");
    const blockerTwo = await created("Repeated blocker two");
    for (const blocker of [blockerOne, blockerTwo]) {
      const result = (await responseBody(
        await graphql(
          app,
          `
            mutation Block($input: AddBlockedByInput!) {
              addBlockedBy(input: $input) {
                clientMutationId
                blockedBy {
                  id
                }
              }
            }
          `,
          { input: { issueId: fixture.issue.node_id, blockingIssueId: blocker.issue.id, clientMutationId: same } },
          "Block",
        ),
      )) as any;
      expect(result.data.addBlockedBy.clientMutationId).toBe(same);
    }

    const transition = async (name: "closeIssue" | "reopenIssue", issueId: string) => {
      const result = await responseBody(
        await graphql(
          app,
          `mutation Transition($input: ${name === "closeIssue" ? "CloseIssueInput" : "ReopenIssueInput"}!) { ${name}(input: $input) { clientMutationId issue { id } } }`,
          { input: { issueId, clientMutationId: same } },
          "Transition",
        ),
      );
      return (result as any).data[name];
    };
    expect((await transition("closeIssue", issueOne.issue.id)).clientMutationId).toBe(same);
    expect((await transition("reopenIssue", issueOne.issue.id)).clientMutationId).toBe(same);
    expect((await transition("closeIssue", issueTwo.issue.id)).clientMutationId).toBe(same);
    expect((await transition("reopenIssue", issueTwo.issue.id)).clientMutationId).toBe(same);

    const labels: string[] = [];
    for (const name of ["repeat-label-one", "repeat-label-two"]) {
      const response = await graphql(
        app,
        `
          mutation Label($input: CreateLabelInput!) {
            createLabel(input: $input) {
              clientMutationId
              label {
                id
              }
            }
          }
        `,
        { input: { repositoryId: fixture.repo.node_id, name, clientMutationId: same } },
        "Label",
      );
      const result = ((await responseBody(response)) as any).data.createLabel;
      labels.push(result.label.id);
      expect(result.clientMutationId).toBe(same);
    }
    for (const id of labels) {
      const response = await graphql(
        app,
        `
          mutation Delete($input: DeleteLabelInput!) {
            deleteLabel(input: $input) {
              clientMutationId
              label {
                id
              }
            }
          }
        `,
        { input: { id, clientMutationId: same } },
        "Delete",
      );
      const result = ((await responseBody(response)) as any).data.deleteLabel;
      expect(result.clientMutationId).toBe(same);
    }
    for (const issue of [childOne, childTwo]) {
      const response = await graphql(
        app,
        `
          mutation Delete($input: DeleteIssueInput!) {
            deleteIssue(input: $input) {
              clientMutationId
              repository {
                id
              }
            }
          }
        `,
        { input: { issueId: issue.issue.id, clientMutationId: same } },
        "Delete",
      );
      const result = ((await responseBody(response)) as any).data.deleteIssue;
      expect(result.clientMutationId).toBe(same);
    }
  });

  it("deletes an issue through GraphQL and cascades only its records", async () => {
    const { app, store, webhooks } = createTestApp();
    const target = await createIssue(app, "Delete target");
    const unrelated = await createIssue(app, "Keep issue");
    const parent = await createIssue(app, "Delete parent");
    const child = await createIssue(app, "Delete child");
    const blocker = await createIssue(app, "Delete blocker");
    const gh = getGitHubStore(store);
    const repo = gh.repos.findOneBy("full_name", "octocat/hello-world")!;
    const label = gh.labels.insert({
      node_id: "MDU6TGFiZWw5OTk5",
      repo_id: repo.id,
      name: "keep-label",
      color: "ffffff",
      description: null,
      default: false,
    });
    const targetRow = gh.issues.findOneBy("number", target.number)!;
    const unrelatedRow = gh.issues.findOneBy("number", unrelated.number)!;
    gh.issues.update(targetRow.id, { label_ids: [label.id] });
    gh.issues.update(unrelatedRow.id, { label_ids: [label.id] });
    gh.issues.update(unrelatedRow.id, { duplicate_issue_id: target.id });

    const relation = (path: string, body: object) =>
      app.request(`${base}${path}`, { method: "POST", headers: headers(), body: JSON.stringify(body) });
    expect(
      (await relation(`/repos/octocat/hello-world/issues/${parent.number}/sub_issues`, { sub_issue_id: target.id }))
        .status,
    ).toBe(201);
    expect(
      (await relation(`/repos/octocat/hello-world/issues/${target.number}/sub_issues`, { sub_issue_id: child.id }))
        .status,
    ).toBe(201);
    expect(
      (
        await relation(`/repos/octocat/hello-world/issues/${target.number}/dependencies/blocked_by`, {
          issue_id: blocker.id,
        })
      ).status,
    ).toBe(201);
    expect(
      (await relation(`/repos/octocat/hello-world/issues/${target.number}/comments`, { body: "remove me" })).status,
    ).toBe(201);
    expect(
      (await relation(`/repos/octocat/hello-world/issues/${unrelated.number}/comments`, { body: "keep me" })).status,
    ).toBe(201);
    const targetEvents = gh.issueEvents.findBy("issue_number", target.number).map((event) => event.id);
    const unrelatedEvents = gh.issueEvents.findBy("issue_number", unrelated.number).map((event) => event.id);
    const beforeOpen = repo.open_issues_count;
    webhooks.register({
      url: "https://hooks.example/delete",
      events: ["issues"],
      active: true,
      owner: "octocat",
      repo: "hello-world",
    });
    webhooks.clear();

    const response = await graphql(
      app,
      `
        mutation Delete($input: DeleteIssueInput!) {
          deleteIssue(input: $input) {
            clientMutationId
            repository {
              id
              nameWithOwner
            }
          }
        }
      `,
      { input: { issueId: target.node_id, clientMutationId: "delete-1" } },
      "Delete",
    );
    expect(response.status).toBe(200);
    expect(((await responseBody(response)) as any).data.deleteIssue).toEqual({
      clientMutationId: "delete-1",
      repository: { id: repo.node_id, nameWithOwner: "octocat/hello-world" },
    });
    expect(webhooks.getDeliveries()).toEqual([]);
    expect(gh.issues.get(target.id)).toBeUndefined();
    expect(gh.comments.findBy("issue_number", target.number)).toEqual([]);
    expect(gh.issueEvents.findBy("issue_number", target.number)).toEqual([]);
    expect(targetEvents.every((id) => !gh.issueEvents.get(id))).toBe(true);
    expect(unrelatedEvents.every((id) => gh.issueEvents.get(id))).toBe(true);
    expect(
      gh.issueSubIssues.all().some((edge) => edge.parent_issue_id === target.id || edge.child_issue_id === target.id),
    ).toBe(false);
    expect(
      gh.issueDependencies
        .all()
        .some((edge) => edge.blocked_issue_id === target.id || edge.blocking_issue_id === target.id),
    ).toBe(false);
    expect(gh.issues.get(unrelated.id)?.duplicate_issue_id).toBeNull();
    expect(gh.labels.get(label.id)).toBeDefined();
    expect(gh.issues.get(unrelated.id)?.label_ids).toEqual([label.id]);
    expect(gh.repos.get(repo.id)?.open_issues_count).toBe(beforeOpen - 1);

    const missing = await app.request(`${base}/repos/octocat/hello-world/issues/${target.number}`, {
      headers: headers(),
    });
    expect(missing.status).toBe(404);
    const reads = await graphql(
      app,
      `query { repository(owner: "octocat", name: "hello-world") { issue(number: ${target.number}) { id } } }`,
    );
    expect(((await responseBody(reads)) as any).data.repository.issue).toBeNull();
    const unrelatedComment = await app.request(
      `${base}/repos/octocat/hello-world/issues/${unrelated.number}/comments`,
      { headers: headers() },
    );
    expect(unrelatedComment.status).toBe(200);
    expect(((await unrelatedComment.json()) as Array<{ body: string }>).map((comment) => comment.body)).toEqual([
      "keep me",
    ]);

    const second = await graphql(
      app,
      `
        mutation Delete($input: DeleteIssueInput!) {
          deleteIssue(input: $input) {
            clientMutationId
            repository {
              id
            }
          }
        }
      `,
      { input: { issueId: parent.node_id, clientMutationId: "delete-1" } },
      "Delete",
    );
    expect(((await responseBody(second)) as any).data.deleteIssue).toEqual({
      clientMutationId: "delete-1",
      repository: { id: repo.node_id },
    });
    const repeated = await graphql(
      app,
      `
        mutation Delete($input: DeleteIssueInput!) {
          deleteIssue(input: $input) {
            clientMutationId
          }
        }
      `,
      { input: { issueId: parent.node_id, clientMutationId: "delete-1" } },
      "Delete",
    );
    expect((await responseBody(repeated)).errors?.[0]?.message).toContain("Not Found");
  });

  it("rejects deletion before side effects for inaccessible, wrong-type, and read-only requests", async () => {
    const { app, store, tokenMap } = createTestApp();
    const target = await createIssue(app, "Atomic delete");
    const gh = getGitHubStore(store);
    const repo = gh.repos.findOneBy("full_name", "octocat/hello-world")!;
    addInstallationToken(store, tokenMap, "delete-read", {
      permissions: { issues: "read" },
      repositorySelection: "selected",
      repositoryIds: [repo.id],
    });
    addInstallationToken(store, tokenMap, "delete-excluded", {
      permissions: { issues: "write" },
      repositorySelection: "selected",
      repositoryIds: [],
    });
    const mutation = `mutation Delete($input: DeleteIssueInput!) { deleteIssue(input: $input) { clientMutationId } }`;
    const before = gh.issues.all().map((issue) => issue.id);
    for (const token of ["delete-read", "delete-excluded"]) {
      const denied = await graphql(
        app,
        mutation,
        { input: { issueId: target.node_id, clientMutationId: token } },
        "Delete",
        token,
      );
      expect(denied.status).toBe(403);
      expect(gh.issues.all().map((issue) => issue.id)).toEqual(before);
    }
    const wrong = await graphql(app, mutation, { input: { issueId: repo.node_id } }, "Delete");
    expect((await responseBody(wrong)).errors?.[0]?.message).toContain("Not Found");
    const missing = await graphql(app, mutation, { input: { issueId: "MDI6SXNzdWU5OTk5" } }, "Delete");
    expect((await responseBody(missing)).errors?.[0]?.message).toContain("Not Found");
    expect(gh.issues.get(target.id)).toBeDefined();
  });
});
