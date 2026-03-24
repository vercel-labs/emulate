import type { RouteContext } from "@internal/core";
import { parseJsonBody, requireAuth } from "@internal/core";
import { getResendStore } from "../store.js";
import {
  generateWebhookSecret,
  resendError,
  parseResendPagination,
  applyResendPagination,
} from "../helpers.js";
import type { ResendWebhook } from "../entities.js";

function formatWebhook(webhook: ResendWebhook) {
  return {
    object: "webhook" as const,
    id: String(webhook.id),
    endpoint: webhook.endpoint,
    events: webhook.events,
    status: webhook.status,
    signing_secret: webhook.signing_secret,
    created_at: webhook.created_at,
    updated_at: webhook.updated_at,
  };
}

export function webhookRoutes({ app, store }: RouteContext): void {
  const rs = getResendStore(store);

  // Create webhook
  app.post("/webhooks", requireAuth(), async (c) => {
    const body = await parseJsonBody(c);

    const endpoint = body.endpoint;
    if (typeof endpoint !== "string" || !endpoint) {
      return resendError(c, 422, "validation_error", "Missing required field: endpoint");
    }

    const events = Array.isArray(body.events) ? body.events.filter((e): e is string => typeof e === "string") : [];
    if (events.length === 0) {
      return resendError(c, 422, "validation_error", "Missing required field: events");
    }

    const signingSecret = generateWebhookSecret();

    const webhook = rs.webhooks.insert({
      endpoint,
      events,
      status: "enabled",
      signing_secret: signingSecret,
    });

    return c.json(formatWebhook(webhook));
  });

  // List webhooks
  app.get("/webhooks", requireAuth(), (c) => {
    const pagination = parseResendPagination(c);
    const allWebhooks = rs.webhooks.all();
    const { data, has_more } = applyResendPagination(allWebhooks, pagination);

    return c.json({
      object: "list",
      has_more,
      data: data.map(formatWebhook),
    });
  });

  // Get webhook
  app.get("/webhooks/:id", requireAuth(), (c) => {
    const id = parseInt(c.req.param("id"), 10);
    const webhook = rs.webhooks.get(id);
    if (!webhook) {
      return resendError(c, 404, "not_found", "Webhook not found");
    }
    return c.json(formatWebhook(webhook));
  });

  // Update webhook
  app.patch("/webhooks/:id", requireAuth(), async (c) => {
    const id = parseInt(c.req.param("id"), 10);
    const webhook = rs.webhooks.get(id);
    if (!webhook) {
      return resendError(c, 404, "not_found", "Webhook not found");
    }

    const body = await parseJsonBody(c);
    const updates: Partial<ResendWebhook> = {};

    if (typeof body.endpoint === "string") {
      updates.endpoint = body.endpoint;
    }
    if (Array.isArray(body.events)) {
      updates.events = body.events.filter((e): e is string => typeof e === "string");
    }
    if (typeof body.status === "string") {
      updates.status = body.status as ResendWebhook["status"];
    }

    const updated = rs.webhooks.update(id, updates);
    if (!updated) {
      return resendError(c, 404, "not_found", "Webhook not found");
    }

    return c.json(formatWebhook(updated));
  });

  // Delete webhook
  app.delete("/webhooks/:id", requireAuth(), (c) => {
    const id = parseInt(c.req.param("id"), 10);
    const webhook = rs.webhooks.get(id);
    if (!webhook) {
      return resendError(c, 404, "not_found", "Webhook not found");
    }

    rs.webhooks.delete(id);

    return c.json({
      object: "webhook",
      id: String(id),
      deleted: true,
    });
  });
}
