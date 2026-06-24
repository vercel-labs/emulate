import twilio from "twilio";

// Seeded defaults from the Twilio emulator. The emulator boots with a single
// account, Auth Token, and Verify Service so no setup is required.
export const TWILIO_ACCOUNT_SID = "AC00000000000000000000000000000000";
export const TWILIO_AUTH_TOKEN = "twilio_test_auth_token";
export const VERIFY_SERVICE_SID = "VA00000000000000000000000000000000";

// The seeded Verify Service issues this code for every verification unless a
// CustomCode is supplied. Shown in the UI so the demo can be completed without
// opening the inspector.
export const SEEDED_VERIFY_CODE = "123456";

const EMULATOR_BASE_URL = process.env.TWILIO_BASE_URL ?? "http://localhost:3000/emulate/twilio";

// The official Twilio SDK builds absolute URLs against product hosts such as
// api.twilio.com and verify.twilio.com. This request client rewrites those
// hosts onto the embedded emulator, which mounts each product under a path
// prefix (see the URL mapping in the emulator docs).
const HOST_PREFIXES: Record<string, string> = {
  "api.twilio.com": "",
  "verify.twilio.com": "/verify",
  "messaging.twilio.com": "/messaging",
  "conversations.twilio.com": "/conversations",
};

interface TwilioRequestOptions {
  method: string;
  uri: string;
  username?: string;
  password?: string;
  headers?: Record<string, string>;
  params?: Record<string, string | number | boolean>;
  data?: Record<string, unknown>;
}

class EmulatorRequestClient {
  async request(opts: TwilioRequestOptions) {
    const original = new URL(opts.uri);
    const prefix = HOST_PREFIXES[original.hostname] ?? "";
    const target = new URL(`${EMULATOR_BASE_URL}${prefix}${original.pathname}`);

    for (const [key, value] of Object.entries(opts.params ?? {})) {
      target.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.username && opts.password) {
      headers.Authorization = `Basic ${Buffer.from(`${opts.username}:${opts.password}`).toString("base64")}`;
    }

    let body: string | undefined;
    if (opts.data && Object.keys(opts.data).length > 0) {
      body = new URLSearchParams(
        Object.entries(opts.data).flatMap(([key, value]) => {
          if (Array.isArray(value)) return value.map((item) => [key, String(item)] as [string, string]);
          if (value === undefined || value === null) return [];
          return [[key, String(value)] as [string, string]];
        }),
      ).toString();
      headers["Content-Type"] = headers["Content-Type"] ?? "application/x-www-form-urlencoded";
    }

    const response = await fetch(target, { method: opts.method.toUpperCase(), headers, body });
    const text = await response.text();

    return {
      statusCode: response.status,
      body: text ? JSON.parse(text) : "",
      headers: Object.fromEntries(response.headers.entries()),
    };
  }
}

export const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  httpClient: new EmulatorRequestClient() as any,
});
