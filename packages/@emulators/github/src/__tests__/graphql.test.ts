import { describe, expect, it, vi } from "vitest";
import { getGitHubStore } from "../index.js";
import {
  addInstallationToken,
  base,
  createFixture,
  createIssue,
  createTestApp,
  graphql,
  headers,
  responseBody,
} from "./graphql-test-helpers.js";

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
    vi.useFakeTimers({ now: Date.now() });
    try {
      vi.advanceTimersByTime(5);
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
    } finally {
      vi.useRealTimers();
    }

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
