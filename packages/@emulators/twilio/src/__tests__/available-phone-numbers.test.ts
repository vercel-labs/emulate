import { beforeEach, describe, expect, it } from "vitest";
import { seedFromConfig, DEFAULT_ACCOUNT_SID } from "../index.js";
import { basicAuth, createTwilioTestApp, formBody, formHeaders } from "./helpers.js";

describe("Twilio available phone numbers", () => {
  let setup: ReturnType<typeof createTwilioTestApp>;

  beforeEach(() => {
    setup = createTwilioTestApp();
  });

  async function search(path: string) {
    const res = await setup.app.request(
      `http://localhost/2010-04-01/Accounts/${DEFAULT_ACCOUNT_SID}/AvailablePhoneNumbers/${path}`,
      { headers: { Authorization: basicAuth() } },
    );
    return { status: res.status, body: (await res.json()) as any };
  }

  it("generates fictional local numbers in the requested area code", async () => {
    const { status, body } = await search("CA/Local.json?AreaCode=306&VoiceEnabled=true&SmsEnabled=true&PageSize=3");
    expect(status).toBe(200);
    expect(body.available_phone_numbers).toEqual([
      expect.objectContaining({ phone_number: "+13065550100", friendly_name: "(306) 555-0100", iso_country: "CA" }),
      expect.objectContaining({ phone_number: "+13065550101" }),
      expect.objectContaining({ phone_number: "+13065550102" }),
    ]);
    expect(body.available_phone_numbers[0]).toEqual({
      friendly_name: "(306) 555-0100",
      phone_number: "+13065550100",
      lata: null,
      locality: null,
      rate_center: null,
      latitude: null,
      longitude: null,
      region: null,
      postal_code: null,
      iso_country: "CA",
      address_requirements: "none",
      beta: false,
      capabilities: { voice: true, SMS: true, MMS: true, fax: false },
    });
    expect(body.page_size).toBe(3);
    expect(body.uri).toBe(`/2010-04-01/Accounts/${DEFAULT_ACCOUNT_SID}/AvailablePhoneNumbers/CA/Local.json`);
  });

  it("leaves out numbers that are already owned", async () => {
    const buy = await setup.app.request(
      `http://localhost/2010-04-01/Accounts/${DEFAULT_ACCOUNT_SID}/IncomingPhoneNumbers.json`,
      {
        method: "POST",
        headers: formHeaders(),
        body: formBody({ PhoneNumber: "+13065550100" }),
      },
    );
    expect(buy.status).toBe(201);

    const { body } = await search("CA/Local.json?AreaCode=306&PageSize=2");
    expect(body.available_phone_numbers.map((n: any) => n.phone_number)).toEqual(["+13065550101", "+13065550102"]);
  });

  it("keeps search filters on page links", async () => {
    const first = await search("CA/Local.json?AreaCode=306&SmsEnabled=true&PageSize=2");
    const next = new URL(first.body.next_page_uri, "http://localhost");
    expect(next.searchParams.get("AreaCode")).toBe("306");
    expect(next.searchParams.get("SmsEnabled")).toBe("true");

    const second = await search(`CA/Local.json${next.search}`);
    expect(second.body.available_phone_numbers.map((n: any) => n.phone_number)).toEqual([
      "+13065550102",
      "+13065550103",
    ]);
  });

  it("returns seeded numbers in place of generated ones and applies filters", async () => {
    seedFromConfig(setup.store, "http://localhost:4301", {
      available_phone_numbers: [
        {
          phone_number: "+13065550142",
          friendly_name: "(306) 555-0142",
          iso_country: "CA",
          locality: "Regina",
          region: "SK",
        },
        {
          phone_number: "+13065550177",
          iso_country: "CA",
          capabilities: { sms: false, mms: false },
        },
        { phone_number: "+12045550123", iso_country: "CA", locality: "Winnipeg", region: "MB" },
        { phone_number: "+18005550100", iso_country: "CA", type: "toll_free" },
      ],
    });

    const all = await search("CA/Local.json");
    expect(all.body.available_phone_numbers.map((n: any) => n.phone_number)).toEqual([
      "+13065550142",
      "+13065550177",
      "+12045550123",
    ]);
    expect(all.body.available_phone_numbers[0]).toMatchObject({ locality: "Regina", region: "SK" });

    const smsCapable = await search("CA/Local.json?AreaCode=306&SmsEnabled=true");
    expect(smsCapable.body.available_phone_numbers.map((n: any) => n.phone_number)).toEqual(["+13065550142"]);

    const contains = await search("CA/Local.json?Contains=55501*7");
    expect(contains.body.available_phone_numbers.map((n: any) => n.phone_number)).toEqual(["+13065550177"]);

    const anchored = await search(`CA/Local.json?Contains=${encodeURIComponent("+1204%")}`);
    expect(anchored.body.available_phone_numbers.map((n: any) => n.phone_number)).toEqual(["+12045550123"]);

    const unseededAreaCode = await search("CA/Local.json?AreaCode=403");
    expect(unseededAreaCode.body.available_phone_numbers).toEqual([]);

    const tollFree = await search("CA/TollFree.json");
    expect(tollFree.body.available_phone_numbers.map((n: any) => n.phone_number)).toEqual(["+18005550100"]);
  });

  it("matches Contains letters against keypad digits", async () => {
    const { body } = await search("US/Local.json?AreaCode=415&Contains=JJJ0101$");
    expect(body.available_phone_numbers.map((n: any) => n.phone_number)).toEqual(["+14155550101"]);
  });

  it("generates no mobile or toll-free numbers without a seed", async () => {
    expect((await search("US/TollFree.json")).body.available_phone_numbers).toEqual([]);
    expect((await search("US/Mobile.json")).body.available_phone_numbers).toEqual([]);
  });

  it.each(["US/Local.json?AreaCode=999", "US/Local.json?AreaCode=411", "US/TollFree.json?AreaCode=306"])(
    "rejects an invalid area code on %s",
    async (path) => {
      const { status, body } = await search(path);
      expect(status).toBe(400);
      expect(body).toMatchObject({ code: 21451, message: "Invalid area code" });
    },
  );

  it("requires Basic auth", async () => {
    const res = await setup.app.request(
      `http://localhost/2010-04-01/Accounts/${DEFAULT_ACCOUNT_SID}/AvailablePhoneNumbers/US/Local.json`,
    );
    expect(res.status).toBe(401);
  });
});
