import { createCipheriv, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendCodeAction, signOutAction, verifyCodeAction } from "../actions";
import { encodePendingSignIn, encodeSession, getPendingSignIn, getSession } from "@/lib/session";

const { cookieValues, cookieStore, sendEmail } = vi.hoisted(() => {
  const cookieValues = new Map<string, string>();
  return {
    cookieValues,
    cookieStore: {
      get: vi.fn((name: string) => {
        const value = cookieValues.get(name);
        return value === undefined ? undefined : { value };
      }),
      set: vi.fn((name: string, value: string) => cookieValues.set(name, value)),
      delete: vi.fn((name: string) => cookieValues.delete(name)),
    },
    sendEmail: vi.fn(),
  };
});

vi.mock("next/headers", () => ({ cookies: async () => cookieStore }));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`Redirect: ${path}`);
  },
}));
vi.mock("@/lib/resend", () => ({ resend: { emails: { send: sendEmail } } }));

const TEST_SECRET = "a1".repeat(32);
const email = "recipient@example.com";

function form(field: string, value: string): FormData {
  const formData = new FormData();
  formData.set(field, value);
  return formData;
}

function pending() {
  return { email, code: "123456", expiresAt: Date.now() + 600_000 };
}

// Create authenticated but invalid payloads to exercise validation after decryption.
function encryptedFixture(name: string, value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(TEST_SECRET, "hex"), iv);
  cipher.setAAD(Buffer.from(name));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url");
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  vi.stubEnv("AUTH_SECRET", TEST_SECRET);
  vi.stubEnv("NODE_ENV", "test");
  cookieValues.clear();
  vi.clearAllMocks();
  sendEmail.mockResolvedValue({ error: null });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("magic link verification", () => {
  it("only signs in after submitting the code sent to the requested email", async () => {
    await expect(sendCodeAction(null, form("email", email))).rejects.toThrow("Redirect: /verify");
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: email }));
    const message = sendEmail.mock.calls[0][0];
    const code = message.html.match(/\b\d{6}\b/)?.[0];
    expect(code).toMatch(/^\d{6}$/);
    expect(cookieStore.set).toHaveBeenCalledWith(
      "pending_signin",
      expect.any(String),
      expect.objectContaining({ httpOnly: true, secure: false, sameSite: "lax", maxAge: 600 }),
    );
    expect(cookieValues.has("session")).toBe(false);

    await expect(verifyCodeAction(null, form("code", code!))).rejects.toThrow("Redirect: /dashboard");
    expect(cookieValues.has("pending_signin")).toBe(false);
    expect(cookieStore.set).toHaveBeenCalledWith(
      "session",
      expect.any(String),
      expect.objectContaining({ httpOnly: true, secure: false, sameSite: "lax", maxAge: 86400 }),
    );
    expect(await getSession()).toEqual({ email, signedInAt: new Date().toISOString() });
    expect(await verifyCodeAction(null, form("code", code!))).toEqual({
      error: "No pending sign-in. Please start over.",
    });

    await expect(signOutAction()).rejects.toThrow("Redirect: /");
    expect(await getSession()).toBeNull();
  });

  it("rejects the reported forged pending cookie without issuing a session", async () => {
    const forged = { email: "victim@example.com", code: "123456", expiresAt: 9999999999999 };
    cookieValues.set("pending_signin", Buffer.from(JSON.stringify(forged)).toString("base64url"));

    expect(await getPendingSignIn()).toBeNull();
    expect(await verifyCodeAction(null, form("code", forged.code))).toEqual({
      error: "No pending sign-in. Please start over.",
    });
    expect(cookieStore.set).not.toHaveBeenCalled();
    expect(cookieValues.has("session")).toBe(false);
  });

  it("rejects an incorrect code for an authentic challenge", async () => {
    cookieValues.set("pending_signin", encodePendingSignIn(pending()));
    expect(await verifyCodeAction(null, form("code", "654321"))).toEqual({
      error: "Invalid code. Please try again.",
    });
    expect(cookieStore.set).not.toHaveBeenCalled();
    expect(cookieValues.has("pending_signin")).toBe(true);
  });

  it("rejects an expired challenge even if its code matches", async () => {
    cookieValues.set("pending_signin", encodePendingSignIn(pending()));
    vi.advanceTimersByTime(600_000);
    expect(await getPendingSignIn()).toBeNull();
    expect(await verifyCodeAction(null, form("code", "123456"))).toEqual({
      error: "No pending sign-in. Please start over.",
    });
    expect(cookieStore.set).not.toHaveBeenCalled();
  });

  it("does not set a challenge when sending the email fails", async () => {
    sendEmail.mockResolvedValue({ error: { message: "Email unavailable" } });
    expect(await sendCodeAction(null, form("email", email))).toEqual({ error: "Email unavailable" });
    expect(cookieStore.set).not.toHaveBeenCalled();
  });

  it("uses secure cookies in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await expect(sendCodeAction(null, form("email", email))).rejects.toThrow("Redirect: /verify");
    expect(cookieStore.set).toHaveBeenCalledWith(
      "pending_signin",
      expect.any(String),
      expect.objectContaining({ secure: true }),
    );
    const challenge = await getPendingSignIn();
    await expect(verifyCodeAction(null, form("code", challenge!.code))).rejects.toThrow("Redirect: /dashboard");
    expect(cookieStore.set).toHaveBeenCalledWith(
      "session",
      expect.any(String),
      expect.objectContaining({ secure: true }),
    );
  });
});

describe("authenticated cookies", () => {
  it("keeps the challenge private and uses a fresh nonce for each cookie", async () => {
    const challenge = pending();
    const raw = encodePendingSignIn(challenge);
    const bytes = Buffer.from(raw, "base64url");
    expect(bytes.includes(Buffer.from(challenge.email))).toBe(false);
    expect(bytes.includes(Buffer.from(challenge.code))).toBe(false);
    expect(encodePendingSignIn(challenge)).not.toBe(raw);
    cookieValues.set("pending_signin", raw);
    expect(await getPendingSignIn()).toEqual(challenge);
  });

  it.each([
    ["nonce", 0],
    ["authentication tag", 12],
    ["ciphertext", 28],
  ])("rejects a modified %s", async (_part, offset) => {
    const bytes = Buffer.from(encodePendingSignIn(pending()), "base64url");
    bytes[offset as number] ^= 1;
    cookieValues.set("pending_signin", bytes.toString("base64url"));
    expect(await verifyCodeAction(null, form("code", "123456"))).toEqual({
      error: "No pending sign-in. Please start over.",
    });
    expect(cookieStore.set).not.toHaveBeenCalled();
  });

  it("binds cookies to their purpose", async () => {
    const validForBothCookies = { ...pending(), signedInAt: new Date().toISOString() };
    cookieValues.set("session", encryptedFixture("pending_signin", validForBothCookies));
    cookieValues.set("pending_signin", encryptedFixture("session", validForBothCookies));
    expect(await getSession()).toBeNull();
    expect(await getPendingSignIn()).toBeNull();
  });

  it("rejects a forged unsigned session", async () => {
    const forged = { email: "victim@example.com", signedInAt: new Date().toISOString() };
    cookieValues.set("session", Buffer.from(JSON.stringify(forged)).toString("base64url"));
    expect(await getSession()).toBeNull();
  });

  it("rejects a modified session", async () => {
    const bytes = Buffer.from(encodeSession({ email, signedInAt: new Date().toISOString() }), "base64url");
    bytes[28] ^= 1;
    cookieValues.set("session", bytes.toString("base64url"));
    expect(await getSession()).toBeNull();
  });

  it("checks session expiry on the server", async () => {
    cookieValues.set("session", encodeSession({ email, signedInAt: new Date().toISOString() }));
    vi.advanceTimersByTime(86_400_000 - 1);
    expect(await getSession()).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(await getSession()).toBeNull();
  });

  it("invalidates existing cookies after secret rotation", async () => {
    cookieValues.set("pending_signin", encodePendingSignIn(pending()));
    cookieValues.set("session", encodeSession({ email, signedInAt: new Date().toISOString() }));
    vi.stubEnv("AUTH_SECRET", "b2".repeat(32));
    expect(await getPendingSignIn()).toBeNull();
    expect(await getSession()).toBeNull();
  });

  it.each([
    ["empty", ""],
    ["invalid base64url", "not a cookie"],
    ["truncated", "e30"],
    ["oversized", "a".repeat(4097)],
  ])("rejects a %s cookie", async (_kind, raw) => {
    cookieValues.set("pending_signin", raw);
    cookieValues.set("session", raw);
    expect(await getPendingSignIn()).toBeNull();
    expect(await getSession()).toBeNull();
  });

  it.each([
    null,
    [],
    {},
    { email, code: "123456" },
    { email, code: "123456", expiresAt: "9999999999999" },
    { email, code: "123456", expiresAt: null },
    { email, code: "123456", expiresAt: 9999999999999.5 },
    { email: 123, code: "123456", expiresAt: 9999999999999 },
    { email: "", code: "123456", expiresAt: 9999999999999 },
    { email, code: 123456, expiresAt: 9999999999999 },
    { email, code: "12345", expiresAt: 9999999999999 },
  ])("rejects an invalid authenticated challenge: %j", async (value) => {
    cookieValues.set("pending_signin", encryptedFixture("pending_signin", value));
    expect(await getPendingSignIn()).toBeNull();
  });

  it.each([
    {},
    { email, signedInAt: new Date().toISOString() },
    { email, signedInAt: "", expiresAt: 9999999999999 },
    { email: 123, signedInAt: "2026-01-01T00:00:00.000Z", expiresAt: 9999999999999 },
  ])("rejects an invalid authenticated session: %j", async (value) => {
    cookieValues.set("session", encryptedFixture("session", value));
    expect(await getSession()).toBeNull();
  });

  it.each([undefined, "", "too-short", "g".repeat(64)])("fails closed with an invalid secret: %s", async (secret) => {
    vi.stubEnv("AUTH_SECRET", secret);
    await expect(sendCodeAction(null, form("email", email))).rejects.toThrow("AUTH_SECRET");
    expect(sendEmail).not.toHaveBeenCalled();
    expect(cookieStore.set).not.toHaveBeenCalled();
    expect(() => encodeSession({ email, signedInAt: new Date().toISOString() })).toThrow("AUTH_SECRET");
    cookieValues.set("pending_signin", "e30");
    await expect(getPendingSignIn()).rejects.toThrow("AUTH_SECRET");
  });
});
