import type { ServiceHost } from "@emulators/core";

/** Real Microsoft identity platform and Graph hosts. */
export const hosts: readonly ServiceHost[] = [{ host: "login.microsoftonline.com" }, { host: "graph.microsoft.com" }];
