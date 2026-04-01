import type { RouteContext } from "@emulators/core";
import { generateClerkId, nowUnix } from "../helpers.js";
import {
  clerkError,
  requireSecretKey,
  isAuthResponse,
  deletedResponse,
  emailAddressResponse,
  readJsonBody,
} from "../route-helpers.js";
import { getClerkStore } from "../store.js";

export function emailAddressRoutes({ app, store, tokenMap }: RouteContext): void {
  const cs = getClerkStore(store);

  app.get("/v1/email_addresses/:emailId", (c) => {
    const auth = requireSecretKey(c, tokenMap);
    if (isAuthResponse(auth)) return auth;

    const emailId = c.req.param("emailId");
    const email = cs.emailAddresses.findOneBy("email_id", emailId);
    if (!email) return clerkError(c, 404, "RESOURCE_NOT_FOUND", "Email address not found");

    return c.json(emailAddressResponse(email));
  });

  app.post("/v1/email_addresses", async (c) => {
    const auth = requireSecretKey(c, tokenMap);
    if (isAuthResponse(auth)) return auth;

    const body = await readJsonBody(c);
    const userId = body.user_id as string;
    const emailAddr = body.email_address as string;
    const verified = body.verified as boolean ?? false;
    const primary = body.primary as boolean ?? false;

    if (!userId || !emailAddr) {
      return clerkError(c, 422, "INVALID_REQUEST_BODY", "user_id and email_address are required");
    }

    const user = cs.users.findOneBy("clerk_id", userId);
    if (!user) return clerkError(c, 404, "RESOURCE_NOT_FOUND", "User not found");

    const now = nowUnix();
    const email = cs.emailAddresses.insert({
      email_id: generateClerkId("idn_"),
      email_address: emailAddr,
      user_id: userId,
      verification_status: verified ? "verified" : "unverified",
      verification_strategy: "email_code",
      is_primary: primary,
      reserved: false,
      created_at_unix: now,
      updated_at_unix: now,
    });

    if (primary) {
      for (const existing of cs.emailAddresses.findBy("user_id", userId)) {
        if (existing.email_id !== email.email_id && existing.is_primary) {
          cs.emailAddresses.update(existing.id, { is_primary: false });
        }
      }
      cs.users.update(user.id, { primary_email_address_id: email.email_id, updated_at_unix: now });
    }

    return c.json(emailAddressResponse(email), 200);
  });

  app.patch("/v1/email_addresses/:emailId", async (c) => {
    const auth = requireSecretKey(c, tokenMap);
    if (isAuthResponse(auth)) return auth;

    const emailId = c.req.param("emailId");
    const email = cs.emailAddresses.findOneBy("email_id", emailId);
    if (!email) return clerkError(c, 404, "RESOURCE_NOT_FOUND", "Email address not found");

    const body = await readJsonBody(c);
    const now = nowUnix();
    const patch: Record<string, unknown> = { updated_at_unix: now };

    if (body.verified !== undefined) {
      patch.verification_status = body.verified ? "verified" : "unverified";
    }
    if (body.primary === true) {
      patch.is_primary = true;
      for (const existing of cs.emailAddresses.findBy("user_id", email.user_id)) {
        if (existing.email_id !== emailId && existing.is_primary) {
          cs.emailAddresses.update(existing.id, { is_primary: false });
        }
      }
      const user = cs.users.findOneBy("clerk_id", email.user_id);
      if (user) cs.users.update(user.id, { primary_email_address_id: emailId, updated_at_unix: now });
    }

    cs.emailAddresses.update(email.id, patch);
    const updated = cs.emailAddresses.findOneBy("email_id", emailId)!;
    return c.json(emailAddressResponse(updated));
  });

  app.delete("/v1/email_addresses/:emailId", (c) => {
    const auth = requireSecretKey(c, tokenMap);
    if (isAuthResponse(auth)) return auth;

    const emailId = c.req.param("emailId");
    const email = cs.emailAddresses.findOneBy("email_id", emailId);
    if (!email) return clerkError(c, 404, "RESOURCE_NOT_FOUND", "Email address not found");

    cs.emailAddresses.delete(email.id);

    if (email.is_primary) {
      const remaining = cs.emailAddresses.findBy("user_id", email.user_id);
      const user = cs.users.findOneBy("clerk_id", email.user_id);
      if (user) {
        const newPrimary = remaining[0];
        if (newPrimary) {
          cs.emailAddresses.update(newPrimary.id, { is_primary: true });
          cs.users.update(user.id, { primary_email_address_id: newPrimary.email_id });
        } else {
          cs.users.update(user.id, { primary_email_address_id: null });
        }
      }
    }

    return c.json(deletedResponse("email_address", emailId));
  });
}
