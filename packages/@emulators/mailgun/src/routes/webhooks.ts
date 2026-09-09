import type { WebhookType } from "../entities.js";
import { WEBHOOK_TYPES, formatWebhooks } from "../formatters.js";
import { api, all, badRequest, notFound, parseBody, route } from "../helpers.js";
import { findDomain, type MailgunRouteContext } from "../route-utils.js";

function webhookType(value: string): WebhookType {
  const normalized = value === "permanent_fail" || value === "temporary_fail" ? value : value.replace(/-/g, "_");
  if (!WEBHOOK_TYPES.includes(normalized as WebhookType))
    throw badRequest(`Invalid webhook type: ${value}. Supported types are ${WEBHOOK_TYPES.join(", ")}`);
  return normalized as WebhookType;
}

function validUrls(urls: string[]): string[] {
  const cleaned = urls.map((url) => url.trim()).filter(Boolean);
  if (cleaned.length === 0) throw badRequest("'url' parameter is missing");
  if (cleaned.length > 3) throw badRequest("Only 3 urls per webhook are allowed");
  for (const url of cleaned) {
    try {
      new URL(url);
    } catch {
      throw badRequest(`'url' parameter is not a valid URL: ${url}`);
    }
  }
  return cleaned;
}

export function webhookRoutes(rc: MailgunRouteContext): void {
  const { app, ms } = rc;

  route(
    app,
    "get",
    "/v3/domains/:domain/webhooks",
    api(
      ms,
      (c) => {
        const domain = findDomain(ms, c.req.param("domain"));
        return c.json({ webhooks: formatWebhooks(ms.webhooks.findBy("domain", domain.name)) });
      },
      "domain",
    ),
  );

  route(
    app,
    "post",
    "/v3/domains/:domain/webhooks",
    api(
      ms,
      async (c) => {
        const domain = findDomain(ms, c.req.param("domain"));
        const body = await parseBody(c);
        const id = body.fields.id?.[0];
        if (!id) throw badRequest("'id' parameter is missing");
        const type = webhookType(id);
        if (ms.webhooks.findBy("domain", domain.name).some((webhook) => webhook.type === type))
          throw badRequest("Webhook already exists");
        const urls = validUrls(all(body, "url"));
        const webhook = ms.webhooks.insert({ domain: domain.name, type, urls });
        return c.json({ message: "Webhook has been created", webhook: { urls: webhook.urls } });
      },
      "domain",
    ),
  );

  route(
    app,
    "get",
    "/v3/domains/:domain/webhooks/:type",
    api(
      ms,
      (c) => {
        const domain = findDomain(ms, c.req.param("domain"));
        const type = webhookType(c.req.param("type"));
        const webhook = ms.webhooks.findBy("domain", domain.name).find((candidate) => candidate.type === type);
        if (!webhook) throw notFound("Webhook not found");
        return c.json({ webhook: { urls: webhook.urls } });
      },
      "domain",
    ),
  );

  route(
    app,
    "put",
    "/v3/domains/:domain/webhooks/:type",
    api(
      ms,
      async (c) => {
        const domain = findDomain(ms, c.req.param("domain"));
        const type = webhookType(c.req.param("type"));
        const body = await parseBody(c);
        const urls = validUrls(all(body, "url"));
        const existing = ms.webhooks.findBy("domain", domain.name).find((candidate) => candidate.type === type);
        const webhook = existing
          ? ms.webhooks.update(existing.id, { urls })!
          : ms.webhooks.insert({ domain: domain.name, type, urls });
        return c.json({ message: "Webhook has been updated", webhook: { urls: webhook.urls } });
      },
      "domain",
    ),
  );

  route(
    app,
    "delete",
    "/v3/domains/:domain/webhooks/:type",
    api(
      ms,
      (c) => {
        const domain = findDomain(ms, c.req.param("domain"));
        const type = webhookType(c.req.param("type"));
        const webhook = ms.webhooks.findBy("domain", domain.name).find((candidate) => candidate.type === type);
        if (!webhook) throw notFound("Webhook not found");
        ms.webhooks.delete(webhook.id);
        return c.json({ message: "Webhook has been deleted", webhook: { urls: webhook.urls } });
      },
      "domain",
    ),
  );
}
