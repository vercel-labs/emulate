import type { Hono } from "hono";
import type { ServicePlugin, Store, WebhookDispatcher, TokenMap, AppEnv, RouteContext } from "@emulators/core";
import { getTwilioStore } from "./store.js";
import { generateSid } from "./helpers.js";
import { messageRoutes } from "./routes/messages.js";
import { callRoutes } from "./routes/calls.js";
import { verifyRoutes } from "./routes/verify.js";
import { inboxRoutes } from "./routes/inbox.js";

export { getTwilioStore, type TwilioStore } from "./store.js";
export * from "./entities.js";

export interface TwilioSeedConfig {
  port?: number;
  account_sid?: string;
  auth_token?: string;
  phone_numbers?: string[];
  verify_services?: Array<{
    sid?: string;
    friendly_name: string;
    code_length?: number;
  }>;
}

export function seedFromConfig(store: Store, _baseUrl: string, config: TwilioSeedConfig): void {
  const ts = getTwilioStore(store);
  const accountSid = config.account_sid ?? "AC_test_account";

  if (config.phone_numbers) {
    for (const num of config.phone_numbers) {
      ts.phoneNumbers.insert({
        sid: generateSid("PN"),
        account_sid: accountSid,
        phone_number: num,
        friendly_name: num,
      });
    }
  }

  if (config.verify_services) {
    for (const svc of config.verify_services) {
      ts.verifyServices.insert({
        sid: svc.sid ?? generateSid("VA"),
        friendly_name: svc.friendly_name,
        code_length: svc.code_length ?? 6,
      });
    }
  }
}

export const twilioPlugin: ServicePlugin = {
  name: "twilio",
  register(app: Hono<AppEnv>, store: Store, webhooks: WebhookDispatcher, baseUrl: string, tokenMap?: TokenMap): void {
    const ctx: RouteContext = { app, store, webhooks, baseUrl, tokenMap };
    messageRoutes(ctx);
    callRoutes(ctx);
    verifyRoutes(ctx);
    inboxRoutes(ctx);
  },
  seed(store: Store, _baseUrl: string): void {
    const ts = getTwilioStore(store);
    // Seed a default phone number
    ts.phoneNumbers.insert({
      sid: generateSid("PN"),
      account_sid: "AC_test_account",
      phone_number: "+15551234567",
      friendly_name: "+15551234567",
    });
    // Seed a default verify service
    ts.verifyServices.insert({
      sid: "VA_default_service",
      friendly_name: "Default Verify Service",
      code_length: 6,
    });
  },
};

export default twilioPlugin;
