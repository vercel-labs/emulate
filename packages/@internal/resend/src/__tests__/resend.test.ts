import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { Store, WebhookDispatcher, authMiddleware, type TokenMap } from "@internal/core";
import { resendPlugin, seedFromConfig } from "../index.js";

const base = "http://localhost:4000";

function createTestApp() {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map();
  tokenMap.set("re_test_token", {
    login: "api-key-user",
    id: 1,
    scopes: [],
  });

  const app = new Hono();
  app.use("*", authMiddleware(tokenMap));
  resendPlugin.register(app as any, store, webhooks, base, tokenMap);
  resendPlugin.seed?.(store, base);

  return { app, store, webhooks, tokenMap };
}

function authHeaders(): HeadersInit {
  return { Authorization: "Bearer re_test_token" };
}

function jsonHeaders(): HeadersInit {
  return {
    Authorization: "Bearer re_test_token",
    "Content-Type": "application/json",
  };
}

describe("Resend plugin integration", () => {
  let app: Hono;

  beforeEach(() => {
    app = createTestApp().app;
  });

  // --- Emails ---

  it("POST /emails sends an email and returns id", async () => {
    const res = await app.request(`${base}/emails`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        from: "sender@test.example.com",
        to: "recipient@example.com",
        subject: "Hello",
        html: "<p>World</p>",
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { id: string };
    expect(body.id).toBeDefined();
    expect(typeof body.id).toBe("string");
  });

  it("GET /emails/:id returns email with all fields", async () => {
    const sendRes = await app.request(`${base}/emails`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        from: "sender@test.example.com",
        to: ["a@example.com", "b@example.com"],
        subject: "Test Subject",
        html: "<p>Body</p>",
        text: "Body",
      }),
    });
    const { id } = await sendRes.json() as { id: string };

    const res = await app.request(`${base}/emails/${id}`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const email = await res.json() as Record<string, unknown>;
    expect(email.object).toBe("email");
    expect(email.id).toBe(id);
    expect(email.from).toBe("sender@test.example.com");
    expect(email.to).toEqual(["a@example.com", "b@example.com"]);
    expect(email.subject).toBe("Test Subject");
    expect(email.html).toBe("<p>Body</p>");
    expect(email.text).toBe("Body");
    expect(email.last_event).toBe("sent");
    expect(email.created_at).toBeDefined();
  });

  it("GET /emails lists emails with pagination structure", async () => {
    await app.request(`${base}/emails`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ from: "a@test.com", to: "b@test.com", subject: "One" }),
    });
    await app.request(`${base}/emails`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ from: "a@test.com", to: "b@test.com", subject: "Two" }),
    });

    const res = await app.request(`${base}/emails`, { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = await res.json() as { object: string; has_more: boolean; data: unknown[] };
    expect(body.object).toBe("list");
    expect(typeof body.has_more).toBe("boolean");
    expect(body.data.length).toBe(2);
  });

  it("POST /emails/batch sends batch emails", async () => {
    const res = await app.request(`${base}/emails/batch`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify([
        { from: "a@test.com", to: "b@test.com", subject: "Batch 1", html: "<p>1</p>" },
        { from: "a@test.com", to: "c@test.com", subject: "Batch 2", html: "<p>2</p>" },
      ]),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { data: Array<{ id: string }> };
    expect(body.data).toHaveLength(2);
    expect(body.data[0].id).toBeDefined();
    expect(body.data[1].id).toBeDefined();
  });

  it("POST /emails/:id/cancel cancels a scheduled email", async () => {
    const sendRes = await app.request(`${base}/emails`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        from: "a@test.com",
        to: "b@test.com",
        subject: "Scheduled",
        html: "<p>Later</p>",
        scheduled_at: "2025-12-01T00:00:00Z",
      }),
    });
    const { id } = await sendRes.json() as { id: string };

    // Verify it's scheduled
    const getRes = await app.request(`${base}/emails/${id}`, { headers: authHeaders() });
    const emailBefore = await getRes.json() as { last_event: string };
    expect(emailBefore.last_event).toBe("scheduled");

    // Cancel
    const cancelRes = await app.request(`${base}/emails/${id}/cancel`, {
      method: "POST",
      headers: authHeaders(),
    });
    expect(cancelRes.status).toBe(200);
    const canceled = await cancelRes.json() as { last_event: string };
    expect(canceled.last_event).toBe("canceled");
  });

  // --- Domains ---

  it("POST /domains creates a domain with DNS records", async () => {
    const res = await app.request(`${base}/domains`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ name: "mydomain.com" }),
    });
    expect(res.status).toBe(200);
    const domain = await res.json() as { object: string; name: string; records: unknown[]; status: string };
    expect(domain.object).toBe("domain");
    expect(domain.name).toBe("mydomain.com");
    expect(domain.status).toBe("not_started");
    expect(domain.records).toHaveLength(3);
  });

  it("POST /domains/:id/verify sets domain status to verified", async () => {
    const createRes = await app.request(`${base}/domains`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ name: "verify-test.com" }),
    });
    const { id } = await createRes.json() as { id: string };

    const verifyRes = await app.request(`${base}/domains/${id}/verify`, {
      method: "POST",
      headers: authHeaders(),
    });
    expect(verifyRes.status).toBe(200);
    const verified = await verifyRes.json() as { status: string; records: Array<{ status: string }> };
    expect(verified.status).toBe("verified");
    expect(verified.records.every((r) => r.status === "verified")).toBe(true);
  });

  it("DELETE /domains/:id returns deleted response", async () => {
    const createRes = await app.request(`${base}/domains`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ name: "delete-test.com" }),
    });
    const { id } = await createRes.json() as { id: string };

    const deleteRes = await app.request(`${base}/domains/${id}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    expect(deleteRes.status).toBe(200);
    const body = await deleteRes.json() as { object: string; id: string; deleted: boolean };
    expect(body.object).toBe("domain");
    expect(body.id).toBe(id);
    expect(body.deleted).toBe(true);
  });

  // --- API Keys ---

  it("POST /api-keys creates key with re_ prefix token", async () => {
    const res = await app.request(`${base}/api-keys`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ name: "My Key" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { id: string; token: string };
    expect(body.id).toBeDefined();
    expect(body.token).toMatch(/^re_/);
  });

  it("GET /api-keys lists keys without token field", async () => {
    await app.request(`${base}/api-keys`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ name: "Listed Key" }),
    });

    const res = await app.request(`${base}/api-keys`, { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = await res.json() as { object: string; data: Array<Record<string, unknown>> };
    expect(body.object).toBe("list");
    // The list response should not include the token
    for (const key of body.data) {
      expect(key).not.toHaveProperty("token");
    }
  });

  // --- Contacts ---

  it("POST /contacts creates a contact", async () => {
    const res = await app.request(`${base}/contacts`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        email: "contact@example.com",
        first_name: "Jane",
        last_name: "Doe",
      }),
    });
    expect(res.status).toBe(200);
    const contact = await res.json() as { object: string; email: string; first_name: string };
    expect(contact.object).toBe("contact");
    expect(contact.email).toBe("contact@example.com");
    expect(contact.first_name).toBe("Jane");
  });

  it("GET /contacts/:email retrieves contact by email", async () => {
    await app.request(`${base}/contacts`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ email: "lookup@example.com", first_name: "Lookup" }),
    });

    const res = await app.request(`${base}/contacts/lookup@example.com`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const contact = await res.json() as { email: string; first_name: string };
    expect(contact.email).toBe("lookup@example.com");
    expect(contact.first_name).toBe("Lookup");
  });

  it("DELETE /contacts/:id uses 'contact' field not 'id' in response", async () => {
    const createRes = await app.request(`${base}/contacts`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ email: "delete-me@example.com" }),
    });
    const { id } = await createRes.json() as { id: string };

    const deleteRes = await app.request(`${base}/contacts/${id}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    expect(deleteRes.status).toBe(200);
    const body = await deleteRes.json() as { object: string; contact: string; deleted: boolean };
    expect(body.object).toBe("contact");
    expect(body.contact).toBe(id);
    expect(body.deleted).toBe(true);
    expect(body).not.toHaveProperty("id");
  });

  // --- Audiences ---

  it("POST /audiences creates an audience", async () => {
    const res = await app.request(`${base}/audiences`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ name: "Newsletter" }),
    });
    expect(res.status).toBe(200);
    const audience = await res.json() as { object: string; name: string };
    expect(audience.object).toBe("audience");
    expect(audience.name).toBe("Newsletter");
  });

  // --- Webhooks ---

  it("POST /webhooks creates webhook with whsec_ signing secret", async () => {
    const res = await app.request(`${base}/webhooks`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        endpoint: "https://example.com/webhook",
        events: ["email.sent", "email.delivered"],
      }),
    });
    expect(res.status).toBe(200);
    const webhook = await res.json() as { object: string; signing_secret: string; events: string[] };
    expect(webhook.object).toBe("webhook");
    expect(webhook.signing_secret).toMatch(/^whsec_/);
    expect(webhook.events).toEqual(["email.sent", "email.delivered"]);
  });

  // --- Error format ---

  it("returns Resend error format for validation errors", async () => {
    const res = await app.request(`${base}/emails`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(422);
    const body = await res.json() as { statusCode: number; name: string; message: string };
    expect(body.statusCode).toBe(422);
    expect(body.name).toBe("validation_error");
    expect(typeof body.message).toBe("string");
  });

  // --- Pagination ---

  it("pagination returns has_more and respects limit", async () => {
    // Create 3 emails
    for (let i = 0; i < 3; i++) {
      await app.request(`${base}/emails`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ from: "a@test.com", to: "b@test.com", subject: `Email ${i}` }),
      });
    }

    const res = await app.request(`${base}/emails?limit=2`, { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = await res.json() as { object: string; has_more: boolean; data: unknown[] };
    expect(body.object).toBe("list");
    expect(body.data).toHaveLength(2);
    expect(body.has_more).toBe(true);
  });

  // --- Seed defaults ---

  it("seeds a default verified domain", async () => {
    const res = await app.request(`${base}/domains`, { headers: authHeaders() });
    const body = await res.json() as { data: Array<{ name: string; status: string }> };
    const defaultDomain = body.data.find((d) => d.name === "test.example.com");
    expect(defaultDomain).toBeDefined();
    expect(defaultDomain!.status).toBe("verified");
  });

  it("seeds a default API key", async () => {
    const res = await app.request(`${base}/api-keys`, { headers: authHeaders() });
    const body = await res.json() as { data: Array<{ name: string }> };
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    const defaultKey = body.data.find((k) => k.name === "Default API Key");
    expect(defaultKey).toBeDefined();
  });
});
