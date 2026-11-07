import type { Context, MiddlewareHandler, Store, WebhookDispatcher } from "@emulators/core";
import { getStripeStore } from "./store.js";
import { randomBase62, stripeId } from "./helpers.js";
import type { StripeEvent, StripeEventRequest } from "./entities.js";

/** The API version events are rendered with unless the seed config pins another. */
export const STRIPE_API_VERSION = "2026-10-28.endive";

const API_VERSION_KEY = "stripe.api_version";

export function setStripeApiVersion(store: Store, version: string): void {
  store.setData(API_VERSION_KEY, version);
}

export function getStripeApiVersion(store: Store): string {
  return store.getData<string>(API_VERSION_KEY) ?? STRIPE_API_VERSION;
}

const requestIds = new WeakMap<Request, string>();

/**
 * Assigns every /v1 request a `req_` id and returns it in the Request-Id header, as Stripe does.
 * Mount it on `*`: the core router has no prefix wildcards, so the path is checked here.
 */
export function requestIdMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    if (!c.req.path.startsWith("/v1/")) return next();
    const id = `req_${randomBase62(14)}`;
    requestIds.set(c.req.raw, id);
    await next();
    c.header("Request-Id", id);
  };
}

export function requestIdFor(c: Context): string | undefined {
  return requestIds.get(c.req.raw);
}

/** Event.request for an API call, or the all-null form Stripe uses for events nobody requested. */
function eventRequest(c: Context | undefined): StripeEventRequest {
  if (!c) return { id: null, idempotency_key: null };
  return {
    id: requestIdFor(c) ?? null,
    idempotency_key: c.req.header("Idempotency-Key") ?? null,
  };
}

/** The Event object in the key order of the API reference. */
export function formatEvent(e: StripeEvent) {
  return {
    id: e.stripe_id,
    object: "event" as const,
    api_version: e.api_version,
    created: e.created,
    data: e.data.previous_attributes
      ? { object: e.data.object, previous_attributes: e.data.previous_attributes }
      : { object: e.data.object },
    livemode: false,
    pending_webhooks: e.pending_webhooks,
    request: e.request,
    type: e.type,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Stripe's `previous_attributes`: the old value of every changed field. Hashes such as
 * `metadata` are diffed key by key, with null standing for a key that did not exist before.
 */
export function previousAttributes(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, unknown> {
  const previous: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const old = before[key];
    const now = after[key];
    if (sameValue(old, now)) continue;
    if (isPlainObject(old) && isPlainObject(now) && !("object" in old)) {
      previous[key] = previousAttributes(old, now);
    } else {
      previous[key] = old === undefined ? null : old;
    }
  }
  return previous;
}

export interface EventBatchContext {
  store: Store;
  webhooks: WebhookDispatcher;
}

export interface EventBatch {
  /** Record an event. Nothing is stored or sent until commit. */
  emit(type: string, object: Record<string, unknown>, previous?: Record<string, unknown>): void;
  /** Store the events in emit order, then deliver them one by one. */
  commit(): Promise<void>;
}

function matchingEndpointCount(webhooks: WebhookDispatcher, type: string): number {
  return webhooks
    .getSubscriptions("stripe")
    .filter((s) => s.active && s.repo === undefined && (s.events.includes("*") || s.events.includes(type))).length;
}

/**
 * Collect the events a request causes and deliver them as Stripe Event objects. Pass the
 * request context `c` for events an API call triggered; leave it out for events Stripe
 * raises on its own (hosted pages, billing time) so `request` is all null.
 */
export function eventBatch(ctx: EventBatchContext, c?: Context): EventBatch {
  const ss = getStripeStore(ctx.store);
  const pending: Array<{ type: string; object: Record<string, unknown>; previous?: Record<string, unknown> }> = [];

  return {
    emit(type, object, previous) {
      pending.push({ type, object, previous });
    },

    async commit() {
      const request = eventRequest(c);
      const apiVersion = getStripeApiVersion(ctx.store);
      const created = Math.floor(Date.now() / 1000);

      const stored = pending.splice(0).map(({ type, object, previous }) =>
        ss.events.insert({
          stripe_id: stripeId("evt"),
          type,
          api_version: apiVersion,
          created,
          data: structuredClone(
            previous && Object.keys(previous).length > 0 ? { object, previous_attributes: previous } : { object },
          ),
          pending_webhooks: matchingEndpointCount(ctx.webhooks, type),
          request: { ...request },
        }),
      );

      for (const event of stored) {
        if (event.pending_webhooks === 0) continue;
        await ctx.webhooks.dispatch(event.type, undefined, formatEvent(event), "stripe");
        const delivered = ctx.webhooks
          .getDeliveries()
          .filter((d) => d.success && (d.payload as { id?: unknown } | undefined)?.id === event.stripe_id).length;
        if (delivered > 0) {
          ss.events.update(event.id, { pending_webhooks: Math.max(0, event.pending_webhooks - delivered) });
        }
      }
    },
  };
}
