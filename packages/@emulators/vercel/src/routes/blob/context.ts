import type { RouteContext } from "@emulators/core";
import type { VercelStore } from "../../store.js";
import type { Authenticate } from "./auth.js";

export interface BlobRouteContext {
  app: RouteContext["app"];
  vs: VercelStore;
  baseUrl: string;
  parsedBaseUrl: URL;
  authenticate: Authenticate;
}
