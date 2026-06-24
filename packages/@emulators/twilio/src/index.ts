import type { Hono } from "@emulators/core";
import type { AppEnv, RouteContext, ServicePlugin, Store, TokenMap, WebhookDispatcher } from "@emulators/core";
import { fixedSid, twilioSid } from "./ids.js";
import { getTwilioStore } from "./store.js";
import { accountRoutes } from "./routes/accounts.js";
import { phoneNumberRoutes } from "./routes/phone-numbers.js";
import { messagingServiceRoutes } from "./routes/messaging-services.js";
import { messageRoutes } from "./routes/messages.js";
import { verifyRoutes } from "./routes/verify.js";
import { callRoutes } from "./routes/calls.js";
import { conversationRoutes } from "./routes/conversations.js";
import { simulatorRoutes } from "./routes/simulator.js";
import { inspectorRoutes } from "./routes/inspector.js";

export { getTwilioStore, type TwilioStore } from "./store.js";
export * from "./entities.js";

export interface TwilioSeedConfig {
  port?: number;
  account?: {
    sid?: string;
    auth_token?: string;
    friendly_name?: string;
    status?: "active" | "suspended" | "closed";
  };
  api_keys?: Array<{
    sid?: string;
    secret: string;
    friendly_name?: string;
  }>;
  phone_numbers?: Array<{
    sid?: string;
    phone_number: string;
    friendly_name?: string;
    sms_url?: string;
    sms_method?: string;
    voice_url?: string;
    voice_method?: string;
    status_callback?: string;
  }>;
  messaging_services?: Array<{
    sid?: string;
    friendly_name: string;
    phone_numbers?: string[];
    status_callback?: string;
    inbound_request_url?: string;
  }>;
  verify_services?: Array<{
    sid?: string;
    friendly_name: string;
    code?: string;
    default_channel?: string;
  }>;
  conversations?: {
    services?: Array<{
      sid?: string;
      friendly_name: string;
    }>;
  };
}

export const DEFAULT_ACCOUNT_SID = fixedSid("AC");
export const DEFAULT_API_KEY_SID = fixedSid("SK");
export const DEFAULT_PHONE_NUMBER_SID = fixedSid("PN");
export const DEFAULT_MESSAGING_SERVICE_SID = fixedSid("MG");
export const DEFAULT_VERIFY_SERVICE_SID = fixedSid("VA");
export const DEFAULT_AUTH_TOKEN = "twilio_test_auth_token";
export const DEFAULT_API_KEY_SECRET = "twilio_test_api_secret";
export const DEFAULT_PHONE_NUMBER = "+15551234567";

function seedDefaults(store: Store): void {
  seedFromConfig(store, "", {
    account: {
      sid: DEFAULT_ACCOUNT_SID,
      auth_token: DEFAULT_AUTH_TOKEN,
      friendly_name: "Local Twilio Account",
      status: "active",
    },
    api_keys: [{ sid: DEFAULT_API_KEY_SID, secret: DEFAULT_API_KEY_SECRET, friendly_name: "Local API Key" }],
    phone_numbers: [
      {
        sid: DEFAULT_PHONE_NUMBER_SID,
        phone_number: DEFAULT_PHONE_NUMBER,
        friendly_name: "Local SMS and Voice Number",
      },
    ],
    messaging_services: [
      {
        sid: DEFAULT_MESSAGING_SERVICE_SID,
        friendly_name: "Local Messaging Service",
        phone_numbers: [DEFAULT_PHONE_NUMBER],
      },
    ],
    verify_services: [
      {
        sid: DEFAULT_VERIFY_SERVICE_SID,
        friendly_name: "Local Verify Service",
        code: "123456",
        default_channel: "sms",
      },
    ],
    conversations: {
      services: [{ friendly_name: "Local Conversations" }],
    },
  });
}

export function seedFromConfig(store: Store, _baseUrl: string, config: TwilioSeedConfig): void {
  const ts = getTwilioStore(store);
  const accountSid = config.account?.sid ?? DEFAULT_ACCOUNT_SID;
  let account = ts.accounts.findOneBy("sid", accountSid);
  if (!account) {
    account = ts.accounts.insert({
      sid: accountSid,
      friendly_name: config.account?.friendly_name ?? "Local Twilio Account",
      auth_token: config.account?.auth_token ?? DEFAULT_AUTH_TOKEN,
      status: config.account?.status ?? "active",
      owner_account_sid: null,
    });
  } else {
    account = ts.accounts.update(account.id, {
      friendly_name: config.account?.friendly_name ?? account.friendly_name,
      auth_token: config.account?.auth_token ?? account.auth_token,
      status: config.account?.status ?? account.status,
    })!;
  }

  for (const key of config.api_keys ?? []) {
    const existing = key.sid ? ts.apiKeys.findOneBy("sid", key.sid) : undefined;
    if (existing) {
      ts.apiKeys.update(existing.id, {
        account_sid: account.sid,
        secret: key.secret,
        friendly_name: key.friendly_name ?? existing.friendly_name,
        active: true,
      });
      continue;
    }
    ts.apiKeys.insert({
      sid: key.sid ?? twilioSid("SK"),
      account_sid: account.sid,
      secret: key.secret,
      friendly_name: key.friendly_name ?? "Local API Key",
      active: true,
    });
  }

  for (const number of config.phone_numbers ?? []) {
    const existing =
      (number.sid ? ts.phoneNumbers.findOneBy("sid", number.sid) : undefined) ??
      ts.phoneNumbers.findOneBy("phone_number", number.phone_number);
    if (existing) {
      ts.phoneNumbers.update(existing.id, {
        account_sid: account.sid,
        phone_number: number.phone_number,
        friendly_name: number.friendly_name ?? existing.friendly_name,
        sms_url: number.sms_url ?? existing.sms_url,
        sms_method: number.sms_method ? number.sms_method.toUpperCase() : existing.sms_method,
        voice_url: number.voice_url ?? existing.voice_url,
        voice_method: number.voice_method ? number.voice_method.toUpperCase() : existing.voice_method,
        status_callback: number.status_callback ?? existing.status_callback,
      });
      continue;
    }
    ts.phoneNumbers.insert({
      sid: number.sid ?? twilioSid("PN"),
      account_sid: account.sid,
      phone_number: number.phone_number,
      friendly_name: number.friendly_name ?? number.phone_number,
      capabilities: { sms: true, mms: true, voice: true },
      sms_url: number.sms_url ?? null,
      sms_method: (number.sms_method ?? "POST").toUpperCase(),
      voice_url: number.voice_url ?? null,
      voice_method: (number.voice_method ?? "POST").toUpperCase(),
      status_callback: number.status_callback ?? null,
      application_sid: null,
    });
  }

  for (const serviceCfg of config.messaging_services ?? []) {
    let service = serviceCfg.sid
      ? ts.messagingServices.findOneBy("sid", serviceCfg.sid)
      : ts.messagingServices
          .findBy("account_sid", account.sid)
          .find((candidate) => candidate.friendly_name === serviceCfg.friendly_name);
    if (!service) {
      service = ts.messagingServices.insert({
        sid: serviceCfg.sid ?? twilioSid("MG"),
        account_sid: account.sid,
        friendly_name: serviceCfg.friendly_name,
        inbound_request_url: serviceCfg.inbound_request_url ?? null,
        status_callback: serviceCfg.status_callback ?? null,
      });
    } else {
      service = ts.messagingServices.update(service.id, {
        friendly_name: serviceCfg.friendly_name,
        inbound_request_url: serviceCfg.inbound_request_url ?? service.inbound_request_url,
        status_callback: serviceCfg.status_callback ?? service.status_callback,
      })!;
    }
    for (const numberRef of serviceCfg.phone_numbers ?? []) {
      const phoneNumber =
        ts.phoneNumbers.findOneBy("phone_number", numberRef) ?? ts.phoneNumbers.findOneBy("sid", numberRef);
      if (!phoneNumber) continue;
      const alreadyAssigned = ts.messagingServicePhoneNumbers
        .findBy("service_sid", service.sid)
        .some((item) => item.phone_number_sid === phoneNumber.sid);
      if (alreadyAssigned) continue;
      ts.messagingServicePhoneNumbers.insert({
        sid: twilioSid("PN"),
        account_sid: account.sid,
        service_sid: service.sid,
        phone_number_sid: phoneNumber.sid,
      });
    }
  }

  for (const service of config.verify_services ?? []) {
    const existing = service.sid
      ? ts.verifyServices.findOneBy("sid", service.sid)
      : ts.verifyServices
          .findBy("account_sid", account.sid)
          .find((candidate) => candidate.friendly_name === service.friendly_name);
    if (existing) {
      ts.verifyServices.update(existing.id, {
        friendly_name: service.friendly_name,
        code: service.code ?? existing.code,
        default_channel: service.default_channel ?? existing.default_channel,
      });
      continue;
    }
    ts.verifyServices.insert({
      sid: service.sid ?? twilioSid("VA"),
      account_sid: account.sid,
      friendly_name: service.friendly_name,
      code: service.code ?? "123456",
      default_channel: service.default_channel ?? "sms",
    });
  }

  for (const service of config.conversations?.services ?? []) {
    const existing = service.sid
      ? ts.conversationServices.findOneBy("sid", service.sid)
      : ts.conversationServices
          .findBy("account_sid", account.sid)
          .find((candidate) => candidate.friendly_name === service.friendly_name);
    if (existing) {
      ts.conversationServices.update(existing.id, { friendly_name: service.friendly_name });
      continue;
    }
    ts.conversationServices.insert({
      sid: service.sid ?? twilioSid("IS"),
      account_sid: account.sid,
      friendly_name: service.friendly_name,
    });
  }
}

export const twilioPlugin: ServicePlugin = {
  name: "twilio",
  register(app: Hono<AppEnv>, store: Store, webhooks: WebhookDispatcher, baseUrl: string, tokenMap?: TokenMap): void {
    const ctx: RouteContext = { app, store, webhooks, baseUrl, tokenMap };
    accountRoutes(ctx);
    phoneNumberRoutes(ctx);
    messagingServiceRoutes(ctx);
    messageRoutes(ctx);
    verifyRoutes(ctx);
    callRoutes(ctx);
    conversationRoutes(ctx);
    simulatorRoutes(ctx);
    inspectorRoutes(ctx);
  },
  seed(store: Store): void {
    seedDefaults(store);
  },
};

export default twilioPlugin;
