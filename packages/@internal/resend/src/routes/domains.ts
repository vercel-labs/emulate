import type { RouteContext } from "@internal/core";
import { parseJsonBody, requireAuth } from "@internal/core";
import { getResendStore } from "../store.js";
import { resendError, parseResendPagination, applyResendPagination } from "../helpers.js";
import type { ResendDomain } from "../entities.js";

function generateDnsRecords(name: string, region: string) {
  return [
    {
      record: "SPF",
      name: `send.${name}`,
      type: "MX",
      ttl: "Auto",
      status: "not_started",
      value: `feedback-smtp.${region}.amazonses.com`,
      priority: 10,
    },
    {
      record: "SPF",
      name: `send.${name}`,
      type: "TXT",
      ttl: "Auto",
      status: "not_started",
      value: `"v=spf1 include:amazonses.com ~all"`,
    },
    {
      record: "DKIM",
      name: `resend._domainkey.${name}`,
      type: "CNAME",
      ttl: "Auto",
      status: "not_started",
      value: `${name}.dkim.resend.dev`,
    },
  ];
}

function formatDomain(domain: ResendDomain) {
  return {
    object: "domain" as const,
    id: String(domain.id),
    name: domain.name,
    status: domain.status,
    region: domain.region,
    click_tracking: domain.click_tracking,
    open_tracking: domain.open_tracking,
    tls: domain.tls,
    records: domain.records,
    created_at: domain.created_at,
    updated_at: domain.updated_at,
  };
}

export function domainRoutes({ app, store }: RouteContext): void {
  const rs = getResendStore(store);

  // Create domain
  app.post("/domains", requireAuth(), async (c) => {
    const body = await parseJsonBody(c);

    const name = body.name;
    if (typeof name !== "string" || !name) {
      return resendError(c, 422, "validation_error", "Missing required field: name");
    }

    const region = (typeof body.region === "string" ? body.region : "us-east-1") as ResendDomain["region"];
    const records = generateDnsRecords(name, region);

    const domain = rs.domains.insert({
      name,
      status: "not_started",
      region,
      click_tracking: typeof body.click_tracking === "boolean" ? body.click_tracking : false,
      open_tracking: typeof body.open_tracking === "boolean" ? body.open_tracking : false,
      tls: typeof body.tls === "string" ? (body.tls as ResendDomain["tls"]) : "opportunistic",
      records,
    });

    return c.json(formatDomain(domain));
  });

  // List domains
  app.get("/domains", requireAuth(), (c) => {
    const pagination = parseResendPagination(c);
    const allDomains = rs.domains.all();
    const { data, has_more } = applyResendPagination(allDomains, pagination);

    return c.json({
      object: "list",
      has_more,
      data: data.map(formatDomain),
    });
  });

  // Get domain
  app.get("/domains/:id", requireAuth(), (c) => {
    const id = parseInt(c.req.param("id"), 10);
    const domain = rs.domains.get(id);
    if (!domain) {
      return resendError(c, 404, "not_found", "Domain not found");
    }
    return c.json(formatDomain(domain));
  });

  // Update domain
  app.patch("/domains/:id", requireAuth(), async (c) => {
    const id = parseInt(c.req.param("id"), 10);
    const domain = rs.domains.get(id);
    if (!domain) {
      return resendError(c, 404, "not_found", "Domain not found");
    }

    const body = await parseJsonBody(c);
    const updates: Partial<ResendDomain> = {};

    if (typeof body.click_tracking === "boolean") {
      updates.click_tracking = body.click_tracking;
    }
    if (typeof body.open_tracking === "boolean") {
      updates.open_tracking = body.open_tracking;
    }
    if (typeof body.tls === "string") {
      updates.tls = body.tls as ResendDomain["tls"];
    }

    const updated = rs.domains.update(id, updates);
    if (!updated) {
      return resendError(c, 404, "not_found", "Domain not found");
    }

    return c.json(formatDomain(updated));
  });

  // Verify domain
  app.post("/domains/:id/verify", requireAuth(), (c) => {
    const id = parseInt(c.req.param("id"), 10);
    const domain = rs.domains.get(id);
    if (!domain) {
      return resendError(c, 404, "not_found", "Domain not found");
    }

    const verifiedRecords = domain.records.map((r) => ({ ...r, status: "verified" }));
    const updated = rs.domains.update(id, {
      status: "verified",
      records: verifiedRecords,
    } as Partial<ResendDomain>);

    if (!updated) {
      return resendError(c, 404, "not_found", "Domain not found");
    }

    return c.json(formatDomain(updated));
  });

  // Delete domain
  app.delete("/domains/:id", requireAuth(), (c) => {
    const id = parseInt(c.req.param("id"), 10);
    const domain = rs.domains.get(id);
    if (!domain) {
      return resendError(c, 404, "not_found", "Domain not found");
    }

    rs.domains.delete(id);

    return c.json({
      object: "domain",
      id: String(id),
      deleted: true,
    });
  });
}
