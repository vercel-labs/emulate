import type { RouteContext } from "@emulators/core";
import { getResendStore } from "../store.js";
import { generateUuid, resendError, resendList, parseResendBody } from "../helpers.js";
import type { ResendDomain } from "../entities.js";

export function domainRoutes(ctx: RouteContext): void {
  const { app, store, webhooks } = ctx;
  const rs = () => getResendStore(store);

  app.post("/domains", async (c) => {
    const body = await parseResendBody(c);
    const name = body.name as string | undefined;

    if (!name) return resendError(c, 422, "validation_error", "Missing required field: name");

    const region = (body.region as string) ?? "us-east-1";
    const uuid = generateUuid();

    const records = [
      {
        record: "SPF",
        name,
        type: "MX",
        ttl: "Auto",
        status: "pending" as const,
        value: `feedback-smtp.${region}.amazonses.com`,
        priority: 10,
      },
      {
        record: "SPF",
        name,
        type: "TXT",
        ttl: "Auto",
        status: "pending" as const,
        value: "v=spf1 include:amazonses.com ~all",
      },
      {
        record: "DKIM",
        name: `resend._domainkey.${name}`,
        type: "CNAME",
        ttl: "Auto",
        status: "pending" as const,
        value: `resend.domainkey.${region}.amazonses.com`,
      },
    ];

    const domain = rs().domains.insert({
      uuid,
      name,
      status: "pending",
      region,
      records,
    });

    await webhooks.dispatch("domain.created", undefined, { type: "domain.created", data: { id: uuid, name } }, "resend");

    return c.json(formatDomain(domain), 200);
  });

  app.get("/domains", (c) => {
    const allDomains = rs().domains.all();
    return c.json(resendList(allDomains.map(formatDomain)));
  });

  app.get("/domains/:id", (c) => {
    const id = c.req.param("id");
    const domain = rs().domains.findOneBy("uuid", id);
    if (!domain) return resendError(c, 404, "not_found", "Domain not found");
    return c.json(formatDomain(domain));
  });

  app.delete("/domains/:id", async (c) => {
    const id = c.req.param("id");
    const domain = rs().domains.findOneBy("uuid", id);
    if (!domain) return resendError(c, 404, "not_found", "Domain not found");

    rs().domains.delete(domain.id);

    await webhooks.dispatch("domain.deleted", undefined, { type: "domain.deleted", data: { id: domain.uuid, name: domain.name } }, "resend");

    return c.json({ object: "domain", id: domain.uuid, deleted: true });
  });

  app.post("/domains/:id/verify", (c) => {
    const id = c.req.param("id");
    const domain = rs().domains.findOneBy("uuid", id);
    if (!domain) return resendError(c, 404, "not_found", "Domain not found");

    const verifiedRecords = domain.records.map((r) => ({ ...r, status: "verified" as const }));

    rs().domains.update(domain.id, {
      status: "verified",
      records: verifiedRecords,
    });

    return c.json({ object: "domain", id: domain.uuid, status: "verified" });
  });
}

function formatDomain(domain: ResendDomain) {
  return {
    id: domain.uuid,
    object: "domain",
    name: domain.name,
    status: domain.status,
    region: domain.region,
    records: domain.records,
    created_at: domain.created_at,
  };
}
