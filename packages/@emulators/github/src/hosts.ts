import type { ServiceHost } from "@emulators/core";

/** Real GitHub hosts. REST and OAuth paths do not overlap, so every host maps unchanged. */
export const hosts: readonly ServiceHost[] = [
  { host: "api.github.com" },
  { host: "github.com" },
  { host: "uploads.github.com" },
];
