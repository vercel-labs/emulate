import type { RouteContext } from "@emulators/core";
import { getTwilioStore } from "../store.js";
import { generateSid, parseTwilioBody, twilioError } from "../helpers.js";

const DEFAULT_ACCOUNT_SID = "AC_test_account";

export function callRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const ts = getTwilioStore(store);

  // Create call
  app.post("/2010-04-01/Accounts/:accountSid/Calls.json", async (c) => {
    const accountSid = c.req.param("accountSid") || DEFAULT_ACCOUNT_SID;
    const body = await parseTwilioBody(c);

    const to = String(body.To ?? body.to ?? "");
    const from = String(body.From ?? body.from ?? "");

    if (!to || !from) {
      return twilioError(c, 400, 21211, "The 'To' and 'From' parameters are required");
    }

    const sid = generateSid("CA");
    const now = new Date().toISOString();

    const call = ts.calls.insert({
      sid,
      account_sid: accountSid,
      to,
      from,
      status: "completed",
      direction: "outbound-api",
      duration: 0,
      start_time: now,
      end_time: now,
    });

    return c.json(
      {
        sid: call.sid,
        account_sid: call.account_sid,
        to: call.to,
        from: call.from,
        status: call.status,
        direction: call.direction,
        duration: call.duration,
        start_time: call.start_time,
        end_time: call.end_time,
        date_created: call.created_at,
        uri: `/2010-04-01/Accounts/${accountSid}/Calls/${call.sid}.json`,
      },
      201,
    );
  });

  // List calls
  app.get("/2010-04-01/Accounts/:accountSid/Calls.json", (c) => {
    const accountSid = c.req.param("accountSid") || DEFAULT_ACCOUNT_SID;
    const calls = ts.calls.findBy("account_sid", accountSid);

    return c.json({
      calls: calls.map((call) => ({
        sid: call.sid,
        account_sid: call.account_sid,
        to: call.to,
        from: call.from,
        status: call.status,
        direction: call.direction,
        duration: call.duration,
      })),
      page: 0,
      page_size: 50,
    });
  });
}
