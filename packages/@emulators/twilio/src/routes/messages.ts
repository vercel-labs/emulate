import type { RouteContext } from "@emulators/core";
import { getTwilioStore } from "../store.js";
import { generateSid, parseTwilioBody, twilioError } from "../helpers.js";

const DEFAULT_ACCOUNT_SID = "AC_test_account";

export function messageRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const ts = getTwilioStore(store);

  // Send SMS
  app.post("/2010-04-01/Accounts/:accountSid/Messages.json", async (c) => {
    const accountSid = c.req.param("accountSid") || DEFAULT_ACCOUNT_SID;
    const body = await parseTwilioBody(c);

    const to = String(body.To ?? body.to ?? "");
    const from = String(body.From ?? body.from ?? "");
    const messageBody = String(body.Body ?? body.body ?? "");

    if (!to || !messageBody) {
      return twilioError(c, 400, 21211, "The 'To' number and 'Body' are required");
    }

    const sid = generateSid("SM");
    const now = new Date().toISOString();

    const message = ts.messages.insert({
      sid,
      account_sid: accountSid,
      to,
      from: from || ts.phoneNumbers.all()[0]?.phone_number || "+15551234567",
      body: messageBody,
      status: "delivered",
      direction: "outbound-api",
      num_segments: Math.ceil(messageBody.length / 160),
      date_sent: now,
    });

    return c.json(
      {
        sid: message.sid,
        account_sid: message.account_sid,
        to: message.to,
        from: message.from,
        body: message.body,
        status: message.status,
        direction: message.direction,
        num_segments: message.num_segments,
        date_created: message.created_at,
        date_sent: message.date_sent,
        date_updated: message.updated_at,
        uri: `/2010-04-01/Accounts/${accountSid}/Messages/${message.sid}.json`,
      },
      201,
    );
  });

  // List messages
  app.get("/2010-04-01/Accounts/:accountSid/Messages.json", (c) => {
    const accountSid = c.req.param("accountSid") || DEFAULT_ACCOUNT_SID;
    const messages = ts.messages.findBy("account_sid", accountSid);

    return c.json({
      messages: messages.map((m) => ({
        sid: m.sid,
        account_sid: m.account_sid,
        to: m.to,
        from: m.from,
        body: m.body,
        status: m.status,
        direction: m.direction,
        num_segments: m.num_segments,
        date_sent: m.date_sent,
      })),
      page: 0,
      page_size: 50,
    });
  });

  // Get single message
  app.get("/2010-04-01/Accounts/:accountSid/Messages/:messageSid.json", (c) => {
    const messageSid = c.req.param("messageSid");
    const message = ts.messages.findOneBy("sid", messageSid);
    if (!message) {
      return twilioError(c, 404, 20404, "The requested resource was not found");
    }
    return c.json({
      sid: message.sid,
      account_sid: message.account_sid,
      to: message.to,
      from: message.from,
      body: message.body,
      status: message.status,
      direction: message.direction,
      num_segments: message.num_segments,
      date_sent: message.date_sent,
    });
  });
}
