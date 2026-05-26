import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClerkClient } from "@clerk/backend";
import { decodeJwt } from "jose";
import { getClerkStore } from "../index.js";
import { clerkTestSecretKey, startClerkTestEmulator, type ClerkTestEmulator } from "./helpers.js";

// pk_test_ + base64("emulate.example.com$") with trailing = stripped
const TEST_PUBLISHABLE_KEY = "pk_test_ZW11bGF0ZS5leGFtcGxlLmNvbSQ";

describe("Clerk plugin - real @clerk/backend SDK", () => {
  let emulator: ClerkTestEmulator;
  let clerk: ReturnType<typeof createClerkClient>;

  beforeAll(async () => {
    emulator = await startClerkTestEmulator();
    clerk = createClerkClient({
      secretKey: clerkTestSecretKey,
      publishableKey: TEST_PUBLISHABLE_KEY,
      apiUrl: emulator.url,
    });
  });

  afterAll(async () => {
    await emulator?.close();
  });

  async function createSessionJwt(userId: string): Promise<{ jwt: string; sessionId: string }> {
    const headers = {
      Authorization: `Bearer ${clerkTestSecretKey}`,
      "Content-Type": "application/json",
    };

    const sessionRes = await fetch(`${emulator.url}/v1/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ user_id: userId }),
    });
    const session = (await sessionRes.json()) as { id: string };

    const tokenRes = await fetch(`${emulator.url}/v1/sessions/${session.id}/tokens`, {
      method: "POST",
      headers: { Authorization: `Bearer ${clerkTestSecretKey}` },
    });
    const { jwt } = (await tokenRes.json()) as { jwt: string };

    return { jwt, sessionId: session.id };
  }

  it("authenticateRequest verifies emulator-issued JWTs", async () => {
    const cs = getClerkStore(emulator.store);
    const aliceUser = cs.users.all().find((u) => u.first_name === "Alice")!;

    const { jwt, sessionId } = await createSessionJwt(aliceUser.clerk_id);

    const pemRes = await fetch(`${emulator.url}/_emulate/jwt-public-key`);
    const jwtKey = await pemRes.text();

    const request = new Request("https://example.com/api/test", {
      headers: { Authorization: `Bearer ${jwt}` },
    });

    const result = await clerk.authenticateRequest(request, { jwtKey });
    expect(result.isSignedIn).toBe(true);

    const auth = result.toAuth();
    expect(auth.userId).toBe(aliceUser.clerk_id);
    expect(auth.sessionId).toBe(sessionId);
  });

  it("authenticateRequest includes org claims when user has membership", async () => {
    const cs = getClerkStore(emulator.store);
    const aliceUser = cs.users.all().find((u) => u.first_name === "Alice")!;

    const { jwt } = await createSessionJwt(aliceUser.clerk_id);

    const pemRes = await fetch(`${emulator.url}/_emulate/jwt-public-key`);
    const jwtKey = await pemRes.text();

    const request = new Request("https://example.com/api/test", {
      headers: { Authorization: `Bearer ${jwt}` },
    });

    const result = await clerk.authenticateRequest(request, { jwtKey });
    expect(result.isSignedIn).toBe(true);

    const auth = result.toAuth();
    expect(auth.orgId).toMatch(/^org_/);
    expect(auth.orgRole).toBe("org:admin");
    expect(auth.orgSlug).toBe("acme");
  });

  it("authenticateRequest rejects unsigned/invalid tokens", async () => {
    const pemRes = await fetch(`${emulator.url}/_emulate/jwt-public-key`);
    const jwtKey = await pemRes.text();

    const request = new Request("https://example.com/api/test", {
      headers: { Authorization: "Bearer invalid.token.here" },
    });

    const result = await clerk.authenticateRequest(request, { jwtKey });
    expect(result.isSignedIn).toBe(false);
  });

  it("session JWT includes sts claim", async () => {
    const cs = getClerkStore(emulator.store);
    const user = cs.users.all()[0];

    const { jwt } = await createSessionJwt(user.clerk_id);
    const claims = decodeJwt(jwt);
    expect(claims.sts).toBe("active");
  });

  it("serves the public key PEM at /v1/jwt-public-key", async () => {
    const res = await fetch(`${emulator.url}/_emulate/jwt-public-key`);
    expect(res.ok).toBe(true);
    const pem = await res.text();
    expect(pem).toContain("-----BEGIN PUBLIC KEY-----");
    expect(pem).toContain("-----END PUBLIC KEY-----");
  });
});
