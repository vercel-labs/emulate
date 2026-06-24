import type { Context, RouteContext } from "@emulators/core";
import { twilioSid } from "../ids.js";
import { formatPhoneNumber } from "../formatters.js";
import { getTwilioStore } from "../store.js";
import {
  accountFromParam,
  bodyString,
  normalizeMethod,
  normalizePhoneNumber,
  parseTwilioBody,
  requireTwilioAuth,
  twilioError,
  twilioList,
} from "../helpers.js";

export function phoneNumberRoutes({ app, store }: RouteContext): void {
  const ts = getTwilioStore(store);

  app.get("/2010-04-01/Accounts/:accountSid/IncomingPhoneNumbers.json", (c) => {
    const account = authenticatedAccount(c);
    if (account instanceof Response) return account;
    let numbers = ts.phoneNumbers.findBy("account_sid", account.sid);
    const phoneNumber = c.req.query("PhoneNumber");
    const friendlyName = c.req.query("FriendlyName");
    if (phoneNumber) numbers = numbers.filter((number) => number.phone_number === phoneNumber);
    if (friendlyName) numbers = numbers.filter((number) => number.friendly_name === friendlyName);
    return twilioList(
      c,
      "incoming_phone_numbers",
      numbers,
      `/2010-04-01/Accounts/${account.sid}/IncomingPhoneNumbers.json`,
      formatPhoneNumber,
    );
  });

  app.post("/2010-04-01/Accounts/:accountSid/IncomingPhoneNumbers.json", async (c) => {
    const account = authenticatedAccount(c);
    if (account instanceof Response) return account;
    const body = await parseTwilioBody(c);
    const phoneNumber = normalizePhoneNumber(bodyString(body, "PhoneNumber"));
    if (!phoneNumber) return twilioError(c, 400, "PhoneNumber is invalid", 21421);
    const existing = ts.phoneNumbers.findOneBy("phone_number", phoneNumber);
    if (existing) return twilioError(c, 400, "Phone number is already owned by this account", 21452);
    const inserted = ts.phoneNumbers.insert({
      sid: twilioSid("PN"),
      account_sid: account.sid,
      phone_number: phoneNumber,
      friendly_name: bodyString(body, "FriendlyName") ?? phoneNumber,
      capabilities: { sms: true, mms: true, voice: true },
      sms_url: bodyString(body, "SmsUrl") ?? null,
      sms_method: normalizeMethod(bodyString(body, "SmsMethod")),
      voice_url: bodyString(body, "VoiceUrl") ?? null,
      voice_method: normalizeMethod(bodyString(body, "VoiceMethod")),
      status_callback: bodyString(body, "StatusCallback") ?? null,
      application_sid: bodyString(body, "ApplicationSid") ?? null,
    });
    return c.json(formatPhoneNumber(inserted), 201);
  });

  app.get("/2010-04-01/Accounts/:accountSid/IncomingPhoneNumbers/:sid.json", (c) => {
    const number = authenticatedPhoneNumber(c);
    if (number instanceof Response) return number;
    return c.json(formatPhoneNumber(number));
  });

  app.post("/2010-04-01/Accounts/:accountSid/IncomingPhoneNumbers/:sid.json", async (c) => {
    const number = authenticatedPhoneNumber(c);
    if (number instanceof Response) return number;
    const body = await parseTwilioBody(c);
    const friendlyName = bodyString(body, "FriendlyName");
    const updated = ts.phoneNumbers.update(number.id, {
      friendly_name: friendlyName ?? number.friendly_name,
      sms_url: bodyString(body, "SmsUrl") ?? number.sms_url,
      sms_method: bodyString(body, "SmsMethod") ? normalizeMethod(bodyString(body, "SmsMethod")) : number.sms_method,
      voice_url: bodyString(body, "VoiceUrl") ?? number.voice_url,
      voice_method: bodyString(body, "VoiceMethod")
        ? normalizeMethod(bodyString(body, "VoiceMethod"))
        : number.voice_method,
      status_callback: bodyString(body, "StatusCallback") ?? number.status_callback,
      application_sid: bodyString(body, "ApplicationSid") ?? number.application_sid,
    })!;
    return c.json(formatPhoneNumber(updated));
  });

  app.delete("/2010-04-01/Accounts/:accountSid/IncomingPhoneNumbers/:sid.json", (c) => {
    const number = authenticatedPhoneNumber(c);
    if (number instanceof Response) return number;
    ts.phoneNumbers.delete(number.id);
    return c.body(null, 204);
  });

  function authenticatedAccount(c: Context) {
    const auth = requireTwilioAuth(c, ts);
    if (auth instanceof Response) return auth;
    return accountFromParam(c, ts, auth);
  }

  function authenticatedPhoneNumber(c: Context) {
    const account = authenticatedAccount(c);
    if (account instanceof Response) return account;
    const number = ts.phoneNumbers.findOneBy("sid", c.req.param("sid"));
    if (!number || number.account_sid !== account.sid)
      return twilioError(c, 404, "The requested resource was not found", 20404);
    return number;
  }
}
