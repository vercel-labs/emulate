import { beforeEach, describe, expect, it } from "vitest";
import { getTwilioStore, DEFAULT_ACCOUNT_SID, DEFAULT_PHONE_NUMBER } from "../index.js";
import { createTwilioTestApp, formBody, formHeaders } from "./helpers.js";

describe("Twilio inactive accounts", () => {
  let setup: ReturnType<typeof createTwilioTestApp>;

  beforeEach(() => {
    setup = createTwilioTestApp();
  });

  async function setStatus(status: "active" | "suspended" | "closed") {
    const res = await setup.app.request(`http://localhost/2010-04-01/Accounts/${DEFAULT_ACCOUNT_SID}.json`, {
      method: "POST",
      headers: formHeaders(),
      body: formBody({ Status: status }),
    });
    expect(res.status).toBe(200);
  }

  function sendMessage() {
    return setup.app.request(`http://localhost/2010-04-01/Accounts/${DEFAULT_ACCOUNT_SID}/Messages.json`, {
      method: "POST",
      headers: formHeaders(),
      body: formBody({ To: "+15550001111", From: DEFAULT_PHONE_NUMBER, Body: "Ahoy" }),
    });
  }

  function placeCall() {
    return setup.app.request(`http://localhost/2010-04-01/Accounts/${DEFAULT_ACCOUNT_SID}/Calls.json`, {
      method: "POST",
      headers: formHeaders(),
      body: formBody({ To: "+15550003333", From: DEFAULT_PHONE_NUMBER, Twiml: "<Response><Say>Hi</Say></Response>" }),
    });
  }

  it("refuses messages from a suspended account", async () => {
    await setStatus("suspended");
    const res = await sendMessage();
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 20005, message: "Account not active" });
    expect(getTwilioStore(setup.store).messages.all()).toHaveLength(0);
  });

  it("refuses calls from a closed account", async () => {
    await setStatus("closed");
    const res = await placeCall();
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 20005, message: "Account not active" });
    expect(getTwilioStore(setup.store).calls.all()).toHaveLength(0);
  });

  it("resumes messages and calls when the account is active again", async () => {
    await setStatus("suspended");
    expect((await sendMessage()).status).toBe(401);
    expect((await placeCall()).status).toBe(401);

    await setStatus("active");
    expect((await sendMessage()).status).toBe(201);
    expect((await placeCall()).status).toBe(201);
  });
});
