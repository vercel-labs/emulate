import type { RouteContext } from "@emulators/core";
import { twilioSid } from "../ids.js";
import { formatCall, formatMessage, formatVerification } from "../formatters.js";
import { getTwilioStore } from "../store.js";
import type { TwilioVerification, TwilioVerificationStatus } from "../entities.js";
import {
  bodyString,
  dispatchTwilioWebhook,
  messageSegments,
  normalizePhoneNumber,
  parseTwilioBody,
  requireTwilioAuth,
  twilioError,
} from "../helpers.js";
import { parseTwimlSteps } from "./calls.js";

const VERIFICATION_STATUSES: TwilioVerificationStatus[] = [
  "pending",
  "approved",
  "canceled",
  "max_attempts_reached",
  "deleted",
  "failed",
  "expired",
];

export function simulatorRoutes({ app, store }: RouteContext): void {
  const ts = getTwilioStore(store);

  app.post("/_twilio/simulate/inbound-message", async (c) => {
    const account = requireTwilioAuth(c, ts);
    if (account instanceof Response) return account;
    const body = await parseTwilioBody(c);
    const to = normalizePhoneNumber(bodyString(body, "To"));
    const from = normalizePhoneNumber(bodyString(body, "From"));
    if (!to || !from) return twilioError(c, 400, "To and From are required", 20001);
    const number = ts.phoneNumbers.findOneBy("phone_number", to);
    if (!number || number.account_sid !== account.sid) return twilioError(c, 404, "Phone number was not found", 20404);
    const messagingServiceAssignment = ts.messagingServicePhoneNumbers.findOneBy("phone_number_sid", number.sid);
    const messagingService = messagingServiceAssignment
      ? ts.messagingServices.findOneBy("sid", messagingServiceAssignment.service_sid)
      : undefined;
    const messageBody = bodyString(body, "Body") ?? "";
    const message = ts.messages.insert({
      sid: twilioSid("SM"),
      account_sid: account.sid,
      to,
      from,
      body: messageBody,
      direction: "inbound",
      status: "received",
      messaging_service_sid: messagingService?.sid ?? null,
      num_segments: messageSegments(messageBody),
      num_media: "0",
      media_urls: [],
      error_code: null,
      error_message: null,
      price: null,
      price_unit: "USD",
      api_version: "2010-04-01",
      status_callback: null,
      date_sent: new Date().toISOString(),
    });
    const inboundUrl = messagingService?.inbound_request_url ?? number.sms_url;
    const inboundMethod = messagingService?.inbound_request_url ? "POST" : number.sms_method;
    await dispatchTwilioWebhook(ts, account, "message.inbound", inboundUrl, inboundMethod, {
      AccountSid: account.sid,
      MessageSid: message.sid,
      SmsSid: message.sid,
      SmsStatus: "received",
      MessagingServiceSid: messagingService?.sid ?? "",
      To: message.to,
      From: message.from ?? "",
      Body: message.body ?? "",
      NumMedia: "0",
      NumSegments: message.num_segments,
      ApiVersion: message.api_version,
    });
    return c.json(formatMessage(message), 201);
  });

  app.post("/_twilio/simulate/message-status", async (c) => {
    const account = requireTwilioAuth(c, ts);
    if (account instanceof Response) return account;
    const body = await parseTwilioBody(c);
    const sid = bodyString(body, "MessageSid");
    const status = bodyString(body, "Status");
    if (!sid || !status) return twilioError(c, 400, "MessageSid and Status are required", 20001);
    const message = ts.messages.findOneBy("sid", sid);
    if (!message || message.account_sid !== account.sid)
      return twilioError(c, 404, "The requested resource was not found", 20404);
    const updated = ts.messages.update(message.id, {
      status: status as typeof message.status,
      date_sent: ["sent", "delivered"].includes(status) ? new Date().toISOString() : message.date_sent,
    })!;
    await dispatchTwilioWebhook(ts, account, `message.${status}`, updated.status_callback, "POST", {
      AccountSid: account.sid,
      MessageSid: updated.sid,
      SmsSid: updated.sid,
      SmsStatus: updated.status,
      MessageStatus: updated.status,
      To: updated.to,
      From: updated.from ?? "",
      Body: updated.body ?? "",
      NumMedia: updated.num_media,
      NumSegments: updated.num_segments,
      ApiVersion: updated.api_version,
    });
    return c.json(formatMessage(updated));
  });

  app.post("/_twilio/simulate/inbound-call", async (c) => {
    const account = requireTwilioAuth(c, ts);
    if (account instanceof Response) return account;
    const body = await parseTwilioBody(c);
    const to = normalizePhoneNumber(bodyString(body, "To"));
    const from = normalizePhoneNumber(bodyString(body, "From"));
    if (!to || !from) return twilioError(c, 400, "To and From are required", 20001);
    const number = ts.phoneNumbers.findOneBy("phone_number", to);
    if (!number || number.account_sid !== account.sid) return twilioError(c, 404, "Phone number was not found", 20404);
    const call = ts.calls.insert({
      sid: twilioSid("CA"),
      account_sid: account.sid,
      to,
      from,
      status: "in-progress",
      direction: "inbound",
      api_version: "2010-04-01",
      price: null,
      price_unit: "USD",
      parent_call_sid: null,
      phone_number_sid: number.sid,
      start_time: new Date().toISOString(),
      end_time: null,
      duration: "0",
      url: number.voice_url,
      method: number.voice_method,
      twiml: null,
      twiml_steps: [],
      status_callback: number.status_callback,
      status_callback_event: [],
    });
    await dispatchTwilioWebhook(ts, account, "call.inbound", number.voice_url, number.voice_method, {
      AccountSid: account.sid,
      CallSid: call.sid,
      CallStatus: call.status,
      To: call.to,
      From: call.from,
      Direction: call.direction,
      ApiVersion: call.api_version,
    });
    return c.json(formatCall(call), 201);
  });

  app.post("/_twilio/simulate/call-status", async (c) => {
    const account = requireTwilioAuth(c, ts);
    if (account instanceof Response) return account;
    const body = await parseTwilioBody(c);
    const sid = bodyString(body, "CallSid");
    const status = bodyString(body, "Status");
    const twiml = bodyString(body, "Twiml");
    if (!sid || !status) return twilioError(c, 400, "CallSid and Status are required", 20001);
    const call = ts.calls.findOneBy("sid", sid);
    if (!call || call.account_sid !== account.sid)
      return twilioError(c, 404, "The requested resource was not found", 20404);
    const terminal = ["completed", "busy", "failed", "no-answer", "canceled"].includes(status);
    const updated = ts.calls.update(call.id, {
      status: status as typeof call.status,
      twiml: twiml ?? call.twiml,
      twiml_steps: twiml ? parseTwimlSteps(twiml) : call.twiml_steps,
      end_time: terminal ? new Date().toISOString() : call.end_time,
    })!;
    await dispatchTwilioWebhook(ts, account, `call.${status}`, updated.status_callback, "POST", {
      AccountSid: account.sid,
      CallSid: updated.sid,
      CallStatus: updated.status,
      To: updated.to,
      From: updated.from,
      Direction: updated.direction,
      ApiVersion: updated.api_version,
    });
    return c.json(formatCall(updated));
  });

  app.post("/_twilio/simulate/verification-status", async (c) => {
    const account = requireTwilioAuth(c, ts);
    if (account instanceof Response) return account;
    const body = await parseTwilioBody(c);
    const sid = bodyString(body, "VerificationSid");
    const to = normalizePhoneNumber(bodyString(body, "To"));
    const serviceSid = bodyString(body, "ServiceSid");
    const status = bodyString(body, "Status");
    if (!status) return twilioError(c, 400, "Status is required", 20001);
    if (!sid && !to) return twilioError(c, 400, "VerificationSid or To is required", 20001);
    if (!VERIFICATION_STATUSES.includes(status as TwilioVerificationStatus)) {
      return twilioError(c, 400, "Status is invalid", 20001);
    }
    const verification = findVerification(account.sid, sid, to, serviceSid);
    if (!verification) {
      return twilioError(c, 404, "The requested resource was not found", 20404);
    }
    const updated = ts.verifications.update(verification.id, {
      status: status as TwilioVerificationStatus,
      valid: status === "approved",
    })!;
    return c.json(formatVerification(updated));
  });

  app.get("/_twilio/simulate/verification-code", (c) => {
    const account = requireTwilioAuth(c, ts);
    if (account instanceof Response) return account;
    const sid = c.req.query("VerificationSid");
    const to = normalizePhoneNumber(c.req.query("To"));
    const serviceSid = c.req.query("ServiceSid");
    if (!sid && !to) return twilioError(c, 400, "VerificationSid or To is required", 20001);
    const verification = findVerification(account.sid, sid, to, serviceSid);
    if (!verification) {
      return twilioError(c, 404, "The requested resource was not found", 20404);
    }
    return c.json({
      account_sid: verification.account_sid,
      service_sid: verification.service_sid,
      verification_sid: verification.sid,
      to: verification.to,
      channel: verification.channel,
      status: verification.status,
      code: verification.code,
      attempts: verification.attempts,
      valid: verification.valid,
      date_created: verification.created_at,
      date_updated: verification.updated_at,
    });
  });

  function findVerification(
    accountSid: string,
    verificationSid: string | undefined,
    to: string | null,
    serviceSid: string | undefined,
  ): TwilioVerification | null {
    const candidates = verificationSid
      ? [ts.verifications.findOneBy("sid", verificationSid)].filter((item): item is TwilioVerification => Boolean(item))
      : ts.verifications
          .all()
          .filter((verification) => verification.to === to)
          .sort((a, b) => b.id - a.id);
    return (
      candidates.find(
        (verification) =>
          verification.account_sid === accountSid && (!serviceSid || verification.service_sid === serviceSid),
      ) ?? null
    );
  }
}
