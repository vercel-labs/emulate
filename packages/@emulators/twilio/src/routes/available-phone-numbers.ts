import type { Context, InsertInput, RouteContext } from "@emulators/core";
import type { TwilioAvailablePhoneNumber, TwilioAvailablePhoneNumberType } from "../entities.js";
import { formatAvailablePhoneNumber } from "../formatters.js";
import { getTwilioStore } from "../store.js";
import { accountFromParam, requireTwilioAuth, twilioError, twilioList } from "../helpers.js";

type AvailablePhoneNumber = InsertInput<TwilioAvailablePhoneNumber>;

const RESOURCE_TYPES: Record<string, TwilioAvailablePhoneNumberType> = {
  Local: "local",
  Mobile: "mobile",
  TollFree: "toll_free",
};

const DEFAULT_AREA_CODES: Record<string, string> = { US: "415", CA: "416" };

const TOLL_FREE_AREA_CODES = ["800", "833", "844", "855", "866", "877", "888"];

const CAPABILITY_FILTERS = [
  ["SmsEnabled", "sms"],
  ["MmsEnabled", "mms"],
  ["VoiceEnabled", "voice"],
] as const;

const KEYPAD = ["abc", "def", "ghi", "jkl", "mno", "pqrs", "tuv", "wxyz"];

export function availablePhoneNumberRoutes({ app, store }: RouteContext): void {
  const ts = getTwilioStore(store);

  for (const [resource, type] of Object.entries(RESOURCE_TYPES)) {
    app.get(`/2010-04-01/Accounts/:accountSid/AvailablePhoneNumbers/:countryCode/${resource}.json`, (c) => {
      const account = authenticatedAccount(c);
      if (account instanceof Response) return account;

      const filters: Record<string, string> = {};
      for (const key of ["AreaCode", "Contains", ...CAPABILITY_FILTERS.map(([param]) => param)]) {
        const value = c.req.query(key);
        if (value !== undefined) filters[key] = value;
      }
      const areaCode = filters.AreaCode;
      if (areaCode !== undefined && !isValidAreaCode(areaCode, type)) {
        return twilioError(c, 400, "Invalid area code", 21451);
      }
      const pattern = filters.Contains ? containsPattern(filters.Contains) : null;

      const countryCode = c.req.param("countryCode").toUpperCase();
      const seeded = ts.availablePhoneNumbers.findBy("iso_country", countryCode).filter((n) => n.type === type);
      const candidates: AvailablePhoneNumber[] = seeded.length ? seeded : generatedNumbers(countryCode, type, areaCode);
      const owned = new Set(ts.phoneNumbers.all().map((n) => n.phone_number));

      const results = candidates.filter(
        (number) =>
          !owned.has(number.phone_number) &&
          (!areaCode || number.phone_number.startsWith(`+1${areaCode}`)) &&
          (!pattern || pattern.test(number.phone_number)) &&
          CAPABILITY_FILTERS.every(
            ([param, capability]) =>
              filters[param] === undefined ||
              number.capabilities[capability] === (filters[param].toLowerCase() === "true"),
          ),
      );

      return twilioList(
        c,
        "available_phone_numbers",
        results,
        `/2010-04-01/Accounts/${account.sid}/AvailablePhoneNumbers/${countryCode}/${resource}.json`,
        formatAvailablePhoneNumber,
        filters,
      );
    });
  }

  function authenticatedAccount(c: Context) {
    const auth = requireTwilioAuth(c, ts);
    if (auth instanceof Response) return auth;
    return accountFromParam(c, ts, auth);
  }
}

// North American area codes are NXX with a second digit other than 9, and never N11.
function isValidAreaCode(areaCode: string, type: TwilioAvailablePhoneNumberType): boolean {
  if (type === "toll_free") return TOLL_FREE_AREA_CODES.includes(areaCode);
  return /^[2-9][0-8]\d$/.test(areaCode) && areaCode.slice(1) !== "11";
}

function generatedNumbers(
  countryCode: string,
  type: TwilioAvailablePhoneNumberType,
  areaCode: string | undefined,
): AvailablePhoneNumber[] {
  if (type !== "local" || !(countryCode in DEFAULT_AREA_CODES)) return [];
  const area = areaCode ?? DEFAULT_AREA_CODES[countryCode];
  return Array.from({ length: 100 }, (_, index) => {
    const line = String(index).padStart(2, "0");
    return {
      phone_number: `+1${area}55501${line}`,
      friendly_name: `(${area}) 555-01${line}`,
      iso_country: countryCode,
      type,
      lata: null,
      locality: null,
      rate_center: null,
      latitude: null,
      longitude: null,
      region: null,
      postal_code: null,
      address_requirements: "none",
      beta: false,
      capabilities: { voice: true, sms: true, mms: true, fax: false },
    };
  });
}

// Twilio Contains: letters are keypad digits, * is one digit, % is any digits, leading + and trailing $ anchor.
function containsPattern(contains: string): RegExp {
  const anchoredStart = contains.startsWith("+");
  const anchoredEnd = contains.endsWith("$");
  const body = contains.slice(anchoredStart ? 1 : 0, anchoredEnd ? -1 : undefined);
  let source = "";
  for (const char of body.toLowerCase()) {
    const key = KEYPAD.findIndex((letters) => letters.includes(char));
    if (char === "*") source += "\\d";
    else if (char === "%") source += "\\d*";
    else if (key !== -1) source += String(key + 2);
    else source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${anchoredStart ? "^\\+" : ""}${source}${anchoredEnd ? "$" : ""}`);
}
