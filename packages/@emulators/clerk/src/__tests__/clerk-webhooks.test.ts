import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getClerkStore } from "../index.js";
import { clerkTestSecretKey, startClerkTestEmulator, type ClerkTestEmulator } from "./helpers.js";

interface CapturedRequest {
  url: string;
  body: { type: string; data: Record<string, unknown> };
}

function captureWebhookRequests(): { requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = [];
  const originalFetch = globalThis.fetch;

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith("https://hooks.test/")) {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
        requests.push({ url, body });
        return new Response("ok", { status: 200 });
      }
      return originalFetch(input, init);
    }),
  );

  return { requests };
}

describe("Clerk plugin - webhook emission", () => {
  let emulator: ClerkTestEmulator;
  let capture: { requests: CapturedRequest[] };

  beforeAll(async () => {
    capture = captureWebhookRequests();
    emulator = await startClerkTestEmulator();
    emulator.webhooks.register({
      url: "https://hooks.test/clerk",
      events: ["*"],
      active: true,
      owner: "clerk",
    });
  });

  afterEach(() => {
    capture.requests.length = 0;
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await emulator?.close();
  });

  function authHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${clerkTestSecretKey}`,
      "Content-Type": "application/json",
    };
  }

  it("emits user.created on POST /v1/users", async () => {
    const res = await fetch(`${emulator.url}/v1/users`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        email_address: ["webhook-user@example.com"],
        first_name: "Webhook",
        last_name: "User",
      }),
    });
    expect(res.ok).toBe(true);

    // Wait for async dispatch
    await new Promise((r) => setTimeout(r, 50));

    expect(capture.requests).toHaveLength(1);
    expect(capture.requests[0].body.type).toBe("user.created");
    expect(capture.requests[0].body.data.first_name).toBe("Webhook");
  });

  it("emits user.updated on PATCH /v1/users/:id", async () => {
    const cs = getClerkStore(emulator.store);
    const user = cs.users.all().find((u) => u.first_name === "Alice")!;

    const res = await fetch(`${emulator.url}/v1/users/${user.clerk_id}`, {
      method: "PATCH",
      headers: authHeaders(),
      body: JSON.stringify({ first_name: "Alicia" }),
    });
    expect(res.ok).toBe(true);

    await new Promise((r) => setTimeout(r, 50));

    expect(capture.requests).toHaveLength(1);
    expect(capture.requests[0].body.type).toBe("user.updated");
    expect(capture.requests[0].body.data.first_name).toBe("Alicia");
  });

  it("emits user.deleted on DELETE /v1/users/:id", async () => {
    const createRes = await fetch(`${emulator.url}/v1/users`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ email_address: ["delete-me@example.com"], first_name: "Delete" }),
    });
    const created = (await createRes.json()) as Record<string, unknown>;
    capture.requests.length = 0;

    const res = await fetch(`${emulator.url}/v1/users/${created.id}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    expect(res.ok).toBe(true);

    await new Promise((r) => setTimeout(r, 50));

    expect(capture.requests).toHaveLength(1);
    expect(capture.requests[0].body.type).toBe("user.deleted");
    expect(capture.requests[0].body.data.id).toBe(created.id);
  });

  it("emits organization.created on POST /v1/organizations", async () => {
    const res = await fetch(`${emulator.url}/v1/organizations`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: "Webhook Org" }),
    });
    expect(res.ok).toBe(true);

    await new Promise((r) => setTimeout(r, 50));

    expect(capture.requests).toHaveLength(1);
    expect(capture.requests[0].body.type).toBe("organization.created");
    expect(capture.requests[0].body.data.name).toBe("Webhook Org");
  });

  it("emits org_membership.created on POST memberships", async () => {
    const cs = getClerkStore(emulator.store);
    const org = cs.organizations.findOneBy("slug", "acme")!;

    const userRes = await fetch(`${emulator.url}/v1/users`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ email_address: ["member-hook@example.com"], first_name: "Member" }),
    });
    const user = (await userRes.json()) as Record<string, unknown>;
    capture.requests.length = 0;

    const res = await fetch(`${emulator.url}/v1/organizations/${org.clerk_id}/memberships`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ user_id: user.id, role: "org:member" }),
    });
    expect(res.ok).toBe(true);

    await new Promise((r) => setTimeout(r, 50));

    expect(capture.requests).toHaveLength(1);
    expect(capture.requests[0].body.type).toBe("org_membership.created");
    expect(capture.requests[0].body.data.role).toBe("org:member");
  });

  it("emits org_invitation.created on POST invitations", async () => {
    const cs = getClerkStore(emulator.store);
    const org = cs.organizations.findOneBy("slug", "acme")!;

    const res = await fetch(`${emulator.url}/v1/organizations/${org.clerk_id}/invitations`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ email_address: "invite-hook@example.com", role: "org:member" }),
    });
    expect(res.ok).toBe(true);

    await new Promise((r) => setTimeout(r, 50));

    expect(capture.requests).toHaveLength(1);
    expect(capture.requests[0].body.type).toBe("org_invitation.created");
    expect(capture.requests[0].body.data.email_address).toBe("invite-hook@example.com");
  });

  it("emits org_domain.created and org_domain.deleted", async () => {
    const cs = getClerkStore(emulator.store);
    const org = cs.organizations.findOneBy("slug", "acme")!;

    const createRes = await fetch(`${emulator.url}/v1/organizations/${org.clerk_id}/domains`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: "webhook-domain.com", enrollment_mode: "manual_invitation" }),
    });
    expect(createRes.ok).toBe(true);
    const domain = (await createRes.json()) as Record<string, unknown>;

    await new Promise((r) => setTimeout(r, 50));

    expect(capture.requests).toHaveLength(1);
    expect(capture.requests[0].body.type).toBe("org_domain.created");
    expect(capture.requests[0].body.data.name).toBe("webhook-domain.com");

    capture.requests.length = 0;

    const deleteRes = await fetch(`${emulator.url}/v1/organizations/${org.clerk_id}/domains/${domain.id}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    expect(deleteRes.ok).toBe(true);

    await new Promise((r) => setTimeout(r, 50));

    expect(capture.requests).toHaveLength(1);
    expect(capture.requests[0].body.type).toBe("org_domain.deleted");
  });
});
