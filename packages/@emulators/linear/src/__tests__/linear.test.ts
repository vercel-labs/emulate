import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { Store, WebhookDispatcher, type TokenMap } from "@emulators/core";
import { linearPlugin, seedFromConfig } from "../index.js";

const base = "http://localhost:4012";

function createTestApp() {
  const app = new Hono();
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map();

  linearPlugin.register(app as any, store, webhooks, base, tokenMap);
  linearPlugin.seed?.(store, base);
  seedFromConfig(store, base, {
    api_keys: ["lin_api_seeded"],
    organizations: [{ id: "org-acme", name: "Acme", url_key: "acme" }],
    users: [
      { id: "user-alice", name: "Alice", email: "alice@example.com", organization: "org-acme", admin: true },
      { id: "user-bob", name: "Bob", email: "bob@example.com", organization: "org-acme" },
    ],
    teams: [
      { id: "team-eng", name: "Engineering", key: "ENG", organization: "org-acme" },
      { id: "team-ops", name: "Operations", key: "OPS", organization: "org-acme" },
    ],
    workflow_states: [
      { id: "state-todo", name: "Todo", type: "unstarted", team: "team-eng", position: 1 },
      { id: "state-started", name: "Started", type: "started", team: "team-eng", position: 2 },
      { id: "state-done", name: "Done", type: "completed", team: "team-eng", position: 3 },
    ],
    labels: [
      { id: "label-bug", name: "Bug", team: "team-eng" },
      { id: "label-feature", name: "Feature", team: "team-eng" },
    ],
    projects: [
      { id: "project-api", name: "API", slug_id: "api", team: "team-eng", lead: "user-alice", state: "started" },
    ],
    issues: [
      {
        id: "issue-one",
        title: "First seeded issue",
        team: "team-eng",
        state: "state-todo",
        assignee: "user-alice",
        creator: "user-bob",
        project: "project-api",
        labels: ["label-bug"],
      },
      {
        id: "issue-two",
        title: "Second seeded issue",
        team: "team-eng",
        state: "state-started",
        assignee: "user-bob",
        creator: "user-alice",
        project: "project-api",
        labels: ["label-feature"],
      },
      {
        id: "issue-three",
        title: "Third seeded issue",
        team: "team-eng",
        state: "state-done",
        assignee: "user-alice",
        creator: "user-alice",
        project: "project-api",
        labels: ["label-bug", "label-feature"],
      },
    ],
  });

  return { app, store, webhooks, tokenMap };
}

async function gql(app: Hono, query: string, variables?: Record<string, unknown>, token = "lin_api_seeded") {
  return app.request(`${base}/graphql`, {
    method: "POST",
    headers: { Authorization: token, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
}

describe("Linear GraphQL emulator", () => {
  let app: Hono;

  beforeEach(() => {
    app = createTestApp().app;
  });

  it("accepts the standard GraphQL HTTP body shape", async () => {
    const res = await gql(app, "query GetIssue($id: ID!) { issue(id: $id) { id title } }", { id: "issue-one" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.issue).toEqual({ id: "issue-one", title: "First seeded issue" });
    expect(body.errors).toEqual([]);
  });

  it("supports schema introspection", async () => {
    const res = await gql(app, "{ __schema { queryType { name } types { name } } }");
    const body = (await res.json()) as any;
    expect(body.data.__schema.queryType.name).toBe("Query");
    expect(body.data.__schema.types.some((type: { name: string }) => type.name === "Issue")).toBe(true);
  });

  it("returns organizations", async () => {
    const res = await gql(app, "{ organizations { nodes { id name urlKey } } }");
    const body = (await res.json()) as any;
    expect(body.data.organizations.nodes).toContainEqual({ id: "org-acme", name: "Acme", urlKey: "acme" });
  });

  it("returns one organization by id", async () => {
    const res = await gql(app, '{ organization(id: "org-acme") { id name } }');
    const body = (await res.json()) as any;
    expect(body.data.organization).toEqual({ id: "org-acme", name: "Acme" });
  });

  it("returns users", async () => {
    const res = await gql(app, "{ users { nodes { id name email admin active organization { id } } } }");
    const body = (await res.json()) as any;
    expect(body.data.users.nodes).toContainEqual({
      id: "user-alice",
      name: "Alice",
      email: "alice@example.com",
      admin: true,
      active: true,
      organization: { id: "org-acme" },
    });
  });

  it("returns one user by id", async () => {
    const res = await gql(app, '{ user(id: "user-bob") { id name email } }');
    const body = (await res.json()) as any;
    expect(body.data.user).toEqual({ id: "user-bob", name: "Bob", email: "bob@example.com" });
  });

  it("returns teams", async () => {
    const res = await gql(app, "{ teams { nodes { id key name organization { id } } } }");
    const body = (await res.json()) as any;
    expect(body.data.teams.nodes).toContainEqual({
      id: "team-eng",
      key: "ENG",
      name: "Engineering",
      organization: { id: "org-acme" },
    });
  });

  it("returns one team by id", async () => {
    const res = await gql(app, '{ team(id: "team-ops") { id key name } }');
    const body = (await res.json()) as any;
    expect(body.data.team).toEqual({ id: "team-ops", key: "OPS", name: "Operations" });
  });

  it("returns workflow states", async () => {
    const res = await gql(app, "{ workflowStates { nodes { id name type team { id } } } }");
    const body = (await res.json()) as any;
    expect(body.data.workflowStates.nodes).toContainEqual({
      id: "state-started",
      name: "Started",
      type: "started",
      team: { id: "team-eng" },
    });
  });

  it("returns one workflow state by id", async () => {
    const res = await gql(app, '{ workflowState(id: "state-done") { id name type } }');
    const body = (await res.json()) as any;
    expect(body.data.workflowState).toEqual({ id: "state-done", name: "Done", type: "completed" });
  });

  it("returns labels", async () => {
    const res = await gql(app, "{ labels { nodes { id name team { id } } } }");
    const body = (await res.json()) as any;
    expect(body.data.labels.nodes).toContainEqual({ id: "label-feature", name: "Feature", team: { id: "team-eng" } });
  });

  it("returns one label by id", async () => {
    const res = await gql(app, '{ label(id: "label-bug") { id name issues { nodes { id } } } }');
    const body = (await res.json()) as any;
    expect(body.data.label.name).toBe("Bug");
    expect(body.data.label.issues.nodes.map((issue: { id: string }) => issue.id)).toContain("issue-one");
  });

  it("returns projects", async () => {
    const res = await gql(app, "{ projects { nodes { id name slugId state team { id } lead { id } } } }");
    const body = (await res.json()) as any;
    expect(body.data.projects.nodes).toContainEqual({
      id: "project-api",
      name: "API",
      slugId: "api",
      state: "started",
      team: { id: "team-eng" },
      lead: { id: "user-alice" },
    });
  });

  it("returns one project by id", async () => {
    const res = await gql(app, '{ project(id: "project-api") { id name issues { nodes { id } } } }');
    const body = (await res.json()) as any;
    expect(body.data.project.id).toBe("project-api");
    expect(body.data.project.issues.nodes).toHaveLength(3);
  });

  it("returns issues with relationships", async () => {
    const res = await gql(
      app,
      "{ issues { nodes { id identifier title team { key } state { name } assignee { id } creator { id } project { id } labels { nodes { id } } } } }",
    );
    const body = (await res.json()) as any;
    expect(body.data.issues.nodes).toContainEqual({
      id: "issue-one",
      identifier: "ENG-1",
      title: "First seeded issue",
      team: { key: "ENG" },
      state: { name: "Todo" },
      assignee: { id: "user-alice" },
      creator: { id: "user-bob" },
      project: { id: "project-api" },
      labels: { nodes: [{ id: "label-bug" }] },
    });
  });

  it("returns one issue by id", async () => {
    const res = await gql(app, '{ issue(id: "issue-two") { id identifier title } }');
    const body = (await res.json()) as any;
    expect(body.data.issue).toEqual({ id: "issue-two", identifier: "ENG-2", title: "Second seeded issue" });
  });

  it("returns one issue by identifier", async () => {
    const res = await gql(app, '{ issue(identifier: "ENG-3") { id title } }');
    const body = (await res.json()) as any;
    expect(body.data.issue).toEqual({ id: "issue-three", title: "Third seeded issue" });
  });

  it("returns relay edges and page info", async () => {
    const res = await gql(
      app,
      "{ issues(first: 2) { edges { cursor node { id } } pageInfo { hasNextPage hasPreviousPage startCursor endCursor } } }",
    );
    const body = (await res.json()) as any;
    expect(body.data.issues.edges).toHaveLength(2);
    expect(body.data.issues.edges[0].cursor).toBeTruthy();
    expect(body.data.issues.pageInfo.hasNextPage).toBe(true);
    expect(body.data.issues.pageInfo.hasPreviousPage).toBe(false);
  });

  it("paginates forward with after", async () => {
    const firstRes = await gql(
      app,
      "{ issues(first: 2) { edges { cursor node { id } } pageInfo { endCursor } nodes { id } } }",
    );
    const firstBody = (await firstRes.json()) as any;
    const secondRes = await gql(
      app,
      "query($after: String!) { issues(first: 1, after: $after) { nodes { id } pageInfo { hasPreviousPage } } }",
      {
        after: firstBody.data.issues.edges[0].cursor,
      },
    );
    const secondBody = (await secondRes.json()) as any;
    expect(secondBody.data.issues.nodes[0].id).toBe(firstBody.data.issues.edges[1].node.id);
    expect(secondBody.data.issues.pageInfo.hasPreviousPage).toBe(true);
  });

  it("paginates backward with before and last", async () => {
    const firstRes = await gql(app, "{ issues(first: 3) { edges { cursor node { id } } } }");
    const firstBody = (await firstRes.json()) as any;
    const before = firstBody.data.issues.edges[2].cursor;
    const secondRes = await gql(
      app,
      "query($before: String!) { issues(last: 1, before: $before) { nodes { id } pageInfo { hasNextPage } } }",
      {
        before,
      },
    );
    const secondBody = (await secondRes.json()) as any;
    expect(secondBody.data.issues.nodes[0].id).toBe(firstBody.data.issues.edges[1].node.id);
    expect(secondBody.data.issues.pageInfo.hasNextPage).toBe(true);
  });

  it("validates PAT auth with raw Authorization header", async () => {
    const res = await gql(app, "{ viewer { id } }");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.errors).toEqual([]);
  });

  it("accepts Bearer PAT auth for client compatibility", async () => {
    const res = await gql(app, "{ viewer { id } }", undefined, "Bearer lin_api_seeded");
    expect(res.status).toBe(200);
  });

  it("rejects missing PAT auth", async () => {
    const res = await app.request(`${base}/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "{ viewer { id } }" }),
    });
    const body = (await res.json()) as any;
    expect(res.status).toBe(401);
    expect(body.errors[0].extensions.code).toBe("AUTHENTICATION_ERROR");
  });

  it("rejects unknown PAT auth", async () => {
    const res = await gql(app, "{ viewer { id } }", undefined, "lin_api_unknown");
    const body = (await res.json()) as any;
    expect(res.status).toBe(401);
    expect(body.errors[0].extensions.code).toBe("AUTHENTICATION_ERROR");
  });

  it("returns GraphQL errors with an extensions code", async () => {
    const res = await gql(app, "{ missingField }");
    const body = (await res.json()) as any;
    expect(res.status).toBe(200);
    expect(body.data).toBeNull();
    expect(body.errors[0].extensions.code).toBe("GRAPHQL_ERROR");
  });

  it("rejects non string query bodies with a Linear shaped error", async () => {
    const res = await app.request(`${base}/graphql`, {
      method: "POST",
      headers: { Authorization: "lin_api_seeded", "Content-Type": "application/json" },
      body: JSON.stringify({ query: 1 }),
    });
    const body = (await res.json()) as any;
    expect(res.status).toBe(400);
    expect(body.errors[0].extensions.code).toBe("BAD_REQUEST");
  });
});
