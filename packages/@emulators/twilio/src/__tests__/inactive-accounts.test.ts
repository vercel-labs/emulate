import { describe, expect, it } from "vitest";
import { DEFAULT_ACCOUNT_SID, DEFAULT_PHONE_NUMBER } from "../index.js";
import { basicAuth, createTwilioTestApp, formBody, formHeaders } from "./helpers.js";

const accountUrl = `http://localhost/2010-04-01/Accounts/${DEFAULT_ACCOUNT_SID}`;

function post(setup: ReturnType<typeof createTwilioTestApp>, path: string, body: Record<string, string>) {
  return setup.app.request(`${accountUrl}${path}`, {
    method: "POST",
    headers: { ...formHeaders(), Authorization: basicAuth() },
    body: formBody(body),
  });
}

const sendMessage = (setup: ReturnType<typeof createTwilioTestApp>) =>
  post(setup, "/Messages.json", { From: DEFAULT_PHONE_NUMBER, To: "+15550001111", Body: "hi" });
const placeCall = (setup: ReturnType<typeof createTwilioTestApp>) =>
  post(setup, "/Calls.json", { From: DEFAULT_PHONE_NUMBER, To: "+15550001111", Url: "http://localhost/twiml" });

describe("Twilio inactive accounts", () => {
  for (const status of ["suspended", "closed"]) {
    it(`refuses messages and calls from a ${status} account with 20005`, async () => {
      const setup = createTwilioTestApp();
      expect((await sendMessage(setup)).status).toBe(201);
      expect((await post(setup, ".json", { Status: status })).status).toBe(200);

      for (const response of [await sendMessage(setup), await placeCall(setup)]) {
        expect(response.status).toBe(401);
        expect(await response.json()).toMatchObject({ code: 20005, message: "Account not active", status: 401 });
      }
    });
  }

  it("sends again once the account is active", async () => {
    const setup = createTwilioTestApp();
    await post(setup, ".json", { Status: "suspended" });
    await post(setup, ".json", { Status: "active" });
    expect((await sendMessage(setup)).status).toBe(201);
  });
});
