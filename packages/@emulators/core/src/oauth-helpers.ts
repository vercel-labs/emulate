import { timingSafeEqual } from "crypto";

export function normalizeUri(uri: string): string {
  try {
    const u = new URL(uri);
    return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return uri.replace(/\/+$/, "").split("?")[0];
  }
}

export function matchesRedirectUri(incoming: string, registered: string[]): boolean {
  const normalized = normalizeUri(incoming);
  return registered.some((r) => normalizeUri(r) === normalized);
}

/**
 * Says what is wrong with the client or redirect URI an authorization callback was posted with, as an error page
 * title and message, or null when the client may be sent there. With no clients registered, anything is accepted.
 */
export function callbackRegistrationError(
  clientId: string,
  redirectUri: string,
  clients: ReadonlyArray<{ client_id: string; redirect_uris: string[] }>,
): { title: string; message: string } | null {
  if (clients.length === 0) return null;
  const client = clients.find((entry) => entry.client_id === clientId);
  if (!client) return { title: "Application not found", message: `The client_id '${clientId}' is not registered.` };
  if (!matchesRedirectUri(redirectUri, client.redirect_uris)) {
    return { title: "Redirect URI mismatch", message: "The redirect_uri is not registered for this application." };
  }
  return null;
}

export function constantTimeSecretEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf-8");
  const bufB = Buffer.from(b, "utf-8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function bodyStr(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v) && typeof v[0] === "string") return v[0];
  return "";
}

export function parseCookies(header: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of header.split(";")) {
    const [k, ...v] = part.split("=");
    if (k) cookies[k.trim()] = v.join("=").trim();
  }
  return cookies;
}
