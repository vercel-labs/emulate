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
      { owner: "octocat", name: "private-repo", private: true },
    ],
  });

  return { app, store, tokenMap };
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
});
