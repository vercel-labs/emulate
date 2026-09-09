import type { AppEnv, Context } from "@emulators/core";
import type { MailgunEvent } from "../entities.js";
import { eventSeconds, formatTag } from "../formatters.js";
import {
  api,
  badRequest,
  first,
  notFound,
  pagedItems,
  parseBody,
  parseDuration,
  parseTime,
  rfc2822,
  route,
} from "../helpers.js";
import { findDomain, type MailgunRouteContext } from "../route-utils.js";

type Resolution = "hour" | "day" | "month";

interface StatsBucket {
  time: string;
  accepted: { incoming: number; outgoing: number; total: number };
  delivered: { smtp: number; http: number; optimized: number; total: number };
  failed: {
    permanent: {
      suppress_bounce: number;
      suppress_unsubscribe: number;
      suppress_complaint: number;
      bounce: number;
      delayed_bounce: number;
      total: number;
    };
    temporary: { espblock: number; total: number };
  };
  opened: { total: number };
  clicked: { total: number };
  unsubscribed: { total: number };
  complained: { total: number };
  stored: { total: number };
}

function bucketStart(seconds: number, resolution: Resolution): number {
  const date = new Date(seconds * 1000);
  if (resolution === "hour") date.setUTCMinutes(0, 0, 0);
  else if (resolution === "day") date.setUTCHours(0, 0, 0, 0);
  else {
    date.setUTCDate(1);
    date.setUTCHours(0, 0, 0, 0);
  }
  return Math.floor(date.getTime() / 1000);
}

function nextBucket(seconds: number, resolution: Resolution): number {
  const date = new Date(seconds * 1000);
  if (resolution === "hour") date.setUTCHours(date.getUTCHours() + 1);
  else if (resolution === "day") date.setUTCDate(date.getUTCDate() + 1);
  else date.setUTCMonth(date.getUTCMonth() + 1);
  return Math.floor(date.getTime() / 1000);
}

function emptyBucket(time: number): StatsBucket {
  return {
    time: rfc2822(time),
    accepted: { incoming: 0, outgoing: 0, total: 0 },
    delivered: { smtp: 0, http: 0, optimized: 0, total: 0 },
    failed: {
      permanent: {
        suppress_bounce: 0,
        suppress_unsubscribe: 0,
        suppress_complaint: 0,
        bounce: 0,
        delayed_bounce: 0,
        total: 0,
      },
      temporary: { espblock: 0, total: 0 },
    },
    opened: { total: 0 },
    clicked: { total: 0 },
    unsubscribed: { total: 0 },
    complained: { total: 0 },
    stored: { total: 0 },
  };
}

export function computeStats(c: Context<AppEnv>, events: MailgunEvent[]) {
  const url = new URL(c.req.url);
  const requestedEvents = url.searchParams.getAll("event").flatMap((value) => value.split(","));
  const resolutionRaw = url.searchParams.get("resolution") ?? "day";
  if (!["hour", "day", "month"].includes(resolutionRaw))
    throw badRequest("'resolution' parameter must be one of hour, day, month");
  const resolution = resolutionRaw as Resolution;
  const now = Math.ceil(Date.now() / 1000);
  const duration = parseDuration(url.searchParams.get("duration") ?? undefined);
  const end = parseTime(url.searchParams.get("end") ?? undefined) ?? now;
  const start = parseTime(url.searchParams.get("start") ?? undefined) ?? (duration ? end - duration : end - 7 * 86400);
  const buckets = new Map<number, StatsBucket>();
  for (let time = bucketStart(start, resolution); time <= end; time = nextBucket(time, resolution))
    buckets.set(time, emptyBucket(time));
  for (const event of events) {
    const time = eventSeconds(event);
    if (time < start || time > end) continue;
    const bucket = buckets.get(bucketStart(time, resolution));
    if (!bucket) continue;
    switch (event.event) {
      case "accepted":
        bucket.accepted.outgoing++;
        bucket.accepted.total++;
        break;
      case "delivered":
        bucket.delivered.smtp++;
        bucket.delivered.total++;
        break;
      case "failed":
        if (event.severity === "temporary") {
          bucket.failed.temporary.espblock++;
          bucket.failed.temporary.total++;
        } else {
          bucket.failed.permanent.total++;
          if (event.reason === "suppress-bounce") bucket.failed.permanent.suppress_bounce++;
          else if (event.reason === "suppress-unsubscribe") bucket.failed.permanent.suppress_unsubscribe++;
          else if (event.reason === "suppress-complaint") bucket.failed.permanent.suppress_complaint++;
          else bucket.failed.permanent.bounce++;
        }
        break;
      case "opened":
        bucket.opened.total++;
        break;
      case "clicked":
        bucket.clicked.total++;
        break;
      case "unsubscribed":
        bucket.unsubscribed.total++;
        break;
      case "complained":
        bucket.complained.total++;
        break;
      case "stored":
        bucket.stored.total++;
        break;
      default:
        break;
    }
  }
  const wanted = requestedEvents.length > 0 ? new Set(requestedEvents.map((item) => item.trim())) : null;
  const stats = [...buckets.values()].map((bucket) => {
    if (!wanted) return bucket;
    const filtered: Record<string, unknown> = { time: bucket.time };
    for (const key of wanted) if (key in bucket) filtered[key] = (bucket as unknown as Record<string, unknown>)[key];
    return filtered;
  });
  return { start: rfc2822(start), end: rfc2822(end), resolution, stats };
}

export function tagRoutes(rc: MailgunRouteContext): void {
  const { app, ms } = rc;
  const tagsOf = (domain: string) => [...ms.tags.findBy("domain", domain)].sort((a, b) => a.tag.localeCompare(b.tag));

  route(
    app,
    "get",
    "/v3/:domain/tags",
    api(
      ms,
      (c) => {
        const domain = findDomain(ms, c.req.param("domain"));
        const paged = pagedItems(c, tagsOf(domain.name), {
          anchorKey: "tag",
          anchor: (tag) => tag.tag,
          defaultLimit: 100,
        });
        return c.json({ items: paged.items.map(formatTag), paging: paged.paging });
      },
      "domain",
    ),
  );

  route(
    app,
    "get",
    "/v3/:domain/tags/:tag",
    api(
      ms,
      (c) => {
        const domain = findDomain(ms, c.req.param("domain"));
        const tag = tagsOf(domain.name).find((candidate) => candidate.tag === decodeURIComponent(c.req.param("tag")));
        if (!tag) throw notFound("Tag not found");
        return c.json(formatTag(tag));
      },
      "domain",
    ),
  );

  route(
    app,
    "put",
    "/v3/:domain/tags/:tag",
    api(
      ms,
      async (c) => {
        const domain = findDomain(ms, c.req.param("domain"));
        const name = decodeURIComponent(c.req.param("tag"));
        const body = await parseBody(c);
        const description = first(body, "description") ?? "";
        const existing = tagsOf(domain.name).find((candidate) => candidate.tag === name);
        if (existing) ms.tags.update(existing.id, { description });
        else {
          const now = new Date().toUTCString();
          ms.tags.insert({ domain: domain.name, tag: name, description, first_seen: now, last_seen: now });
        }
        return c.json({ message: "Tag updated" });
      },
      "domain",
    ),
  );

  route(
    app,
    "delete",
    "/v3/:domain/tags/:tag",
    api(
      ms,
      (c) => {
        const domain = findDomain(ms, c.req.param("domain"));
        const tag = tagsOf(domain.name).find((candidate) => candidate.tag === decodeURIComponent(c.req.param("tag")));
        if (!tag) throw notFound("Tag not found");
        ms.tags.delete(tag.id);
        return c.json({ message: "Tag deleted" });
      },
      "domain",
    ),
  );

  route(
    app,
    "get",
    "/v3/:domain/tags/:tag/stats",
    api(
      ms,
      (c) => {
        const domain = findDomain(ms, c.req.param("domain"));
        const name = decodeURIComponent(c.req.param("tag"));
        const events = ms.events.findBy("domain", domain.name).filter((event) => event.tags.includes(name));
        return c.json({ tag: name, ...computeStats(c, events) });
      },
      "domain",
    ),
  );

  route(
    app,
    "get",
    "/v3/:domain/tags/:tag/stats/aggregates/devices",
    api(
      ms,
      (c) => {
        const domain = findDomain(ms, c.req.param("domain"));
        const name = decodeURIComponent(c.req.param("tag"));
        const opened = ms.events
          .findBy("domain", domain.name)
          .filter((event) => event.tags.includes(name) && event.event === "opened").length;
        return c.json({
          tag: name,
          device: {
            desktop: { opened, clicked: 0, unique_opened: opened, unique_clicked: 0, unsubscribed: 0, complained: 0 },
          },
        });
      },
      "domain",
    ),
  );

  route(
    app,
    "get",
    "/v3/:domain/stats/total",
    api(
      ms,
      (c) => {
        const domain = findDomain(ms, c.req.param("domain"));
        return c.json(computeStats(c, ms.events.findBy("domain", domain.name)));
      },
      "domain",
    ),
  );

  route(
    app,
    "get",
    "/v3/stats/total",
    api(ms, (c, key) => {
      const events = key.kind === "domain" ? ms.events.findBy("domain", key.domain ?? "") : ms.events.all();
      return c.json(computeStats(c, events));
    }),
  );

  route(
    app,
    "get",
    "/v3/:domain/tag/limits",
    api(
      ms,
      (c) => {
        const domain = findDomain(ms, c.req.param("domain"));
        return c.json({ limit: 4000, count: tagsOf(domain.name).length });
      },
      "domain",
    ),
  );
}
