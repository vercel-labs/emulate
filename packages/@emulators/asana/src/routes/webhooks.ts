import type { RouteContext } from "@emulators/core";
import { getAsanaStore } from "../store.js";
import {
  generateGid,
  asanaError,
  asanaData,
  parsePagination,
  applyPagination,
  parseAsanaBody,
  formatWebhook,
} from "../helpers.js";

export function webhookRoutes({ app, store, baseUrl }: RouteContext): void {
  const as = () => getAsanaStore(store);

  app.get("/api/1.0/webhooks", (c) => {
    const pagination = parsePagination(c);
    const resourceGid = c.req.query("resource");

    let webhooks = as().webhooks.all();
    if (resourceGid) webhooks = webhooks.filter((w) => w.resource_gid === resourceGid);

    const s = as();
    const formatted = webhooks.map((w) => formatWebhook(w, s));
    const result = applyPagination(formatted, pagination, "/api/1.0/webhooks", baseUrl);
    return c.json(result);
  });

  app.post("/api/1.0/webhooks", async (c) => {
    const body = await parseAsanaBody(c);
    if (!body.resource) return asanaError(c, 400, "resource: Missing input");
    if (!body.target) return asanaError(c, 400, "target: Missing input");

    const gid = generateGid();
    const webhook = as().webhooks.insert({
      gid,
      resource_type: "webhook",
      resource_gid: body.resource as string,
      target: body.target as string,
      active: true,
      last_success_at: null,
      last_failure_at: null,
      last_failure_content: "",
    });

    return c.json(asanaData(formatWebhook(webhook, as())), 201);
  });

  app.get("/api/1.0/webhooks/:webhook_gid", (c) => {
    const gid = c.req.param("webhook_gid");
    const webhook = as().webhooks.findOneBy("gid", gid);
    if (!webhook) return asanaError(c, 404, "webhook: Not Found");
    return c.json(asanaData(formatWebhook(webhook, as())));
  });

  app.put("/api/1.0/webhooks/:webhook_gid", async (c) => {
    const gid = c.req.param("webhook_gid");
    const webhook = as().webhooks.findOneBy("gid", gid);
    if (!webhook) return asanaError(c, 404, "webhook: Not Found");

    const body = await parseAsanaBody(c);
    const updates: Partial<{ active: boolean }> = {};
    if (body.active !== undefined) updates.active = body.active as boolean;

    const updated = as().webhooks.update(webhook.id, updates);
    return c.json(asanaData(formatWebhook(updated ?? webhook, as())));
  });

  app.delete("/api/1.0/webhooks/:webhook_gid", (c) => {
    const gid = c.req.param("webhook_gid");
    const webhook = as().webhooks.findOneBy("gid", gid);
    if (!webhook) return asanaError(c, 404, "webhook: Not Found");

    as().webhooks.delete(webhook.id);
    return c.json(asanaData({}));
  });
}
