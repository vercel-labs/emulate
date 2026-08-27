import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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

function createTestApp(options: { store?: Store; webhooks?: WebhookDispatcher } = {}) {
  const store = options.store ?? new Store();
  const webhooks = options.webhooks ?? new WebhookDispatcher();
  const tokenMap: TokenMap = new Map();
  tokenMap.set("re_test_token", {
    login: "testuser@example.com",
    id: 1,
    scopes: [],
  });
  tokenMap.set("re_other_token", {
    login: "other@example.com",
    id: 2,
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

function sendJson(
  app: Hono,
  path: string,
  body: unknown,
  headers: Record<string, string> = authHeaders(),
): Promise<Response> {
  return app.request(`${base}${path}`, {
    method: "POST",
    headers,
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

describe("Resend plugin - Idempotency-Key", () => {
  const payload = {
    from: "sender@example.com",
    to: "recipient@example.com",
    subject: "Idempotent send",
  };

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    ["single", "/emails", payload, 1],
    ["batch", "/emails/batch", [payload, { ...payload, to: "second@example.com" }], 2],
  ] as const)(
    "replays an equivalent %s response without inserting emails or dispatching webhooks",
    async (_name, path, body, count) => {
      const { app, store, webhooks } = createTestApp();
      const dispatch = vi.spyOn(webhooks, "dispatch");
      const headers = { ...authHeaders(), "Idempotency-Key": `replay-${_name}` };

      const first = await sendJson(app, path, body, headers);
      const firstText = await first.text();
      const webhookCount = dispatch.mock.calls.length;
      const second = await sendJson(app, path, body, headers);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(await second.text()).toBe(firstText);
      expect(getResendStore(store).emails.count()).toBe(count);
      expect(getResendStore(store).idempotencyRecords.count()).toBe(1);
      expect(dispatch).toHaveBeenCalledTimes(webhookCount);
    },
  );

  it("continues creating distinct emails without a key and with different keys", async () => {
    const { app, store } = createTestApp();
    const noKeyFirst = await sendJson(app, "/emails", payload);
    const noKeySecond = await sendJson(app, "/emails", payload);
    const firstKey = await sendJson(app, "/emails", payload, {
      ...authHeaders(),
      "Idempotency-Key": "different-a",
    });
    const secondKey = await sendJson(app, "/emails", payload, {
      ...authHeaders(),
      "Idempotency-Key": "different-b",
    });

    const ids = await Promise.all(
      [noKeyFirst, noKeySecond, firstKey, secondKey].map(
        async (response) => ((await response.json()) as { id: string }).id,
      ),
    );
    expect(new Set(ids).size).toBe(4);
    expect(getResendStore(store).emails.count()).toBe(4);
  });

  it.each([
    ["from", { from: "changed@example.com" }],
    ["to", { to: "changed@example.com" }],
    ["subject", { subject: "Changed" }],
    ["html", { html: "<p>Changed</p>" }],
    ["text", { text: "Changed" }],
    ["cc", { cc: "cc@example.com" }],
    ["bcc", { bcc: "bcc@example.com" }],
    ["reply_to", { reply_to: "reply@example.com" }],
    ["headers", { headers: { "X-Custom": "changed" } }],
    ["tags", { tags: [{ name: "environment", value: "test" }] }],
    ["attachments", { attachments: [{ filename: "hello.txt", content: "changed" }] }],
    ["template", { template: { id: "template-id", variables: { nested: "changed" } } }],
    ["scheduled_at", { scheduled_at: "2099-01-01T00:00:00Z" }],
    ["unknown nested field", { custom: { nested: { value: "changed" } } }],
  ])("returns a payload conflict when %s changes", async (field, override) => {
    const { app, store, webhooks } = createTestApp();
    const dispatch = vi.spyOn(webhooks, "dispatch");
    const headers = { ...authHeaders(), "Idempotency-Key": `conflict-${field}` };

    expect((await sendJson(app, "/emails", payload, headers)).status).toBe(200);
    const webhookCount = dispatch.mock.calls.length;
    const conflict = await sendJson(app, "/emails", { ...payload, ...override }, headers);

    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({
      statusCode: 409,
      name: "invalid_idempotent_request",
      message:
        "This idempotency key has been used with this HTTP method and endpoint within the last 24 hours, but the request body was modified and doesn’t match the original request.",
    });
    expect(getResendStore(store).emails.count()).toBe(1);
    expect(dispatch).toHaveBeenCalledTimes(webhookCount);
  });

  it.each([
    [
      "a field in a batch item",
      [payload, { ...payload, to: "second@example.com", custom: { nested: "original" } }],
      [payload, { ...payload, to: "second@example.com", custom: { nested: "changed" } }],
    ],
    [
      "batch order",
      [
        { ...payload, subject: "First" },
        { ...payload, subject: "Second" },
      ],
      [
        { ...payload, subject: "Second" },
        { ...payload, subject: "First" },
      ],
    ],
  ])("returns a payload conflict when %s changes", async (name, original, changed) => {
    const { app, store, webhooks } = createTestApp();
    const dispatch = vi.spyOn(webhooks, "dispatch");
    const headers = { ...authHeaders(), "Idempotency-Key": `batch-conflict-${name}` };

    expect((await sendJson(app, "/emails/batch", original, headers)).status).toBe(200);
    const emailCount = getResendStore(store).emails.count();
    const webhookCount = dispatch.mock.calls.length;
    const conflict = await sendJson(app, "/emails/batch", changed, headers);

    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as { name: string }).name).toBe("invalid_idempotent_request");
    expect(getResendStore(store).emails.count()).toBe(emailCount);
    expect(dispatch).toHaveBeenCalledTimes(webhookCount);
  });

  it("treats object ordering, header ordering, address forms, and omitted defaults as equivalent", async () => {
    const { app, store } = createTestApp();
    const headers = { ...authHeaders(), "Idempotency-Key": "canonical-equivalence" };
    const firstPayload = {
      ...payload,
      cc: "cc@example.com",
      bcc: "bcc@example.com",
      reply_to: "reply@example.com",
      headers: { "X-Second": "2", "X-First": "1" },
      custom: { z: 1, a: { second: true, first: false } },
    };
    const equivalentPayload = {
      custom: { a: { first: false, second: true }, z: 1 },
      headers: { "X-First": "1", "X-Second": "2" },
      reply_to: ["reply@example.com"],
      bcc: ["bcc@example.com"],
      cc: ["cc@example.com"],
      subject: payload.subject,
      to: [payload.to],
      from: payload.from,
      html: null,
      text: null,
      tags: [],
      scheduled_at: null,
    };

    const first = await sendJson(app, "/emails", firstPayload, headers);
    const second = await sendJson(app, "/emails", equivalentPayload, headers);

    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(await first.json());

    const defaultHeaders = { ...authHeaders(), "Idempotency-Key": "canonical-defaults" };
    const omittedDefaults = await sendJson(app, "/emails", payload, defaultHeaders);
    const explicitDefaults = await sendJson(
      app,
      "/emails",
      {
        ...payload,
        to: [payload.to],
        html: null,
        text: null,
        cc: [],
        bcc: [],
        reply_to: [],
        headers: {},
        tags: [],
        scheduled_at: null,
      },
      defaultHeaders,
    );
    expect(await explicitDefaults.json()).toEqual(await omittedDefaults.json());
    expect(getResendStore(store).emails.count()).toBe(2);
  });

  it("scopes the same textual key by endpoint and credential without persisting authorization secrets", async () => {
    const { app, store } = createTestApp();
    const key = "isolated-key";
    const first = await sendJson(app, "/emails", payload, { ...authHeaders(), "Idempotency-Key": key });
    const batch = await sendJson(app, "/emails/batch", [payload], {
      ...authHeaders(),
      "Idempotency-Key": key,
    });
    const otherCredential = await sendJson(app, "/emails", payload, {
      Authorization: "Bearer re_adapter_token",
      "Content-Type": "application/json",
      "Idempotency-Key": key,
    });

    expect([first.status, batch.status, otherCredential.status]).toEqual([200, 200, 200]);
    const rs = getResendStore(store);
    expect(rs.emails.count()).toBe(3);
    expect(rs.idempotencyRecords.count()).toBe(3);
    expect(JSON.stringify(store.snapshot())).not.toContain("re_test_token");
    expect(JSON.stringify(store.snapshot())).not.toContain("re_adapter_token");
  });

  it.each([
    ["empty", ""],
    ["too long", "x".repeat(257)],
  ])("rejects a %s key without side effects", async (_name, key) => {
    const { app, store, webhooks } = createTestApp();
    const dispatch = vi.spyOn(webhooks, "dispatch");
    const response = await sendJson(app, "/emails", payload, {
      ...authHeaders(),
      "Idempotency-Key": key,
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      statusCode: 400,
      name: "invalid_idempotency_key",
      message: "Idempotency keys, if present, must have between 1 and 256 characters.",
    });
    expect(getResendStore(store).emails.count()).toBe(0);
    expect(getResendStore(store).idempotencyRecords.count()).toBe(0);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each([1, 256])("accepts a %i-character key", async (length) => {
    const { app } = createTestApp();
    const headers = { ...authHeaders(), "Idempotency-Key": "x".repeat(length) };
    const first = await sendJson(app, "/emails", payload, headers);
    const replay = await sendJson(app, "/emails", payload, headers);
    expect(first.status).toBe(200);
    expect(await replay.json()).toEqual(await first.json());
  });

  it("does not reserve keys for malformed, validation-failing, or oversized requests", async () => {
    const { app, store } = createTestApp();
    const headers = { ...authHeaders(), "Idempotency-Key": "reusable-after-validation" };
    const malformed = await app.request(`${base}/emails/batch`, {
      method: "POST",
      headers,
      body: "not json",
    });
    const invalid = await sendJson(app, "/emails", { from: payload.from }, headers);
    const oversized = await sendJson(
      app,
      "/emails/batch",
      Array.from({ length: 101 }, () => payload),
      headers,
    );

    expect([malformed.status, invalid.status, oversized.status]).toEqual([422, 422, 422]);
    expect(getResendStore(store).idempotencyRecords.count()).toBe(0);
    const valid = await sendJson(app, "/emails", payload, headers);
    expect(valid.status).toBe(200);
    expect(getResendStore(store).emails.count()).toBe(1);
  });

  it("returns a concurrency conflict while the original request is awaiting webhook dispatch", async () => {
    const { app, store, webhooks } = createTestApp();
    let releaseDispatch!: () => void;
    const deferred = new Promise<void>((resolve) => {
      releaseDispatch = resolve;
    });
    let dispatchStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      dispatchStarted = resolve;
    });
    let callCount = 0;
    vi.spyOn(webhooks, "dispatch").mockImplementation(async () => {
      callCount += 1;
      if (callCount === 1) {
        dispatchStarted();
        await deferred;
      }
    });
    const headers = { ...authHeaders(), "Idempotency-Key": "concurrent-key" };

    const firstPromise = sendJson(app, "/emails", payload, headers);
    await started;
    const concurrent = await sendJson(app, "/emails", payload, headers);

    expect(concurrent.status).toBe(409);
    expect(await concurrent.json()).toEqual({
      statusCode: 409,
      name: "concurrent_idempotent_requests",
      message: "There is another request in progress with the same idempotency key.",
    });
    expect(getResendStore(store).emails.count()).toBe(1);

    releaseDispatch();
    const first = await firstPromise;
    expect(first.status).toBe(200);
    const replay = await sendJson(app, "/emails", payload, headers);
    expect(await replay.json()).toEqual(await first.json());
    expect(getResendStore(store).emails.count()).toBe(1);
  });

  it("replays immediately before 24 hours and permits a fresh send at expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const { app, store } = createTestApp();
    const headers = { ...authHeaders(), "Idempotency-Key": "ttl-key" };
    const first = await sendJson(app, "/emails", payload, headers);
    const firstBody = (await first.json()) as { id: string };

    vi.setSystemTime(new Date("2026-01-01T23:59:59.999Z"));
    const beforeExpiry = await sendJson(app, "/emails", payload, headers);
    expect(await beforeExpiry.json()).toEqual(firstBody);

    vi.setSystemTime(new Date("2026-01-02T00:00:00.000Z"));
    const atExpiry = await sendJson(app, "/emails", payload, headers);
    const atExpiryBody = (await atExpiry.json()) as { id: string };
    expect(atExpiryBody.id).not.toBe(firstBody.id);
    expect(getResendStore(store).emails.count()).toBe(2);
    expect(getResendStore(store).idempotencyRecords.count()).toBe(1);
  });

  it("restores completed records and replays them within their original TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-01T00:00:00.000Z"));
    const firstContext = createTestApp();
    const headers = { ...authHeaders(), "Idempotency-Key": "snapshot-key" };
    const first = await sendJson(firstContext.app, "/emails/batch", [payload], headers);
    const firstBody = await first.json();
    const snapshot = firstContext.store.snapshot();

    vi.setSystemTime(new Date("2026-02-01T12:00:00.000Z"));
    const restoredStore = new Store();
    restoredStore.restore(snapshot);
    const restoredContext = createTestApp({ store: restoredStore });
    const dispatch = vi.spyOn(restoredContext.webhooks, "dispatch");
    const replay = await sendJson(restoredContext.app, "/emails/batch", [payload], headers);

    expect(await replay.json()).toEqual(firstBody);
    expect(getResendStore(restoredStore).emails.count()).toBe(1);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("does not expose the key or internal record fields through email APIs", async () => {
    const { app } = createTestApp();
    const key = "private-idempotency-key";
    const send = await sendJson(app, "/emails", payload, { ...authHeaders(), "Idempotency-Key": key });
    const { id } = (await send.json()) as { id: string };
    const detail = await app.request(`${base}/emails/${id}`, { headers: authHeaders() });
    const list = await app.request(`${base}/emails`, { headers: authHeaders() });
    const detailText = await detail.text();
    const listText = await list.text();

    for (const text of [detailText, listText]) {
      expect(text).not.toContain(key);
      expect(text).not.toContain("lookup_digest");
      expect(text).not.toContain("request_fingerprint");
      expect(text).not.toContain("expires_at");
    }
  });

  it("rolls back inserted rows and releases the reservation after an unexpected execution failure", async () => {
    const { app, store, webhooks } = createTestApp();
    const headers = { ...authHeaders(), "Idempotency-Key": "retry-after-failure" };
    const dispatch = vi.spyOn(webhooks, "dispatch");
    dispatch.mockResolvedValueOnce();
    dispatch.mockResolvedValueOnce();
    dispatch.mockRejectedValueOnce(new Error("injected failure"));
    const batch = [payload, { ...payload, to: "second@example.com" }];

    const failed = await sendJson(app, "/emails/batch", batch, headers);
    expect(failed.status).toBe(500);
    expect(getResendStore(store).emails.count()).toBe(0);
    expect(getResendStore(store).idempotencyRecords.count()).toBe(0);

    vi.restoreAllMocks();
    const retry = await sendJson(app, "/emails/batch", batch, headers);
    expect(retry.status).toBe(200);
    expect(getResendStore(store).emails.count()).toBe(2);
    expect(getResendStore(store).idempotencyRecords.findOneBy("state", "completed")?.state).toBe("completed");
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
});
