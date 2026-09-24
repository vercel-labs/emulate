import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "@emulators/core";
import {
  Store,
  WebhookDispatcher,
  authMiddleware,
  createApiErrorHandler,
  createErrorHandler,
  type TokenMap,
} from "@emulators/core";
import { resendPlugin, seedFromConfig, getResendStore } from "../index.js";

const base = "http://localhost:4000";

function createTestApp(store = new Store(), webhooks = new WebhookDispatcher()) {
  const tokenMap: TokenMap = new Map();
  tokenMap.set("re_test_token", {
    login: "testuser@example.com",
    id: 1,
    scopes: [],
  });

  const app = new Hono();
  app.onError(createApiErrorHandler());
  app.use("*", createErrorHandler());
  app.use("*", authMiddleware(tokenMap));
  resendPlugin.register(app as any, store, webhooks, base, tokenMap);

  return { app, store, webhooks, tokenMap };
}

function authHeaders(): Record<string, string> {
  return { Authorization: "Bearer re_test_token", "Content-Type": "application/json" };
}

function sendEmail(app: Hono, body: unknown, headers: Record<string, string> = {}) {
  return app.request(`${base}/emails`, {
    method: "POST",
    headers: { ...authHeaders(), ...headers },
    body: JSON.stringify(body),
  });
}

describe("Resend plugin - Emails", () => {
  let app: Hono;

  beforeEach(() => {
    app = createTestApp().app;
  });

  it("POST /emails sends an email and returns id", async () => {
    const res = await app.request(`${base}/emails`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        from: "noreply@example.com",
        to: ["user@example.com"],
        subject: "Hello",
        html: "<p>World</p>",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };
    expect(body.id).toBeDefined();
    expect(typeof body.id).toBe("string");
  });

  it("POST /emails validates required fields", async () => {
    const res = await app.request(`${base}/emails`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ from: "noreply@example.com" }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { statusCode: number; name: string; message: string };
    expect(body.statusCode).toBe(422);
    expect(body.name).toBe("validation_error");
    expect(body.message).toContain("to");
  });

  it("GET /emails/:id retrieves a sent email", async () => {
    const sendRes = await app.request(`${base}/emails`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        from: "noreply@example.com",
        to: "user@example.com",
        subject: "Test",
        text: "plain text",
      }),
    });
    const { id } = (await sendRes.json()) as { id: string };

    const res = await app.request(`${base}/emails/${id}`, { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.id).toBe(id);
    expect(body.subject).toBe("Test");
    expect(body.status).toBe("delivered");
    expect(body.from).toBe("noreply@example.com");
  });

  it("GET /emails lists all emails", async () => {
    await app.request(`${base}/emails`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ from: "a@b.com", to: "c@d.com", subject: "S1" }),
    });
    await app.request(`${base}/emails`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ from: "a@b.com", to: "c@d.com", subject: "S2" }),
    });

    const res = await app.request(`${base}/emails`, { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { object: string; data: any[] };
    expect(body.object).toBe("list");
    expect(body.data.length).toBe(2);
  });

  it("POST /emails/batch sends multiple emails", async () => {
    const res = await app.request(`${base}/emails/batch`, {
      method: "POST",
      headers: { Authorization: "Bearer re_test_token", "Content-Type": "application/json" },
      body: JSON.stringify([
        { from: "a@b.com", to: "c@d.com", subject: "Batch 1" },
        { from: "a@b.com", to: "e@f.com", subject: "Batch 2" },
      ]),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data.length).toBe(2);
    expect(body.data[0].id).toBeDefined();
    expect(body.data[1].id).toBeDefined();
  });

  it("replays equivalent normalized single-email payloads", async () => {
    const { app: testApp, store, webhooks } = createTestApp();
    const dispatch = vi.spyOn(webhooks, "dispatch");
    const key = { "Idempotency-Key": "normalized-single" };

    const first = await sendEmail(testApp, { from: "a@b.com", to: "c@d.com", subject: "Normalized" }, key);
    const second = await sendEmail(
      testApp,
      {
        from: "a@b.com",
        to: ["c@d.com"],
        subject: "Normalized",
        html: null,
        text: null,
        cc: [],
        bcc: [],
        reply_to: [],
        headers: {},
        tags: [],
        scheduled_at: null,
      },
      { "idempotency-key": key["Idempotency-Key"] },
    );

    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(await first.clone().json());
    expect(getResendStore(store).emails.all()).toHaveLength(1);
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("replays equivalent normalized batch payloads", async () => {
    const { app: testApp, store, webhooks } = createTestApp();
    const dispatch = vi.spyOn(webhooks, "dispatch");
    const key = { "Idempotency-Key": "normalized-batch" };
    const firstPayload = [
      { from: "a@b.com", to: "c@d.com", subject: "Batch one" },
      { from: "a@b.com", to: "d@e.com", subject: "Batch two" },
    ];
    const secondPayload = firstPayload.map((email) => ({
      ...email,
      to: [email.to],
      html: null,
      text: null,
      cc: [],
      bcc: [],
      reply_to: [],
      headers: {},
      tags: [],
      scheduled_at: null,
    }));
    const request = (body: unknown, headers: Record<string, string> = key) =>
      testApp.request(`${base}/emails/batch`, {
        method: "POST",
        headers: { ...authHeaders(), ...headers },
        body: JSON.stringify(body),
      });

    const first = await request(firstPayload);
    const firstBody = await first.json();
    const second = await request(secondPayload, { "idempotency-key": key["Idempotency-Key"] });

    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(firstBody);
    expect(getResendStore(store).emails.all()).toHaveLength(2);
    expect(dispatch).toHaveBeenCalledTimes(4);
  });

  it("preserves per-email insertion and webhook ordering without an idempotency key", async () => {
    const { app: testApp, store, webhooks } = createTestApp();
    const emailCountsAtDispatch: number[] = [];
    vi.spyOn(webhooks, "dispatch").mockImplementation(async () => {
      emailCountsAtDispatch.push(getResendStore(store).emails.all().length);
    });

    const response = await testApp.request(`${base}/emails/batch`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify([
        { from: "a@b.com", to: "c@d.com", subject: "First" },
        { from: "a@b.com", to: "d@e.com", subject: "Second" },
      ]),
    });

    expect(response.status).toBe(200);
    expect(emailCountsAtDispatch).toEqual([1, 1, 2, 2]);
  });

  it("POST /emails replays an idempotent request without duplicating emails or webhooks", async () => {
    const { app: testApp, store, webhooks } = createTestApp();
    const dispatch = vi.spyOn(webhooks, "dispatch");
    const payload = { from: "a@b.com", to: "c@d.com", subject: "Idempotent" };
    const headers = { "Idempotency-Key": "single-send" };

    const first = await sendEmail(testApp, payload, headers);
    const second = await sendEmail(testApp, payload, { "idempotency-key": headers["Idempotency-Key"] });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(await first.clone().json());
    expect(getResendStore(store).emails.all()).toHaveLength(1);
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("POST /emails/batch replays the complete batch response without duplicating emails or webhooks", async () => {
    const { app: testApp, store, webhooks } = createTestApp();
    const dispatch = vi.spyOn(webhooks, "dispatch");
    const payload = [
      { from: "a@b.com", to: "c@d.com", subject: "Batch one" },
      { from: "a@b.com", to: "d@e.com", subject: "Batch two" },
    ];
    const headers = { "Idempotency-Key": "batch-send" };
    const request = (body: unknown) =>
      testApp.request(`${base}/emails/batch`, {
        method: "POST",
        headers: { ...authHeaders(), ...headers },
        body: JSON.stringify(body),
      });

    const first = await request(payload);
    const firstBody = await first.json();
    const second = await request(payload);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(firstBody);
    expect((firstBody as { data: Array<{ id: string }> }).data).toHaveLength(2);
    expect(getResendStore(store).emails.all()).toHaveLength(2);
    expect(dispatch).toHaveBeenCalledTimes(4);
  });

  it("without an idempotency key, each email send creates a new email", async () => {
    const first = await sendEmail(app, { from: "a@b.com", to: "c@d.com", subject: "First" });
    const second = await sendEmail(app, { from: "a@b.com", to: "c@d.com", subject: "First" });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstBody = (await first.json()) as { id: string };
    const secondBody = (await second.json()) as { id: string };
    expect(firstBody.id).not.toBe(secondBody.id);

    const list = await app.request(`${base}/emails`, { headers: authHeaders() });
    expect(((await list.json()) as { data: unknown[] }).data).toHaveLength(2);
  });

  it("rejects empty and overlong idempotency keys", async () => {
    const empty = await sendEmail(
      app,
      { from: "a@b.com", to: "c@d.com", subject: "Invalid" },
      { "Idempotency-Key": "" },
    );
    const overlong = await sendEmail(
      app,
      { from: "a@b.com", to: "c@d.com", subject: "Invalid" },
      { "Idempotency-Key": "x".repeat(257) },
    );

    for (const response of [empty, overlong]) {
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        statusCode: 400,
        name: "invalid_idempotency_key",
        message: "Idempotency-Key must be between 1 and 256 characters",
      });
    }
  });

  it("rejects a different payload or endpoint for an existing idempotency key", async () => {
    const headers = { "Idempotency-Key": "conflict" };
    await sendEmail(app, { from: "a@b.com", to: "c@d.com", subject: "Original" }, headers);

    const changedPayload = await sendEmail(app, { from: "a@b.com", to: "c@d.com", subject: "Changed" }, headers);
    expect(changedPayload.status).toBe(409);
    expect(((await changedPayload.json()) as { name: string }).name).toBe("invalid_idempotent_request");

    const changedEndpoint = await app.request(`${base}/emails/batch`, {
      method: "POST",
      headers: { ...authHeaders(), ...headers },
      body: JSON.stringify([{ from: "a@b.com", to: "c@d.com", subject: "Original" }]),
    });
    expect(changedEndpoint.status).toBe(409);
    expect(((await changedEndpoint.json()) as { name: string }).name).toBe("invalid_idempotent_request");
    const list = await app.request(`${base}/emails`, { headers: authHeaders() });
    expect(((await list.json()) as { data: unknown[] }).data).toHaveLength(1);
  });

  it("expires idempotency records after 24 hours", async () => {
    const { app: testApp, store } = createTestApp();
    const payload = { from: "a@b.com", to: "c@d.com", subject: "Expired" };
    const first = await sendEmail(testApp, payload, { "Idempotency-Key": "expires" });
    const firstId = ((await first.json()) as { id: string }).id;
    const idempotencyKeys = getResendStore(store).idempotencyKeys;
    const record = idempotencyKeys.findOneBy("idempotency_key", "expires");
    expect(record).toBeDefined();
    idempotencyKeys.update(record!.id, {
      created_at: new Date(Date.now() - 24 * 60 * 60 * 1000 - 1).toISOString(),
    });

    const second = await sendEmail(testApp, payload, { "Idempotency-Key": "expires" });
    expect(((await second.json()) as { id: string }).id).not.toBe(firstId);
    expect(getResendStore(store).emails.all()).toHaveLength(2);
    expect(idempotencyKeys.all()).toHaveLength(1);
  });

  it("supports prototype-named idempotency keys", async () => {
    const { app: testApp, store } = createTestApp();

    for (const key of ["constructor", "__proto__"]) {
      const first = await sendEmail(
        testApp,
        { from: "a@b.com", to: "c@d.com", subject: key },
        { "Idempotency-Key": key },
      );
      const second = await sendEmail(
        testApp,
        { from: "a@b.com", to: "c@d.com", subject: key },
        { "Idempotency-Key": key },
      );
      expect(((await second.json()) as { id: string }).id).toBe(((await first.json()) as { id: string }).id);
    }

    expect(getResendStore(store).emails.all()).toHaveLength(2);
    expect(getResendStore(store).idempotencyKeys.all()).toHaveLength(2);
  });

  it("persists idempotency records in store snapshots", async () => {
    const { app: testApp, store } = createTestApp();
    const payload = { from: "a@b.com", to: "c@d.com", subject: "Persistent" };
    const first = await sendEmail(testApp, payload, { "Idempotency-Key": "persistent" });
    const firstBody = await first.json();

    const restoredStore = new Store();
    restoredStore.restore(JSON.parse(JSON.stringify(store.snapshot())));
    const restoredApp = createTestApp(restoredStore).app;
    const second = await sendEmail(restoredApp, payload, { "Idempotency-Key": "persistent" });

    expect(await second.json()).toEqual(firstBody);
    expect(getResendStore(restoredStore).emails.all()).toHaveLength(1);
  });

  it("POST /emails/:id/cancel cancels a scheduled email", async () => {
    const sendRes = await app.request(`${base}/emails`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        from: "a@b.com",
        to: "c@d.com",
        subject: "Scheduled",
        scheduled_at: "2099-01-01T00:00:00Z",
      }),
    });
    const { id } = (await sendRes.json()) as { id: string };

    const res = await app.request(`${base}/emails/${id}/cancel`, {
      method: "POST",
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.canceled).toBe(true);

    // Verify status changed
    const getRes = await app.request(`${base}/emails/${id}`, { headers: authHeaders() });
    const email = (await getRes.json()) as any;
    expect(email.status).toBe("canceled");
  });

  it("POST /emails/:id/cancel fails for delivered email", async () => {
    const sendRes = await app.request(`${base}/emails`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ from: "a@b.com", to: "c@d.com", subject: "Sent" }),
    });
    const { id } = (await sendRes.json()) as { id: string };

    const res = await app.request(`${base}/emails/${id}/cancel`, {
      method: "POST",
      headers: authHeaders(),
    });
    expect(res.status).toBe(422);
  });
});

describe("Resend plugin - Domains", () => {
  let app: Hono;

  beforeEach(() => {
    app = createTestApp().app;
  });

  it("POST /domains creates a domain with DNS records", async () => {
    const res = await app.request(`${base}/domains`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: "example.com" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.id).toBeDefined();
    expect(body.name).toBe("example.com");
    expect(body.status).toBe("pending");
    expect(body.records.length).toBeGreaterThan(0);
  });

  it("POST /domains/:id/verify verifies a domain", async () => {
    const createRes = await app.request(`${base}/domains`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: "verify.com" }),
    });
    const { id } = (await createRes.json()) as { id: string };

    const res = await app.request(`${base}/domains/${id}/verify`, {
      method: "POST",
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.status).toBe("verified");
  });

  it("GET /domains lists domains", async () => {
    await app.request(`${base}/domains`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: "list1.com" }),
    });

    const res = await app.request(`${base}/domains`, { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.object).toBe("list");
    expect(body.data.length).toBeGreaterThanOrEqual(1);
  });

  it("DELETE /domains/:id deletes a domain", async () => {
    const createRes = await app.request(`${base}/domains`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: "delete.com" }),
    });
    const { id } = (await createRes.json()) as { id: string };

    const res = await app.request(`${base}/domains/${id}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.deleted).toBe(true);
  });
});

describe("Resend plugin - API Keys", () => {
  let app: Hono;

  beforeEach(() => {
    app = createTestApp().app;
  });

  it("POST /api-keys creates a key with re_ prefix", async () => {
    const res = await app.request(`${base}/api-keys`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: "Production" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; token: string };
    expect(body.id).toBeDefined();
    expect(body.token).toMatch(/^re_/);
  });

  it("GET /api-keys lists keys without full tokens", async () => {
    await app.request(`${base}/api-keys`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: "Key1" }),
    });

    const res = await app.request(`${base}/api-keys`, { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.object).toBe("list");
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    // Should not expose full token in list
    expect(body.data[0].token).toBeUndefined();
  });

  it("DELETE /api-keys/:id deletes a key", async () => {
    const createRes = await app.request(`${base}/api-keys`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: "ToDelete" }),
    });
    const { id } = (await createRes.json()) as { id: string };

    const res = await app.request(`${base}/api-keys/${id}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.deleted).toBe(true);
  });
});

describe("Resend plugin - Contacts & Audiences", () => {
  let app: Hono;

  beforeEach(() => {
    app = createTestApp().app;
  });

  it("POST /audiences creates an audience", async () => {
    const res = await app.request(`${base}/audiences`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: "Newsletter" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.id).toBeDefined();
    expect(body.name).toBe("Newsletter");
  });

  it("POST /audiences/:id/contacts creates a contact", async () => {
    const audRes = await app.request(`${base}/audiences`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: "Subscribers" }),
    });
    const { id: audienceId } = (await audRes.json()) as { id: string };

    const res = await app.request(`${base}/audiences/${audienceId}/contacts`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ email: "user@example.com", first_name: "Test" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.email).toBe("user@example.com");
  });

  it("GET /audiences/:id/contacts lists contacts", async () => {
    const audRes = await app.request(`${base}/audiences`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: "List" }),
    });
    const { id: audienceId } = (await audRes.json()) as { id: string };

    await app.request(`${base}/audiences/${audienceId}/contacts`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ email: "a@b.com" }),
    });

    const res = await app.request(`${base}/audiences/${audienceId}/contacts`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.object).toBe("list");
    expect(body.data.length).toBe(1);
  });

  it("DELETE /audiences/:audience_id/contacts/:id deletes a contact", async () => {
    const audRes = await app.request(`${base}/audiences`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: "Cleanup" }),
    });
    const { id: audienceId } = (await audRes.json()) as { id: string };

    const ctRes = await app.request(`${base}/audiences/${audienceId}/contacts`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ email: "del@b.com" }),
    });
    const { id: contactId } = (await ctRes.json()) as { id: string };

    const res = await app.request(`${base}/audiences/${audienceId}/contacts/${contactId}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.deleted).toBe(true);
  });
});

describe("Resend plugin - Inbox UI", () => {
  let app: Hono;

  beforeEach(() => {
    app = createTestApp().app;
  });

  it("GET /inbox renders empty inbox page", async () => {
    const res = await app.request(`${base}/inbox`, { headers: authHeaders() });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const html = await res.text();
    expect(html).toContain("Inbox");
    expect(html).toContain("0 emails sent");
  });

  it("GET /inbox shows sent emails", async () => {
    await app.request(`${base}/emails`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ from: "a@b.com", to: "c@d.com", subject: "Test Subject" }),
    });

    const res = await app.request(`${base}/inbox`, { headers: authHeaders() });
    const html = await res.text();
    expect(html).toContain("Test Subject");
    expect(html).toContain("1 email sent");
  });

  it("GET /inbox/:id shows email detail", async () => {
    const sendRes = await app.request(`${base}/emails`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        from: "sender@test.com",
        to: "recipient@test.com",
        subject: "Detail Test",
        html: "<h1>Hello</h1>",
      }),
    });
    const { id } = (await sendRes.json()) as { id: string };

    const res = await app.request(`${base}/inbox/${id}`, { headers: authHeaders() });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Detail Test");
    expect(html).toContain("sender@test.com");
    expect(html).toContain("recipient@test.com");
    expect(html).toContain("iframe");
  });

  it("GET /inbox/:id returns 404 for unknown email", async () => {
    const res = await app.request(`${base}/inbox/nonexistent-id`, { headers: authHeaders() });
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain("Not Found");
  });
});

describe("Resend plugin - allowlist and send attempts", () => {
  const allowlist = ["alex@acme.example.test", "casey@cedar.example.test"];

  function seededApp() {
    const setup = createTestApp();
    seedFromConfig(setup.store, base, { allowlist });
    return setup;
  }

  it("rejects an address that is not in the allowlist and records the attempt", async () => {
    const { app, store } = seededApp();
    const res = await sendEmail(
      app,
      {
        from: "operations@recruitflow.example.test",
        to: ["blair@beacon.example.test"],
        subject: "Checking in with Beacon Talent",
      },
      { "Idempotency-Key": "rev-abc:blair" },
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      statusCode: 403,
      name: "validation_error",
      message: "blair@beacon.example.test is not in the allowlist: alex@acme.example.test, casey@cedar.example.test.",
    });
    const rs = getResendStore(store);
    expect(rs.emails.all()).toEqual([]);
    expect(rs.idempotencyKeys.all()).toEqual([]);
    expect(rs.sendAttempts.all()).toMatchObject([
      {
        to: ["blair@beacon.example.test"],
        from: "operations@recruitflow.example.test",
        subject: "Checking in with Beacon Talent",
        idempotency_key: "rev-abc:blair",
      },
    ]);
  });

  it("records another attempt when a rejected send is retried", async () => {
    const { app, store } = seededApp();
    const body = {
      from: "operations@recruitflow.example.test",
      to: ["blair@beacon.example.test"],
      subject: "Checking in",
    };
    await sendEmail(app, body, { "Idempotency-Key": "rev-abc:blair" });
    await sendEmail(app, body, { "Idempotency-Key": "rev-abc:blair" });
    expect(getResendStore(store).sendAttempts.all()).toHaveLength(2);
    expect(getResendStore(store).emails.all()).toEqual([]);
  });

  it("stores a delivered email and one attempt for an allowed recipient", async () => {
    const { app, store } = seededApp();
    const res = await sendEmail(app, {
      from: "operations@recruitflow.example.test",
      to: ["alex@acme.example.test"],
      cc: ["casey@cedar.example.test"],
      subject: "Checking in with Acme",
    });
    expect(res.status).toBe(200);
    const rs = getResendStore(store);
    expect(rs.emails.all()).toHaveLength(1);
    expect(rs.emails.all()[0].status).toBe("delivered");
    expect(rs.sendAttempts.all()).toHaveLength(1);
  });

  it("does not record an attempt when an idempotency key replays a stored email", async () => {
    const { app, store } = seededApp();
    const headers = { "Idempotency-Key": "rev-abc:alex" };
    const body = {
      from: "operations@recruitflow.example.test",
      to: ["alex@acme.example.test"],
      subject: "Checking in with Acme",
    };
    await sendEmail(app, body, headers);
    const replay = await sendEmail(app, body, headers);
    expect(replay.status).toBe(200);
    expect(getResendStore(store).sendAttempts.all()).toHaveLength(1);
    expect(getResendStore(store).emails.all()).toHaveLength(1);
  });

  it("rejects every email in a batch when one recipient is missing", async () => {
    const { app, store } = seededApp();
    const res = await app.request(`${base}/emails/batch`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify([
        { from: "operations@recruitflow.example.test", to: ["alex@acme.example.test"], subject: "Alex" },
        { from: "operations@recruitflow.example.test", to: ["blair@beacon.example.test"], subject: "Blair" },
      ]),
    });
    expect(res.status).toBe(403);
    expect(getResendStore(store).emails.all()).toEqual([]);
    expect(getResendStore(store).sendAttempts.all()).toHaveLength(2);
  });

  it("rejects every recipient when the allowlist is empty", async () => {
    const { app, store } = createTestApp();
    seedFromConfig(store, base, { allowlist: [] });
    const res = await sendEmail(app, { from: "a@b.com", to: ["c@d.com"], subject: "Hi" });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { message: string }).message).toBe("c@d.com is not in the allowlist: .");
    expect(getResendStore(store).sendAttempts.all()).toHaveLength(1);
  });

  it("does not record an attempt when required fields are missing", async () => {
    const { app, store } = seededApp();
    const res = await sendEmail(app, { from: "operations@recruitflow.example.test" });
    expect(res.status).toBe(422);
    expect(getResendStore(store).sendAttempts.all()).toEqual([]);
  });
});

describe("Resend plugin - seedFromConfig", () => {
  it("seeds domains and contacts from config", () => {
    const { store } = createTestApp();
    seedFromConfig(store, base, {
      domains: [{ name: "example.com" }],
      contacts: [{ email: "user@example.com", first_name: "Test", last_name: "User" }],
    });

    const rs = getResendStore(store);
    const domains = rs.domains.all();
    expect(domains.length).toBe(1);
    expect(domains[0].name).toBe("example.com");
    expect(domains[0].status).toBe("verified");

    const contacts = rs.contacts.all();
    expect(contacts.length).toBe(1);
    expect(contacts[0].email).toBe("user@example.com");
  });

  it("stores an allowlist, including an empty one", () => {
    const { store } = createTestApp();
    seedFromConfig(store, base, { allowlist: ["alex@acme.example.test"] });
    expect(store.getData("allowlist")).toEqual(["alex@acme.example.test"]);
    seedFromConfig(store, base, { allowlist: [] });
    expect(store.getData("allowlist")).toEqual([]);
  });
});
