import { api, badRequest, emailValid, first, parseBody, route } from "../helpers.js";
import type { MailgunRouteContext } from "../route-utils.js";

const DISPOSABLE_DOMAINS = new Set([
  "mailinator.com",
  "guerrillamail.com",
  "yopmail.com",
  "10minutemail.com",
  "tempmail.com",
  "trashmail.com",
  "sharklasers.com",
  "dispostable.com",
]);
const ROLE_LOCAL_PARTS = new Set([
  "postmaster",
  "admin",
  "administrator",
  "info",
  "support",
  "sales",
  "noreply",
  "no-reply",
  "contact",
  "webmaster",
  "abuse",
  "billing",
  "help",
  "marketing",
  "security",
  "team",
]);
const TYPOS: Record<string, string> = {
  "gmial.com": "gmail.com",
  "gmal.com": "gmail.com",
  "gamil.com": "gmail.com",
  "gmail.co": "gmail.com",
  "gmail.cm": "gmail.com",
  "hotmal.com": "hotmail.com",
  "hotmial.com": "hotmail.com",
  "yaho.com": "yahoo.com",
  "yahooo.com": "yahoo.com",
  "outlok.com": "outlook.com",
  "outloo.com": "outlook.com",
  "protonmial.com": "protonmail.com",
};

export function validateAddress(raw: string): Record<string, unknown> {
  const address = raw.trim();
  const lowered = address.toLowerCase();
  const [localPart = "", domain = ""] = lowered.split("@");
  const base: Record<string, unknown> = {
    address,
    did_you_mean: null,
    is_disposable_address: false,
    is_role_address: false,
    reason: [] as string[],
    result: "deliverable",
    risk: "low",
    root_address: address,
    engagement: { engaging: false, behavior: "unknown", is_bot: false },
  };
  if (!emailValid(address)) {
    return { ...base, result: "undeliverable", risk: "high", reason: ["malformed"], root_address: null };
  }
  const plusIndex = localPart.indexOf("+");
  if (plusIndex > 0) base.root_address = `${localPart.slice(0, plusIndex)}@${domain}`;
  if (TYPOS[domain]) {
    return {
      ...base,
      did_you_mean: `${localPart}@${TYPOS[domain]}`,
      result: "undeliverable",
      risk: "high",
      reason: ["no_mx", "unknown_provider"],
    };
  }
  if (DISPOSABLE_DOMAINS.has(domain)) {
    return { ...base, is_disposable_address: true, result: "do_not_send", risk: "high", reason: ["disposable"] };
  }
  if (localPart === "bounce" || domain === "bounce.test" || domain.endsWith(".invalid")) {
    return { ...base, result: "undeliverable", risk: "high", reason: ["mailbox_does_not_exist"] };
  }
  if (ROLE_LOCAL_PARTS.has(localPart)) {
    return { ...base, is_role_address: true, result: "deliverable", risk: "medium", reason: [] };
  }
  if (
    domain.endsWith(".test") ||
    domain.endsWith(".example") ||
    domain === "example.com" ||
    domain.endsWith(".localhost")
  ) {
    return { ...base, result: "catch_all", risk: "medium", reason: ["catch_all"] };
  }
  return base;
}

export function validateRoutes(rc: MailgunRouteContext): void {
  const { app, ms } = rc;

  route(
    app,
    "get",
    "/v4/address/validate",
    api(ms, (c) => {
      const address = c.req.query("address");
      if (!address) throw badRequest("'address' parameter is missing");
      return c.json(validateAddress(address));
    }),
  );

  route(
    app,
    "post",
    "/v4/address/validate",
    api(ms, async (c) => {
      const body = await parseBody(c);
      const address = first(body, "address") ?? c.req.query("address");
      if (!address) throw badRequest("'address' parameter is missing");
      return c.json(validateAddress(address));
    }),
  );

  route(
    app,
    "get",
    "/v3/address/validate",
    api(ms, (c) => {
      const address = c.req.query("address");
      if (!address) throw badRequest("'address' parameter is missing");
      const result = validateAddress(address);
      return c.json({
        address: result.address,
        did_you_mean: result.did_you_mean,
        is_disposable_address: result.is_disposable_address,
        is_role_address: result.is_role_address,
        is_valid: result.result !== "undeliverable",
        mailbox_verification:
          result.result === "deliverable" ? "true" : result.result === "undeliverable" ? "false" : "unknown",
        parts: {
          display_name: null,
          domain: String(result.address).split("@")[1] ?? null,
          local_part: String(result.address).split("@")[0] ?? null,
        },
        reason: (result.reason as string[])[0] ?? null,
      });
    }),
  );
}
