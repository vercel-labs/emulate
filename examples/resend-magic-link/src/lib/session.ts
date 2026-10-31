import { createCipheriv, createDecipheriv, randomBytes, randomInt } from "node:crypto";
import { cookies } from "next/headers";

const SESSION_COOKIE = "session";
const PENDING_COOKIE = "pending_signin";
const SESSION_MAX_AGE = 24 * 60 * 60 * 1000;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export type Session = {
  email: string;
  signedInAt: string;
};

interface PendingSignIn {
  email: string;
  code: string;
  expiresAt: number;
}

function getEncryptionKey(): Buffer {
  const secret = process.env.AUTH_SECRET;
  if (!secret || !/^[a-fA-F0-9]{64}$/.test(secret)) {
    throw new Error("AUTH_SECRET must be a 32-byte hex-encoded secret");
  }
  return Buffer.from(secret, "hex");
}

function encodeCookie(name: string, value: object): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", getEncryptionKey(), iv);
  cipher.setAAD(Buffer.from(name));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url");
}

function decodeCookie(name: string, raw: string): Record<string, unknown> | null {
  const key = getEncryptionKey();
  try {
    if (raw.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
    const data = Buffer.from(raw, "base64url");
    if (data.length <= IV_LENGTH + TAG_LENGTH) return null;
    const decipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, IV_LENGTH));
    decipher.setAAD(Buffer.from(name));
    decipher.setAuthTag(data.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH));
    const plaintext = Buffer.concat([decipher.update(data.subarray(IV_LENGTH + TAG_LENGTH)), decipher.final()]);
    const value: unknown = JSON.parse(plaintext.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isUnexpired(expiresAt: unknown): expiresAt is number {
  return typeof expiresAt === "number" && Number.isSafeInteger(expiresAt) && expiresAt > Date.now();
}

export async function getSession(): Promise<Session | null> {
  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  if (!raw) return null;
  const session = decodeCookie(SESSION_COOKIE, raw);
  if (
    !session ||
    typeof session.email !== "string" ||
    !session.email ||
    typeof session.signedInAt !== "string" ||
    !session.signedInAt ||
    !isUnexpired(session.expiresAt)
  ) {
    return null;
  }
  return { email: session.email, signedInAt: session.signedInAt };
}

export function encodeSession(session: Session): string {
  return encodeCookie(SESSION_COOKIE, { ...session, expiresAt: Date.now() + SESSION_MAX_AGE });
}

export async function getPendingSignIn(): Promise<PendingSignIn | null> {
  const cookieStore = await cookies();
  const raw = cookieStore.get(PENDING_COOKIE)?.value;
  if (!raw) return null;
  const pending = decodeCookie(PENDING_COOKIE, raw);
  if (
    !pending ||
    typeof pending.email !== "string" ||
    !pending.email ||
    typeof pending.code !== "string" ||
    !/^\d{6}$/.test(pending.code) ||
    !isUnexpired(pending.expiresAt)
  ) {
    return null;
  }
  return { email: pending.email, code: pending.code, expiresAt: pending.expiresAt };
}

export function encodePendingSignIn(pending: PendingSignIn): string {
  return encodeCookie(PENDING_COOKIE, pending);
}

export function generateCode(): string {
  return randomInt(100000, 1000000).toString();
}
