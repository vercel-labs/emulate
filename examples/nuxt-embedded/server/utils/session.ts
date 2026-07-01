import type { H3Event } from "h3";

const SESSION_COOKIE = "session";

export type Session = {
  provider: string;
  accessToken: string;
  user: {
    name: string;
    email: string;
    login?: string;
    avatar?: string;
  };
};

export function readSession(event: H3Event): Session | null {
  const raw = getCookie(event, SESSION_COOKIE);
  if (!raw) return null;
  try {
    return JSON.parse(Buffer.from(raw, "base64url").toString("utf-8")) as Session;
  } catch {
    return null;
  }
}

// Demo only: plain base64url with no signature. In production, sign or
// encrypt the cookie (e.g. with nuxt-auth-utils or a signed session).
export function writeSession(event: H3Event, session: Session): void {
  const value = Buffer.from(JSON.stringify(session)).toString("base64url");
  setCookie(event, SESSION_COOKIE, value, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60,
  });
}

export function endSession(event: H3Event): void {
  setCookie(event, SESSION_COOKIE, "", { path: "/", maxAge: 0 });
}
