import type { RouteContext } from "@emulators/core";
import { getTwilioStore } from "../store.js";
import { generateSid, generateVerificationCode, parseTwilioBody, twilioError } from "../helpers.js";

export function verifyRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const ts = getTwilioStore(store);

  // Send verification
  app.post("/v2/Services/:serviceSid/Verifications", async (c) => {
    const serviceSid = c.req.param("serviceSid");
    const service = ts.verifyServices.findOneBy("sid", serviceSid);
    if (!service) {
      return twilioError(c, 404, 60200, "Verify service not found");
    }

    const body = await parseTwilioBody(c);
    const to = String(body.To ?? body.to ?? "");
    const channel = String(body.Channel ?? body.channel ?? "sms");

    if (!to) {
      return twilioError(c, 400, 60200, "The 'To' parameter is required");
    }

    const code = generateVerificationCode(service.code_length);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    const verification = ts.verifications.insert({
      sid: generateSid("VE"),
      service_sid: serviceSid,
      to,
      channel: channel as "sms" | "email" | "call",
      status: "pending",
      code,
      expires_at: expiresAt,
    });

    return c.json(
      {
        sid: verification.sid,
        service_sid: verification.service_sid,
        to: verification.to,
        channel: verification.channel,
        status: verification.status,
        date_created: verification.created_at,
        date_updated: verification.updated_at,
      },
      201,
    );
  });

  // Check verification
  app.post("/v2/Services/:serviceSid/VerificationCheck", async (c) => {
    const serviceSid = c.req.param("serviceSid");
    const body = await parseTwilioBody(c);
    const to = String(body.To ?? body.to ?? "");
    const code = String(body.Code ?? body.code ?? "");

    if (!to || !code) {
      return twilioError(c, 400, 60200, "The 'To' and 'Code' parameters are required");
    }

    const verifications = ts.verifications
      .findBy("service_sid", serviceSid)
      .filter((v) => v.to === to && v.status === "pending");

    const latest = verifications[verifications.length - 1];
    if (!latest) {
      return twilioError(c, 404, 60200, "No pending verification found for this number");
    }

    const expired = new Date(latest.expires_at) < new Date();
    if (expired) {
      ts.verifications.update(latest.id, { status: "expired" });
      return c.json({
        sid: latest.sid,
        service_sid: latest.service_sid,
        to: latest.to,
        channel: latest.channel,
        status: "expired",
      });
    }

    if (latest.code === code) {
      ts.verifications.update(latest.id, { status: "approved" });
      return c.json({
        sid: latest.sid,
        service_sid: latest.service_sid,
        to: latest.to,
        channel: latest.channel,
        status: "approved",
      });
    }

    return c.json({
      sid: latest.sid,
      service_sid: latest.service_sid,
      to: latest.to,
      channel: latest.channel,
      status: "pending",
    });
  });
}
