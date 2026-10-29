import type { ServiceHost } from "@emulators/core";

/** Real Clerk hosts: the Backend API and development Frontend API instances. */
export const hosts: readonly ServiceHost[] = [{ host: "api.clerk.com" }, { host: "*.clerk.accounts.dev" }];
