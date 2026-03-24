import { describe, it, expect } from "vitest";
import { jwtVerify, importJWK } from "jose";
import { createHash, randomBytes } from "crypto";
import {
  generateSigningKeySync,
  importSigningKey,
  createIdToken,
  resolvePath,
  verifyPkce,
} from "../crypto.js";
import type { IdpUser } from "../entities.js";

const mockUser: IdpUser = {
  id: 1,
  uid: "user_abc123",
  email: "alice@example.com",
  email_verified: true,
  name: "Alice Example",
  given_name: "Alice",
  family_name: "Example",
  picture: null,
  locale: "en",
  groups: ["engineering", "admins"],
  roles: ["owner"],
  attributes: { department: "Engineering", employee_id: "E-1001" },
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

describe("generateSigningKeySync", () => {
  it("produces a valid RSA signing key with default kid", () => {
    const key = generateSigningKeySync();
    expect(key.alg).toBe("RS256");
    expect(key.private_key_pem).toContain("-----BEGIN PRIVATE KEY-----");
    expect(key.public_key_jwk.kty).toBe("RSA");
    expect(key.public_key_jwk.n).toBeDefined();
    expect(key.public_key_jwk.e).toBeDefined();
    expect(key.public_key_jwk.alg).toBe("RS256");
    expect(key.public_key_jwk.use).toBe("sig");
    expect(key.public_key_jwk.kid).toBe(key.kid);
    expect(key.active).toBe(true);
    expect(typeof key.kid).toBe("string");
    expect(key.kid.length).toBeGreaterThan(0);
  });

  it("uses provided kid", () => {
    const key = generateSigningKeySync("custom-kid");
    expect(key.kid).toBe("custom-kid");
    expect(key.public_key_jwk.kid).toBe("custom-kid");
  });
});

describe("importSigningKey", () => {
  it("imports a PEM and computes matching JWK", () => {
    const generated = generateSigningKeySync("test-import");
    const imported = importSigningKey(generated.private_key_pem, "imported-kid");
    expect(imported.kid).toBe("imported-kid");
    expect(imported.alg).toBe("RS256");
    expect(imported.public_key_jwk.kty).toBe("RSA");
    expect(imported.public_key_jwk.n).toBe(generated.public_key_jwk.n);
    expect(imported.active).toBe(true);
  });
});

describe("createIdToken", () => {
  it("produces a decodable RS256 JWT with standard claims", async () => {
    const key = generateSigningKeySync("jwt-test");
    const token = await createIdToken(mockUser, "my-client", "test-nonce", "http://localhost:4003", key, 3600, {});

    const pubKey = await importJWK(key.public_key_jwk as Parameters<typeof importJWK>[0], "RS256");
    const { payload, protectedHeader } = await jwtVerify(token, pubKey);

    expect(protectedHeader.alg).toBe("RS256");
    expect(protectedHeader.kid).toBe("jwt-test");
    expect(payload.sub).toBe("user_abc123");
    expect(payload.email).toBe("alice@example.com");
    expect(payload.iss).toBe("http://localhost:4003");
    expect(payload.aud).toBe("my-client");
    expect(payload.nonce).toBe("test-nonce");
    expect(payload.exp).toBeDefined();
    expect(payload.iat).toBeDefined();
  });

  it("includes mapped custom claims", async () => {
    const key = generateSigningKeySync();
    const token = await createIdToken(mockUser, "c", null, "http://localhost", key, 3600, {
      dept: "attributes.department",
      groups: "groups",
    });

    const pubKey = await importJWK(key.public_key_jwk as Parameters<typeof importJWK>[0], "RS256");
    const { payload } = await jwtVerify(token, pubKey);
    expect(payload.dept).toBe("Engineering");
    expect(payload.groups).toEqual(["engineering", "admins"]);
  });

  it("omits nonce when null", async () => {
    const key = generateSigningKeySync();
    const token = await createIdToken(mockUser, "c", null, "http://localhost", key, 3600, {});

    const pubKey = await importJWK(key.public_key_jwk as Parameters<typeof importJWK>[0], "RS256");
    const { payload } = await jwtVerify(token, pubKey);
    expect(payload.nonce).toBeUndefined();
  });
});

describe("resolvePath", () => {
  it("resolves nested dot paths", () => {
    expect(resolvePath({ a: { b: "c" } }, "a.b")).toBe("c");
  });

  it("returns undefined for missing paths", () => {
    expect(resolvePath({ a: 1 }, "missing.path")).toBeUndefined();
  });

  it("resolves top-level arrays", () => {
    expect(resolvePath(mockUser, "groups")).toEqual(["engineering", "admins"]);
  });

  it("resolves attributes", () => {
    expect(resolvePath(mockUser, "attributes.department")).toBe("Engineering");
  });
});

describe("verifyPkce", () => {
  it("validates S256 with correct verifier", () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    expect(verifyPkce(verifier, challenge, "S256")).toBe(true);
  });

  it("rejects S256 with wrong verifier", () => {
    const verifier = "correct-verifier";
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    expect(verifyPkce("wrong-verifier", challenge, "S256")).toBe(false);
  });

  it("validates plain method", () => {
    const verifier = "my-plain-verifier";
    expect(verifyPkce(verifier, verifier, "plain")).toBe(true);
  });

  it("rejects plain with mismatch", () => {
    expect(verifyPkce("a", "b", "plain")).toBe(false);
  });
});
