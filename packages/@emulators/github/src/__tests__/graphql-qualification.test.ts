import { describe, expect, it, vi } from "vitest";
import { Hono } from "@emulators/core";
import { getGitHubStore } from "../index.js";
import {
  DEFAULT_GRAPHQL_TOKEN,
  addInstallationToken,
  base,
  createFixture,
  createIssue,
  createTestApp,
  graphql,
  headers,
  responseBody,
} from "./graphql-test-helpers.js";

describe("GitHub GraphQL qualification", () => {
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

  it("propagates non-null resolver errors with HTTP 200 and null data", async () => {
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

  it("runs the explicit user and App permission matrix across every issue-graph family", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { app, store, tokenMap } = createTestApp();
    const fixture = await createFixture(app);
    const parent = await createIssue(app, "Permission parent");
    const child = await createIssue(app, "Permission child");
    const blocker = await createIssue(app, "Permission blocker");
    const deletion = await createIssue(app, "Permission deletion");
    let matrixToken = DEFAULT_GRAPHQL_TOKEN;
    const runMatrixGraphql = (
      matrixApp: Hono,
      query: string,
      variables?: Record<string, unknown>,
      operationName?: string,
    ) => graphql(matrixApp, query, variables, operationName, matrixToken);
    const privateIssueResponse = await app.request(`${base}/repos/octocat/private-repo/issues`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ title: "Private permission issue" }),
    });
    const privateIssue = (await privateIssueResponse.json()) as { node_id: string };
    const privateLabelResponse = await app.request(`${base}/repos/octocat/private-repo/labels`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ name: "private-label" }),
    });
    const privateLabel = (await privateLabelResponse.json()) as { node_id: string };
    const gh = getGitHubStore(store);
    const repo = gh.repos.findOneBy("full_name", "octocat/hello-world")!;
    const privateRepo = gh.repos.findOneBy("full_name", "octocat/private-repo")!;
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
    tokenMap.set("matrix-private-excluded", {
      login: "outsider",
      id: 2,
      scopes: ["issues:write"],
      installation: {
        installationId: 43,
        appId: 9,
        accountId: 2,
        accountType: "User",
        permissions: { issues: "write" },
        repositoryIds: [repo.id],
        repositorySelection: "selected",
      },
    });
    const rows: Array<{
      name: string;
      token: string;
      expected: number;
      run: () => Promise<Response>;
      check?: (body: any) => void;
      denied?: boolean;
    }> = [
      {
        name: "user repository read",
        token: "octocat-token",
        expected: 200,
        run: () =>
          runMatrixGraphql(
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
          runMatrixGraphql(
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
          runMatrixGraphql(
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
          runMatrixGraphql(
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
          runMatrixGraphql(
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
          runMatrixGraphql(
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
          runMatrixGraphql(
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
          runMatrixGraphql(
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
          runMatrixGraphql(
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
          runMatrixGraphql(
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
          runMatrixGraphql(
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
          runMatrixGraphql(
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
          runMatrixGraphql(
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
          runMatrixGraphql(
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
          runMatrixGraphql(
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
          runMatrixGraphql(
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
          runMatrixGraphql(
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
          runMatrixGraphql(
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
          runMatrixGraphql(
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
          runMatrixGraphql(
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
          runMatrixGraphql(
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
          runMatrixGraphql(
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
          runMatrixGraphql(
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
          runMatrixGraphql(
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
      {
        name: "private excluded comment write",
        token: "matrix-private-excluded",
        expected: 403,
        run: () =>
          runMatrixGraphql(
            app,
            `
              mutation PrivateComment($input: AddCommentInput!) {
                addComment(input: $input) {
                  comment {
                    id
                  }
                }
              }
            `,
            { input: { subjectId: privateIssue.node_id, body: "denied" } },
            "PrivateComment",
          ) as Promise<Response>,
      },
      {
        name: "private excluded close write",
        token: "matrix-private-excluded",
        expected: 403,
        run: () =>
          runMatrixGraphql(
            app,
            `
              mutation PrivateClose($input: CloseIssueInput!) {
                closeIssue(input: $input) {
                  issue {
                    id
                  }
                }
              }
            `,
            { input: { issueId: privateIssue.node_id } },
            "PrivateClose",
          ) as Promise<Response>,
      },
      {
        name: "private excluded reopen write",
        token: "matrix-private-excluded",
        expected: 403,
        run: () =>
          runMatrixGraphql(
            app,
            `
              mutation PrivateReopen($input: ReopenIssueInput!) {
                reopenIssue(input: $input) {
                  issue {
                    id
                  }
                }
              }
            `,
            { input: { issueId: privateIssue.node_id } },
            "PrivateReopen",
          ) as Promise<Response>,
      },
      {
        name: "private excluded create label write",
        token: "matrix-private-excluded",
        expected: 403,
        run: () =>
          runMatrixGraphql(
            app,
            `
              mutation PrivateLabel($input: CreateLabelInput!) {
                createLabel(input: $input) {
                  label {
                    id
                  }
                }
              }
            `,
            { input: { repositoryId: privateRepo.node_id, name: "denied" } },
            "PrivateLabel",
          ) as Promise<Response>,
      },
      {
        name: "private excluded delete label write",
        token: "matrix-private-excluded",
        expected: 403,
        run: () =>
          runMatrixGraphql(
            app,
            `
              mutation PrivateDeleteLabel($input: DeleteLabelInput!) {
                deleteLabel(input: $input) {
                  label {
                    id
                  }
                }
              }
            `,
            { input: { id: privateLabel.node_id } },
            "PrivateDeleteLabel",
          ) as Promise<Response>,
      },
      {
        name: "private excluded delete issue write",
        token: "matrix-private-excluded",
        expected: 403,
        run: () =>
          runMatrixGraphql(
            app,
            `
              mutation PrivateDelete($input: DeleteIssueInput!) {
                deleteIssue(input: $input) {
                  repository {
                    id
                  }
                }
              }
            `,
            { input: { issueId: privateIssue.node_id } },
            "PrivateDelete",
          ) as Promise<Response>,
      },
      {
        name: "private excluded subissue write",
        token: "matrix-private-excluded",
        expected: 200,
        denied: true,
        run: () =>
          runMatrixGraphql(
            app,
            `
              mutation PrivateSub($input: AddSubIssueInput!) {
                addSubIssue(input: $input) {
                  subIssue {
                    id
                  }
                }
              }
            `,
            { input: { parentIssueId: privateIssue.node_id, childIssueId: child.node_id } },
            "PrivateSub",
          ) as Promise<Response>,
      },
      {
        name: "private excluded dependency write",
        token: "matrix-private-excluded",
        expected: 200,
        denied: true,
        run: () =>
          runMatrixGraphql(
            app,
            `
              mutation PrivateDependency($input: AddBlockedByInput!) {
                addBlockedBy(input: $input) {
                  blockedBy {
                    id
                  }
                }
              }
            `,
            { input: { issueId: privateIssue.node_id, blockingIssueId: blocker.node_id } },
            "PrivateDependency",
          ) as Promise<Response>,
      },
    ];
    const beforeDenied = () =>
      JSON.stringify({
        issues: gh.issues.all(),
        comments: gh.comments.all(),
        labels: gh.labels.all(),
        subIssues: gh.issueSubIssues.all(),
        dependencies: gh.issueDependencies.all(),
        events: gh.issueEvents.all(),
      });
    for (const row of rows) {
      matrixToken = row.token;
      const before = row.denied || row.expected === 403 ? beforeDenied() : "";
      const response = await row.run();
      expect(response.status, row.name).toBe(row.expected);
      const body = (await responseBody(response)) as any;
      if (row.check) row.check(body);
      if (row.denied) expect(body.errors?.length, row.name).toBeGreaterThan(0);
      if (row.denied || row.expected === 403) expect(beforeDenied(), row.name).toBe(before);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
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
});
