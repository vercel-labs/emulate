import type { RouteContext } from "@emulators/core";
import type { VercelStore } from "../../store.js";

export interface BlobRouteContext {
  app: RouteContext["app"];
  vs: VercelStore;
  baseUrl: string;
  parsedBaseUrl: URL;
}
