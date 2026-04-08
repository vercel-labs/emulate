import { cookies } from "next/headers";

const SESSION_COOKIE = "session";
const PENDING_COOKIE = "pending_signin";

export type Session = {
  email: string;
  signedInAt: string;
};

interface PendingSignIn {
  email: string;
  code: string;
  expiresAt: number;
}

export async function getSession(): Promise<Session | null> {
  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  if (!raw) return null;
  try {
    return JSON.parse(Buffer.from(raw, "base64url").toString("utf-8"));
  } catch {
    return null;
  }
}

export function encodeSession(session: Session): string {
  return Buffer.from(JSON.stringify(session)).toString("base64url");
}

export async function getPendingSignIn(): Promise<PendingSignIn | null> {
  const cookieStore = await cookies();
  const raw = cookieStore.get(PENDING_COOKIE)?.value;
  if (!raw) return null;
  try {
    const pending = JSON.parse(Buffer.from(raw, "base64url").toString("utf-8")) as PendingSignIn;
    if (Date.now() > pending.expiresAt) return null;
    return pending;
  } catch {
    return null;
  }
}

export function encodePendingSignIn(pending: PendingSignIn): string {
  return Buffer.from(JSON.stringify(pending)).toString("base64url");
}

export function generateCode(): string {
  const digits = Math.floor(100000 + Math.random() * 900000);
  return digits.toString();
}
