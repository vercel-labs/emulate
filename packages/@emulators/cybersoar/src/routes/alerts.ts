import type { AppEnv, Hono } from "@emulators/core";
import {
  CYBERSOAR_SERVICES,
  CYBERSOAR_STATUSES,
  CYBERSOAR_VERDICTS,
  MAIL_SENT_TAG,
  type CsAlert,
  type CsCustomer,
  type CybersoarService,
  type CybersoarStatus,
  type CybersoarVerdict,
} from "../entities.js";
import {
  api,
  badRequest,
  guid,
  isoDate,
  notFound,
  num,
  parseJsonBody,
  queryOf,
  slugify,
  str,
  stringArray,
  unquote,
  type Json,
} from "../helpers.js";
import { logEvent, type CsStore } from "../store.js";

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export function formatAlert(alert: CsAlert): Json {
  return {
    id: alert.alert_id,
    createdAt: alert.created_at_iso,
    importedAt: alert.imported_at,
    firstImportAt: alert.first_import_at,
    ingestAt: alert.ingest_at,
    closedAt: alert.closed_at,
    caseId: alert.case_id,
    criticity: alert.criticity,
    customer: alert.customer,
    msp: alert.msp,
    description: alert.description,
    elasticId: alert.elastic_id,
    ruleId: alert.rule_id,
    ruleName: alert.rule_name,
    ruleRuntime: alert.rule_runtime,
    service: alert.service,
    sourceRef: alert.source_ref,
    status: alert.status,
    verdict: alert.verdict,
    tags: alert.tags,
    analyst: alert.analyst,
  };
}

export function namespacesFor(customer: CsCustomer): string[] {
  return [`${customer.msp}:${customer.name}`, `${customer.msp_slug}:${customer.slug}`];
}

export function ensureCustomer(
  cs: CsStore,
  input: { name: string; msp?: string; slug?: string; msp_slug?: string; id?: string; services?: CybersoarService[] },
): CsCustomer {
  const existing =
    (input.id && cs.customers.findOneBy("customer_id", input.id)) ||
    cs.customers
      .all()
      .find(
        (candidate) =>
          candidate.name.toLowerCase() === input.name.toLowerCase() &&
          (!input.msp || candidate.msp.toLowerCase() === input.msp.toLowerCase()),
      );
  if (existing) return existing;
  const msp = input.msp ?? "Direct";
  return cs.customers.insert({
    customer_id: input.id ?? guid(),
    name: input.name,
    slug: input.slug ?? slugify(input.name),
    msp,
    msp_slug: input.msp_slug ?? slugify(msp),
    services: input.services ?? [...CYBERSOAR_SERVICES],
  });
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T | undefined {
  const text = str(value);
  if (text === undefined) return undefined;
  if (!allowed.includes(text as T))
    throw badRequest(`${field} must be one of the following values: ${allowed.join(", ")}`);
  return text as T;
}

export interface CreateAlertInput {
  id?: string;
  caseId?: string;
  customer: CsCustomer;
  service: CybersoarService;
  ruleName: string;
  ruleId?: string;
  ruleRuntime?: string;
  description?: string;
  criticity?: number;
  status?: CybersoarStatus;
  verdict?: CybersoarVerdict;
  tags?: string[];
  ingestAt?: string;
  createdAt?: string;
  closedAt?: string | null;
  elasticId?: string;
  sourceRef?: string;
  analyst?: string | null;
}

export function createAlert(cs: CsStore, input: CreateAlertInput): CsAlert {
  const ingestAt = input.ingestAt ?? new Date().toISOString();
  const createdAt = input.createdAt ?? new Date(Date.parse(ingestAt) - 30000).toISOString();
  const status = input.status ?? "WAITING_ANALYST";
  const verdict = input.verdict ?? (status === "CLOSED" ? "INDETERMINATE" : "NEW");
  const alert = cs.alerts.insert({
    alert_id: input.id ?? guid(),
    case_id: input.caseId ?? `CASE-${guid().slice(0, 8).toUpperCase()}`,
    customer_id: input.customer.customer_id,
    customer: input.customer.name,
    msp: input.customer.msp,
    namespaces: namespacesFor(input.customer),
    created_at_iso: createdAt,
    imported_at: ingestAt,
    first_import_at: ingestAt,
    ingest_at: ingestAt,
    closed_at:
      input.closedAt !== undefined
        ? input.closedAt
        : status === "CLOSED"
          ? new Date(Date.parse(ingestAt) + 3600000).toISOString()
          : null,
    criticity: Math.min(Math.max(Math.round(input.criticity ?? 2), 1), 4),
    description: input.description ?? `${input.ruleName} detected for ${input.customer.name}`,
    elastic_id: input.elasticId ?? guid(),
    rule_id: input.ruleId ?? `rule-${slugify(input.ruleName)}`,
    rule_name: input.ruleName,
    rule_runtime: input.ruleRuntime ?? "kql",
    service: input.service,
    source_ref: input.sourceRef ?? guid().replace(/-/g, "").slice(0, 8),
    status,
    verdict,
    tags: input.tags ?? [],
    analyst: input.analyst ?? null,
  });
  logEvent(cs, "alert.created", alert.alert_id, {
    customer: alert.customer,
    service: alert.service,
    ruleName: alert.rule_name,
    status: alert.status,
    verdict: alert.verdict,
  });
  return alert;
}

export function closeAlert(
  cs: CsStore,
  alert: CsAlert,
  verdict: CybersoarVerdict,
  options: { notify?: boolean; analyst?: string } = {},
): CsAlert {
  const tags = options.notify && !alert.tags.includes(MAIL_SENT_TAG) ? [...alert.tags, MAIL_SENT_TAG] : alert.tags;
  const updated = cs.alerts.update(alert.id, {
    status: "CLOSED",
    verdict,
    closed_at: new Date().toISOString(),
    tags,
    analyst: options.analyst ?? alert.analyst ?? "soc-analyst",
  })!;
  logEvent(cs, "alert.closed", updated.alert_id, { verdict, notify: options.notify ?? false });
  return updated;
}

function matchesNamespace(alert: CsAlert, wanted: string): boolean {
  const target = unquote(wanted).toLowerCase();
  if (!target) return true;
  return (
    alert.namespaces.some((namespace) => namespace.toLowerCase() === target) || alert.customer.toLowerCase() === target
  );
}

export function filterAlerts(cs: CsStore, query: Record<string, string | undefined>): CsAlert[] {
  const services = stringArray(query.service);
  const verdicts = stringArray(query.verdict);
  const statuses = stringArray(query.status);
  const tags = stringArray(query.tags);
  for (const service of services ?? []) oneOf(service, CYBERSOAR_SERVICES, "service");
  for (const verdict of verdicts ?? []) oneOf(verdict, CYBERSOAR_VERDICTS, "verdict");
  for (const status of statuses ?? []) oneOf(status, CYBERSOAR_STATUSES, "status");
  const ingestGt = isoDate(query["ingestAt.gt"], "ingestAt.gt");
  const ingestGte = isoDate(query["ingestAt.gte"], "ingestAt.gte");
  const ingestLt = isoDate(query["ingestAt.lt"], "ingestAt.lt");
  const ingestLte = isoDate(query["ingestAt.lte"], "ingestAt.lte");
  const createdGt = isoDate(query["createdAt.gt"], "createdAt.gt");
  const createdLt = isoDate(query["createdAt.lt"], "createdAt.lt");
  const criticity = num(query.criticity);
  const criticityGte = num(query["criticity.gte"]);
  const search = query.search?.toLowerCase();
  return cs.alerts
    .all()
    .filter((alert) => {
      if (query.name !== undefined && !matchesNamespace(alert, query.name)) return false;
      if (query.customer !== undefined && alert.customer.toLowerCase() !== unquote(query.customer).toLowerCase())
        return false;
      if (services && services.length > 0 && !services.includes(alert.service)) return false;
      if (verdicts && verdicts.length > 0 && !verdicts.includes(alert.verdict)) return false;
      if (statuses && statuses.length > 0 && !statuses.includes(alert.status)) return false;
      if (tags && tags.length > 0 && !tags.every((tag) => alert.tags.includes(tag))) return false;
      if (query.caseId !== undefined && alert.case_id !== query.caseId) return false;
      if (query.ruleId !== undefined && alert.rule_id !== query.ruleId) return false;
      if (ingestGt && alert.ingest_at <= ingestGt) return false;
      if (ingestGte && alert.ingest_at < ingestGte) return false;
      if (ingestLt && alert.ingest_at >= ingestLt) return false;
      if (ingestLte && alert.ingest_at > ingestLte) return false;
      if (createdGt && alert.created_at_iso <= createdGt) return false;
      if (createdLt && alert.created_at_iso >= createdLt) return false;
      if (criticity !== undefined && alert.criticity !== criticity) return false;
      if (criticityGte !== undefined && alert.criticity < criticityGte) return false;
      if (
        search &&
        !`${alert.rule_name} ${alert.description} ${alert.case_id} ${alert.customer}`.toLowerCase().includes(search)
      )
        return false;
      return true;
    })
    .sort((a, b) => (a.ingest_at < b.ingest_at ? 1 : a.ingest_at > b.ingest_at ? -1 : b.id - a.id));
}

export function paginate<T>(
  rows: T[],
  query: Record<string, string | undefined>,
): { data: T[]; meta: { count: number; pageIndex: number; pageSize: number; nextPage?: number } } {
  const pageSizeRaw = num(query.pageSize);
  if (pageSizeRaw !== undefined && (pageSizeRaw < 1 || !Number.isInteger(pageSizeRaw)))
    throw badRequest("pageSize must be a positive integer");
  const pageSize = Math.min(pageSizeRaw ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const pageIndexRaw = num(query.pageIndex);
  if (pageIndexRaw !== undefined && (pageIndexRaw < 0 || !Number.isInteger(pageIndexRaw)))
    throw badRequest("pageIndex must be a non-negative integer");
  const pageIndex = pageIndexRaw ?? 0;
  const data = rows.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize);
  const hasMore = (pageIndex + 1) * pageSize < rows.length;
  return { data, meta: { count: rows.length, pageIndex, pageSize, ...(hasMore ? { nextPage: pageIndex + 1 } : {}) } };
}

function formatCase(alerts: CsAlert[]): Json {
  const sorted = [...alerts].sort((a, b) => (a.ingest_at < b.ingest_at ? -1 : 1));
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  return {
    caseId: first.case_id,
    customer: first.customer,
    msp: first.msp,
    service: first.service,
    status: alerts.every((alert) => alert.status === "CLOSED") ? "CLOSED" : "WAITING_ANALYST",
    verdict: last.verdict,
    criticity: Math.max(...alerts.map((alert) => alert.criticity)),
    alertCount: alerts.length,
    ruleNames: [...new Set(alerts.map((alert) => alert.rule_name))],
    firstIngestAt: first.ingest_at,
    lastIngestAt: last.ingest_at,
    tags: [...new Set(alerts.flatMap((alert) => alert.tags))],
  };
}

export function alertRoutes(app: Hono<AppEnv>, cs: CsStore): void {
  const findAlert = (id: string) => {
    const alert = cs.alerts.findOneBy("alert_id", id);
    if (!alert) throw notFound(`Alert ${id} not found`);
    return alert;
  };

  app.get("/health", (c) => c.json({ status: "ok", service: "cybersoar", alerts: cs.alerts.count() }));

  app.get(
    "/incidents/alerts",
    api(cs, (c) => {
      const rows = filterAlerts(cs, queryOf(c));
      logEvent(cs, "alerts.listed", c.req.query("name") ?? "*", { count: rows.length, query: queryOf(c) });
      const page = paginate(rows, queryOf(c));
      return c.json({ data: page.data.map(formatAlert), meta: page.meta });
    }),
  );

  app.get(
    "/incidents/alerts/stats",
    api(cs, (c) => {
      const rows = filterAlerts(cs, queryOf(c));
      const count = (pick: (alert: CsAlert) => string) =>
        rows.reduce<Record<string, number>>(
          (acc, alert) => ({ ...acc, [pick(alert)]: (acc[pick(alert)] ?? 0) + 1 }),
          {},
        );
      return c.json({
        data: {
          total: rows.length,
          byService: count((alert) => alert.service),
          byVerdict: count((alert) => alert.verdict),
          byStatus: count((alert) => alert.status),
          byCriticity: count((alert) => String(alert.criticity)),
          mailSent: rows.filter((alert) => alert.tags.includes(MAIL_SENT_TAG)).length,
        },
      });
    }),
  );

  app.post(
    "/incidents/alerts",
    api(cs, async (c) => {
      const body = await parseJsonBody(c);
      const errors: string[] = [];
      const customerName = str(body.customer);
      const service = str(body.service);
      const ruleName = str(body.ruleName);
      if (!customerName) errors.push("customer should not be empty");
      if (!service) errors.push("service should not be empty");
      if (!ruleName) errors.push("ruleName should not be empty");
      if (errors.length > 0) throw badRequest(errors);
      const customer = ensureCustomer(cs, { name: customerName!, msp: str(body.msp) });
      const alert = createAlert(cs, {
        id: str(body.id),
        caseId: str(body.caseId),
        customer,
        service: oneOf(service, CYBERSOAR_SERVICES, "service")!,
        ruleName: ruleName!,
        ruleId: str(body.ruleId),
        ruleRuntime: str(body.ruleRuntime),
        description: str(body.description),
        criticity: num(body.criticity),
        status: oneOf(body.status, CYBERSOAR_STATUSES, "status"),
        verdict: oneOf(body.verdict, CYBERSOAR_VERDICTS, "verdict"),
        tags: stringArray(body.tags),
        ingestAt: isoDate(body.ingestAt, "ingestAt"),
        createdAt: isoDate(body.createdAt, "createdAt"),
        elasticId: str(body.elasticId),
        sourceRef: str(body.sourceRef),
      });
      return c.json({ data: formatAlert(alert) }, 201);
    }),
  );

  app.get(
    "/incidents/alerts/:id",
    api(cs, (c) => c.json({ data: formatAlert(findAlert(c.req.param("id"))) })),
  );

  app.patch(
    "/incidents/alerts/:id",
    api(cs, async (c) => {
      const alert = findAlert(c.req.param("id"));
      const body = await parseJsonBody(c);
      const status = oneOf(body.status, CYBERSOAR_STATUSES, "status");
      const verdict = oneOf(body.verdict, CYBERSOAR_VERDICTS, "verdict");
      const patch: Partial<CsAlert> = {};
      if (status) patch.status = status;
      if (verdict) patch.verdict = verdict;
      if (body.tags !== undefined) patch.tags = stringArray(body.tags) ?? [];
      if (body.criticity !== undefined)
        patch.criticity = Math.min(Math.max(Math.round(num(body.criticity) ?? alert.criticity), 1), 4);
      if (body.description !== undefined) patch.description = str(body.description) ?? alert.description;
      if (body.analyst !== undefined) patch.analyst = str(body.analyst) ?? null;
      if (status === "CLOSED" && !alert.closed_at) patch.closed_at = new Date().toISOString();
      if (status === "WAITING_ANALYST") patch.closed_at = null;
      const updated = cs.alerts.update(alert.id, patch)!;
      logEvent(cs, "alert.updated", updated.alert_id, patch as Record<string, unknown>);
      return c.json({ data: formatAlert(updated) });
    }),
  );

  app.delete(
    "/incidents/alerts/:id",
    api(cs, (c) => {
      const alert = findAlert(c.req.param("id"));
      cs.alerts.delete(alert.id);
      logEvent(cs, "alert.deleted", alert.alert_id, {});
      return c.body(null, 204);
    }),
  );

  app.get(
    "/incidents/cases",
    api(cs, (c) => {
      const rows = filterAlerts(cs, queryOf(c));
      const grouped = new Map<string, CsAlert[]>();
      for (const alert of rows) grouped.set(alert.case_id, [...(grouped.get(alert.case_id) ?? []), alert]);
      const cases = [...grouped.values()]
        .map(formatCase)
        .sort((a, b) => (String(a.lastIngestAt) < String(b.lastIngestAt) ? 1 : -1));
      const page = paginate(cases, queryOf(c));
      return c.json(page);
    }),
  );

  app.get(
    "/incidents/cases/:caseId",
    api(cs, (c) => {
      const alerts = cs.alerts.findBy("case_id", c.req.param("caseId"));
      if (alerts.length === 0) throw notFound(`Case ${c.req.param("caseId")} not found`);
      return c.json({ data: { ...formatCase(alerts), alerts: alerts.map(formatAlert) } });
    }),
  );

  app.get(
    "/customers",
    api(cs, (c) =>
      c.json({
        data: cs.customers.all().map((customer) => ({
          id: customer.customer_id,
          name: customer.name,
          slug: customer.slug,
          msp: customer.msp,
          mspSlug: customer.msp_slug,
          namespaces: namespacesFor(customer),
          services: customer.services,
          alertCount: cs.alerts.findBy("customer_id", customer.customer_id).length,
        })),
        meta: { count: cs.customers.count() },
      }),
    ),
  );
}
