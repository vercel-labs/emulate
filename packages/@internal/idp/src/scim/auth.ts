import { timingSafeEqual } from "crypto";
import type { Context, Next } from "hono";
import type { Store } from "@internal/core";
import { scimError } from "./response.js";

export function scimAuthMiddleware(store: Store) {
  return async (c: Context, next: Next) => {
    const expectedToken = store.getData<string>("idp.scim.bearerToken");

    if (!expectedToken) {
      // No token configured = open access (dev convenience)
      await next();
      return;
    }

    const authHeader = c.req.header("Authorization") ?? "";
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();

    if (!token) {
      return c.json(scimError(401, "Bearer token required"), 401);
    }

    // Constant-time comparison
    const tokenBuf = Buffer.from(token);
    const expectedBuf = Buffer.from(expectedToken);
    if (tokenBuf.length !== expectedBuf.length || !timingSafeEqual(tokenBuf, expectedBuf)) {
      return c.json(scimError(401, "Invalid bearer token"), 401);
    }

    await next();
  };
}
