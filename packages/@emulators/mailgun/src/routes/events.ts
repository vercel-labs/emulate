import type { AppEnv, Context } from "@emulators/core";
import type { MailgunEvent } from "../entities.js";
import { eventSeconds, formatEvent, formatLogItem } from "../formatters.js";
import { api, badRequest, parseBody, parseTime, route, yesNo } from "../helpers.js";
import { findDomain, type MailgunRouteContext } from "../route-utils.js";

interface EventsQuery {
  begin?: number;
  end?: number;
  ascending: boolean;
  limit: number;
  filters: Record<string, string>;
  start: number;
}

const FILTER_KEYS = ["event", "recipient", "from", "subject", "tags", "message-id", "severity", "list"] as const;

function parseQuery(c: Context<AppEnv>): EventsQuery {
  const url = new URL(c.req.url);
  const requested = Number(url.searchParams.get("limit") ?? 100);
  const filters: Record<string, string> = {};
  for (const key of FILTER_KEYS) {
    const value = url.searchParams.get(key);
    if (value) filters[key] = value;
  }
  return {
    begin: parseTime(url.searchParams.get("begin") ?? undefined),
    end: parseTime(url.searchParams.get("end") ?? undefined),
    ascending: yesNo(url.searchParams.get("ascending") ?? undefined, false),
    limit: Number.isFinite(requested) ? Math.min(Math.max(1, requested), 300) : 100,
    filters,
    start: 0,
  };
}

function matchExpression(actual: string, expression: string): boolean {
  const alternatives = expression
    .split(/\s+OR\s+/i)
    .flatMap((part) => part.split(",").map((item) => item.trim()))
    .filter(Boolean);
  const lowered = actual.toLowerCase();
  return alternatives.some((candidate) => {
    const value = candidate.replace(/^"|"$/g, "").toLowerCase();
    if (value.startsWith("*") || value.endsWith("*")) return lowered.includes(value.replace(/\*/g, ""));
    return lowered === value || lowered.includes(value);
  });
}

export function filterEvents(events: MailgunEvent[], query: EventsQuery): MailgunEvent[] {
  return events.filter((event) => {
    const time = eventSeconds(event);
    if (query.begin !== undefined && (query.ascending ? time < query.begin : time > query.begin)) return false;
    if (query.end !== undefined && (query.ascending ? time > query.end : time < query.end)) return false;
    for (const [key, expression] of Object.entries(query.filters)) {
      const actual =
        key === "event"
          ? event.event
          : key === "recipient"
            ? event.recipient
            : key === "from"
              ? event.from
              : key === "subject"
                ? event.subject
                : key === "tags"
                  ? event.tags.join(",")
                  : key === "message-id"
                    ? event.message_id.replace(/^<|>$/g, "")
                    : key === "severity"
                      ? (event.severity ?? "")
                      : event.to;
      if (!matchExpression(actual, expression)) return false;
    }
    return true;
  });
}

export function encodeToken(query: EventsQuery): string {
  return Buffer.from(JSON.stringify(query)).toString("base64url");
}

export function decodeToken(token: string): EventsQuery | null {
  try {
    const parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object" || typeof parsed.limit !== "number") return null;
    return parsed as EventsQuery;
  } catch {
    return null;
  }
}

export function eventRoutes(rc: MailgunRouteContext): void {
  const { app, ms, fmt, baseUrl } = rc;

  function respond(c: Context<AppEnv>, domainName: string, query: EventsQuery) {
    const sorted = ms.events
      .findBy("domain", domainName)
      .sort(
        (a, b) =>
          (query.ascending ? eventSeconds(a) - eventSeconds(b) : eventSeconds(b) - eventSeconds(a)) ||
          (query.ascending ? a.id - b.id : b.id - a.id),
      );
    const filtered = filterEvents(sorted, query);
    const page = filtered.slice(query.start, query.start + query.limit);
    const link = (start: number) =>
      `${baseUrl}/v3/${domainName}/events/${encodeToken({ ...query, start: Math.max(0, start) })}`;
    return c.json({
      items: page.map((event) => formatEvent(fmt, event)),
      paging: {
        first: link(0),
        last: link(Math.max(0, filtered.length - query.limit)),
        next: link(query.start + query.limit),
        previous: link(query.start - query.limit),
      },
    });
  }

  route(
    app,
    "get",
    "/v3/:domain/events",
    api(
      ms,
      (c) => {
        const domain = findDomain(ms, c.req.param("domain"));
        return respond(c, domain.name, parseQuery(c));
      },
      "domain",
    ),
  );

  route(
    app,
    "get",
    "/v3/:domain/events/:token",
    api(
      ms,
      (c) => {
        const domain = findDomain(ms, c.req.param("domain"));
        const query = decodeToken(c.req.param("token"));
        if (!query) throw badRequest("Invalid paging token");
        return respond(c, domain.name, query);
      },
      "domain",
    ),
  );

  route(
    app,
    "post",
    "/v1/analytics/logs",
    api(ms, async (c, key) => {
      const raw = await c.req.text();
      let body: Record<string, unknown> = {};
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          const form = await parseBodyFromText(raw);
          body = form;
        }
      }
      const start = parseTime(typeof body.start === "string" ? body.start : undefined);
      const end = parseTime(typeof body.end === "string" ? body.end : undefined);
      const pagination = (body.pagination ?? {}) as Record<string, unknown>;
      const limit = Math.min(Math.max(1, Number(pagination.limit ?? 50)), 300);
      const sort = String(pagination.sort ?? "timestamp:desc");
      const ascending = sort.endsWith(":asc");
      const tokenStart = pagination.token
        ? Number(Buffer.from(String(pagination.token), "base64url").toString("utf8"))
        : 0;
      const eventFilter = Array.isArray(body.events) ? body.events.map(String) : [];
      const filter = (body.filter ?? {}) as Record<string, unknown>;
      const clauses = Array.isArray(filter.AND) ? (filter.AND as Array<Record<string, unknown>>) : [];

      let events = ms.events.all();
      if (key.kind === "domain") events = events.filter((event) => event.domain === key.domain);
      events = events.filter((event) => {
        const time = eventSeconds(event);
        if (start !== undefined && time < start) return false;
        if (end !== undefined && time > end) return false;
        if (eventFilter.length > 0 && !eventFilter.includes(event.event)) return false;
        for (const clause of clauses) {
          const attribute = String(clause.attribute ?? "");
          const comparator = String(clause.comparator ?? "=");
          const values = Array.isArray(clause.values)
            ? (clause.values as Array<Record<string, unknown>>).map((item) => String(item.value ?? item.label ?? ""))
            : [];
          const actual =
            attribute === "event"
              ? event.event
              : attribute === "recipient"
                ? event.recipient
                : attribute === "domain"
                  ? event.domain
                  : attribute === "tag" || attribute === "tags"
                    ? event.tags.join(",")
                    : attribute === "message-id"
                      ? event.message_id.replace(/^<|>$/g, "")
                      : attribute === "subject"
                        ? event.subject
                        : attribute === "from"
                          ? event.from
                          : attribute === "severity"
                            ? (event.severity ?? "")
                            : attribute === "recipient-domain"
                              ? (event.recipient.split("@")[1] ?? "")
                              : "";
          const matched = values.some((value) =>
            comparator === "contains" || comparator === "~"
              ? actual.toLowerCase().includes(value.toLowerCase())
              : actual.toLowerCase() === value.toLowerCase(),
          );
          if (comparator === "!=" ? matched : !matched) return false;
        }
        return true;
      });
      events.sort(
        (a, b) =>
          (ascending ? eventSeconds(a) - eventSeconds(b) : eventSeconds(b) - eventSeconds(a)) ||
          (ascending ? a.id - b.id : b.id - a.id),
      );
      const page = events.slice(tokenStart, tokenStart + limit);
      const nextToken =
        tokenStart + limit < events.length ? Buffer.from(String(tokenStart + limit)).toString("base64url") : "";
      const aggregates: Record<string, number> = {};
      for (const event of events) aggregates[event.event] = (aggregates[event.event] ?? 0) + 1;
      return c.json({
        start: start !== undefined ? new Date(start * 1000).toUTCString() : "",
        end: end !== undefined ? new Date(end * 1000).toUTCString() : "",
        items: page.map((event) => formatLogItem(fmt, event)),
        pagination: { sort, token: nextToken, limit, total: events.length },
        aggregates: { metrics: aggregates },
      });
    }),
  );
}

async function parseBodyFromText(raw: string): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of new URLSearchParams(raw)) out[key] = value;
  return out;
}

export { parseBody };
