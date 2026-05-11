import { randomBytes } from "node:crypto";
import type { RouteContext } from "@emulators/core";
import { debug } from "@emulators/core";
import { buildLogEvent } from "../helpers.js";
import {
  AUTH0_ERRORS,
  managementApiError,
  findUserById,
  readJsonObject,
  requireManagementToken,
} from "../route-helpers.js";
import { getAuth0Store } from "../store.js";

export function ticketRoutes({ app, store, baseUrl, tokenMap, webhooks }: RouteContext): void {
  const auth0Store = getAuth0Store(store);

  // Create email verification ticket
  app.post("/api/v2/tickets/email-verification", async (c) => {
    const auth = requireManagementToken(c, tokenMap);
    if (auth instanceof Response) return auth;

    const body = await readJsonObject(c);
    const userId = typeof body.user_id === "string" ? body.user_id : "";
    const resultUrl = typeof body.result_url === "string" ? body.result_url : "";
    const ttlSeconds = typeof body.ttl_sec === "number" ? body.ttl_sec : 432000; // 5 days default

    if (!userId) {
      return managementApiError(c, 400, "Payload validation error: 'user_id' is required.");
    }

    const user = findUserById(auth0Store, userId);
    if (!user) return managementApiError(c, 404, AUTH0_ERRORS.USER_NOT_FOUND);

    const ticketId = randomBytes(16).toString("hex");
    auth0Store.emailVerificationTickets.insert({
      user_id: userId,
      ticket_id: ticketId,
      result_url: resultUrl,
      ttl_seconds: ttlSeconds,
    });

    const ticket = `${baseUrl}/tickets/email-verification?ticket=${ticketId}`;

    debug("auth0.tickets", `[email-verification] user=${userId} ticket=${ticketId.slice(0, 8)}...`);

    return c.json({ ticket });
  });

  // Handle email verification ticket (simulate clicking the link)
  app.get("/tickets/email-verification", async (c) => {
    const ticketId = c.req.query("ticket") ?? "";
    const ticket = auth0Store.emailVerificationTickets.findOneBy("ticket_id", ticketId);
    if (!ticket) {
      return c.text("Invalid or expired ticket", 400);
    }

    const user = findUserById(auth0Store, ticket.user_id);
    if (user) {
      auth0Store.users.update(user.id, { email_verified: true });

      await webhooks.dispatch(
        "sv",
        undefined,
        buildLogEvent("sv", {
          user_id: user.user_id,
          user_name: user.email,
          description: "Successfully consumed email verification link",
          connection: user.connection,
          strategy: "auth0",
          strategy_type: "database",
        }),
        "auth0",
      );
    }

    auth0Store.emailVerificationTickets.delete(ticket.id);

    if (ticket.result_url) {
      return c.redirect(ticket.result_url, 302);
    }
    return c.text("Email verified successfully");
  });
}
