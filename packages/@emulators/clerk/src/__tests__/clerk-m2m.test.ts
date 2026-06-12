import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClerkClient } from "@clerk/backend";
import { decodeJwt } from "jose";
import { getClerkStore } from "../index.js";
import {
  clerkTestSecretKey,
  clerkTestMachineKey,
  startClerkTestEmulator,
  type ClerkTestEmulator,
} from "./helpers.js";

describe("Clerk plugin - M2M tokens", () => {
  let emulator: ClerkTestEmulator;

  beforeAll(async () => {
    emulator = await startClerkTestEmulator();
  });

  afterAll(async () => {
    await emulator?.close();
  });

  function authHeaders(key = clerkTestSecretKey): Record<string, string> {
    return {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    };
  }

  describe("HTTP API", () => {
    it("creates a JWT-format M2M token", async () => {
      const res = await fetch(`${emulator.url}/m2m_tokens`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ token_format: "jwt" }),
      });
      expect(res.ok).toBe(true);

      const body = (await res.json()) as Record<string, unknown>;
      expect(body.object).toBe("machine_to_machine_token");
      expect(body.id).toMatch(/^mt_/);
      expect(body.subject).toMatch(/^mch_/);
      expect(body.token).toBeTruthy();
      expect(body.revoked).toBe(false);

      const claims = decodeJwt(body.token as string);
      expect(claims.sub).toMatch(/^mch_/);
      expect(claims.jti).toBe(body.id);
      expect(claims.iss).toBe(emulator.url);
    });

    it("creates an opaque-format M2M token", async () => {
      const res = await fetch(`${emulator.url}/m2m_tokens`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ token_format: "opaque" }),
      });
      expect(res.ok).toBe(true);

      const body = (await res.json()) as Record<string, unknown>;
      expect(body.object).toBe("machine_to_machine_token");
      expect(body.token).toMatch(/^mt_/);
    });

    it("creates a token with custom expiration", async () => {
      const res = await fetch(`${emulator.url}/m2m_tokens`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ token_format: "jwt", seconds_until_expiration: 3600 }),
      });
      expect(res.ok).toBe(true);

      const body = (await res.json()) as Record<string, unknown>;
      expect(body.expiration).toBeTruthy();

      const claims = decodeJwt(body.token as string);
      expect(claims.exp).toBeDefined();
    });

    it("creates a token with custom claims", async () => {
      const res = await fetch(`${emulator.url}/m2m_tokens`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ token_format: "jwt", claims: { service: "billing" } }),
      });
      expect(res.ok).toBe(true);

      const body = (await res.json()) as Record<string, unknown>;
      expect(body.claims).toEqual({ service: "billing" });

      const claims = decodeJwt(body.token as string);
      expect(claims.service).toBe("billing");
    });

    it("verifies an opaque token", async () => {
      const createRes = await fetch(`${emulator.url}/m2m_tokens`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ token_format: "opaque" }),
      });
      const created = (await createRes.json()) as Record<string, unknown>;

      const verifyRes = await fetch(`${emulator.url}/m2m_tokens/verify`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ token: created.token }),
      });
      expect(verifyRes.ok).toBe(true);

      const body = (await verifyRes.json()) as Record<string, unknown>;
      expect(body.id).toBe(created.id);
      expect(body.subject).toBe(created.subject);
    });

    it("rejects verification of unknown token", async () => {
      const res = await fetch(`${emulator.url}/m2m_tokens/verify`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ token: "mt_nonexistent" }),
      });
      expect(res.status).toBe(404);
    });

    it("lists M2M tokens", async () => {
      const res = await fetch(`${emulator.url}/m2m_tokens`, {
        headers: authHeaders(),
      });
      expect(res.ok).toBe(true);

      const body = (await res.json()) as { m2m_tokens: unknown[]; total_count: number };
      expect(body.m2m_tokens.length).toBeGreaterThan(0);
      expect(body.total_count).toBe(body.m2m_tokens.length);
    });

    it("revokes a token", async () => {
      const createRes = await fetch(`${emulator.url}/m2m_tokens`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ token_format: "opaque" }),
      });
      const created = (await createRes.json()) as Record<string, unknown>;

      const revokeRes = await fetch(`${emulator.url}/m2m_tokens/${created.id}/revoke`, {
        method: "POST",
        headers: authHeaders(),
      });
      expect(revokeRes.ok).toBe(true);

      const body = (await revokeRes.json()) as Record<string, unknown>;
      expect(body.revoked).toBe(true);
      expect(body.revocation_reason).toBe("manually_revoked");

      // Verify a revoked token fails
      const verifyRes = await fetch(`${emulator.url}/m2m_tokens/verify`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ token: created.token }),
      });
      expect(verifyRes.status).toBe(401);
    });

    it("authenticates with ak_ machine secret key", async () => {
      const res = await fetch(`${emulator.url}/m2m_tokens`, {
        method: "POST",
        headers: authHeaders(clerkTestMachineKey),
        body: JSON.stringify({ token_format: "jwt" }),
      });
      expect(res.ok).toBe(true);

      const body = (await res.json()) as Record<string, unknown>;
      expect(body.object).toBe("machine_to_machine_token");
    });
  });

  describe("SDK integration", () => {
    it("creates and verifies M2M JWT tokens through the SDK", async () => {
      const clerk = createClerkClient({
        secretKey: clerkTestSecretKey,
        publishableKey: "pk_test_ZW11bGF0ZS5leGFtcGxlLmNvbSQ",
        apiUrl: emulator.url,
      });

      const token = await clerk.m2m.createToken({ tokenFormat: "jwt" });
      expect(token.id).toMatch(/^mt_/);
      expect(token.subject).toMatch(/^mch_/);
      expect(token.token).toBeTruthy();

      // SDK verifies JWT locally via JWKS
      const verified = await clerk.m2m.verify({ token: token.token! });
      expect(verified.id).toBe(token.id);
      expect(verified.subject).toBe(token.subject);
    });
  });
});
