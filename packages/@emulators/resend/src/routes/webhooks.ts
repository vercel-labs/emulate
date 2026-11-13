import type { RouteContext } from "@emulators/core";
import { getResendStore } from "../store.js";
import { generateUuid, resendError, parseResendBody } from "../helpers.js";
import type { ResendWebhook } from "../entities.js";
import { generateSigningSecret, subscribeWebhook } from "../webhooks.js";

const STATUSES = ["enabled", "disabled"] as const;

function isEventList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((event) => typeof event === "string" && event);
}

function formatWebhook(webhook: ResendWebhook) {
  return {
    id: webhook.uuid,
    created_at: webhook.created_at,
    status: webhook.status,
    endpoint: webhook.endpoint,
    events: webhook.events,
  };
}

export function webhookRoutes(ctx: RouteContext): void {
  const { app, store, webhooks } = ctx;
  const rs = () => getResendStore(store);

  app.post("/webhooks", async (c) => {
    const body = await parseResendBody(c);
    if (typeof body.endpoint !== "string" || !body.endpoint) {
      return resendError(c, 422, "validation_error", "Missing required field: endpoint");
    }
    if (!isEventList(body.events)) {
      return resendError(c, 422, "validation_error", "Missing required field: events");
    }

    const webhook = rs().webhooks.insert({
      uuid: generateUuid(),
      endpoint: body.endpoint,
      events: body.events,
      status: "enabled",
      signing_secret: generateSigningSecret(),
    });
    subscribeWebhook(webhooks, webhook);

    return c.json({ object: "webhook", id: webhook.uuid, signing_secret: webhook.signing_secret }, 200);
  });

  app.get("/webhooks", (c) => {
    return c.json({ object: "list", has_more: false, data: rs().webhooks.all().map(formatWebhook) });
  });

  app.get("/webhooks/:id", (c) => {
    const webhook = rs().webhooks.findOneBy("uuid", c.req.param("id"));
    if (!webhook) return resendError(c, 404, "not_found", "Webhook not found");
    return c.json({ object: "webhook", ...formatWebhook(webhook), signing_secret: webhook.signing_secret });
  });

  app.patch("/webhooks/:id", async (c) => {
    const webhook = rs().webhooks.findOneBy("uuid", c.req.param("id"));
    if (!webhook) return resendError(c, 404, "not_found", "Webhook not found");

    const body = await parseResendBody(c);
    const changes: Partial<Pick<ResendWebhook, "endpoint" | "events" | "status">> = {};
    if (body.endpoint !== undefined) {
      if (typeof body.endpoint !== "string" || !body.endpoint) {
        return resendError(c, 422, "validation_error", "endpoint must be a non-empty string");
      }
      changes.endpoint = body.endpoint;
    }
    if (body.events !== undefined) {
      if (!isEventList(body.events)) {
        return resendError(c, 422, "validation_error", "events must be a non-empty array of event types");
      }
      changes.events = body.events;
    }
    if (body.status !== undefined) {
      if (!STATUSES.includes(body.status as ResendWebhook["status"])) {
        return resendError(c, 422, "validation_error", "status must be one of: enabled, disabled");
      }
      changes.status = body.status as ResendWebhook["status"];
    }

    const updated = rs().webhooks.update(webhook.id, changes)!;
    subscribeWebhook(webhooks, updated);

    return c.json({ object: "webhook", id: updated.uuid });
  });

  app.delete("/webhooks/:id", (c) => {
    const webhook = rs().webhooks.findOneBy("uuid", c.req.param("id"));
    if (!webhook) return resendError(c, 404, "not_found", "Webhook not found");

    rs().webhooks.delete(webhook.id);
    webhooks.unregister(webhook.id);

    return c.json({ object: "webhook", id: webhook.uuid, deleted: true });
  });
}
