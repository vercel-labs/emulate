import type { RouteContext } from "@emulators/core";
import { getVercelStore } from "../../store.js";
import type { BlobRouteContext } from "./context.js";
import { registerPut } from "./put.js";
import { registerHeadList } from "./head-list.js";
import { registerDelete } from "./delete.js";
import { registerMultipart } from "./multipart.js";
import { registerContent } from "./content.js";

export function blobRoutes({ app, store, baseUrl }: RouteContext): void {
  const vs = getVercelStore(store);
  const parsedBaseUrl = new URL(baseUrl);
  const ctx: BlobRouteContext = { app, vs, baseUrl, parsedBaseUrl };

  registerPut(ctx);
  registerHeadList(ctx);
  registerDelete(ctx);
  registerMultipart(ctx);
  registerContent(ctx);
}
