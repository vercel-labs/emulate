import type { ServiceHost } from "@emulators/core";

/** Real Vercel hosts. The Blob SDK calls `https://vercel.com/api/blob`. */
export const hosts: readonly ServiceHost[] = [{ host: "api.vercel.com" }, { host: "vercel.com" }];
