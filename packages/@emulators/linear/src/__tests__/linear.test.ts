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

async function gql(app: Hono, query: string, variables?: Record<string, unknown>) {
  return app.request(`${base}/graphql`, {
    method: "POST",
    headers: {
      Authorization: "Bearer lin_test_admin",
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
        return app.request(url, init);
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

    const teams = await client.client.rawRequest<
      { teams: { nodes: Array<{ id: string; key: string; name: string }> } },
      Record<string, never>
    >(`query { teams { nodes { id key name } } }`);
    expect(teams.data?.teams.nodes[0].key).toBe("ENG");

    const teamId = teams.data!.teams.nodes[0].id;
    const createIssue = await client.client.rawRequest<
      { issueCreate: { success: boolean; issue: { id: string; identifier: string; title: string } } },
      { input: { teamId: string; title: string } }
    >(
      `mutation($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success
          issue { id identifier title }
        }
      }`,
      { input: { teamId, title: "Created from SDK" } },
    );
    expect(createIssue.data?.issueCreate.issue.identifier).toBe("ENG-2");

    const issueId = createIssue.data!.issueCreate.issue.id;
    const updateIssue = await client.client.rawRequest<
      { issueUpdate: { success: boolean; issue: { id: string; title: string; priority: number } } },
      { input: { id: string; title: string; priority: number } }
    >(
      `mutation($input: IssueUpdateInput!) {
        issueUpdate(input: $input) {
          success
          issue { id title priority }
        }
      }`,
      { input: { id: issueId, title: "Updated from SDK", priority: 1 } },
    );
    expect(updateIssue.data?.issueUpdate.issue.title).toBe("Updated from SDK");
    expect(updateIssue.data?.issueUpdate.issue.priority).toBe(1);

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

    const createComment = await client.client.rawRequest<
      { commentCreate: { success: boolean; comment: { id: string; body: string; issue: { identifier: string } } } },
      { input: { issueId: string; body: string } }
    >(
      `mutation($input: CommentCreateInput!) {
        commentCreate(input: $input) {
          success
          comment { id body issue { identifier } }
        }
      }`,
      { input: { issueId, body: "Commented from SDK" } },
    );
    expect(createComment.data?.commentCreate.comment.issue.identifier).toBe("ENG-2");
  });
});
