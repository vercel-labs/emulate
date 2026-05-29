import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getClerkStore } from "../index.js";
import { clerkTestSecretKey, startClerkTestEmulator, type ClerkTestEmulator } from "./helpers.js";

describe("Clerk plugin - FAPI (Frontend API)", () => {
  let emulator: ClerkTestEmulator;

  beforeAll(async () => {
    emulator = await startClerkTestEmulator();
  });

  afterAll(async () => {
    await emulator?.close();
  });

  it("POST /v1/dev_browser returns a dev browser JWT", async () => {
    const res = await fetch(`${emulator.url}/v1/dev_browser`, { method: "POST" });
    expect(res.ok).toBe(true);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.id).toBeTruthy();
    expect(res.headers.get("clerk-db-jwt")).toBeTruthy();
  });

  it("GET /v1/environment returns environment config", async () => {
    const res = await fetch(`${emulator.url}/v1/environment`);
    expect(res.ok).toBe(true);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.response).toBeDefined();
    expect(body.client).toBeDefined();

    const env = body.response as Record<string, unknown>;
    expect(env.display_config).toBeDefined();
    expect(env.user_settings).toBeDefined();
    expect(env.organization_settings).toBeDefined();
    expect((env.display_config as any).instance_environment_type).toBe("development");
  });

  it("GET /v1/client returns client state", async () => {
    const res = await fetch(`${emulator.url}/v1/client`);
    expect(res.ok).toBe(true);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.response).toBeDefined();

    const client = body.response as Record<string, unknown>;
    expect(client.object).toBe("client");
    expect(client.id).toBe("client_emulate");
    expect(Array.isArray(client.sessions)).toBe(true);
  });

  it("sign-in flow: identifier → password → session", async () => {
    // Step 1: Create sign-in with identifier
    const createRes = await fetch(`${emulator.url}/v1/client/sign_ins`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: "alice@example.com" }),
    });
    expect(createRes.ok).toBe(true);
    const createBody = (await createRes.json()) as { response: Record<string, unknown>; client: Record<string, unknown> };
    const signIn = createBody.response;
    expect(signIn.object).toBe("sign_in");
    expect(signIn.status).toBe("needs_first_factor");
    expect((signIn.supported_first_factors as any[])[0].strategy).toBe("password");

    // Step 2: Attempt first factor with password
    const attemptRes = await fetch(`${emulator.url}/v1/client/sign_ins/${signIn.id}/attempt_first_factor`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ strategy: "password", password: "alice123" }),
    });
    expect(attemptRes.ok).toBe(true);
    const attemptBody = (await attemptRes.json()) as { response: Record<string, unknown>; client: Record<string, unknown> };
    const completed = attemptBody.response;
    expect(completed.status).toBe("complete");
    expect(completed.created_session_id).toMatch(/^sess_/);

    // Step 3: Verify client now has the session
    const client = attemptBody.client as { sessions: Array<Record<string, unknown>>; last_active_session_id: string };
    expect(client.sessions.length).toBeGreaterThanOrEqual(1);
    expect(client.last_active_session_id).toBe(completed.created_session_id);
  });

  it("sign-in rejects wrong password", async () => {
    const createRes = await fetch(`${emulator.url}/v1/client/sign_ins`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: "alice@example.com" }),
    });
    const createBody = (await createRes.json()) as { response: Record<string, unknown> };
    const signIn = createBody.response;

    const attemptRes = await fetch(`${emulator.url}/v1/client/sign_ins/${signIn.id}/attempt_first_factor`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ strategy: "password", password: "wrong" }),
    });
    expect(attemptRes.status).toBe(422);
    const body = (await attemptRes.json()) as { errors: Array<{ code: string }> };
    expect(body.errors[0].code).toBe("form_password_incorrect");
  });

  it("sign-in rejects unknown identifier", async () => {
    const res = await fetch(`${emulator.url}/v1/client/sign_ins`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: "nobody@example.com" }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { errors: Array<{ code: string }> };
    expect(body.errors[0].code).toBe("form_identifier_not_found");
  });

  it("FAPI session token creation", async () => {
    // Sign in first
    const createRes = await fetch(`${emulator.url}/v1/client/sign_ins`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: "alice@example.com" }),
    });
    const { response: signIn } = (await createRes.json()) as { response: Record<string, unknown> };

    const attemptRes = await fetch(`${emulator.url}/v1/client/sign_ins/${signIn.id}/attempt_first_factor`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ strategy: "password", password: "alice123" }),
    });
    const { response: completed } = (await attemptRes.json()) as { response: Record<string, unknown> };
    const sessionId = completed.created_session_id as string;

    // Get token via FAPI path
    const tokenRes = await fetch(`${emulator.url}/v1/client/sessions/${sessionId}/tokens`, {
      method: "POST",
    });
    expect(tokenRes.ok).toBe(true);
    const tokenBody = (await tokenRes.json()) as { object: string; jwt: string };
    expect(tokenBody.object).toBe("token");
    expect(tokenBody.jwt).toBeTruthy();
  });

  it("session touch", async () => {
    const cs = getClerkStore(emulator.store);
    const session = cs.sessions.all().find((s) => s.status === "active");
    if (!session) return;

    const res = await fetch(`${emulator.url}/v1/client/sessions/${session.clerk_id}/touch`, {
      method: "POST",
    });
    expect(res.ok).toBe(true);
    const body = (await res.json()) as { response: Record<string, unknown>; client: Record<string, unknown> };
    expect(body.client).toBeDefined();
  });

  async function form(url: string, fields: Record<string, string>) {
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    });
  }

  describe("email-code sign-in", () => {
    it("create exposes an email_code first factor with email_address_id", async () => {
      const res = await form(`${emulator.url}/v1/client/sign_ins`, { identifier: "alice@example.com" });
      const { response } = (await res.json()) as { response: any };
      expect(response.status).toBe("needs_first_factor");
      const emailFactor = response.supported_first_factors.find((f: any) => f.strategy === "email_code");
      expect(emailFactor).toBeDefined();
      expect(emailFactor.email_address_id).toMatch(/^idn_/);
    });

    it("prepare then attempt with correct code completes", async () => {
      const createRes = await form(`${emulator.url}/v1/client/sign_ins`, { identifier: "alice@example.com" });
      const { response: signIn } = (await createRes.json()) as { response: any };

      const prepRes = await form(`${emulator.url}/v1/client/sign_ins/${signIn.id}/prepare_first_factor`, {
        strategy: "email_code",
        email_address_id: signIn.supported_first_factors.find((f: any) => f.strategy === "email_code").email_address_id,
      });
      const { response: prepared } = (await prepRes.json()) as { response: any };
      expect(prepared.first_factor_verification.status).toBe("unverified");

      const attemptRes = await form(`${emulator.url}/v1/client/sign_ins/${signIn.id}/attempt_first_factor`, {
        strategy: "email_code",
        code: "424242",
      });
      const { response: done } = (await attemptRes.json()) as { response: any };
      expect(done.status).toBe("complete");
      expect(done.created_session_id).toMatch(/^sess_/);
    });

    it("rejects an incorrect email code", async () => {
      const createRes = await form(`${emulator.url}/v1/client/sign_ins`, { identifier: "alice@example.com" });
      const { response: signIn } = (await createRes.json()) as { response: any };

      const res = await form(`${emulator.url}/v1/client/sign_ins/${signIn.id}/attempt_first_factor`, {
        strategy: "email_code",
        code: "000000",
      });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { errors: Array<{ code: string }> };
      expect(body.errors[0].code).toBe("form_code_incorrect");
    });
  });

  describe("MFA (second factor)", () => {
    it("password sign-in for a TOTP user returns needs_second_factor, then completes", async () => {
      const createRes = await form(`${emulator.url}/v1/client/sign_ins`, {
        identifier: "mfa@example.com",
        password: "mfa12345",
      });
      const { response: signIn } = (await createRes.json()) as { response: any };
      expect(signIn.status).toBe("needs_second_factor");
      expect(signIn.supported_second_factors.some((f: any) => f.strategy === "totp")).toBe(true);
      expect(signIn.created_session_id).toBeNull();

      const mfaRes = await form(`${emulator.url}/v1/client/sign_ins/${signIn.id}/attempt_second_factor`, {
        strategy: "totp",
        code: "424242",
      });
      const { response: done } = (await mfaRes.json()) as { response: any };
      expect(done.status).toBe("complete");
      expect(done.created_session_id).toMatch(/^sess_/);
    });

    it("rejects an incorrect TOTP code", async () => {
      const createRes = await form(`${emulator.url}/v1/client/sign_ins`, {
        identifier: "mfa@example.com",
        password: "mfa12345",
      });
      const { response: signIn } = (await createRes.json()) as { response: any };

      const res = await form(`${emulator.url}/v1/client/sign_ins/${signIn.id}/attempt_second_factor`, {
        strategy: "totp",
        code: "999999",
      });
      expect(res.status).toBe(422);
    });
  });

  describe("sign-up", () => {
    it("create → prepare → attempt creates a user and session", async () => {
      const email = `signup-${Date.now()}@example.com`;
      const createRes = await form(`${emulator.url}/v1/client/sign_ups`, {
        email_address: email,
        password: "newpass123",
        first_name: "New",
        last_name: "User",
      });
      const { response: signUp } = (await createRes.json()) as { response: any };
      expect(signUp.status).toBe("missing_requirements");
      expect(signUp.unverified_fields).toContain("email_address");

      await form(`${emulator.url}/v1/client/sign_ups/${signUp.id}/prepare_verification`, { strategy: "email_code" });

      const attemptRes = await form(`${emulator.url}/v1/client/sign_ups/${signUp.id}/attempt_verification`, {
        strategy: "email_code",
        code: "424242",
      });
      const { response: done } = (await attemptRes.json()) as { response: any };
      expect(done.status).toBe("complete");
      expect(done.created_session_id).toMatch(/^sess_/);

      const cs = getClerkStore(emulator.store);
      const created = cs.emailAddresses.findOneBy("email_address", email);
      expect(created).toBeDefined();
      expect(created!.verification_status).toBe("verified");
    });

    it("rejects a duplicate email", async () => {
      const res = await form(`${emulator.url}/v1/client/sign_ups`, {
        email_address: "alice@example.com",
        password: "whatever1",
      });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { errors: Array<{ code: string }> };
      expect(body.errors[0].code).toBe("form_identifier_exists");
    });

    it("rejects an incorrect verification code", async () => {
      const createRes = await form(`${emulator.url}/v1/client/sign_ups`, {
        email_address: `bad-${Date.now()}@example.com`,
        password: "newpass123",
      });
      const { response: signUp } = (await createRes.json()) as { response: any };
      const res = await form(`${emulator.url}/v1/client/sign_ups/${signUp.id}/attempt_verification`, {
        strategy: "email_code",
        code: "111111",
      });
      expect(res.status).toBe(422);
    });
  });

  describe("organization memberships", () => {
    it("returns paginated {data,total_count} for the session user", async () => {
      const cs = getClerkStore(emulator.store);
      const alice = cs.users.all().find((u) => u.first_name === "Alice")!;
      const sessionRes = await fetch(`${emulator.url}/v1/sessions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${clerkTestSecretKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: alice.clerk_id }),
      });
      const session = (await sessionRes.json()) as { id: string };

      const res = await fetch(`${emulator.url}/v1/me/organization_memberships?_clerk_session_id=${session.id}`);
      expect(res.ok).toBe(true);
      const { response } = (await res.json()) as { response: { data: any[]; total_count: number } };
      expect(Array.isArray(response.data)).toBe(true);
      expect(response.total_count).toBe(response.data.length);
      expect(response.data[0].organization.slug).toBe("acme");
    });
  });
});
