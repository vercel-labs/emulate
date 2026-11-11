import type { ServiceHost } from "@emulators/core";

/**
 * Real Google hosts. The OAuth token and revocation endpoints live at the root
 * of oauth2.googleapis.com and are served under `/oauth2` by the emulator.
 */
export const hosts: readonly ServiceHost[] = [
  { host: "accounts.google.com" },
  { host: "www.googleapis.com" },
  { host: "gmail.googleapis.com" },
  { host: "oauth2.googleapis.com", prefix: "/oauth2" },
];
