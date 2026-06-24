import type { Context, RouteContext } from "@emulators/core";
import { twilioSid } from "../ids.js";
import { formatCall } from "../formatters.js";
import { getTwilioStore } from "../store.js";
import type { TwilioAccount, TwilioCall, TwilioCallStatus } from "../entities.js";
import {
  accountFromParam,
  bodyString,
  bodyStrings,
  dispatchTwilioWebhook,
  normalizeMethod,
  normalizePhoneNumber,
  parseTwilioBody,
  requireTwilioAuth,
  twilioError,
  twilioList,
} from "../helpers.js";

export function callRoutes({ app, store }: RouteContext): void {
  const ts = getTwilioStore(store);

  app.get("/2010-04-01/Accounts/:accountSid/Calls.json", (c) => {
    const account = authenticatedAccount(c);
    if (account instanceof Response) return account;
    let calls = ts.calls.findBy("account_sid", account.sid);
    const to = c.req.query("To");
    const from = c.req.query("From");
    if (to) calls = calls.filter((call) => call.to === to);
    if (from) calls = calls.filter((call) => call.from === from);
    calls = calls.sort((a, b) => b.id - a.id);
    return twilioList(c, "calls", calls, `/2010-04-01/Accounts/${account.sid}/Calls.json`, formatCall);
  });

  app.post("/2010-04-01/Accounts/:accountSid/Calls.json", async (c) => {
    const account = authenticatedAccount(c);
    if (account instanceof Response) return account;
    const body = await parseTwilioBody(c);
    const to = normalizePhoneNumber(bodyString(body, "To"));
    const from = normalizePhoneNumber(bodyString(body, "From"));
    if (!to) return twilioError(c, 400, "To is required", 21201);
    if (!from) return twilioError(c, 400, "From is required", 21201);
    const ownedNumber = ts.phoneNumbers.findOneBy("phone_number", from);
    if (!ownedNumber || ownedNumber.account_sid !== account.sid) {
      return twilioError(c, 400, "From phone number is not owned by this account", 21210);
    }
    const now = new Date().toISOString();
    const call = ts.calls.insert({
      sid: twilioSid("CA"),
      account_sid: account.sid,
      to,
      from,
      status: "queued",
      direction: "outbound-api",
      api_version: "2010-04-01",
      price: null,
      price_unit: "USD",
      parent_call_sid: null,
      phone_number_sid: ownedNumber.sid,
      start_time: null,
      end_time: null,
      duration: "0",
      url: bodyString(body, "Url") ?? null,
      method: normalizeMethod(bodyString(body, "Method")),
      twiml: bodyString(body, "Twiml") ?? null,
      twiml_steps: parseTwimlSteps(bodyString(body, "Twiml") ?? ""),
      status_callback: bodyString(body, "StatusCallback") ?? null,
      status_callback_event: bodyStrings(body, "StatusCallbackEvent"),
    });
    await dispatchCallCallback(account, "queued", call);
    const updated = ts.calls.update(call.id, { status: "ringing", start_time: now })!;
    await dispatchCallCallback(account, "ringing", updated);
    return c.json(formatCall(updated), 201);
  });

  app.get("/2010-04-01/Accounts/:accountSid/Calls/:callSid.json", (c) => {
    const call = authenticatedCall(c);
    if (call instanceof Response) return call;
    return c.json(formatCall(call));
  });

  app.post("/2010-04-01/Accounts/:accountSid/Calls/:callSid.json", async (c) => {
    const call = authenticatedCall(c);
    if (call instanceof Response) return call;
    const body = await parseTwilioBody(c);
    const status = bodyString(body, "Status") as TwilioCallStatus | undefined;
    if (status && !["completed", "canceled", "busy", "failed", "no-answer", "in-progress"].includes(status)) {
      return twilioError(c, 400, "Status is invalid", 20001);
    }
    const terminal = status && ["completed", "canceled", "busy", "failed", "no-answer"].includes(status);
    const updated = ts.calls.update(call.id, {
      status: status ?? call.status,
      url: bodyString(body, "Url") ?? call.url,
      method: bodyString(body, "Method") ? normalizeMethod(bodyString(body, "Method")) : call.method,
      twiml: bodyString(body, "Twiml") ?? call.twiml,
      twiml_steps: bodyString(body, "Twiml") ? parseTwimlSteps(bodyString(body, "Twiml") ?? "") : call.twiml_steps,
      end_time: terminal ? new Date().toISOString() : call.end_time,
      duration: terminal ? durationSeconds(call.start_time, new Date().toISOString()) : call.duration,
    })!;
    const account = ts.accounts.findOneBy("sid", updated.account_sid)!;
    if (status) await dispatchCallCallback(account, status, updated);
    return c.json(formatCall(updated));
  });

  app.delete("/2010-04-01/Accounts/:accountSid/Calls/:callSid.json", (c) => {
    const call = authenticatedCall(c);
    if (call instanceof Response) return call;
    ts.calls.delete(call.id);
    return c.body(null, 204);
  });

  function authenticatedAccount(c: Context) {
    const auth = requireTwilioAuth(c, ts);
    if (auth instanceof Response) return auth;
    return accountFromParam(c, ts, auth);
  }

  function authenticatedCall(c: Context) {
    const account = authenticatedAccount(c);
    if (account instanceof Response) return account;
    const call = ts.calls.findOneBy("sid", c.req.param("callSid"));
    if (!call || call.account_sid !== account.sid) {
      return twilioError(c, 404, "The requested resource was not found", 20404);
    }
    return call;
  }

  async function dispatchCallCallback(account: TwilioAccount, status: TwilioCallStatus, call: TwilioCall) {
    if (call.status_callback_event.length > 0 && !call.status_callback_event.includes(status)) return;
    await dispatchTwilioWebhook(ts, account, `call.${status}`, call.status_callback, "POST", {
      AccountSid: account.sid,
      CallSid: call.sid,
      CallStatus: status,
      To: call.to,
      From: call.from,
      Direction: call.direction,
      ApiVersion: call.api_version,
    });
  }
}

export function parseTwimlSteps(twiml: string): string[] {
  if (!twiml) return [];
  const steps: string[] = [];
  const regex = /<([A-Z][A-Za-z0-9]*)\b/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(twiml))) {
    if (match[1] !== "Response") steps.push(match[1]);
  }
  return steps;
}

function durationSeconds(start: string | null, end: string): string {
  if (!start) return "0";
  return String(Math.max(0, Math.floor((new Date(end).getTime() - new Date(start).getTime()) / 1000)));
}
