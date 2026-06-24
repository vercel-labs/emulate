import type { Context, RouteContext } from "@emulators/core";
import { twilioSid } from "../ids.js";
import { formatMedia, formatMessage } from "../formatters.js";
import { getTwilioStore } from "../store.js";
import type { TwilioAccount, TwilioMessage, TwilioMessageStatus } from "../entities.js";
import {
  accountFromParam,
  bodyString,
  bodyStrings,
  dispatchTwilioWebhook,
  messageSegments,
  normalizePhoneNumber,
  parseTwilioBody,
  requireTwilioAuth,
  twilioError,
  twilioList,
} from "../helpers.js";

export function messageRoutes({ app, store }: RouteContext): void {
  const ts = getTwilioStore(store);

  app.get("/2010-04-01/Accounts/:accountSid/Messages.json", (c) => {
    const account = authenticatedAccount(c);
    if (account instanceof Response) return account;
    let messages = ts.messages.findBy("account_sid", account.sid);
    const to = c.req.query("To");
    const from = c.req.query("From");
    if (to) messages = messages.filter((message) => message.to === to);
    if (from) messages = messages.filter((message) => message.from === from);
    messages = messages.sort((a, b) => b.id - a.id);
    return twilioList(c, "messages", messages, `/2010-04-01/Accounts/${account.sid}/Messages.json`, formatMessage);
  });

  app.post("/2010-04-01/Accounts/:accountSid/Messages.json", async (c) => {
    const account = authenticatedAccount(c);
    if (account instanceof Response) return account;
    const body = await parseTwilioBody(c);
    const to = normalizePhoneNumber(bodyString(body, "To"));
    if (!to) return twilioError(c, 400, "A 'To' phone number is required.", 21201);
    const bodyText = bodyString(body, "Body") ?? null;
    const mediaUrls = bodyStrings(body, "MediaUrl");
    const serviceSid = bodyString(body, "MessagingServiceSid") ?? null;
    const explicitFrom = normalizePhoneNumber(bodyString(body, "From") ?? undefined);
    const sender = resolveSender(c, account, explicitFrom, serviceSid);
    if (sender instanceof Response) return sender;
    const statusCallback = bodyString(body, "StatusCallback") ?? sender.statusCallback;
    const message = ts.messages.insert({
      sid: twilioSid(mediaUrls.length > 0 ? "MM" : "SM"),
      account_sid: account.sid,
      to,
      from: sender.from,
      body: bodyText,
      direction: "outbound-api",
      status: bodyString(body, "ScheduleType") ? "scheduled" : "queued",
      messaging_service_sid: serviceSid,
      num_segments: messageSegments(bodyText),
      num_media: String(mediaUrls.length),
      media_urls: mediaUrls,
      error_code: null,
      error_message: null,
      price: null,
      price_unit: "USD",
      api_version: "2010-04-01",
      status_callback: statusCallback,
      date_sent: null,
    });
    for (const mediaUrl of mediaUrls) {
      ts.media.insert({
        sid: twilioSid("ME"),
        account_sid: account.sid,
        message_sid: message.sid,
        content_type: "application/octet-stream",
        uri: mediaUrl,
      });
    }
    await dispatchMessageCallback(account, message.status, message);
    return c.json(formatMessage(message), 201);
  });

  app.get("/2010-04-01/Accounts/:accountSid/Messages/:messageSid.json", (c) => {
    const message = authenticatedMessage(c);
    if (message instanceof Response) return message;
    return c.json(formatMessage(message));
  });

  app.post("/2010-04-01/Accounts/:accountSid/Messages/:messageSid.json", async (c) => {
    const message = authenticatedMessage(c);
    if (message instanceof Response) return message;
    const body = await parseTwilioBody(c);
    const requestedStatus = bodyString(body, "Status") as TwilioMessageStatus | undefined;
    const bodyText = bodyString(body, "Body");
    if (requestedStatus && !["canceled", "failed", "delivered", "sent", "undelivered"].includes(requestedStatus)) {
      return twilioError(c, 400, "Status is invalid", 20001);
    }
    const updated = ts.messages.update(message.id, {
      body: bodyText ?? message.body,
      num_segments: bodyText !== undefined ? messageSegments(bodyText) : message.num_segments,
      status: requestedStatus ?? message.status,
      date_sent:
        requestedStatus === "sent" || requestedStatus === "delivered" ? new Date().toISOString() : message.date_sent,
    })!;
    const account = ts.accounts.findOneBy("sid", updated.account_sid)!;
    if (requestedStatus) await dispatchMessageCallback(account, requestedStatus, updated);
    return c.json(formatMessage(updated));
  });

  app.delete("/2010-04-01/Accounts/:accountSid/Messages/:messageSid.json", (c) => {
    const message = authenticatedMessage(c);
    if (message instanceof Response) return message;
    for (const media of ts.media.findBy("message_sid", message.sid)) ts.media.delete(media.id);
    ts.messages.delete(message.id);
    return c.body(null, 204);
  });

  app.get("/2010-04-01/Accounts/:accountSid/Messages/:messageSid/Media.json", (c) => {
    const message = authenticatedMessage(c);
    if (message instanceof Response) return message;
    const media = ts.media.findBy("message_sid", message.sid);
    return twilioList(
      c,
      "media_list",
      media,
      `/2010-04-01/Accounts/${message.account_sid}/Messages/${message.sid}/Media.json`,
      formatMedia,
    );
  });

  app.get("/2010-04-01/Accounts/:accountSid/Messages/:messageSid/Media/:mediaSid.json", (c) => {
    const message = authenticatedMessage(c);
    if (message instanceof Response) return message;
    const media = ts.media.findOneBy("sid", c.req.param("mediaSid"));
    if (!media || media.message_sid !== message.sid)
      return twilioError(c, 404, "The requested resource was not found", 20404);
    return c.json(formatMedia(media));
  });

  async function dispatchMessageCallback(account: TwilioAccount, status: TwilioMessageStatus, message: TwilioMessage) {
    await dispatchTwilioWebhook(ts, account, `message.${status}`, message.status_callback, "POST", {
      AccountSid: account.sid,
      MessageSid: message.sid,
      SmsSid: message.sid,
      SmsStatus: status,
      MessageStatus: status,
      To: message.to,
      From: message.from ?? "",
      Body: message.body ?? "",
      NumMedia: message.num_media,
      NumSegments: message.num_segments,
      ApiVersion: message.api_version,
    });
  }

  function authenticatedAccount(c: Context) {
    const auth = requireTwilioAuth(c, ts);
    if (auth instanceof Response) return auth;
    return accountFromParam(c, ts, auth);
  }

  function authenticatedMessage(c: Context) {
    const account = authenticatedAccount(c);
    if (account instanceof Response) return account;
    const message = ts.messages.findOneBy("sid", c.req.param("messageSid"));
    if (!message || message.account_sid !== account.sid) {
      return twilioError(c, 404, "The requested resource was not found", 20404);
    }
    return message;
  }

  function resolveSender(c: Context, account: TwilioAccount, explicitFrom: string | null, serviceSid: string | null) {
    const service = serviceSid ? ts.messagingServices.findOneBy("sid", serviceSid) : null;
    if (serviceSid && (!service || service.account_sid !== account.sid)) {
      return twilioError(c, 400, "Messaging Service was not found", 20404);
    }

    if (explicitFrom) {
      const number = ts.phoneNumbers.findOneBy("phone_number", explicitFrom);
      if (!number || number.account_sid !== account.sid)
        return twilioError(c, 400, "From phone number is not owned by this account", 21606);
      return { from: explicitFrom, statusCallback: number.status_callback ?? service?.status_callback ?? null };
    }

    if (service && serviceSid) {
      for (const assignment of ts.messagingServicePhoneNumbers.findBy("service_sid", serviceSid)) {
        const number = ts.phoneNumbers.findOneBy("sid", assignment.phone_number_sid);
        if (number && number.account_sid === account.sid) {
          return { from: number.phone_number, statusCallback: service.status_callback };
        }
      }
      return twilioError(c, 400, "Messaging Service has no senders", 21712);
    }
    return twilioError(c, 400, "A 'From' phone number or MessagingServiceSid is required.", 21603);
  }
}
