import { randomBytes } from "crypto";
import type { Context } from "hono";
import type { RouteContext } from "@emulators/core";
import { parseJsonBody } from "@emulators/core";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { getVercelStore } from "../store.js";
import { generateUid } from "../helpers.js";
import type { VercelUser } from "../entities.js";

function vercelErr(c: Context, status: ContentfulStatusCode, code: string, message: string) {
  return c.json({ error: { code, message } }, status);
}

export function apiKeysRoutes({ app, store, tokenMap }: RouteContext): void {
  const vs = getVercelStore(store);

  app.post("/v1/api-keys", async (c) => {
    const auth = c.get("authUser");
    if (!auth) {
      return vercelErr(c, 401, "not_authenticated", "Authentication required");
    }
    const user = vs.users.findOneBy("username", auth.login as VercelUser["username"]);
    if (!user) {
      return vercelErr(c, 403, "forbidden", "User not found");
    }

    const teamId = c.req.query("teamId") ?? null;
    const body = await parseJsonBody(c);
    const name = typeof body.name === "string" ? body.name : "API Key";

    const tokenString = `vercel_api_${randomBytes(24).toString("base64url")}`;
    const uid = generateUid("ak");

    vs.apiKeys.insert({
      uid,
      name,
      teamId,
      userId: user.uid,
      tokenString,
    });

    if (tokenMap) {
      tokenMap.set(tokenString, { login: user.username, id: user.id, scopes: [] });
    }

    return c.json({
      apiKeyString: tokenString,
      apiKey: {
        id: uid,
        name,
        teamId,
        createdAt: Date.now(),
      },
    });
  });

  app.get("/v1/api-keys", (c) => {
    const auth = c.get("authUser");
    if (!auth) {
      return vercelErr(c, 401, "not_authenticated", "Authentication required");
    }
    const user = vs.users.findOneBy("username", auth.login as VercelUser["username"]);
    if (!user) {
      return vercelErr(c, 403, "forbidden", "User not found");
    }

    const teamId = c.req.query("teamId") ?? null;
    const keys = vs.apiKeys.all().filter((k) => {
      if (k.userId !== user.uid) return false;
      if (teamId && k.teamId !== teamId) return false;
      return true;
    });

    return c.json({
      keys: keys.map((k) => ({
        id: k.uid,
        name: k.name,
        teamId: k.teamId,
        createdAt: k.created_at,
      })),
    });
  });

  app.delete("/v1/api-keys/:keyId", (c) => {
    const auth = c.get("authUser");
    if (!auth) {
      return vercelErr(c, 401, "not_authenticated", "Authentication required");
    }
    const user = vs.users.findOneBy("username", auth.login as VercelUser["username"]);
    if (!user) {
      return vercelErr(c, 403, "forbidden", "User not found");
    }

    const keyId = c.req.param("keyId");
    const key = vs.apiKeys.findOneBy("uid", keyId);
    if (!key) {
      return vercelErr(c, 404, "not_found", "API key not found");
    }

    if (key.userId !== user.uid) {
      return vercelErr(c, 403, "forbidden", "Not authorized to delete this API key");
    }

    if (tokenMap) {
      tokenMap.delete(key.tokenString);
    }

    vs.apiKeys.delete(key.id);
    return c.json({});
  });
}
