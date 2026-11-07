import type { Context, RouteContext } from "@emulators/core";
import { getStripeStore } from "../store.js";
import { parseStripeBody, readBool, readStringList, stripeError, stripeId, stripeList } from "../helpers.js";
import { formatWebhookEndpoint } from "../formatters.js";
import { syncWebhookEndpoints } from "../events.js";
import type { StripeWebhookEndpoint } from "../entities.js";

function missingParam(c: Context, param: string) {
  return stripeError(c, 400, "invalid_request_error", `Missing required param: ${param}.`, "parameter_missing", param);
}

function invalidUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol !== "http:" && parsed.protocol !== "https:";
  } catch {
    return true;
  }
}

function urlError(c: Context, url: string) {
  return stripeError(c, 400, "invalid_request_error", `Invalid URL: ${url}`, "url_invalid", "url");
}

function notFound(c: Context, id: string) {
  return stripeError(c, 404, "invalid_request_error", `No such webhook_endpoint: '${id}'`, "resource_missing", "id");
}

/** Stripe metadata updates merge keys; an empty string removes a key, and `metadata=""` clears all. */
function mergeMetadata(current: Record<string, string>, update: unknown): Record<string, string> {
  if (update === "") return {};
  if (!update || typeof update !== "object" || Array.isArray(update)) return current;
  const merged = { ...current };
  for (const [key, value] of Object.entries(update as Record<string, unknown>)) {
    if (value === "" || value === null) delete merged[key];
    else merged[key] = String(value);
  }
  return merged;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

export function webhookEndpointRoutes(ctx: RouteContext): void {
  const { app, store, webhooks } = ctx;
  const ss = getStripeStore(store);

  const find = (id: string): StripeWebhookEndpoint | undefined => ss.webhookEndpoints.findOneBy("stripe_id", id);

  app.post("/v1/webhook_endpoints", async (c) => {
    const body = await parseStripeBody(c);
    const url = optionalString(body.url);
    if (!url) return missingParam(c, "url");
    const enabledEvents = readStringList(body.enabled_events);
    if (enabledEvents.length === 0) return missingParam(c, "enabled_events");
    if (invalidUrl(url)) return urlError(c, url);

    const endpoint = ss.webhookEndpoints.insert({
      stripe_id: stripeId("we"),
      url,
      enabled_events: enabledEvents,
      status: "enabled",
      api_version: optionalString(body.api_version),
      description: optionalString(body.description),
      metadata: mergeMetadata({}, body.metadata),
      secret: stripeId("whsec", 32),
      created: Math.floor(Date.now() / 1000),
    });
    syncWebhookEndpoints(store, webhooks);

    return c.json(formatWebhookEndpoint(endpoint, { includeSecret: true }));
  });

  app.get("/v1/webhook_endpoints/:id", (c) => {
    const endpoint = find(c.req.param("id"));
    if (!endpoint) return notFound(c, c.req.param("id"));
    return c.json(formatWebhookEndpoint(endpoint));
  });

  app.post("/v1/webhook_endpoints/:id", async (c) => {
    const endpoint = find(c.req.param("id"));
    if (!endpoint) return notFound(c, c.req.param("id"));
    const body = await parseStripeBody(c);

    const patch: Partial<StripeWebhookEndpoint> = {};
    if (body.url !== undefined) {
      const url = optionalString(body.url);
      if (!url || invalidUrl(url)) return urlError(c, String(body.url));
      patch.url = url;
    }
    if (body.enabled_events !== undefined) {
      const events = readStringList(body.enabled_events);
      if (events.length === 0) {
        return stripeError(
          c,
          400,
          "invalid_request_error",
          "Invalid enabled_events: must list at least one event type.",
          "parameter_invalid_empty",
          "enabled_events",
        );
      }
      patch.enabled_events = events;
    }
    if (body.disabled !== undefined) {
      const disabled = readBool(body.disabled);
      if (disabled === undefined) {
        return stripeError(
          c,
          400,
          "invalid_request_error",
          `Invalid boolean: ${String(body.disabled)}`,
          undefined,
          "disabled",
        );
      }
      patch.status = disabled ? "disabled" : "enabled";
    }
    if (body.description !== undefined) patch.description = optionalString(body.description);
    if (body.metadata !== undefined) patch.metadata = mergeMetadata(endpoint.metadata, body.metadata);

    // Resolve the subscription before the url changes, since url and secret identify it.
    const subscriptionId = syncWebhookEndpoints(store, webhooks).get(endpoint.id);
    const updated = ss.webhookEndpoints.update(endpoint.id, patch)!;
    if (subscriptionId !== undefined) {
      webhooks.updateSubscription(subscriptionId, {
        url: updated.url,
        events: [...updated.enabled_events],
        active: updated.status === "enabled",
      });
    }

    return c.json(formatWebhookEndpoint(updated));
  });

  app.delete("/v1/webhook_endpoints/:id", (c) => {
    const endpoint = find(c.req.param("id"));
    if (!endpoint) return notFound(c, c.req.param("id"));
    const subscriptionId = syncWebhookEndpoints(store, webhooks).get(endpoint.id);
    if (subscriptionId !== undefined) webhooks.unregister(subscriptionId);
    ss.webhookEndpoints.delete(endpoint.id);
    return c.json({ id: endpoint.stripe_id, object: "webhook_endpoint" as const, deleted: true as const });
  });

  app.get("/v1/webhook_endpoints", (c) =>
    stripeList(c, ss.webhookEndpoints.all(), "/v1/webhook_endpoints", (ep) => formatWebhookEndpoint(ep), {
      created: (ep) => ep.created,
    }),
  );
}
