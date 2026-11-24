import { cookies } from "next/headers";

export const SESSION_COOKIE = "oauth_session";

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

/** Demo only: the cookie is plain base64url with no signature. In production, sign or encrypt it (for example with iron-session or Auth.js). */
export function encodeSession(session: Session): string {
  return Buffer.from(JSON.stringify(session)).toString("base64url");
}
