import type { AppEnv, Hono } from "@emulators/core";
import {
  BLOCKLIST_TYPES,
  DOMAIN_STATUSES,
  WEBHOOK_EVENT_TYPES,
  type BlocklistType,
  type DomainStatus,
  type Region,
  type ScwBlocklist,
  type ScwDomain,
  type ScwWebhook,
  type ScwWebhookEvent,
  type WebhookEventType,
} from "../entities.js";
import {
  allQuery,
  api,
  bool,
  guid,
  invalidArguments,
  isEmail,
  notFound,
  nowIso,
  num,
  paginate,
  parseJsonBody,
  permissionsDenied,
  route,
  str,
  type ArgumentDetail,
  type Json,
} from "../helpers.js";
import { logEvent, settings, updateSettings, type ScwStore } from "../store.js";
import { resolveEmail } from "./emails.js";

export function formatDomain(scw: ScwStore, domain: ScwDomain): Json {
  const emails = scw.emails.findBy("domain_id", domain.domain_id);
  const count = (status: string) => emails.filter((email) => resolveEmail(email).status === status).length;
  return {
    id: domain.domain_id,
    organization_id: domain.organization_id,
    project_id: domain.project_id,
    name: domain.name,
    status: domain.status,
    created_at: domain.created_at_iso,
    next_check_at: domain.next_check_at,
    last_valid_at: domain.last_valid_at,
    revoked_at: domain.revoked_at,
    last_error: domain.last_error,
    spf_config: domain.spf_config,
    dkim_config: domain.dkim_config,
    statistics: {
      total_count: emails.length,
      sent_count: count("sent"),
      failed_count: count("failed"),
      canceled_count: count("canceled"),
    },
    reputation:
      domain.status === "checked"
        ? {
            status:
              domain.reputation_score >= 90
                ? "excellent"
                : domain.reputation_score >= 70
                  ? "good"
                  : domain.reputation_score >= 50
                    ? "average"
                    : "bad",
            score: domain.reputation_score,
            scored_at: nowIso(),
            previous_score: null,
            previous_scored_at: null,
          }
        : null,
    records: {
      dmarc: { name: `_dmarc.${domain.name}`, value: "v=DMARC1; p=none" },
      dkim: { name: `${domain.dkim_selector}._domainkey.${domain.name}`, value: domain.dkim_config },
      spf: { name: domain.name, value: domain.spf_config },
      mx: { name: domain.name, value: "blackhole.tem.scaleway.com." },
    },
    autoconfig: domain.autoconfig,
    region: domain.region,
  };
}

export function createDomain(
  scw: ScwStore,
  input: {
    id?: string;
    name: string;
    projectId: string;
    organizationId: string;
    region: Region;
    autoconfig?: boolean;
    status?: DomainStatus;
    createdAt?: string;
  },
): ScwDomain {
  const selector = `${input.name
    .replace(/[^a-z0-9]/gi, "")
    .slice(0, 8)
    .toLowerCase()}-${guid().slice(0, 4)}`;
  const createdAt = input.createdAt ?? nowIso();
  const status = input.status ?? (input.autoconfig ? "autoconfiguring" : "unchecked");
  const domain = scw.domains.insert({
    domain_id: input.id ?? guid(),
    organization_id: input.organizationId,
    project_id: input.projectId,
    name: input.name.toLowerCase(),
    status,
    region: input.region,
    created_at_iso: createdAt,
    next_check_at: new Date(Date.now() + 3600000).toISOString(),
    last_valid_at: status === "checked" ? createdAt : null,
    revoked_at: status === "revoked" ? createdAt : null,
    last_error: null,
    spf_config: "v=spf1 include:_spf.tem.scaleway.com -all",
    dkim_config: `v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAemulate${selector.replace(/-/g, "")}AQAB`,
    dkim_selector: selector,
    autoconfig: input.autoconfig ?? false,
    reputation_score: 95,
  });
  logEvent(scw, "domain.created", domain.name, {
    id: domain.domain_id,
    status: domain.status,
    project_id: domain.project_id,
  });
  return domain;
}

function formatWebhook(webhook: ScwWebhook): Json {
  return {
    id: webhook.webhook_id,
    domain_id: webhook.domain_id,
    organization_id: webhook.organization_id,
    project_id: webhook.project_id,
    name: webhook.name,
    event_types: webhook.event_types,
    sns_arn: webhook.sns_arn,
    created_at: webhook.created_at,
    updated_at: webhook.updated_at,
  };
}

function formatWebhookEvent(event: ScwWebhookEvent): Json {
  return {
    id: event.event_id,
    webhook_id: event.webhook_id,
    organization_id: event.organization_id,
    project_id: event.project_id,
    domain_id: event.domain_id,
    type: event.type,
    status: event.status,
    data: event.data,
    created_at: event.created_at,
    updated_at: event.updated_at,
    email_id: event.email_id,
  };
}

function formatBlocklist(entry: ScwBlocklist): Json {
  return {
    id: entry.blocklist_id,
    domain_id: entry.domain_id,
    created_at: entry.created_at,
    updated_at: entry.updated_at,
    ends_at: entry.ends_at,
    email: entry.email,
    type: entry.type,
    reason: entry.reason,
    custom: entry.custom,
  };
}

export function domainRoutes(app: Hono<AppEnv>, scw: ScwStore): void {
  const findDomain = (id: string) => {
    const domain = scw.domains.findOneBy("domain_id", id);
    if (!domain) throw notFound("domain", id);
    return domain;
  };
  const findWebhook = (id: string) => {
    const webhook = scw.webhooks.findOneBy("webhook_id", id);
    if (!webhook) throw notFound("webhook", id);
    return webhook;
  };
  const projectOf = (
    projectId: string | undefined,
    key: { project_ids: string[] | null },
    details: ArgumentDetail[],
  ) => {
    if (!projectId) {
      details.push({ argument_name: "project_id", help_message: "project_id is required", reason: "required" });
      return undefined;
    }
    return projectId;
  };
  const assertProjectAccess = (projectId: string, key: { project_ids: string[] | null }) => {
    const project = scw.projects.findOneBy("project_id", projectId);
    if (!project || (key.project_ids && !key.project_ids.includes(projectId))) throw permissionsDenied();
    return project;
  };

  route(
    app,
    "post",
    "/domains",
    api(scw, async (c, key, region) => {
      const body = await parseJsonBody(c);
      const details: ArgumentDetail[] = [];
      const projectId = projectOf(str(body.project_id), key, details);
      const name = str(body.domain_name)?.trim().toLowerCase();
      if (!name)
        details.push({ argument_name: "domain_name", help_message: "domain_name is required", reason: "required" });
      else if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(name))
        details.push({
          argument_name: "domain_name",
          help_message: "must be a valid domain name",
          reason: "invalid_format",
        });
      if (body.accept_tos !== true)
        details.push({
          argument_name: "accept_tos",
          help_message: "terms of service must be accepted",
          reason: "constraint",
        });
      if (details.length > 0) throw invalidArguments(details);
      const project = assertProjectAccess(projectId!, key);
      if (scw.domains.all().some((domain) => domain.name === name && domain.status !== "revoked"))
        throw invalidArguments([
          { argument_name: "domain_name", help_message: "domain already exists", reason: "constraint" },
        ]);
      const domain = createDomain(scw, {
        name: name!,
        projectId: project.project_id,
        organizationId: project.organization_id,
        region,
        autoconfig: bool(body.autoconfig) ?? false,
      });
      return c.json(formatDomain(scw, domain));
    }),
  );

  route(
    app,
    "get",
    "/domains",
    api(scw, (c, key) => {
      const statuses = allQuery(c, "status");
      for (const status of statuses)
        if (!DOMAIN_STATUSES.includes(status as DomainStatus))
          throw invalidArguments([
            {
              argument_name: "status",
              help_message: `status must be one of ${DOMAIN_STATUSES.join(", ")}`,
              reason: "constraint",
            },
          ]);
      const rows = scw.domains
        .all()
        .filter((domain) => !key.project_ids || key.project_ids.includes(domain.project_id))
        .filter(
          (domain) =>
            (!c.req.query("project_id") || domain.project_id === c.req.query("project_id")) &&
            (!c.req.query("organization_id") || domain.organization_id === c.req.query("organization_id")) &&
            (!c.req.query("name") || domain.name.includes(c.req.query("name")!.toLowerCase())) &&
            (statuses.length === 0 || statuses.includes(domain.status)),
        )
        .sort((a, b) => (a.created_at_iso < b.created_at_iso ? 1 : -1));
      const page = paginate(c, rows);
      return c.json({ total_count: page.total, domains: page.items.map((domain) => formatDomain(scw, domain)) });
    }),
  );

  route(
    app,
    "get",
    "/domains/:id",
    api(scw, (c) => c.json(formatDomain(scw, findDomain(c.req.param("id"))))),
  );

  route(
    app,
    "post",
    "/domains/:id/revoke",
    api(scw, (c) => {
      const domain = findDomain(c.req.param("id"));
      const updated = scw.domains.update(domain.id, { status: "revoked", revoked_at: nowIso() })!;
      logEvent(scw, "domain.revoked", updated.name, { id: updated.domain_id });
      return c.json(formatDomain(scw, updated));
    }),
  );

  route(
    app,
    "post",
    "/domains/:id/check",
    api(scw, (c) => {
      const domain = findDomain(c.req.param("id"));
      if (domain.status === "revoked")
        throw invalidArguments([
          { argument_name: "domain_id", help_message: "revoked domains cannot be checked", reason: "constraint" },
        ]);
      const updated = scw.domains.update(domain.id, {
        status: domain.status === "invalid" ? "invalid" : "checked",
        last_valid_at: domain.status === "invalid" ? domain.last_valid_at : nowIso(),
        next_check_at: new Date(Date.now() + 86400000).toISOString(),
        last_error: domain.status === "invalid" ? "SPF record not found" : null,
      })!;
      logEvent(scw, "domain.checked", updated.name, { id: updated.domain_id, status: updated.status });
      return c.json(formatDomain(scw, updated));
    }),
  );

  route(
    app,
    "get",
    "/domains/:id/verification",
    api(scw, (c) => {
      const domain = findDomain(c.req.param("id"));
      const valid = domain.status === "checked";
      const record = (error: string) => ({
        status: valid ? "valid" : domain.status === "invalid" ? "invalid" : "not_found",
        last_valid_at: domain.last_valid_at,
        error: valid ? null : error,
      });
      return c.json({
        domain_id: domain.domain_id,
        domain_name: domain.name,
        spf_record: record("SPF record not found"),
        dkim_record: record("DKIM record not found"),
        dmarc_record: record("DMARC record not found"),
        mx_record: record("MX record not found"),
        autoconfig_state: {
          enabled: domain.autoconfig,
          autoconfigurable: false,
          reason: domain.autoconfig ? null : "domain_not_found",
        },
      });
    }),
  );

  route(
    app,
    "patch",
    "/domains/:id",
    api(scw, async (c) => {
      const domain = findDomain(c.req.param("id"));
      const body = await parseJsonBody(c);
      const updated = scw.domains.update(domain.id, { autoconfig: bool(body.autoconfig) ?? domain.autoconfig })!;
      return c.json(formatDomain(scw, updated));
    }),
  );

  route(
    app,
    "post",
    "/webhooks",
    api(scw, async (c, key) => {
      const body = await parseJsonBody(c);
      const details: ArgumentDetail[] = [];
      const domainId = str(body.domain_id);
      if (!domainId)
        details.push({ argument_name: "domain_id", help_message: "domain_id is required", reason: "required" });
      const name = str(body.name)?.trim();
      if (!name) details.push({ argument_name: "name", help_message: "name is required", reason: "required" });
      const snsArn = str(body.sns_arn)?.trim();
      if (!snsArn) details.push({ argument_name: "sns_arn", help_message: "sns_arn is required", reason: "required" });
      const eventTypes = Array.isArray(body.event_types) ? body.event_types.map(String) : [];
      if (eventTypes.length === 0)
        details.push({
          argument_name: "event_types",
          help_message: "at least one event type is required",
          reason: "required",
        });
      for (const type of eventTypes)
        if (!WEBHOOK_EVENT_TYPES.includes(type as WebhookEventType))
          details.push({
            argument_name: "event_types",
            help_message: `unknown event type ${type}`,
            reason: "constraint",
          });
      if (details.length > 0) throw invalidArguments(details);
      const domain = findDomain(domainId!);
      assertProjectAccess(str(body.project_id) ?? domain.project_id, key);
      const webhook = scw.webhooks.insert({
        webhook_id: guid(),
        domain_id: domain.domain_id,
        organization_id: domain.organization_id,
        project_id: domain.project_id,
        name: name!,
        event_types: eventTypes as WebhookEventType[],
        sns_arn: snsArn!,
      });
      logEvent(scw, "webhook.created", webhook.name, {
        id: webhook.webhook_id,
        domain: domain.name,
        event_types: eventTypes,
      });
      return c.json(formatWebhook(webhook));
    }),
  );

  route(
    app,
    "get",
    "/webhooks",
    api(scw, (c, key) => {
      const rows = scw.webhooks
        .all()
        .filter(
          (webhook) =>
            (!key.project_ids || key.project_ids.includes(webhook.project_id)) &&
            (!c.req.query("project_id") || webhook.project_id === c.req.query("project_id")) &&
            (!c.req.query("domain_id") || webhook.domain_id === c.req.query("domain_id")),
        );
      const page = paginate(c, rows);
      return c.json({ total_count: page.total, webhooks: page.items.map(formatWebhook) });
    }),
  );

  route(
    app,
    "get",
    "/webhooks/:id",
    api(scw, (c) => c.json(formatWebhook(findWebhook(c.req.param("id"))))),
  );

  route(
    app,
    "patch",
    "/webhooks/:id",
    api(scw, async (c) => {
      const webhook = findWebhook(c.req.param("id"));
      const body = await parseJsonBody(c);
      const eventTypes = Array.isArray(body.event_types) ? body.event_types.map(String) : undefined;
      for (const type of eventTypes ?? [])
        if (!WEBHOOK_EVENT_TYPES.includes(type as WebhookEventType))
          throw invalidArguments([
            { argument_name: "event_types", help_message: `unknown event type ${type}`, reason: "constraint" },
          ]);
      const updated = scw.webhooks.update(webhook.id, {
        name: str(body.name) ?? webhook.name,
        sns_arn: str(body.sns_arn) ?? webhook.sns_arn,
        event_types: (eventTypes as WebhookEventType[] | undefined) ?? webhook.event_types,
      })!;
      return c.json(formatWebhook(updated));
    }),
  );

  route(
    app,
    "delete",
    "/webhooks/:id",
    api(scw, (c) => {
      const webhook = findWebhook(c.req.param("id"));
      scw.webhooks.delete(webhook.id);
      logEvent(scw, "webhook.deleted", webhook.name, { id: webhook.webhook_id });
      return c.body(null, 204);
    }),
  );

  route(
    app,
    "get",
    "/webhooks/:id/events",
    api(scw, (c) => {
      const webhook = findWebhook(c.req.param("id"));
      const types = allQuery(c, "event_types");
      const statuses = allQuery(c, "statuses");
      const rows = scw.webhookEvents
        .findBy("webhook_id", webhook.webhook_id)
        .filter(
          (event) =>
            (types.length === 0 || types.includes(event.type)) &&
            (statuses.length === 0 || statuses.includes(event.status)) &&
            (!c.req.query("email_id") || event.email_id === c.req.query("email_id")),
        )
        .sort((a, b) => (c.req.query("order_by") === "created_at_asc" ? a.id - b.id : b.id - a.id));
      const page = paginate(c, rows);
      return c.json({ total_count: page.total, webhook_events: page.items.map(formatWebhookEvent) });
    }),
  );

  route(
    app,
    "get",
    "/blocklists",
    api(scw, (c) => {
      const domainId = c.req.query("domain_id");
      if (!domainId)
        throw invalidArguments([
          { argument_name: "domain_id", help_message: "domain_id is required", reason: "required" },
        ]);
      const rows = scw.blocklists
        .findBy("domain_id", domainId)
        .filter(
          (entry) =>
            (!c.req.query("email") || entry.email.toLowerCase() === c.req.query("email")!.toLowerCase()) &&
            (!c.req.query("type") || entry.type === c.req.query("type")) &&
            (c.req.query("custom") === undefined || String(entry.custom) === c.req.query("custom")),
        );
      const page = paginate(c, rows);
      return c.json({ total_count: page.total, blocklists: page.items.map(formatBlocklist) });
    }),
  );

  route(
    app,
    "post",
    "/blocklists",
    api(scw, async (c) => {
      const body = await parseJsonBody(c);
      const details: ArgumentDetail[] = [];
      const domainId = str(body.domain_id);
      if (!domainId)
        details.push({ argument_name: "domain_id", help_message: "domain_id is required", reason: "required" });
      const emails = Array.isArray(body.emails) ? body.emails.map(String) : [];
      if (emails.length === 0)
        details.push({ argument_name: "emails", help_message: "at least one email is required", reason: "required" });
      for (const email of emails)
        if (!isEmail(email))
          details.push({
            argument_name: "emails",
            help_message: `${email} is not a valid email address`,
            reason: "invalid_format",
          });
      const type = str(body.type);
      if (!type || !BLOCKLIST_TYPES.includes(type as BlocklistType))
        details.push({
          argument_name: "type",
          help_message: `type must be one of ${BLOCKLIST_TYPES.join(", ")}`,
          reason: "constraint",
        });
      if (details.length > 0) throw invalidArguments(details);
      const domain = findDomain(domainId!);
      const created = emails.map((email) => {
        const existing = scw.blocklists
          .findBy("domain_id", domain.domain_id)
          .find((entry) => entry.email.toLowerCase() === email.toLowerCase());
        if (existing)
          return scw.blocklists.update(existing.id, {
            type: type as BlocklistType,
            reason: str(body.reason) ?? existing.reason,
            ends_at: new Date(Date.now() + 30 * 86400000).toISOString(),
          })!;
        return scw.blocklists.insert({
          blocklist_id: guid(),
          domain_id: domain.domain_id,
          email: email.toLowerCase(),
          type: type as BlocklistType,
          reason: str(body.reason) ?? "manually blocklisted",
          custom: true,
          ends_at: new Date(Date.now() + 30 * 86400000).toISOString(),
        });
      });
      for (const webhook of scw.webhooks
        .findBy("domain_id", domain.domain_id)
        .filter((hook) => hook.event_types.includes("blocklist_created"))) {
        for (const entry of created)
          scw.webhookEvents.insert({
            event_id: guid(),
            webhook_id: webhook.webhook_id,
            organization_id: webhook.organization_id,
            project_id: webhook.project_id,
            domain_id: domain.domain_id,
            type: "blocklist_created",
            status: "sent",
            data: JSON.stringify({ type: "blocklist_created", email: entry.email, blocklist_type: entry.type }),
            email_id: null,
          });
      }
      logEvent(scw, "blocklist.created", domain.name, { emails, type });
      return c.json({ blocklists: created.map(formatBlocklist) });
    }),
  );

  route(
    app,
    "delete",
    "/blocklists/:id",
    api(scw, (c) => {
      const entry = scw.blocklists.findOneBy("blocklist_id", c.req.param("id"));
      if (!entry) throw notFound("blocklist", c.req.param("id"));
      scw.blocklists.delete(entry.id);
      return c.body(null, 204);
    }),
  );

  route(
    app,
    "get",
    "/project/:projectId/settings",
    api(scw, (c, key) => {
      assertProjectAccess(c.req.param("projectId"), key);
      return c.json({ periodic_report: settings(scw).periodic_report });
    }),
  );

  route(
    app,
    "patch",
    "/project/:projectId/settings",
    api(scw, async (c, key) => {
      assertProjectAccess(c.req.param("projectId"), key);
      const body = await parseJsonBody(c);
      const report = (body.periodic_report ?? {}) as Json;
      const current = settings(scw).periodic_report;
      const frequency = str(report.frequency);
      if (frequency && !["monthly", "weekly", "daily"].includes(frequency))
        throw invalidArguments([
          {
            argument_name: "periodic_report.frequency",
            help_message: "frequency must be monthly, weekly, or daily",
            reason: "constraint",
          },
        ]);
      const next = updateSettings(scw, {
        periodic_report: {
          enabled: bool(report.enabled) ?? current.enabled,
          frequency: (frequency as "monthly" | "weekly" | "daily" | undefined) ?? current.frequency,
          sending_hour: num(report.sending_hour) ?? current.sending_hour,
          sending_day: num(report.sending_day) ?? current.sending_day,
        },
      });
      return c.json({ periodic_report: next.periodic_report });
    }),
  );

  route(
    app,
    "get",
    "/project-consumption",
    api(scw, (c) =>
      c.json({
        project_id: c.req.query("project_id") ?? scw.projects.all()[0]?.project_id ?? null,
        email_count: scw.emails.count(),
        domain_count: scw.domains.count(),
        webhook_count: scw.webhooks.count(),
      }),
    ),
  );
}
