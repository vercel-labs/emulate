import { createHash } from "node:crypto";
import { LinearClient } from "@linear/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono, Store, WebhookDispatcher, authMiddleware, type TokenMap } from "@emulators/core";
import { getLinearStore, linearPlugin, seedFromConfig } from "../index.js";

const base = "http://localhost:4300";

function createTestApp() {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map();
  const app = new Hono();
  app.use("*", authMiddleware(tokenMap));
  linearPlugin.register(app as any, store, webhooks, base, tokenMap);
  linearPlugin.seed?.(store, base);
  return { app, store, tokenMap };
}

async function gql(app: Hono, query: string, variables?: Record<string, unknown>, token = "lin_test_admin") {
  return app.request(`${base}/graphql`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
}

describe("Linear emulator", () => {
  let app: Hono;
  let store: Store;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    const setup = createTestApp();
    app = setup.app;
    store = setup.store;
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("serves viewer, teams, and seeded issues through GraphQL", async () => {
    const res = await gql(
      app,
      `query {
        viewer { email admin }
        teams { nodes { key name states { nodes { name type } } } }
        issues { nodes { identifier title team { key } state { name } comments { nodes { body } } } }
      }`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.errors).toBeUndefined();
    expect(body.data.viewer.email).toBe("admin@linear.local");
    expect(body.data.teams.nodes[0].key).toBe("ENG");
    expect(body.data.issues.nodes[0].identifier).toBe("ENG-1");
    expect(body.data.issues.nodes[0].comments.nodes[0].body).toContain("seeded");
  });

  it("creates issues and comments that can be read back", async () => {
    const team = getLinearStore(store).teams.findOneBy("key", "ENG")!;
    const state = getLinearStore(store).workflowStates.findOneBy("name", "Todo")!;

    const createIssue = await gql(
      app,
      `mutation CreateIssue($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success
          issue { id identifier title state { name } }
        }
      }`,
      {
        input: {
          teamId: team.linear_id,
          stateId: state.linear_id,
          title: "Write Linear tests",
          description: "Cover the local GraphQL flow.",
          priority: 2,
        },
      },
    );
    expect(createIssue.status).toBe(200);
    const issueBody = (await createIssue.json()) as any;
    expect(issueBody.errors).toBeUndefined();
    expect(issueBody.data.issueCreate.issue.identifier).toBe("ENG-2");

    const issueId = issueBody.data.issueCreate.issue.id;
    const createComment = await gql(
      app,
      `mutation CreateComment($input: CommentCreateInput!) {
        commentCreate(input: $input) {
          success
          comment { id body issue { identifier } }
        }
      }`,
      { input: { issueId, body: "Done locally." } },
    );
    const commentBody = (await createComment.json()) as any;
    expect(commentBody.errors).toBeUndefined();
    expect(commentBody.data.commentCreate.comment.issue.identifier).toBe("ENG-2");

    const readBack = await gql(app, `query { issue(id: "${issueId}") { title comments { nodes { body } } } }`);
    const readBody = (await readBack.json()) as any;
    expect(readBody.data.issue.comments.nodes[0].body).toBe("Done locally.");
  });

  it("rejects issue creation with an unknown workflow state", async () => {
    const team = getLinearStore(store).teams.findOneBy("key", "ENG")!;

    const res = await gql(
      app,
      `mutation CreateIssue($input: IssueCreateInput!) {
        issueCreate(input: $input) { issue { identifier state { name } } }
      }`,
      { input: { teamId: team.linear_id, stateId: "missing-state", title: "Bad state" } },
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.errors[0].message).toContain("Workflow state not found: missing-state");
    expect(getLinearStore(store).issues.findOneBy("title", "Bad state")).toBeUndefined();
  });

  it("rejects issue mutations with unknown relation IDs", async () => {
    const linearStore = getLinearStore(store);
    const team = linearStore.teams.findOneBy("key", "ENG")!;
    const issue = linearStore.issues.findOneBy("identifier", "ENG-1")!;
    const originalAssignee = issue.assignee_id;

    const createWithUnknownLabel = await gql(
      app,
      `mutation CreateIssue($input: IssueCreateInput!) {
        issueCreate(input: $input) { issue { identifier } }
      }`,
      { input: { teamId: team.linear_id, title: "Bad label", labelIds: ["missing-label"] } },
    );
    expect(createWithUnknownLabel.status).toBe(400);
    const createBody = (await createWithUnknownLabel.json()) as any;
    expect(createBody.errors[0].message).toContain("Issue label not found for team: missing-label");
    expect(linearStore.issues.findOneBy("title", "Bad label")).toBeUndefined();

    const updateWithUnknownAssignee = await gql(
      app,
      `mutation UpdateIssue($input: IssueUpdateInput!) {
        issueUpdate(input: $input) { issue { id } }
      }`,
      { input: { id: issue.linear_id, assigneeId: "missing-user" } },
    );
    expect(updateWithUnknownAssignee.status).toBe(400);
    const updateBody = (await updateWithUnknownAssignee.json()) as any;
    expect(updateBody.errors[0].message).toContain("User not found for assigneeId: missing-user");
    expect(linearStore.issues.findOneBy("linear_id", issue.linear_id)?.assignee_id).toBe(originalAssignee);
  });

  it("rejects adding an issue label from another team", async () => {
    seedFromConfig(store, base, {
      teams: [{ key: "SEC", name: "Security" }],
      labels: [{ name: "Security", color: "#111827", team: "SEC" }],
    });
    const linearStore = getLinearStore(store);
    const issue = linearStore.issues.findOneBy("identifier", "ENG-1")!;
    const securityLabel = linearStore.issueLabels.findOneBy("name", "Security")!;
    const beforeLabelIds = [...issue.label_ids];

    const res = await gql(
      app,
      `mutation AddLabel($id: String!, $labelId: String!) {
        issueAddLabel(id: $id, labelId: $labelId) { issue { labels { nodes { name } } } }
      }`,
      { id: issue.linear_id, labelId: securityLabel.linear_id },
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.errors[0].message).toContain("Issue label not found for team");
    expect(linearStore.issues.findOneBy("linear_id", issue.linear_id)?.label_ids).toEqual(beforeLabelIds);
  });

  it("deletes issue comments and agent sessions with the issue", async () => {
    const team = getLinearStore(store).teams.findOneBy("key", "ENG")!;
    const createIssue = await gql(
      app,
      `mutation CreateIssue($input: IssueCreateInput!) {
        issueCreate(input: $input) { issue { id } }
      }`,
      { input: { teamId: team.linear_id, title: "Delete child records" } },
    );
    const issueBody = (await createIssue.json()) as any;
    const issueId = issueBody.data.issueCreate.issue.id;

    await gql(
      app,
      `mutation CreateComment($input: CommentCreateInput!) {
        commentCreate(input: $input) { comment { id } }
      }`,
      { input: { issueId, body: "Remove me with the issue." } },
    );
    const sessionRes = await gql(
      app,
      `mutation CreateSession($input: AgentSessionCreateOnIssue!) {
        agentSessionCreateOnIssue(input: $input) { agentSession { id } }
      }`,
      { input: { issueId, plan: "Clean up child records" } },
    );
    const sessionBody = (await sessionRes.json()) as any;
    const sessionId = sessionBody.data.agentSessionCreateOnIssue.agentSession.id;

    await gql(
      app,
      `mutation CreateActivity($input: AgentActivityCreateInput!) {
        agentActivityCreate(input: $input) { agentActivity { id } }
      }`,
      { input: { sessionId, type: "response", body: "Done." } },
    );

    const deleteIssue = await gql(
      app,
      `mutation DeleteIssue($id: String!) {
        issueDelete(id: $id) { success }
      }`,
      { id: issueId },
    );
    expect(deleteIssue.status).toBe(200);
    const deleteBody = (await deleteIssue.json()) as any;
    expect(deleteBody.errors).toBeUndefined();

    const linearStore = getLinearStore(store);
    expect(linearStore.comments.findBy("issue_id", issueId)).toEqual([]);
    expect(linearStore.agentSessions.findBy("issue_id", issueId)).toEqual([]);
    expect(linearStore.agentActivities.findBy("session_id", sessionId)).toEqual([]);
  });

  it("deletes comment-scoped agent sessions with the comment", async () => {
    const issue = getLinearStore(store).issues.findOneBy("identifier", "ENG-1")!;
    const commentRes = await gql(
      app,
      `mutation CreateComment($input: CommentCreateInput!) {
        commentCreate(input: $input) { comment { id } }
      }`,
      { input: { issueId: issue.linear_id, body: "Start an agent session." } },
    );
    const commentBody = (await commentRes.json()) as any;
    const commentId = commentBody.data.commentCreate.comment.id;

    const sessionRes = await gql(
      app,
      `mutation CreateSession($input: AgentSessionCreateOnComment!) {
        agentSessionCreateOnComment(input: $input) { agentSession { id } }
      }`,
      { input: { commentId, plan: "Handle the comment." } },
    );
    const sessionBody = (await sessionRes.json()) as any;
    const sessionId = sessionBody.data.agentSessionCreateOnComment.agentSession.id;

    await gql(
      app,
      `mutation CreateActivity($input: AgentActivityCreateInput!) {
        agentActivityCreate(input: $input) { agentActivity { id } }
      }`,
      { input: { sessionId, type: "response", body: "Done." } },
    );

    const deleteComment = await gql(
      app,
      `mutation DeleteComment($id: String!) {
        commentDelete(id: $id) { success }
      }`,
      { id: commentId },
    );
    expect(deleteComment.status).toBe(200);
    const deleteBody = (await deleteComment.json()) as any;
    expect(deleteBody.errors).toBeUndefined();

    const linearStore = getLinearStore(store);
    expect(linearStore.agentSessions.findBy("comment_id", commentId)).toEqual([]);
    expect(linearStore.agentActivities.findBy("session_id", sessionId)).toEqual([]);

    const readSessions = await gql(app, `{ agentSessions { nodes { id comment { id } } } }`);
    const readBody = (await readSessions.json()) as any;
    expect(readBody.errors).toBeUndefined();
  });

  it("clears stale issue lifecycle timestamps when moving between workflow states", async () => {
    const linearStore = getLinearStore(store);
    const team = linearStore.teams.findOneBy("key", "ENG")!;
    const todo = linearStore.workflowStates.findOneBy("name", "Todo")!;
    const done = linearStore.workflowStates.findOneBy("name", "Done")!;

    const createIssue = await gql(
      app,
      `mutation CreateIssue($input: IssueCreateInput!) {
        issueCreate(input: $input) { issue { id completedAt canceledAt startedAt } }
      }`,
      { input: { teamId: team.linear_id, stateId: todo.linear_id, title: "Move lifecycle states" } },
    );
    const issueBody = (await createIssue.json()) as any;
    const issueId = issueBody.data.issueCreate.issue.id;

    const complete = await gql(
      app,
      `mutation UpdateIssue($input: IssueUpdateInput!) {
        issueUpdate(input: $input) { issue { completedAt canceledAt startedAt state { name } } }
      }`,
      { input: { id: issueId, stateId: done.linear_id } },
    );
    const completeBody = (await complete.json()) as any;
    expect(completeBody.data.issueUpdate.issue.state.name).toBe("Done");
    expect(completeBody.data.issueUpdate.issue.completedAt).toBeTruthy();

    const reopen = await gql(
      app,
      `mutation UpdateIssue($input: IssueUpdateInput!) {
        issueUpdate(input: $input) { issue { completedAt canceledAt startedAt state { name } } }
      }`,
      { input: { id: issueId, stateId: todo.linear_id } },
    );
    const reopenBody = (await reopen.json()) as any;
    expect(reopenBody.data.issueUpdate.issue.state.name).toBe("Todo");
    expect(reopenBody.data.issueUpdate.issue.completedAt).toBeNull();
    expect(reopenBody.data.issueUpdate.issue.canceledAt).toBeNull();
    expect(reopenBody.data.issueUpdate.issue.startedAt).toBeNull();
  });

  it("honors issue filter or clauses", async () => {
    const team = getLinearStore(store).teams.findOneBy("key", "ENG")!;
    await gql(
      app,
      `mutation CreateIssue($input: IssueCreateInput!) {
        issueCreate(input: $input) { issue { identifier } }
      }`,
      { input: { teamId: team.linear_id, title: "Review Linear filter logic" } },
    );

    const missing = await gql(
      app,
      `query Issues($filter: IssueFilter) {
        issues(filter: $filter) { nodes { identifier title } }
      }`,
      { filter: { or: [{ title: { eq: "Definitely missing" } }] } },
    );
    expect(missing.status).toBe(200);
    const missingBody = (await missing.json()) as any;
    expect(missingBody.errors).toBeUndefined();
    expect(missingBody.data.issues.nodes).toEqual([]);

    const matching = await gql(
      app,
      `query Issues($filter: IssueFilter) {
        issues(filter: $filter) { nodes { identifier title } }
      }`,
      {
        filter: {
          or: [{ title: { eq: "Definitely missing" } }, { title: { eq: "Review Linear filter logic" } }],
        },
      },
    );
    const matchingBody = (await matching.json()) as any;
    expect(matchingBody.errors).toBeUndefined();
    expect(matchingBody.data.issues.nodes).toEqual([{ identifier: "ENG-2", title: "Review Linear filter logic" }]);
  });

  it("applies negative issue filters across aliases", async () => {
    const res = await gql(
      app,
      `query Issues($teamFilter: IssueFilter, $labelFilter: IssueFilter) {
        byTeam: issues(filter: $teamFilter) { nodes { identifier } }
        byLabel: issues(filter: $labelFilter) { nodes { identifier } }
      }`,
      {
        teamFilter: { team: { neq: "ENG" } },
        labelFilter: { labels: { neq: "Bug" } },
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.errors).toBeUndefined();
    expect(body.data.byTeam.nodes).toEqual([]);
    expect(body.data.byLabel.nodes).toEqual([]);
  });

  it("supports OAuth authorization code exchange with PKCE", async () => {
    seedFromConfig(store, base, {
      oauth_apps: [
        {
          client_id: "pkce-client",
          client_secret: "pkce-secret",
          name: "PKCE App",
          redirect_uris: ["http://localhost:3000/callback"],
          scopes: ["read", "write"],
        },
      ],
    });
    const user = getLinearStore(store).users.findOneBy("email", "admin@linear.local")!;
    const verifier = "linear-pkce-verifier";
    const challenge = createHash("sha256").update(verifier).digest("base64url");

    const codeRes = await app.request(`${base}/oauth/authorize/callback`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        user_ref: user.linear_id,
        actor: "user",
        redirect_uri: "http://localhost:3000/callback",
        scope: "read write",
        state: "state-1",
        client_id: "pkce-client",
        code_challenge: challenge,
        code_challenge_method: "S256",
      }).toString(),
    });
    expect(codeRes.status).toBe(302);
    const location = new URL(codeRes.headers.get("location") ?? "");
    expect(location.searchParams.get("state")).toBe("state-1");

    const tokenRes = await app.request(`${base}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: location.searchParams.get("code") ?? "",
        client_id: "pkce-client",
        client_secret: "pkce-secret",
        redirect_uri: "http://localhost:3000/callback",
        code_verifier: verifier,
      }).toString(),
    });
    expect(tokenRes.status).toBe(200);
    const tokenBody = (await tokenRes.json()) as any;
    expect(tokenBody.access_token).toMatch(/^lin_/);
    expect(tokenBody.refresh_token).toMatch(/^lin_refresh_/);
    expect(tokenBody.scope).toBe("read write");

    const accessGraphql = await app.request(`${base}/graphql`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenBody.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: "{ viewer { email } }" }),
    });
    expect(accessGraphql.status).toBe(200);

    const refreshGraphql = await app.request(`${base}/graphql`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenBody.refresh_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: "{ viewer { email } }" }),
    });
    expect(refreshGraphql.status).toBe(401);
    const refreshBody = (await refreshGraphql.json()) as { message: string };
    expect(refreshBody.message).toContain("refresh tokens");
  });

  it("enforces the OAuth app actor configuration", async () => {
    seedFromConfig(store, base, {
      oauth_apps: [
        {
          client_id: "user-actor-client",
          client_secret: "user-actor-secret",
          name: "User Actor App",
          redirect_uris: ["http://localhost:3000/callback"],
          scopes: ["read"],
          actor: "user",
        },
        {
          client_id: "app-actor-client",
          client_secret: "app-actor-secret",
          name: "App Actor App",
          redirect_uris: ["http://localhost:3000/callback"],
          scopes: ["read"],
          actor: "app",
        },
      ],
    });

    const userActorGrant = await app.request(`${base}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: "user-actor-client",
        client_secret: "user-actor-secret",
        scope: "read",
      }).toString(),
    });
    expect(userActorGrant.status).toBe(400);
    const userActorBody = (await userActorGrant.json()) as any;
    expect(userActorBody.error).toBe("unauthorized_client");

    const appActorAuthorize = await app.request(
      `${base}/oauth/authorize?client_id=app-actor-client&redirect_uri=${encodeURIComponent("http://localhost:3000/callback")}&response_type=code&scope=read`,
    );
    expect(appActorAuthorize.status).toBe(200);
    expect(await appActorAuthorize.text()).toContain("Install App Actor App");

    const actorMismatch = await app.request(
      `${base}/oauth/authorize?client_id=app-actor-client&redirect_uri=${encodeURIComponent("http://localhost:3000/callback")}&response_type=code&scope=read&actor=user`,
    );
    expect(actorMismatch.status).toBe(400);
    expect(await actorMismatch.text()).toContain("Invalid actor");
  });

  it("accepts OAuth client credentials from a Basic header with colons in the secret", async () => {
    seedFromConfig(store, base, {
      oauth_apps: [
        {
          client_id: "basic-client",
          client_secret: "secret:with:colons",
          name: "Basic App",
          redirect_uris: ["http://localhost:3000/callback"],
          scopes: ["read"],
          actor: "app",
        },
      ],
    });

    const credentials = Buffer.from("basic-client:secret:with:colons", "utf8").toString("base64");
    const res = await app.request(`${base}/oauth/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        scope: "read",
      }).toString(),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.access_token).toMatch(/^lin_/);
    expect(body.scope).toBe("read");
  });

  it("lets seed config override the default test token", async () => {
    seedFromConfig(store, base, {
      strict_scopes: true,
      users: [
        {
          email: "admin@example.com",
          name: "Config Admin",
          admin: true,
        },
      ],
      tokens: [
        {
          token: "lin_test_admin",
          user: "admin@example.com",
          scopes: ["read"],
        },
      ],
    });

    const viewer = await gql(app, "{ viewer { email name } }");
    expect(viewer.status).toBe(200);
    const viewerBody = (await viewer.json()) as any;
    expect(viewerBody.errors).toBeUndefined();
    expect(viewerBody.data.viewer).toEqual({ email: "admin@example.com", name: "Config Admin" });

    const adminOnly = await gql(
      app,
      `mutation($input: WebhookCreateInput!) {
        webhookCreate(input: $input) { success webhook { id } }
      }`,
      { input: { url: "http://127.0.0.1:1/linear" } },
    );
    expect(adminOnly.status).toBe(400);
    const adminBody = (await adminOnly.json()) as any;
    expect(adminBody.errors[0].message).toContain("admin");
  });

  it("lets seed config override the default OAuth app", async () => {
    seedFromConfig(store, base, {
      oauth_apps: [
        {
          client_id: "lin_example_client_id",
          client_secret: "configured-secret",
          name: "Configured App",
          redirect_uris: ["http://localhost:3000/callback"],
          scopes: ["read"],
          actor: "app",
        },
      ],
    });
    const oauthApp = getLinearStore(store).oauthApps.findOneBy("client_id", "lin_example_client_id")!;
    expect(oauthApp.name).toBe("Configured App");
    expect(oauthApp.scopes).toEqual(["read"]);
    expect(oauthApp.actor).toBe("app");
    expect(oauthApp.app_user_id).toBeTruthy();

    const invalidScope = await app.request(
      `${base}/oauth/authorize?client_id=lin_example_client_id&redirect_uri=${encodeURIComponent("http://localhost:3000/callback")}&response_type=code&scope=admin`,
    );
    expect(invalidScope.status).toBe(400);
    expect(await invalidScope.text()).toContain("Invalid scope");

    const oldSecret = await app.request(`${base}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: "lin_example_client_id",
        client_secret: "example_client_secret",
        scope: "read",
      }).toString(),
    });
    expect(oldSecret.status).toBe(400);

    const clientCredentials = await app.request(`${base}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: "lin_example_client_id",
        client_secret: "configured-secret",
        scope: "read",
      }).toString(),
    });
    expect(clientCredentials.status).toBe(200);
    const tokenBody = (await clientCredentials.json()) as any;
    expect(tokenBody.access_token).toMatch(/^lin_/);
    expect(tokenBody.scope).toBe("read");
  });

  it("requires read scope for queries in strict mode", async () => {
    seedFromConfig(store, base, {
      strict_scopes: true,
      tokens: [
        {
          token: "lin_no_scopes",
          user: "admin@linear.local",
          scopes: [],
        },
        {
          token: "lin_read_only",
          user: "admin@linear.local",
          scopes: ["read"],
        },
      ],
    });

    const missingRead = await gql(
      app,
      "{ viewer { email } issues { nodes { identifier } } }",
      undefined,
      "lin_no_scopes",
    );
    expect(missingRead.status).toBe(400);
    const missingBody = (await missingRead.json()) as any;
    expect(missingBody.errors[0].message).toContain("read");

    const read = await gql(app, "{ viewer { email } issues { nodes { identifier } } }", undefined, "lin_read_only");
    expect(read.status).toBe(200);
    const readBody = (await read.json()) as any;
    expect(readBody.errors).toBeUndefined();
    expect(readBody.data.viewer.email).toBe("admin@linear.local");
  });

  it("does not let write scope satisfy admin in strict mode", async () => {
    seedFromConfig(store, base, {
      strict_scopes: true,
      tokens: [
        {
          token: "lin_write_only",
          user: "admin@linear.local",
          scopes: ["write"],
        },
      ],
    });

    const res = await gql(
      app,
      `mutation($input: WebhookCreateInput!) {
        webhookCreate(input: $input) { success webhook { id } }
      }`,
      { input: { url: "http://127.0.0.1:1/linear" } },
      "lin_write_only",
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.errors[0].message).toContain("admin");
  });

  it("rejects OAuth scopes that are not registered on the app", async () => {
    seedFromConfig(store, base, {
      oauth_apps: [
        {
          client_id: "read-only-client",
          client_secret: "read-only-secret",
          name: "Read Only App",
          redirect_uris: ["http://localhost:3000/callback"],
          scopes: ["read"],
          actor: "app",
        },
      ],
    });
    const user = getLinearStore(store).users.findOneBy("email", "admin@linear.local")!;

    const codeRes = await app.request(`${base}/oauth/authorize/callback`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        user_ref: user.linear_id,
        actor: "app",
        redirect_uri: "http://localhost:3000/callback",
        scope: "admin",
        state: "state-1",
        client_id: "read-only-client",
      }).toString(),
    });
    expect(codeRes.status).toBe(400);
    expect(await codeRes.text()).toContain("Invalid scope");

    const clientCredentialsRes = await app.request(`${base}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: "read-only-client",
        client_secret: "read-only-secret",
        scope: "admin",
      }).toString(),
    });
    expect(clientCredentialsRes.status).toBe(400);
    const tokenBody = (await clientCredentialsRes.json()) as any;
    expect(tokenBody.error).toBe("invalid_scope");
  });

  it("binds refresh tokens to the OAuth client that received them", async () => {
    seedFromConfig(store, base, {
      oauth_apps: [
        {
          client_id: "client-a",
          client_secret: "secret-a",
          name: "Client A",
          redirect_uris: ["http://localhost:3000/callback"],
          scopes: ["read"],
        },
        {
          client_id: "client-b",
          client_secret: "secret-b",
          name: "Client B",
          redirect_uris: ["http://localhost:3000/callback"],
          scopes: ["read"],
        },
      ],
    });
    const user = getLinearStore(store).users.findOneBy("email", "admin@linear.local")!;

    const codeRes = await app.request(`${base}/oauth/authorize/callback`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        user_ref: user.linear_id,
        actor: "user",
        redirect_uri: "http://localhost:3000/callback",
        scope: "read",
        client_id: "client-a",
      }).toString(),
    });
    const location = new URL(codeRes.headers.get("location") ?? "");

    const tokenRes = await app.request(`${base}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: location.searchParams.get("code") ?? "",
        client_id: "client-a",
        client_secret: "secret-a",
        redirect_uri: "http://localhost:3000/callback",
      }).toString(),
    });
    expect(tokenRes.status).toBe(200);
    const issued = (await tokenRes.json()) as any;

    const wrongClient = await app.request(`${base}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: issued.refresh_token,
        client_id: "client-b",
        client_secret: "secret-b",
      }).toString(),
    });
    expect(wrongClient.status).toBe(400);
    const wrongClientBody = (await wrongClient.json()) as any;
    expect(wrongClientBody.error).toBe("invalid_grant");

    const rightClient = await app.request(`${base}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: issued.refresh_token,
        client_id: "client-a",
        client_secret: "secret-a",
      }).toString(),
    });
    expect(rightClient.status).toBe(200);
  });

  it("stores webhook deliveries for issue mutations", async () => {
    seedFromConfig(store, base, {
      webhooks: [
        {
          label: "Local receiver",
          url: "http://127.0.0.1:1/linear",
          resource_types: ["Issue"],
          all_public_teams: true,
          secret: "local-secret",
        },
      ],
    });
    const team = getLinearStore(store).teams.findOneBy("key", "ENG")!;

    const res = await gql(
      app,
      `mutation($input: IssueCreateInput!) {
        issueCreate(input: $input) { success issue { identifier } }
      }`,
      { input: { teamId: team.linear_id, title: "Trigger webhook" } },
    );
    expect(res.status).toBe(200);
    const deliveries = getLinearStore(store).webhookDeliveries.all();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].event).toBe("Issue");
    expect(deliveries[0].action).toBe("create");
    expect(deliveries[0].headers["Linear-Signature"]).toBeDefined();
  });

  it("stores webhook deliveries for issue label mutations", async () => {
    seedFromConfig(store, base, {
      webhooks: [
        {
          label: "Issue receiver",
          url: "http://127.0.0.1:1/linear",
          resource_types: ["Issue"],
          all_public_teams: true,
        },
      ],
    });
    const linearStore = getLinearStore(store);
    const issue = linearStore.issues.findOneBy("identifier", "ENG-1")!;
    const bug = linearStore.issueLabels.findOneBy("name", "Bug")!;
    const feature = linearStore.issueLabels.findOneBy("name", "Feature")!;

    const addLabel = await gql(
      app,
      `mutation AddLabel($id: String!, $labelId: String!) {
        issueAddLabel(id: $id, labelId: $labelId) { issue { identifier labels { nodes { name } } } }
      }`,
      { id: issue.linear_id, labelId: feature.linear_id },
    );
    expect(addLabel.status).toBe(200);
    const addBody = (await addLabel.json()) as any;
    expect(addBody.errors).toBeUndefined();

    const removeLabel = await gql(
      app,
      `mutation RemoveLabel($id: String!, $labelId: String!) {
        issueRemoveLabel(id: $id, labelId: $labelId) { issue { identifier labels { nodes { name } } } }
      }`,
      { id: issue.linear_id, labelId: feature.linear_id },
    );
    expect(removeLabel.status).toBe(200);
    const removeBody = (await removeLabel.json()) as any;
    expect(removeBody.errors).toBeUndefined();

    const deliveries = linearStore.webhookDeliveries.all();
    expect(deliveries).toHaveLength(2);
    expect(deliveries.map((delivery) => delivery.event)).toEqual(["Issue", "Issue"]);
    expect(deliveries.map((delivery) => delivery.action)).toEqual(["update", "update"]);
    expect((deliveries[0].payload as any).updatedFrom.labels).toEqual([{ id: bug.linear_id, name: "Bug" }]);
  });

  it("does not send all public team webhooks for private team events", async () => {
    seedFromConfig(store, base, {
      teams: [{ key: "SEC", name: "Security", private: true }],
      webhooks: [
        {
          label: "Public teams only",
          url: "http://127.0.0.1:1/linear",
          resource_types: ["Issue"],
          all_public_teams: true,
        },
      ],
    });
    const team = getLinearStore(store).teams.findOneBy("key", "SEC")!;

    const res = await gql(
      app,
      `mutation($input: IssueCreateInput!) {
        issueCreate(input: $input) { success issue { identifier } }
      }`,
      { input: { teamId: team.linear_id, title: "Private team webhook" } },
    );
    expect(res.status).toBe(200);
    expect(getLinearStore(store).webhookDeliveries.all()).toHaveLength(0);
  });

  it("renders the shared inspector", async () => {
    const res = await app.request(`${base}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Linear Inspector");
    expect(html).toContain("ENG-1");
  });

  it("works through the official Linear SDK endpoint override", async () => {
    seedFromConfig(store, base, {
      tokens: [
        {
          token: "lin_oauth_sdk",
          type: "oauth_access",
          user: "admin@linear.local",
          scopes: ["read", "write", "issues:create", "comments:create"],
        },
      ],
    });
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith(`${base}/graphql`)) {
        return app.request(url, {
          method: init?.method,
          headers: init?.headers,
          body: init?.body,
        });
      }
      return originalFetch(input, init);
    };

    const client = new LinearClient({
      apiKey: "lin_test_admin",
      apiUrl: `${base}/graphql`,
    });

    const viewer = await client.viewer;
    expect(viewer.email).toBe("admin@linear.local");
    expect(viewer.isMe).toBe(true);

    const oauthClient = new LinearClient({
      accessToken: "lin_oauth_sdk",
      apiUrl: `${base}/graphql`,
    });
    const oauthViewer = await oauthClient.viewer;
    expect(oauthViewer.email).toBe("admin@linear.local");

    const teams = await client.teams();
    expect(teams.nodes[0].key).toBe("ENG");

    const teamId = teams.nodes[0].id;
    const createIssue = await client.createIssue({ teamId, title: "Created from SDK" });
    expect(createIssue.success).toBe(true);

    expect(createIssue.issueId).toBeTruthy();
    const issueId = createIssue.issueId!;
    expect(getLinearStore(store).issues.findOneBy("linear_id", issueId)?.identifier).toBe("ENG-2");
    const updateIssue = await client.updateIssue(issueId, { title: "Updated from SDK", priority: 1 });
    expect(updateIssue.success).toBe(true);
    expect(updateIssue.issueId).toBe(issueId);
    expect(getLinearStore(store).issues.findOneBy("linear_id", issueId)?.title).toBe("Updated from SDK");
    expect(getLinearStore(store).issues.findOneBy("linear_id", issueId)?.priority).toBe(1);

    const createAgentSession = await client.agentSessionCreateOnIssue({ issueId });
    expect(createAgentSession.success).toBe(true);
    expect(createAgentSession.agentSessionId).toBeTruthy();

    const createLabel = await client.createIssueLabel({ teamId, name: "SDK Label", color: "#0f766e" });
    expect(createLabel.success).toBe(true);
    const labelId = createLabel.issueLabelId!;
    const updateLabel = await client.updateIssueLabel(labelId, { name: "SDK Label Updated" });
    expect(updateLabel.success).toBe(true);
    expect(getLinearStore(store).issueLabels.findOneBy("linear_id", labelId)?.name).toBe("SDK Label Updated");
    const deleteLabel = await client.deleteIssueLabel(labelId);
    expect(deleteLabel.success).toBe(true);
    expect(deleteLabel.entityId).toBe(labelId);

    const firstIssuePage = await client.client.rawRequest<
      {
        issues: {
          nodes: Array<{ id: string; identifier: string }>;
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      },
      { first: number }
    >(
      `query($first: Int) {
        issues(first: $first) {
          nodes { id identifier }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { first: 1 },
    );
    expect(firstIssuePage.data?.issues.nodes[0].identifier).toBe("ENG-1");
    expect(firstIssuePage.data?.issues.pageInfo.hasNextPage).toBe(true);

    const nextIssuePage = await client.client.rawRequest<
      { issues: { nodes: Array<{ id: string; identifier: string }>; pageInfo: { hasNextPage: boolean } } },
      { first: number; after: string }
    >(
      `query($first: Int, $after: String) {
        issues(first: $first, after: $after) {
          nodes { id identifier }
          pageInfo { hasNextPage }
        }
      }`,
      { first: 1, after: firstIssuePage.data!.issues.pageInfo.endCursor! },
    );
    expect(nextIssuePage.data?.issues.nodes[0].identifier).toBe("ENG-2");
    expect(nextIssuePage.data?.issues.pageInfo.hasNextPage).toBe(false);

    const createComment = await client.createComment({ issueId, body: "Commented from SDK" });
    expect(createComment.success).toBe(true);
    expect(getLinearStore(store).comments.findOneBy("linear_id", createComment.commentId!)?.body).toBe(
      "Commented from SDK",
    );
    const commentId = createComment.commentId!;
    const updateComment = await client.updateComment(commentId, { body: "Updated comment from SDK" });
    expect(updateComment.success).toBe(true);
    expect(getLinearStore(store).comments.findOneBy("linear_id", commentId)?.body).toBe("Updated comment from SDK");
    const deleteComment = await client.deleteComment(commentId);
    expect(deleteComment.success).toBe(true);
    expect(deleteComment.entityId).toBe(commentId);

    const archiveIssue = await client.archiveIssue(issueId);
    expect(archiveIssue.success).toBe(true);
    expect(archiveIssue.entityId).toBe(issueId);
    expect(getLinearStore(store).issues.findOneBy("linear_id", issueId)?.archived_at).toBeTruthy();

    const unarchiveIssue = await client.unarchiveIssue(issueId);
    expect(unarchiveIssue.success).toBe(true);
    expect(unarchiveIssue.entityId).toBe(issueId);
    expect(getLinearStore(store).issues.findOneBy("linear_id", issueId)?.archived_at).toBeNull();

    const deleteIssue = await client.deleteIssue(issueId);
    expect(deleteIssue.success).toBe(true);
    expect(deleteIssue.entityId).toBe(issueId);
    expect(getLinearStore(store).issues.findOneBy("linear_id", issueId)).toBeUndefined();
  });
});
