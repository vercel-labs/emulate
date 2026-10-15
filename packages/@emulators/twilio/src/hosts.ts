import type { ServiceHost } from "@emulators/core";

/** Real Twilio product hosts. The emulator mounts each product API under a path prefix. */
export const hosts: readonly ServiceHost[] = [
  { host: "api.twilio.com" },
  { host: "verify.twilio.com", prefix: "/verify" },
  { host: "messaging.twilio.com", prefix: "/messaging" },
  { host: "conversations.twilio.com", prefix: "/conversations" },
];
