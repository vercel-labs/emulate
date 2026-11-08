import type { Context, Next } from "../http.js";
import { createPublicKey } from "crypto";
import { jwtVerify } from "jose";
import { debug } from "../debug.js";
import type { RateLimiter } from "../rate-limit.js";

export interface AuthUser {
  login: string;
  id: number;
  scopes: string[];
  installation?: AuthInstallation;
}

export interface AuthApp {
  appId: number;
  slug: string;
  name: string;
}

export interface AuthInstallation {
  installationId: number;
  appId: number;
  accountId: number;
  accountType: "User" | "Organization";
  permissions: Record<string, string>;
  repositoryIds: number[];
  repositorySelection: "all" | "selected";
}

export type TokenMap = Map<string, AuthUser>;

export interface TokenEntry {
  token: string;
  login: string;
  id: number;
  scopes: string[];
  installation?: AuthInstallation;
}

export function serializeTokenMap(tokenMap: TokenMap): TokenEntry[] {
  return [...tokenMap.entries()].map(([token, user]) => ({
    token,
    login: user.login,
    id: user.id,
    scopes: user.scopes,
    ...(user.installation ? { installation: user.installation } : {}),
  }));
}

export function restoreTokenMap(tokenMap: TokenMap, tokens: TokenEntry[]): void {
  tokenMap.clear();
  for (const t of tokens) {
    tokenMap.set(t.token, {
      login: t.login,
      id: t.id,
      scopes: t.scopes,
      ...(t.installation ? { installation: t.installation } : {}),
    });
  }
}

export type AppEnv = {
  Variables: {
    authUser?: AuthUser;
    authApp?: AuthApp;
    authToken?: string;
    authScopes?: string[];
    docsUrl?: string;
    rateLimiter?: RateLimiter;
  };
};

export interface AppKeyResolver {
  (appId: number): { privateKey: string; slug: string; name: string } | null;
}

export interface AuthFallback {
  login: string;
  id: number;
  scopes: string[];
}

/** Picks the token carried in Basic credentials, or undefined to treat the request as anonymous. */
export type BasicAuthToken = (
  username: string,
  password: string,
  isKnown: (token: string) => boolean,
) => string | undefined;

/** How an emulator treats a bearer token it does not recognise. */
export type UnknownTokenPolicy =
  | { kind: "fallback"; user: AuthFallback }
  | { kind: "reject"; respond: (c: Context) => Response | undefined; basicToken?: BasicAuthToken };

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function decodeBasic(encoded: string): { username: string; password: string } | null {
  if (!encoded || !BASE64.test(encoded)) return null;
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  return colon < 0
    ? { username: decoded, password: "" }
    : { username: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
}

function presentedToken(header: string, tokens: TokenMap, policy: UnknownTokenPolicy | undefined): string | undefined {
  if (/^(Bearer|token)(?:\s+|$)/i.test(header) || policy?.kind !== "reject") {
    return header.replace(/^(Bearer|token)\s+/i, "").trim();
  }
  const basic = header.match(/^Basic(?:\s+(.*))?$/i);
  if (!basic || !policy.basicToken) return undefined;
  const credentials = decodeBasic(basic[1] ?? "");
  if (!credentials) return "";
  return policy.basicToken(credentials.username, credentials.password, (token) => tokens.has(token));
}

export function authMiddleware(
  tokens: TokenMap,
  appKeyResolver?: AppKeyResolver,
  unknownTokenOrFallback?: UnknownTokenPolicy | AuthFallback,
) {
  const unknownToken: UnknownTokenPolicy | undefined =
    unknownTokenOrFallback && !("kind" in unknownTokenOrFallback)
      ? { kind: "fallback", user: unknownTokenOrFallback }
      : unknownTokenOrFallback;
  return async (c: Context, next: Next) => {
    const authHeader = c.req.header("Authorization");
    const token = authHeader ? presentedToken(authHeader, tokens, unknownToken) : undefined;
    if (token !== undefined) {
      if (token.startsWith("eyJ") && appKeyResolver) {
        try {
          const [, payloadB64] = token.split(".");
          const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString());
          const appId = typeof payload.iss === "string" ? parseInt(payload.iss, 10) : payload.iss;

          if (typeof appId === "number" && !isNaN(appId)) {
            const appInfo = appKeyResolver(appId);
            if (appInfo) {
              const publicKey = createPublicKey(appInfo.privateKey);
              await jwtVerify(token, publicKey, { algorithms: ["RS256"] });
              c.set("authApp", {
                appId,
                slug: appInfo.slug,
                name: appInfo.name,
              } satisfies AuthApp);
            }
          }
        } catch {
          // JWT verification failed
        }
        const rejected = !c.get("authApp") && unknownToken?.kind === "reject" ? unknownToken.respond(c) : undefined;
        if (rejected) return rejected;
      } else {
        let user = tokens.get(token);
        if (!user && unknownToken?.kind === "fallback" && token.length > 0) {
          const fallbackUser = unknownToken.user;
          debug("auth", "fallback user for unknown token", { login: fallbackUser.login, id: fallbackUser.id });
          user = { login: fallbackUser.login, id: fallbackUser.id, scopes: fallbackUser.scopes };
        }
        const rejected = !user && unknownToken?.kind === "reject" ? unknownToken.respond(c) : undefined;
        if (rejected) return rejected;
        if (user) {
          c.set("authUser", user);
          c.set("authToken", token);
          c.set("authScopes", user.scopes);
        }
      }
    }
    await next();
  };
}

export function requireAuth() {
  return async (c: Context, next: Next) => {
    if (!c.get("authUser")) {
      const docsUrl = (c.get("docsUrl") as string | undefined) ?? "https://emulate.dev";
      return c.json(
        {
          message: "Requires authentication",
          documentation_url: docsUrl,
        },
        401,
      );
    }
    await next();
  };
}

export function requireAppAuth() {
  return async (c: Context, next: Next) => {
    if (!c.get("authApp")) {
      const docsUrl = (c.get("docsUrl") as string | undefined) ?? "https://emulate.dev";
      return c.json(
        {
          message: "A JSON web token could not be decoded",
          documentation_url: docsUrl,
        },
        401,
      );
    }
    await next();
  };
}
