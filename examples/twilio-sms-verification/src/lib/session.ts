import { cookies } from "next/headers";

const SESSION_COOKIE = "session";
const PENDING_COOKIE = "pending_verification";

export type Session = {
  phone: string;
  verifiedAt: string;
};

interface PendingVerification {
  phone: string;
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

export async function getPendingVerification(): Promise<PendingVerification | null> {
  const cookieStore = await cookies();
  const raw = cookieStore.get(PENDING_COOKIE)?.value;
  if (!raw) return null;
  try {
    const pending = JSON.parse(Buffer.from(raw, "base64url").toString("utf-8")) as PendingVerification;
    if (Date.now() > pending.expiresAt) return null;
    return pending;
  } catch {
    return null;
  }
}

export function encodePendingVerification(pending: PendingVerification): string {
  return Buffer.from(JSON.stringify(pending)).toString("base64url");
}
