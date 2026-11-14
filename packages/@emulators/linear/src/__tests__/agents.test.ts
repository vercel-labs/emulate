import { LinearClient } from "@linear/sdk";
import { LinearWebhookClient } from "@linear/sdk/webhooks";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono, Store, WebhookDispatcher, authMiddleware, type TokenMap } from "@emulators/core";
import { getLinearStore, linearPlugin, seedFromConfig } from "../index.js";

const base = "http://localhost:4302";
const receiverUrl = "http://agent.test/webhook";
const webhookSecret = "agent-webhook-secret";

interface Delivery {
  headers: Record<string, string>;
  body: string;
  payload: any;
}

function createTestApp() {
  const store = new Store();
  const app = new Hono();
  app.use("*", authMiddleware(new Map() as TokenMap));
  linearPlugin.register(app as any, store, new WebhookDispatcher(), base, new Map());
  linearPlugin.seed?.(store, base);
  seedFromConfig(store, base, {
    oauth_apps: [
      {
        client_id: "agent_client",
        client_secret: "agent_secret",
        name: "Emulate Agent",
        redirect_uris: ["http://localhost:3000/callback"],
        actor: "app",
        assignable: true,
        mentionable: true,
      },
      {
        client_id: "other_agent_client",
        client_secret: "other_agent_secret",
        name: "Other Agent",
        redirect_uris: ["http://localhost:3000/callback"],
        actor: "app",
      },
    ],
    tokens: [
      { token: "lin_agent", type: "oauth_access", app: "agent_client" },
      { token: "lin_other_agent", type: "oauth_access", app: "other_agent_client" },
    ],
    webhooks: [
      { label: "Agent events", url: receiverUrl, resource_types: ["AgentSessionEvent"], secret: webhookSecret },
    ],
  });
  return { app, store };
}

async function gql(app: Hono, query: string, variables?: Record<string, unknown>, token = "lin_agent") {
  const res = await app.request(`${base}/graphql`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  return (await res.json()) as { data?: any; errors?: Array<{ message: string }> };
}

const CREATE_ACTIVITY = `mutation($input: AgentActivityCreateInput!) {
  agentActivityCreate(input: $input) { success agentActivity { id } }
}`;

describe("Linear agent sessions and activities", () => {
  let app: Hono;
  let store: Store;
  let deliveries: Delivery[];
  let originalFetch: typeof fetch;
  let agent: LinearClient;
  let human: LinearClient;

  beforeEach(() => {
    ({ app, store } = createTestApp());
    deliveries = [];
    originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === receiverUrl) {
        const body = String(init?.body);
        deliveries.push({ headers: init?.headers as Record<string, string>, body, payload: JSON.parse(body) });
        return new Response(null, { status: 200 });
      }
      if (url.startsWith(`${base}/`)) {
        return app.request(url, { method: init?.method, headers: init?.headers, body: init?.body });
      }
      return originalFetch(input, init);
    };
    agent = new LinearClient({ accessToken: "lin_agent", apiUrl: `${base}/graphql` });
    human = new LinearClient({ apiKey: "lin_test_admin", apiUrl: `${base}/graphql` });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function ls() {
    return getLinearStore(store);
  }

  function agentUser() {
    return ls().users.findOneBy("name", "Emulate Agent")!;
  }

  async function createIssue(title = "Agent work") {
    const teamId = ls().teams.findOneBy("key", "ENG")!.linear_id;
    const created = await human.createIssue({ teamId, title, description: "Check <checkout> & cart" });
    return created.issueId!;
  }

  async function createSession(issueId?: string) {
    const created = await agent.agentSessionCreateOnIssue({ issueId: issueId ?? (await createIssue()) });
    return created.agentSessionId!;
  }

  it("runs a session through @linear/sdk with real activity content, plan, and external links", async () => {
    const issueId = await createIssue();
    const created = await agent.agentSessionCreateOnIssue({
      issueId,
      externalUrls: [{ label: "Dashboard", url: "https://agent.example/sessions/1" }],
    });
    expect(created.success).toBe(true);
    const sessionId = created.agentSessionId!;

    let session = await agent.agentSession(sessionId);
    expect(session.status).toBe("pending");
    expect(session.appUserId).toBe(agentUser().linear_id);
    expect(session.creatorId).toBeUndefined();
    expect(session.issueId).toBe(issueId);
    expect(session.externalLinks.map(({ label, url }) => ({ label, url }))).toEqual([
      { label: "Dashboard", url: "https://agent.example/sessions/1" },
    ]);
    expect(session.externalUrls).toEqual([{ label: "Dashboard", url: "https://agent.example/sessions/1" }]);
    expect(session.slugId).toMatch(/^[0-9a-f]{12}$/);

    const thought = await agent.createAgentActivity({
      agentSessionId: sessionId,
      content: { type: "thought", body: "Reading the issue" },
      ephemeral: true,
    });
    expect(thought.success).toBe(true);
    session = await agent.agentSession(sessionId);
    expect(session.status).toBe("active");
    expect(session.startedAt).toBeInstanceOf(Date);

    await agent.createAgentActivity({
      agentSessionId: sessionId,
      content: { type: "action", action: "Searched", parameter: "checkout", result: "2 files" },
    });
    await agent.createAgentActivity({
      agentSessionId: sessionId,
      content: { type: "elicitation", body: "Which package?" },
      signal: "select" as any,
      signalMetadata: { options: [{ label: "Web", value: "apps/web" }, { value: "apps/api" }] },
    });
    expect((await agent.agentSession(sessionId)).status).toBe("awaitingInput");

    const plan = [
      { content: "Inspect the checkout", status: "completed" },
      { content: "Ship the fix", status: "inProgress" },
    ];
    expect((await agent.updateAgentSession(sessionId, { plan })).success).toBe(true);
    await agent.agentSessionUpdateExternalUrl(sessionId, {
      addedExternalUrls: [{ label: "Pull request", url: "https://github.com/acme/app/pull/9" }],
    });
    session = await agent.agentSession(sessionId);
    expect(session.plan).toEqual({ entries: plan, updatedAt: expect.any(String) });
    expect(session.externalLinks.map((link) => link.url)).toEqual([
      "https://agent.example/sessions/1",
      "https://github.com/acme/app/pull/9",
    ]);

    const response = await agent.createAgentActivity({
      agentSessionId: sessionId,
      content: { type: "response", body: "Fixed in **#9**." },
    });
    session = await agent.agentSession(sessionId);
    expect(session.status).toBe("complete");
    expect(session.endedAt).toBeInstanceOf(Date);

    const activities = await session.activities();
    expect(activities.nodes.map((activity) => activity.content)).toEqual([
      { __typename: "AgentActivityThoughtContent", type: "thought", body: "Reading the issue" },
      {
        __typename: "AgentActivityActionContent",
        type: "action",
        action: "Searched",
        parameter: "checkout",
        result: "2 files",
      },
      { __typename: "AgentActivityElicitationContent", type: "elicitation", body: "Which package?" },
      { __typename: "AgentActivityResponseContent", type: "response", body: "Fixed in **#9**." },
    ]);
    expect(activities.nodes[0].ephemeral).toBe(true);
    expect(activities.nodes[1].ephemeral).toBe(false);
    expect(activities.nodes[2].signal).toBe("select");
    expect(activities.nodes[2].signalMetadata).toEqual({
      options: [{ label: "Web", value: "apps/web" }, { value: "apps/api" }],
    });
    expect(activities.nodes[3].userId).toBe(agentUser().linear_id);

    const actions = await agent.agentActivities({ filter: { type: { eq: "action" } } });
    expect(actions.nodes.map((activity) => activity.agentSessionId)).toEqual([sessionId]);
    const fetched = await agent.agentActivity(response.agentActivityId!);
    expect(fetched.content).toMatchObject({ type: "response" });
  });

  it("keeps a response with the continue signal active and clears the plan on error", async () => {
    const sessionId = await createSession();
    await agent.updateAgentSession(sessionId, { plan: [{ content: "Try", status: "inProgress" }] });
    await agent.createAgentActivity({
      agentSessionId: sessionId,
      content: { type: "response", body: "Halfway there" },
      signal: "continue" as any,
    });
    expect((await agent.agentSession(sessionId)).status).toBe("active");

    await agent.createAgentActivity({
      agentSessionId: sessionId,
      content: { type: "error", body: "Out of credits", reasonCode: "credits" },
    });
    const session = ls().agentSessions.findOneBy("linear_id", sessionId)!;
    expect(session.status).toBe("error");
    expect(session.plan).toBeNull();
    await agent.updateAgentSession(sessionId, { plan: [{ content: "Retry", status: "pending" }] });
    expect(ls().agentSessions.findOneBy("linear_id", sessionId)!.plan).toBeNull();
    const [, error] = ls().agentActivities.findBy("session_id", sessionId);
    expect(error.content).toEqual({ type: "error", body: "Out of credits", reasonCode: "credits" });
  });

  it("rejects activity content, signals, and ids that Linear rejects", async () => {
    const sessionId = await createSession();
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ content: { type: "thought" } }, /content.body is required/],
      [{ content: { type: "action", action: "Search" } }, /content.parameter is required/],
      [{ content: { type: "plan", body: "x" } }, /content.type must be one of/],
      [{ content: { type: "response", body: "x" }, ephemeral: true }, /Only thought and action/],
      [
        { content: { type: "thought", body: "x" }, signal: "continue" },
        /continue signal can only be used with a response/,
      ],
      [
        { content: { type: "response", body: "x" }, signal: "select" },
        /select signal can only be used with an elicitation/,
      ],
      [{ content: { type: "elicitation", body: "x" }, signal: "select", signalMetadata: { options: [] } }, /1 to 100/],
      [{ content: { type: "elicitation", body: "x" }, signal: "auth", signalMetadata: {} }, /signalMetadata.url/],
      [{ content: { type: "thought", body: "x" }, signalMetadata: { a: 1 } }, /signalMetadata requires signal/],
      [{ content: { type: "thought", body: "x" }, signal: "stop" }, /stop signal is reserved for user prompts/],
      [{ content: { type: "prompt", body: "x" } }, /Agents cannot create prompt activities/],
      [{ content: { type: "thought", body: "x" }, id: "not-a-uuid" }, /UUID v4/],
    ];
    for (const [input, message] of cases) {
      const result = await gql(app, CREATE_ACTIVITY, { input: { agentSessionId: sessionId, ...input } });
      expect(result.errors?.[0]?.message, JSON.stringify(input)).toMatch(message);
    }
    expect(ls().agentActivities.findBy("session_id", sessionId)).toHaveLength(0);

    const id = "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f";
    const first = await gql(app, CREATE_ACTIVITY, {
      input: { agentSessionId: sessionId, id, content: { type: "thought", body: "x" } },
    });
    expect(first.data.agentActivityCreate.agentActivity.id).toBe(id);
    const duplicate = await gql(app, CREATE_ACTIVITY, {
      input: { agentSessionId: sessionId, id, content: { type: "thought", body: "y" } },
    });
    expect(duplicate.errors?.[0]?.message).toMatch(/already exists/);

    const foreign = await gql(
      app,
      CREATE_ACTIVITY,
      { input: { agentSessionId: sessionId, content: { type: "thought", body: "x" } } },
      "lin_other_agent",
    );
    expect(foreign.errors?.[0]?.message).toMatch(/belongs to another agent/);
  });

  it("names the missing session field of the input it was given", async () => {
    const withContent = await gql(app, CREATE_ACTIVITY, { input: { content: { type: "thought", body: "x" } } });
    expect(withContent.errors?.[0]?.message).toBe("agentSessionId is required");
    const flat = await gql(app, CREATE_ACTIVITY, { input: { type: "thought", body: "x" } });
    expect(flat.errors?.[0]?.message).toBe("sessionId is required");
  });

  it("validates plans, summaries, and external URL changes", async () => {
    const sessionId = await createSession();
    const update = (input: Record<string, unknown>) =>
      gql(
        app,
        `mutation($id: String!, $input: AgentSessionUpdateInput!) { agentSessionUpdate(id: $id, input: $input) { success } }`,
        {
          id: sessionId,
          input,
        },
      );
    for (const [input, message] of [
      [{ plan: [] }, /1 to 100 entries/],
      [{ plan: [{ content: "x", status: "done" }] }, /plan\[0\]/],
      [{ plan: [{ content: "x", status: "pending", extra: true }] }, /plan\[0\]/],
      [{ summary: "two\nlines" }, /one line/],
      [
        { externalUrls: [{ label: "a", url: "https://a.example" }], removedExternalUrls: ["https://a.example"] },
        /cannot be combined/,
      ],
      [
        {
          externalUrls: [
            { label: "a", url: "https://a.example" },
            { label: "b", url: "https://a.example" },
          ],
        },
        /unique/,
      ],
      [
        { addedExternalUrls: [{ label: "a", url: "https://a.example" }], removedExternalUrls: ["https://a.example"] },
        /added and removed/,
      ],
    ] as Array<[Record<string, unknown>, RegExp]>) {
      expect((await update(input)).errors?.[0]?.message, JSON.stringify(input)).toMatch(message);
    }
    expect(ls().agentSessions.findOneBy("linear_id", sessionId)!.status).toBe("pending");

    expect((await update({ summary: "Title only" })).errors).toBeUndefined();
    expect(ls().agentSessions.findOneBy("linear_id", sessionId)!.status).toBe("pending");
    expect((await update({ externalLink: "https://agent.example/run/2" })).errors).toBeUndefined();
    const session = ls().agentSessions.findOneBy("linear_id", sessionId)!;
    expect(session.status).toBe("active");
    expect(session.summary).toBe("Title only");
    expect(session.external_link).toBe("https://agent.example/run/2");
    expect(session.external_links).toEqual([{ label: "Emulate Agent", url: "https://agent.example/run/2" }]);
  });

  it("sends created events matching AgentSessionEventWebhookPayload when an issue is delegated", async () => {
    const issueId = await createIssue("Fix <checkout> & cart");
    const humanUser = ls().users.findOneBy("email", "admin@linear.local")!;
    await human.updateIssue(issueId, { delegateId: agentUser().linear_id });

    const events = deliveries.filter((delivery) => delivery.payload.type === "AgentSessionEvent");
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event.headers["Linear-Event"]).toBe("AgentSessionEvent");
    const parsed = new LinearWebhookClient(webhookSecret).parseData(
      Buffer.from(event.body),
      event.headers["Linear-Signature"],
      event.headers["Linear-Timestamp"],
    );
    expect(parsed.type).toBe("AgentSessionEvent");

    const session = ls().agentSessions.findBy("issue_id", issueId)[0]!;
    const oauthApp = ls().oauthApps.findOneBy("client_id", "agent_client")!;
    expect(Object.keys(event.payload).sort()).toEqual(
      [
        "action",
        "agentSession",
        "appUserId",
        "createdAt",
        "oauthClientId",
        "organizationId",
        "promptContext",
        "type",
        "webhookId",
        "webhookTimestamp",
      ].sort(),
    );
    expect(event.payload).toMatchObject({
      action: "created",
      appUserId: agentUser().linear_id,
      oauthClientId: oauthApp.linear_id,
      organizationId: ls().organizations.all()[0].linear_id,
    });
    expect(event.payload.agentSession).toMatchObject({
      id: session.linear_id,
      appUserId: agentUser().linear_id,
      status: "pending",
      type: "commentThread",
      issueId,
      issue: { id: issueId, title: "Fix <checkout> & cart", team: { key: "ENG", name: "Engineering" } },
      creatorId: humanUser.linear_id,
      creator: { id: humanUser.linear_id, email: "admin@linear.local", name: humanUser.name },
      commentId: null,
    });
    expect(event.payload.promptContext).toContain('<issue identifier="ENG-2">');
    expect(event.payload.promptContext).toContain("<title>Fix &lt;checkout&gt; &amp; cart</title>");
    expect(event.payload.promptContext).toContain("<description>Check &lt;checkout&gt; &amp; cart</description>");
    expect(event.payload.promptContext).toContain('<team name="Engineering"/>');
  });

  it("puts the mentioning comment in the created event and its prompt context", async () => {
    const issue = ls().issues.findOneBy("identifier", "ENG-1")!;
    await human.createComment({ issueId: issue.linear_id, body: "Emulate Agent please fix <this>" });
    const [event] = deliveries.filter((delivery) => delivery.payload.type === "AgentSessionEvent");
    const comment = ls()
      .comments.findBy("issue_id", issue.linear_id)
      .find((c) => c.body.includes("please fix"))!;
    expect(event.payload.agentSession).toMatchObject({
      commentId: comment.linear_id,
      comment: { id: comment.linear_id, body: comment.body, issueId: issue.linear_id },
    });
    expect(event.payload.promptContext).toContain(
      `<primary-directive-thread comment-id="${comment.linear_id}"><comment author="Admin User"`,
    );
    expect(event.payload.promptContext).toContain("please fix &lt;this&gt;</comment></primary-directive-thread>");
    expect(event.payload.promptContext).toContain("<other-thread comment-id=");
    expect(event.payload.promptContext).toContain("<label>Bug</label>");
    expect(event.payload.promptContext).toContain('<project name="Local Project">');
  });

  it("sends prompted events for user prompts and starts a new turn", async () => {
    const sessionId = await createSession();
    await agent.createAgentActivity({ agentSessionId: sessionId, content: { type: "response", body: "Done" } });
    const completed = ls().agentSessions.findOneBy("linear_id", sessionId)!;
    expect(completed.status).toBe("complete");
    deliveries.length = 0;

    const prompt = await human.createAgentActivity({
      agentSessionId: sessionId,
      content: { type: "prompt", body: "Also update the docs" },
    });
    expect(prompt.success).toBe(true);
    const session = ls().agentSessions.findOneBy("linear_id", sessionId)!;
    expect(session.status).toBe("active");
    expect(session.ended_at).toBeNull();
    expect(session.started_at).not.toBe(completed.started_at);

    const [event] = deliveries;
    expect(event.payload.action).toBe("prompted");
    expect(event.payload).not.toHaveProperty("promptContext");
    const humanUser = ls().users.findOneBy("email", "admin@linear.local")!;
    expect(event.payload.agentActivity).toEqual({
      id: prompt.agentActivityId,
      agentSessionId: sessionId,
      content: { type: "prompt", body: "Also update the docs" },
      signal: null,
      signalMetadata: null,
      sourceCommentId: null,
      userId: humanUser.linear_id,
      user: {
        id: humanUser.linear_id,
        name: humanUser.name,
        email: humanUser.email,
        avatarUrl: null,
        url: expect.any(String),
      },
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
      archivedAt: null,
    });
    const read = await gql(app, `query($id: String!) { agentActivity(id: $id) { promptAuthor { id } user { id } } }`, {
      id: prompt.agentActivityId,
    });
    expect(read.data.agentActivity).toEqual({
      promptAuthor: { id: humanUser.linear_id },
      user: { id: humanUser.linear_id },
    });

    await human.createAgentActivity({
      agentSessionId: sessionId,
      content: { type: "prompt", body: "Stop" },
      signal: "stop" as any,
    });
    expect(ls().agentSessions.findOneBy("linear_id", sessionId)!.status).toBe("stopping");
    expect(deliveries.at(-1)!.payload.agentActivity.signal).toBe("stop");
  });

  it("keeps the earlier flat activity input and session fields working", async () => {
    const issue = ls().issues.findOneBy("identifier", "ENG-1")!;
    const created = await gql(
      app,
      `mutation($input: AgentSessionCreateOnIssue!) { agentSessionCreateOnIssue(input: $input) { agentSession { id } } }`,
      {
        input: {
          issueId: issue.linear_id,
          agentUserId: agentUser().linear_id,
          plan: "Look around",
          externalUrl: "https://agent.example/old",
        },
      },
      "lin_test_admin",
    );
    const sessionId = created.data.agentSessionCreateOnIssue.agentSession.id;

    for (const [type, body] of [
      ["thought", "Thinking"],
      ["prompt", "A user message"],
      ["action", "Searching"],
    ]) {
      const result = await gql(app, CREATE_ACTIVITY, { input: { sessionId, type, body } }, "lin_test_admin");
      expect(result.errors).toBeUndefined();
    }
    expect(deliveries.filter((delivery) => delivery.payload.action === "prompted")).toHaveLength(1);

    const read = await gql(
      app,
      `query($id: String!) { agentSession(id: $id) {
        state status plan externalUrl agentUser { id }
        activities { nodes { type body ephemeral session { id } content { __typename } } }
      } }`,
      { id: sessionId },
      "lin_test_admin",
    );
    expect(read.errors).toBeUndefined();
    expect(read.data.agentSession).toMatchObject({
      state: "active",
      status: "active",
      plan: "Look around",
      externalUrl: "https://agent.example/old",
      agentUser: { id: agentUser().linear_id },
    });
    expect(read.data.agentSession.activities.nodes).toEqual([
      {
        type: "thought",
        body: "Thinking",
        ephemeral: true,
        session: { id: sessionId },
        content: { __typename: "AgentActivityThoughtContent" },
      },
      {
        type: "prompt",
        body: "A user message",
        ephemeral: false,
        session: { id: sessionId },
        content: { __typename: "AgentActivityPromptContent" },
      },
      {
        type: "action",
        body: "Searching",
        ephemeral: true,
        session: { id: sessionId },
        content: { __typename: "AgentActivityActionContent" },
      },
    ]);

    const canceled = await gql(
      app,
      `mutation($input: AgentSessionUpdateInput!) { agentSessionUpdate(input: $input) { agentSession { state status dismissedAt } } }`,
      { input: { id: sessionId, state: "canceled" } },
      "lin_test_admin",
    );
    expect(canceled.data.agentSessionUpdate.agentSession).toMatchObject({
      state: "canceled",
      status: "complete",
      dismissedAt: expect.any(String),
    });
  });
});
