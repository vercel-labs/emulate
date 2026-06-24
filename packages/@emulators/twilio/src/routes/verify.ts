import type { Context, RouteContext } from "@emulators/core";
import { twilioSid } from "../ids.js";
import { formatVerification, formatVerificationCheck, formatVerifyService } from "../formatters.js";
import { getTwilioStore } from "../store.js";
import { bodyString, parseTwilioBody, requireTwilioAuth, twilioError, twilioList } from "../helpers.js";

export function verifyRoutes({ app, store }: RouteContext): void {
  const ts = getTwilioStore(store);

  app.get("/verify/v2/Services", (c) => {
    const account = authenticatedAccount(c);
    if (account instanceof Response) return account;
    const services = ts.verifyServices.findBy("account_sid", account.sid);
    return twilioList(c, "services", services, "/verify/v2/Services", formatVerifyService);
  });

  app.post("/verify/v2/Services", async (c) => {
    const account = authenticatedAccount(c);
    if (account instanceof Response) return account;
    const body = await parseTwilioBody(c);
    const friendlyName = bodyString(body, "FriendlyName");
    if (!friendlyName) return twilioError(c, 400, "FriendlyName is required", 20001);
    const service = ts.verifyServices.insert({
      sid: twilioSid("VA"),
      account_sid: account.sid,
      friendly_name: friendlyName,
      code: bodyString(body, "Code") ?? "123456",
      default_channel: bodyString(body, "DefaultChannel") ?? "sms",
    });
    return c.json(formatVerifyService(service), 201);
  });

  app.get("/verify/v2/Services/:serviceSid", (c) => {
    const service = authenticatedService(c);
    if (service instanceof Response) return service;
    return c.json(formatVerifyService(service));
  });

  app.post("/verify/v2/Services/:serviceSid", async (c) => {
    const service = authenticatedService(c);
    if (service instanceof Response) return service;
    const body = await parseTwilioBody(c);
    const updated = ts.verifyServices.update(service.id, {
      friendly_name: bodyString(body, "FriendlyName") ?? service.friendly_name,
      code: bodyString(body, "Code") ?? service.code,
      default_channel: bodyString(body, "DefaultChannel") ?? service.default_channel,
    })!;
    return c.json(formatVerifyService(updated));
  });

  app.delete("/verify/v2/Services/:serviceSid", (c) => {
    const service = authenticatedService(c);
    if (service instanceof Response) return service;
    ts.verifyServices.delete(service.id);
    return c.body(null, 204);
  });

  app.post("/verify/v2/Services/:serviceSid/Verifications", async (c) => {
    const service = authenticatedService(c);
    if (service instanceof Response) return service;
    const body = await parseTwilioBody(c);
    const to = bodyString(body, "To");
    const channel = bodyString(body, "Channel") ?? service.default_channel;
    if (!to) return twilioError(c, 400, "To is required", 60200);
    if (!["sms", "call", "email", "whatsapp", "sna", "auto"].includes(channel)) {
      return twilioError(c, 400, "Channel is invalid", 60200);
    }
    const existingPending = ts.verifications
      .findBy("service_sid", service.sid)
      .find((verification) => verification.to === to && verification.status === "pending");
    if (existingPending) return c.json(formatVerification(existingPending), 201);
    const code = bodyString(body, "CustomCode") ?? service.code;
    const verification = ts.verifications.insert({
      sid: twilioSid("VE"),
      service_sid: service.sid,
      account_sid: service.account_sid,
      to,
      channel,
      status: "pending",
      code,
      attempts: 0,
      max_attempts: 3,
      lookup: {},
      send_code_attempts: [
        {
          time: new Date().toISOString(),
          channel,
          attempt_sid: twilioSid("VL"),
        },
      ],
      tags: bodyString(body, "Tags") ?? null,
      valid: false,
    });
    return c.json(formatVerification(verification), 201);
  });

  app.get("/verify/v2/Services/:serviceSid/Verifications/:verificationSid", (c) => {
    const verification = authenticatedVerification(c);
    if (verification instanceof Response) return verification;
    return c.json(formatVerification(verification));
  });

  app.post("/verify/v2/Services/:serviceSid/Verifications/:verificationSid", async (c) => {
    const verification = authenticatedVerification(c);
    if (verification instanceof Response) return verification;
    const body = await parseTwilioBody(c);
    const status = bodyString(body, "Status");
    if (status !== "canceled") return twilioError(c, 400, "Status is invalid", 60200);
    const updated = ts.verifications.update(verification.id, { status: "canceled", valid: false })!;
    return c.json(formatVerification(updated));
  });

  app.post("/verify/v2/Services/:serviceSid/VerificationCheck", async (c) => {
    const service = authenticatedService(c);
    if (service instanceof Response) return service;
    const body = await parseTwilioBody(c);
    const to = bodyString(body, "To");
    const sid = bodyString(body, "VerificationSid");
    const code = bodyString(body, "Code");
    if (!code) return twilioError(c, 400, "Code is required", 60200);
    const verification = sid
      ? ts.verifications.findOneBy("sid", sid)
      : ts.verifications
          .findBy("service_sid", service.sid)
          .filter((candidate) => candidate.to === to)
          .sort((a, b) => b.id - a.id)[0];
    if (!verification || verification.service_sid !== service.sid) {
      return twilioError(c, 404, "The requested resource was not found", 20404);
    }
    if (!["pending", "failed"].includes(verification.status)) {
      return c.json(formatVerificationCheck(verification));
    }
    const attempts = verification.attempts + 1;
    const approved = code === verification.code;
    const status = approved ? "approved" : attempts >= verification.max_attempts ? "max_attempts_reached" : "pending";
    const updated = ts.verifications.update(verification.id, {
      attempts,
      status,
      valid: approved,
    })!;
    return c.json(formatVerificationCheck(updated));
  });

  function authenticatedAccount(c: Context) {
    const auth = requireTwilioAuth(c, ts);
    if (auth instanceof Response) return auth;
    return auth;
  }

  function authenticatedService(c: Context) {
    const account = authenticatedAccount(c);
    if (account instanceof Response) return account;
    const service = ts.verifyServices.findOneBy("sid", c.req.param("serviceSid"));
    if (!service || service.account_sid !== account.sid) {
      return twilioError(c, 404, "The requested resource was not found", 20404);
    }
    return service;
  }

  function authenticatedVerification(c: Context) {
    const service = authenticatedService(c);
    if (service instanceof Response) return service;
    const verification = ts.verifications.findOneBy("sid", c.req.param("verificationSid"));
    if (!verification || verification.service_sid !== service.sid) {
      return twilioError(c, 404, "The requested resource was not found", 20404);
    }
    return verification;
  }
}
