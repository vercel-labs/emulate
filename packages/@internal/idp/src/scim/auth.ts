import { timingSafeEqual } from "crypto";
import type { Context, Next } from "hono";
import type { Store } from "@internal/core";
import { scimError } from "./response.js";

export function scimAuthMiddleware(store: Store): (c: Context, next: Next) => Promise<Response | void> {
  return async (c: Context, next: Next): Promise<Response | void> => {
    const expectedToken = store.getData<string>("idp.scim.bearerToken");

    if (!expectedToken) {
      // No token configured = open access (dev convenience)
      await next();
      return;
    }

    const authHeader = c.req.header("Authorization") ?? "";
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();

    if (!token) {
      return new Response(JSON.stringify(scimError(401, "Bearer token required")), {
        status: 401,
        headers: { "Content-Type": "application/scim+json" },
      });
    }

    // Constant-time comparison
    const tokenBuf = Buffer.from(token);
    const expectedBuf = Buffer.from(expectedToken);
    if (tokenBuf.length !== expectedBuf.length || !timingSafeEqual(tokenBuf, expectedBuf)) {
      return new Response(JSON.stringify(scimError(401, "Invalid bearer token")), {
        status: 401,
        headers: { "Content-Type": "application/scim+json" },
      });
    }

    await next();
  };
}
