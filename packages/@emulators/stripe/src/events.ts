import type {
  Context,
  MiddlewareHandler,
  Store,
  WebhookDelivery,
  WebhookDispatcher,
  WebhookSubscription,
} from "@emulators/core";
import { getStripeStore } from "./store.js";
import { randomBase62, stripeId } from "./helpers.js";
import { holdEvents, planChaos } from "./chaos.js";
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

function matchingSubscriptions(webhooks: WebhookDispatcher, type: string): WebhookSubscription[] {
  return webhooks
    .getSubscriptions("stripe")
    .filter((s) => s.active && s.repo === undefined && (s.events.includes("*") || s.events.includes(type)));
}

/** Subscriptions each dispatcher holds on behalf of a stored webhook endpoint. */
const endpointSubscriptions = new WeakMap<WebhookDispatcher, Set<number>>();

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

/**
 * Make the dispatcher match the `stripe.webhook_endpoints` collection and return which
 * subscription serves each endpoint. Endpoints are matched to subscriptions by url and secret,
 * so a store restored into a running or a fresh emulator never registers an endpoint twice.
 * A subscription that served an endpoint the store no longer has is removed. Subscriptions
 * registered directly on the dispatcher, outside this collection, are left alone.
 */
export function syncWebhookEndpoints(store: Store, webhooks: WebhookDispatcher): Map<number, number> {
  const ss = getStripeStore(store);
  const subscriptions = webhooks.getSubscriptions("stripe").filter((s) => s.repo === undefined);
  const claimed = new Set<number>();
  const mapping = new Map<number, number>();
  const owned = endpointSubscriptions.get(webhooks) ?? new Set<number>();
  endpointSubscriptions.set(webhooks, owned);
  // Ids left over from a dispatcher.clear() could be reused by unrelated subscriptions.
  for (const id of owned) if (!webhooks.getSubscription(id)) owned.delete(id);

  for (const endpoint of ss.webhookEndpoints.all().sort((a, b) => a.id - b.id)) {
    const active = endpoint.status === "enabled";
    const sub = subscriptions.find((s) => !claimed.has(s.id) && s.url === endpoint.url && s.secret === endpoint.secret);
    if (sub) {
      if (sub.active !== active || !sameList(sub.events, endpoint.enabled_events)) {
        webhooks.updateSubscription(sub.id, { active, events: [...endpoint.enabled_events] });
      }
      claimed.add(sub.id);
      mapping.set(endpoint.id, sub.id);
    } else {
      const registered = webhooks.register({
        url: endpoint.url,
        events: [...endpoint.enabled_events],
        active,
        secret: endpoint.secret,
        owner: "stripe",
      });
      claimed.add(registered.id);
      mapping.set(endpoint.id, registered.id);
    }
  }

  for (const id of owned) {
    if (claimed.has(id)) continue;
    webhooks.unregister(id);
    owned.delete(id);
  }
  for (const id of claimed) owned.add(id);
  return mapping;
}

function succeededHooks(webhooks: WebhookDispatcher, eventId: string): Set<number> {
  const hooks = new Set<number>();
  for (const d of webhooks.getDeliveries()) {
    if (d.success && (d.payload as { id?: unknown } | undefined)?.id === eventId) hooks.add(d.hook_id);
  }
  return hooks;
}

function lastDeliveryId(webhooks: WebhookDispatcher): number {
  const deliveries = webhooks.getDeliveries();
  return deliveries.length === 0 ? 0 : deliveries[deliveries.length - 1].id;
}

/**
 * Send one stored event to every matching endpoint, `copies` times with the same body, and
 * lower its pending_webhooks by the endpoints that newly answered 2xx. Returns the attempts.
 */
export async function dispatchStoredEvent(
  ctx: EventBatchContext,
  event: StripeEvent,
  copies = 1,
): Promise<WebhookDelivery[]> {
  const ss = getStripeStore(ctx.store);
  const current = ss.events.get(event.id) ?? event;
  const before = succeededHooks(ctx.webhooks, current.stripe_id);
  const since = lastDeliveryId(ctx.webhooks);
  const payload = formatEvent(current);

  for (let i = 0; i < copies; i++) {
    await ctx.webhooks.dispatch(current.type, undefined, payload, "stripe");
  }

  const after = succeededHooks(ctx.webhooks, current.stripe_id);
  const newlyDelivered = [...after].filter((hook) => !before.has(hook)).length;
  if (newlyDelivered > 0) {
    ss.events.update(current.id, { pending_webhooks: Math.max(0, current.pending_webhooks - newlyDelivered) });
  }
  return ctx.webhooks.getDeliveries().filter((d) => d.id > since);
}

/** Deliver freshly stored events, applying the chaos settings to the batch as a whole. */
async function deliverBatch(ctx: EventBatchContext, events: StripeEvent[]): Promise<void> {
  const ss = getStripeStore(ctx.store);
  const plan = planChaos(
    ctx.store,
    events.filter((e) => e.pending_webhooks > 0),
  );

  for (const event of plan.dropped) {
    const created = Math.floor(Date.now() / 1000);
    for (const sub of matchingSubscriptions(ctx.webhooks, event.type)) {
      ss.webhookAttempts.insert({
        event_id: event.stripe_id,
        type: event.type,
        status: "dropped",
        url: sub.url,
        created,
      });
    }
  }
  holdEvents(
    ctx.store,
    plan.held.map((e) => ({ event_id: e.stripe_id, type: e.type })),
  );
  for (const { item, copies } of plan.deliver) {
    await dispatchStoredEvent(ctx, item, copies);
  }
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
      syncWebhookEndpoints(ctx.store, ctx.webhooks);
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
          pending_webhooks: matchingSubscriptions(ctx.webhooks, type).length,
          request: { ...request },
        }),
      );

      await deliverBatch(ctx, stored);
    },
  };
}
