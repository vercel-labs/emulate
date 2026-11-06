import type { ServiceHost } from "@emulators/core";

/**
 * Real Okta org hosts. The org name lives in the hostname, so there is no
 * fixed primary host; pass your org URL as the advertised base URL.
 */
export const hosts: readonly ServiceHost[] = [
  { host: "*.okta.com" },
  { host: "*.oktapreview.com" },
  { host: "*.okta-emea.com" },
];
