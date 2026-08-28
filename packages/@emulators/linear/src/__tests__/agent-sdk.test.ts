import { AgentActivitySignal, LinearClient } from "@linear/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono, Store, WebhookDispatcher, authMiddleware, type TokenMap } from "@emulators/core";
import { getLinearStore, linearPlugin } from "../index.js";

const base = "http://localhost:4301";

function createTestApp() {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map();
  const app = new Hono();
  app.use("*", authMiddleware(tokenMap));
  linearPlugin.register(app as any, store, webhooks, base, tokenMap);
  linearPlugin.seed?.(store, base);
  return { app, store };
}

/**
 * Official @linear/sdk against the emulator — the highest-signal regression
 * guard for Agent Interaction parity.
 */
describe("Linear Agent Interaction via official SDK", () => {
  let app: Hono;
  let store: Store;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    const setup = createTestApp();
    app = setup.app;
    store = setup.store;
    originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith(`${base}/`)) {
        return app.request(url, {
          method: init?.method,
          headers: init?.headers,
          body: init?.body,
        });
      }
      return originalFetch(input, init);
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("creates activities, plans, externalUrls, and status lifecycle with LinearClient", async () => {
    const humanClient = new LinearClient({
      apiKey: "lin_test_admin",
      apiUrl: `${base}/graphql`,
    });
    const client = new LinearClient({
      apiKey: "lin_test_agent",
      apiUrl: `${base}/graphql`,
    });

    const teamId = getLinearStore(store).teams.findOneBy("key", "ENG")!.linear_id;
    const createdIssue = await humanClient.createIssue({ teamId, title: "SDK agent parity" });
    expect(createdIssue.success).toBe(true);
    const issueId = createdIssue.issueId!;

    const createdSession = await client.agentSessionCreateOnIssue({
      issueId,
      externalUrls: [{ label: "Dashboard", url: "https://agent.example/s/1" }],
    });
    expect(createdSession.success).toBe(true);
    const sessionId = createdSession.agentSessionId!;
    expect(sessionId).toBeTruthy();

    const thought = await client.createAgentActivity({
      agentSessionId: sessionId,
      content: { type: "thought", body: "Reading context" },
      ephemeral: true,
    });
    expect(thought.success).toBe(true);

    const action = await client.createAgentActivity({
      agentSessionId: sessionId,
      content: {
        type: "action",
        action: "Searched",
        parameter: "checkout",
        result: "2 hits",
      },
    });
    expect(action.success).toBe(true);

    const elicitation = await client.createAgentActivity({
      agentSessionId: sessionId,
      content: { type: "elicitation", body: "Which package?" },
      signal: AgentActivitySignal.Select,
      signalMetadata: {
        options: [
          { label: "frontend", value: "src/frontend" },
          { label: "backend", value: "src/backend" },
        ],
      },
    });
    expect(elicitation.success).toBe(true);

    const afterElicitation = await client.agentSession(sessionId);
    expect(afterElicitation.status).toBe("awaitingInput");
    expect(afterElicitation.externalLinks.map(({ label, url }) => ({ label, url }))).toEqual([
      { label: "Dashboard", url: "https://agent.example/s/1" },
    ]);

    const updated = await client.updateAgentSession(sessionId, {
      plan: [
        { content: "Inspect issue", status: "completed" },
        { content: "Ship fix", status: "inProgress" },
      ],
      externalUrls: [
        { label: "PR", url: "https://github.com/acme/app/pull/9" },
        { label: "Logs", url: "https://agent.example/logs/9" },
      ],
    });
    expect(updated.success).toBe(true);

    // Status must remain activity-driven (still awaitingInput until response/error).
    expect(getLinearStore(store).agentSessions.findOneBy("linear_id", sessionId)?.status).toBe("awaitingInput");

    const prompt = await humanClient.client.rawRequest(
      `mutation($input: AgentActivityCreatePromptInput!) {
        agentActivityCreatePrompt(input: $input) { success }
      }`,
      {
        input: {
          agentSessionId: sessionId,
          content: { type: "prompt", body: "Use frontend" },
        },
      },
    );
    expect((prompt.data as { agentActivityCreatePrompt: { success: boolean } }).agentActivityCreatePrompt.success).toBe(
      true,
    );

    const response = await client.createAgentActivity({
      agentSessionId: sessionId,
      content: { type: "response", body: "Done" },
    });
    expect(response.success).toBe(true);

    const finalSession = await client.agentSession(sessionId);
    const activities = await finalSession.activities();
    expect(finalSession.status).toBe("complete");
    expect(finalSession.endedAt).toBeTruthy();
    expect(getLinearStore(store).agentSessions.findOneBy("linear_id", sessionId)?.plan).toEqual([
      { content: "Inspect issue", status: "completed" },
      { content: "Ship fix", status: "inProgress" },
    ]);
    expect(finalSession.externalLinks).toHaveLength(2);
    expect(activities.nodes.map((activity) => activity.content.type)).toEqual([
      "action",
      "elicitation",
      "prompt",
      "response",
    ]);
    expect(activities.nodes[1].signal).toBe("select");

    const archivedThoughts = await client.client.rawRequest(
      `query($id: String!) {
        agentSession(id: $id) {
          activities(includeArchived: true, orderBy: updatedAt, filter: { type: { eq: "thought" } }) {
            nodes { archivedAt ephemeral }
          }
        }
      }`,
      { id: sessionId },
    );
    const archivedNodes = (archivedThoughts.data as any).agentSession.activities.nodes;
    expect(archivedNodes).toHaveLength(1);
    expect(archivedNodes[0]).toMatchObject({ archivedAt: expect.any(String), ephemeral: true });
  });

  it("rejects invalid activity content through the SDK path", async () => {
    const humanClient = new LinearClient({
      apiKey: "lin_test_admin",
      apiUrl: `${base}/graphql`,
    });
    const client = new LinearClient({
      apiKey: "lin_test_agent",
      apiUrl: `${base}/graphql`,
    });
    const teamId = getLinearStore(store).teams.findOneBy("key", "ENG")!.linear_id;
    const issue = await humanClient.createIssue({ teamId, title: "bad activity" });
    const session = await client.agentSessionCreateOnIssue({ issueId: issue.issueId! });

    await expect(
      client.createAgentActivity({
        agentSessionId: session.agentSessionId!,
        content: { type: "thought" } as any,
      }),
    ).rejects.toThrow(/content\.body is required|body is required/i);
  });
});
