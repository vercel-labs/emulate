import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getClerkStore } from "../index.js";
import { clerkTestSecretKey, startClerkTestEmulator, type ClerkTestEmulator } from "./helpers.js";

describe("Clerk plugin - organization domains", () => {
  let emulator: ClerkTestEmulator;
  let orgId: string;

  beforeAll(async () => {
    emulator = await startClerkTestEmulator();
    const cs = getClerkStore(emulator.store);
    orgId = cs.organizations.findOneBy("slug", "acme")!.clerk_id;
  });

  afterAll(async () => {
    await emulator?.close();
  });

  function authHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${clerkTestSecretKey}`,
      "Content-Type": "application/json",
    };
  }

  it("creates a domain", async () => {
    const res = await fetch(`${emulator.url}/v1/organizations/${orgId}/domains`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: "example.com", enrollment_mode: "manual_invitation", verified: false }),
    });
    expect(res.ok).toBe(true);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.object).toBe("organization_domain");
    expect(body.id).toMatch(/^orgdom_/);
    expect(body.name).toBe("example.com");
    expect(body.organization_id).toBe(orgId);
    expect(body.enrollment_mode).toBe("manual_invitation");
    expect((body.verification as any).status).toBe("unverified");
  });

  it("creates a verified domain by default", async () => {
    const res = await fetch(`${emulator.url}/v1/organizations/${orgId}/domains`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: "verified.com", enrollment_mode: "automatic_invitation" }),
    });
    expect(res.ok).toBe(true);

    const body = (await res.json()) as Record<string, unknown>;
    expect((body.verification as any).status).toBe("verified");
    expect(body.enrollment_mode).toBe("automatic_invitation");
  });

  it("lists domains for an organization", async () => {
    const res = await fetch(`${emulator.url}/v1/organizations/${orgId}/domains`, {
      headers: authHeaders(),
    });
    expect(res.ok).toBe(true);

    const body = (await res.json()) as Array<Record<string, unknown>>;
    expect(body.length).toBeGreaterThanOrEqual(2);
    expect(body.every((d) => d.organization_id === orgId)).toBe(true);
  });

  it("updates a domain enrollment mode", async () => {
    const createRes = await fetch(`${emulator.url}/v1/organizations/${orgId}/domains`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: "update-test.com", enrollment_mode: "manual_invitation" }),
    });
    const created = (await createRes.json()) as Record<string, unknown>;

    const res = await fetch(`${emulator.url}/v1/organizations/${orgId}/domains/${created.id}`, {
      method: "PATCH",
      headers: authHeaders(),
      body: JSON.stringify({ enrollment_mode: "automatic_suggestion" }),
    });
    expect(res.ok).toBe(true);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.enrollment_mode).toBe("automatic_suggestion");
    expect(body.name).toBe("update-test.com");
  });

  it("updates domain verification status", async () => {
    const createRes = await fetch(`${emulator.url}/v1/organizations/${orgId}/domains`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: "verify-test.com", verified: false }),
    });
    const created = (await createRes.json()) as Record<string, unknown>;
    expect((created.verification as any).status).toBe("unverified");

    const res = await fetch(`${emulator.url}/v1/organizations/${orgId}/domains/${created.id}`, {
      method: "PATCH",
      headers: authHeaders(),
      body: JSON.stringify({ verified: true }),
    });
    expect(res.ok).toBe(true);

    const body = (await res.json()) as Record<string, unknown>;
    expect((body.verification as any).status).toBe("verified");
  });

  it("deletes a domain", async () => {
    const createRes = await fetch(`${emulator.url}/v1/organizations/${orgId}/domains`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: "delete-test.com" }),
    });
    const created = (await createRes.json()) as Record<string, unknown>;

    const res = await fetch(`${emulator.url}/v1/organizations/${orgId}/domains/${created.id}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    expect(res.ok).toBe(true);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.deleted).toBe(true);
    expect(body.id).toBe(created.id);
  });

  it("returns 404 for domain in wrong org", async () => {
    const createRes = await fetch(`${emulator.url}/v1/organizations/${orgId}/domains`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: "wrong-org.com" }),
    });
    const created = (await createRes.json()) as Record<string, unknown>;

    const res = await fetch(`${emulator.url}/v1/organizations/org_nonexistent/domains/${created.id}`, {
      method: "PATCH",
      headers: authHeaders(),
      body: JSON.stringify({ enrollment_mode: "automatic_invitation" }),
    });
    expect(res.status).toBe(404);
  });
});
