import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
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

function createTestApp() {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
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
