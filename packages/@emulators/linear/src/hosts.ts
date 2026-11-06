import type { ServiceHost } from "@emulators/core";

/** Real Linear hosts. GraphQL and token exchange use the API host; authorization uses the app host. */
export const hosts: readonly ServiceHost[] = [{ host: "api.linear.app" }, { host: "linear.app" }];
