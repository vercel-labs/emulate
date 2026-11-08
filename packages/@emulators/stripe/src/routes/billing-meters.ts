import { createHash } from "crypto";
import type { Context, RouteContext } from "@emulators/core";
import { getStripeStore, type StripeStore } from "../store.js";
import {
  expandedJson,
  parseStripeBody,
  parseStripeQuery,
  readInt,
  stripeError,
  stripeId,
  stripeList,
  isRecord,
  readString,
} from "../helpers.js";
import { formatBillingMeter, stripeExpandResolver } from "../formatters.js";
import { eventBatch, previousAttributes } from "../events.js";
import { activeMeterFor, aggregate, meterEventsIn } from "../metering.js";
import type { MeterFormula, StripeBillingMeter } from "../entities.js";

const FORMULAS: readonly MeterFormula[] = ["count", "last", "sum"];
const TIME_WINDOWS = ["day", "hour"] as const;
const MAX_NAME_LENGTH = 100;
const MAX_DISPLAY_NAME_LENGTH = 250;
const GROUPING_SECONDS = { hour: 3600, day: 86400 } as const;

type Invalid = { message: string; param?: string; code?: string };

function wallClock(): number {
  return Math.floor(Date.now() / 1000);
}

function missing(param: string): Invalid {
  return { message: `Missing required param: ${param}.`, param, code: "parameter_missing" };
}

function tooLong(param: string, max: number): Invalid {
  return { message: `Invalid ${param}: must be at most ${max} characters.`, param };
}

/** A payload key setting such as `customer_mapping[event_payload_key]`, or the default when absent. */
function readPayloadKey(
  value: unknown,
  param: string,
  fallback: string,
  extra?: (settings: Record<string, unknown>) => Invalid | undefined,
): { key?: string; error?: Invalid } {
  if (value === undefined || value === "") return { key: fallback };
  if (!isRecord(value)) return { error: { message: `Invalid ${param}: must be an object.`, param } };
  const failed = extra?.(value);
  if (failed) return { error: failed };
  const key = readString(value.event_payload_key);
  if (!key) return { error: missing(`${param}[event_payload_key]`) };
  if (key.length > MAX_NAME_LENGTH) return { error: tooLong(`${param}[event_payload_key]`, MAX_NAME_LENGTH) };
  return { key };
}

export type MeterDefinition = Pick<
  StripeBillingMeter,
  "display_name" | "event_name" | "formula" | "customer_payload_key" | "value_payload_key" | "event_time_window"
>;

/** Validate the params of `POST /v1/billing/meters`, or a seeded meter. */
export function readMeterParams(input: Record<string, unknown>): { meter?: MeterDefinition; error?: Invalid } {
  const displayName = readString(input.display_name);
  if (!displayName) return { error: missing("display_name") };
  if (displayName.length > MAX_DISPLAY_NAME_LENGTH) {
    return { error: tooLong("display_name", MAX_DISPLAY_NAME_LENGTH) };
  }
  const eventName = readString(input.event_name);
  if (!eventName) return { error: missing("event_name") };
  if (eventName.length > MAX_NAME_LENGTH) return { error: tooLong("event_name", MAX_NAME_LENGTH) };

  const aggregation = input.default_aggregation;
  const formula = isRecord(aggregation) ? aggregation.formula : undefined;
  if (formula === undefined || formula === "") return { error: missing("default_aggregation[formula]") };
  if (typeof formula !== "string" || !(FORMULAS as readonly string[]).includes(formula)) {
    return {
      error: {
        message: `Invalid default_aggregation[formula]: must be one of ${FORMULAS.join(", ")}`,
        param: "default_aggregation[formula]",
      },
    };
  }

  const customer = readPayloadKey(input.customer_mapping, "customer_mapping", "stripe_customer_id", (settings) => {
    if (settings.type === undefined || settings.type === "") return missing("customer_mapping[type]");
    if (settings.type !== "by_id") {
      return { message: "Invalid customer_mapping[type]: must be by_id", param: "customer_mapping[type]" };
    }
    return undefined;
  });
  if (customer.error) return { error: customer.error };
  const value = readPayloadKey(input.value_settings, "value_settings", "value");
  if (value.error) return { error: value.error };

  const window = input.event_time_window;
  if (window !== undefined && window !== "" && !(TIME_WINDOWS as readonly unknown[]).includes(window)) {
    return {
      error: { message: "Invalid event_time_window: must be one of day, hour", param: "event_time_window" },
    };
  }

  return {
    meter: {
      display_name: displayName,
      event_name: eventName,
      formula: formula as MeterFormula,
      customer_payload_key: customer.key!,
      value_payload_key: value.key!,
      ...(window !== undefined && window !== "" && { event_time_window: window as "day" | "hour" }),
    },
  };
}

function eventNameTaken(eventName: string): Invalid {
  return {
    message: `An active meter with the event_name '${eventName}' already exists. Event names must be unique among active meters.`,
    param: "event_name",
  };
}

/** Insert a meter after the checks `POST /v1/billing/meters` makes. */
export function insertMeter(
  ss: StripeStore,
  definition: MeterDefinition,
  id?: string,
): { meter?: StripeBillingMeter; error?: Invalid } {
  if (activeMeterFor(ss, definition.event_name)) return { error: eventNameTaken(definition.event_name) };
  const now = wallClock();
  const meter = ss.billingMeters.insert({
    stripe_id: id ?? stripeId("mtr_test", 32),
    ...definition,
    status: "active",
    created: now,
    updated: now,
  });
  return { meter };
}

/** A deterministic summary id, so pagination cursors stay valid across requests. */
function summaryId(meterId: string, customerId: string, start: number, end: number): string {
  const digest = createHash("sha256").update(`${meterId}:${customerId}:${start}:${end}`).digest("base64url");
  return `mtrusg_test_${digest.replace(/[-_]/g, "0")}`;
}

export function billingMeterRoutes(ctx: RouteContext): void {
  const { app, store, baseUrl } = ctx;
  const ss = getStripeStore(store);
  const expand = stripeExpandResolver(ss, baseUrl);

  const invalid = (c: Context, error: Invalid) =>
    stripeError(c, 400, "invalid_request_error", error.message, error.code, error.param);
  const notFound = (c: Context, id: string) =>
    stripeError(c, 404, "invalid_request_error", `No such billing meter: '${id}'`, "resource_missing", "id");

  app.post("/v1/billing/meters", async (c) => {
    const body = await parseStripeBody(c);
    const parsed = readMeterParams(body);
    if (parsed.error) return invalid(c, parsed.error);
    const inserted = insertMeter(ss, parsed.meter!);
    if (inserted.error) return invalid(c, inserted.error);
    const meter = inserted.meter!;
    const ev = eventBatch(ctx, c);
    ev.emit("billing.meter.created", formatBillingMeter(meter));
    await ev.commit();
    return expandedJson(c, formatBillingMeter(meter), expand, body);
  });

  app.get("/v1/billing/meters", (c) => {
    const status = parseStripeQuery(c).status;
    let meters = ss.billingMeters.all();
    if (status === "active" || status === "inactive") meters = meters.filter((m) => m.status === status);
    return stripeList(c, meters, "/v1/billing/meters", formatBillingMeter, { created: (m) => m.created, expand });
  });

  app.get("/v1/billing/meters/:id", (c) => {
    const id = c.req.param("id");
    const meter = ss.billingMeters.findOneBy("stripe_id", id);
    if (!meter) return notFound(c, id);
    return expandedJson(c, formatBillingMeter(meter), expand);
  });

  app.post("/v1/billing/meters/:id", async (c) => {
    const id = c.req.param("id");
    const meter = ss.billingMeters.findOneBy("stripe_id", id);
    if (!meter) return notFound(c, id);
    const body = await parseStripeBody(c);
    if (body.display_name === undefined) return expandedJson(c, formatBillingMeter(meter), expand, body);
    const displayName = readString(body.display_name);
    if (!displayName) return invalid(c, { message: "Invalid display_name: must not be empty.", param: "display_name" });
    if (displayName.length > MAX_DISPLAY_NAME_LENGTH) {
      return invalid(c, tooLong("display_name", MAX_DISPLAY_NAME_LENGTH));
    }
    const before = formatBillingMeter(meter);
    const updated = ss.billingMeters.update(meter.id, { display_name: displayName, updated: wallClock() })!;
    const after = formatBillingMeter(updated);
    const previous = previousAttributes(before, after);
    if (Object.keys(previous).length > 0) {
      const ev = eventBatch(ctx, c);
      ev.emit("billing.meter.updated", after, previous);
      await ev.commit();
    }
    return expandedJson(c, after, expand, body);
  });

  app.post("/v1/billing/meters/:id/deactivate", async (c) => {
    const id = c.req.param("id");
    const meter = ss.billingMeters.findOneBy("stripe_id", id);
    if (!meter) return notFound(c, id);
    const body = await parseStripeBody(c);
    if (meter.status === "inactive") return expandedJson(c, formatBillingMeter(meter), expand, body);
    const now = wallClock();
    const deactivated = ss.billingMeters.update(meter.id, { status: "inactive", deactivated_at: now, updated: now })!;
    const ev = eventBatch(ctx, c);
    ev.emit("billing.meter.deactivated", formatBillingMeter(deactivated));
    await ev.commit();
    return expandedJson(c, formatBillingMeter(deactivated), expand, body);
  });

  app.post("/v1/billing/meters/:id/reactivate", async (c) => {
    const id = c.req.param("id");
    const meter = ss.billingMeters.findOneBy("stripe_id", id);
    if (!meter) return notFound(c, id);
    const body = await parseStripeBody(c);
    if (meter.status === "active") return expandedJson(c, formatBillingMeter(meter), expand, body);
    if (activeMeterFor(ss, meter.event_name)) return invalid(c, eventNameTaken(meter.event_name));
    const reactivated = ss.billingMeters.update(meter.id, {
      status: "active",
      deactivated_at: undefined,
      updated: wallClock(),
    })!;
    const ev = eventBatch(ctx, c);
    ev.emit("billing.meter.reactivated", formatBillingMeter(reactivated));
    await ev.commit();
    return expandedJson(c, formatBillingMeter(reactivated), expand, body);
  });

  app.get("/v1/billing/meters/:id/event_summaries", (c) => {
    const id = c.req.param("id");
    const meter = ss.billingMeters.findOneBy("stripe_id", id);
    if (!meter) return notFound(c, id);
    const query = parseStripeQuery(c);

    const customerId = readString(query.customer);
    if (!customerId) return invalid(c, missing("customer"));
    if (!ss.customers.findOneBy("stripe_id", customerId)) {
      return invalid(c, { message: `No such customer: '${customerId}'`, param: "customer", code: "resource_missing" });
    }
    const windowParam = query.value_grouping_window;
    if (windowParam !== undefined && windowParam !== "" && windowParam !== "hour" && windowParam !== "day") {
      return invalid(c, {
        message: "Invalid value_grouping_window: must be one of day, hour",
        param: "value_grouping_window",
      });
    }
    const grouping = windowParam === "hour" || windowParam === "day" ? windowParam : undefined;
    const align = grouping ? GROUPING_SECONDS[grouping] : 60;
    const boundary = grouping === "day" ? "UTC day" : grouping === "hour" ? "hour" : "minute";
    const times: Record<"start_time" | "end_time", number> = { start_time: 0, end_time: 0 };
    for (const param of ["start_time", "end_time"] as const) {
      if (query[param] === undefined || query[param] === "") return invalid(c, missing(param));
      const time = readInt(query[param]);
      if (time === undefined) return invalid(c, { message: `Invalid integer: ${String(query[param])}`, param });
      if (time % align !== 0) {
        return invalid(c, { message: `Invalid ${param}: must be aligned with ${boundary} boundaries.`, param });
      }
      times[param] = time;
    }
    if (times.end_time <= times.start_time) {
      return invalid(c, { message: "end_time must be after start_time.", param: "end_time" });
    }

    const events = meterEventsIn(ss, meter.stripe_id, customerId, times.start_time, times.end_time);
    const summary = (start: number, end: number, value: number) => ({
      id: summaryId(meter.stripe_id, customerId, start, end),
      object: "billing.meter_event_summary" as const,
      aggregated_value: value,
      end_time: end,
      livemode: false,
      meter: meter.stripe_id,
      start_time: start,
    });

    let summaries: ReturnType<typeof summary>[];
    if (!grouping) {
      summaries = [summary(times.start_time, times.end_time, aggregate(events, meter.formula))];
    } else {
      const size = GROUPING_SECONDS[grouping];
      const buckets = new Map<number, typeof events>();
      for (const event of events) {
        const start = Math.floor(event.timestamp / size) * size;
        buckets.set(start, [...(buckets.get(start) ?? []), event]);
      }
      summaries = [...buckets.entries()]
        .sort(([a], [b]) => b - a)
        .map(([start, bucket]) => summary(start, start + size, aggregate(bucket, meter.formula)));
    }

    const limit = Math.min(Math.max(readInt(query.limit) ?? 10, 1), 100);
    const startingAfter = readString(query.starting_after);
    const endingBefore = readString(query.ending_before);
    let data: typeof summaries;
    let hasMore: boolean;
    const beforeAt = endingBefore && !startingAfter ? summaries.findIndex((s) => s.id === endingBefore) : -1;
    if (beforeAt !== -1) {
      // An ending_before page is the `limit` summaries just before the cursor; more lie beyond its start.
      const before = summaries.slice(0, beforeAt);
      data = before.slice(-limit);
      hasMore = before.length > limit;
    } else {
      const afterAt = startingAfter ? summaries.findIndex((s) => s.id === startingAfter) : -1;
      const rest = summaries.slice(afterAt + 1);
      data = rest.slice(0, limit);
      hasMore = rest.length > limit;
    }
    return c.json({
      object: "list",
      data,
      has_more: hasMore,
      url: `/v1/billing/meters/${meter.stripe_id}/event_summaries`,
    });
  });
}
