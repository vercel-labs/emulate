import type {
  Context,
  Entity,
  MiddlewareHandler,
  Store,
  WebhookDelivery,
  WebhookDispatcher,
  WebhookSubscription,
} from "@emulators/core";
import { getStripeStore } from "./store.js";
import { randomBase62, stripeId, isRecord } from "./helpers.js";
import { holdEvents, planChaos, takeHeld, type HeldEvent } from "./chaos.js";
import type { StripeEvent, StripeEventRequest, StripeEventWebhookTarget, StripeWebhookAttempt } from "./entities.js";

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
    if (isRecord(old) && isRecord(now) && !("object" in old)) {
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

/**
 * The Stripe subscriptions of the dispatcher, synced with the endpoint collection, by the key
 * an event's `webhook_targets` uses: the endpoint's `we_` id, or `hook_<n>` for a subscription
 * registered directly on the dispatcher.
 */
function webhookTargets(store: Store, webhooks: WebhookDispatcher): Map<string, WebhookSubscription> {
  const mapping = syncWebhookEndpoints(store, webhooks);
  const endpointOf = new Map<number, string>();
  for (const endpoint of getStripeStore(store).webhookEndpoints.all()) {
    const subId = mapping.get(endpoint.id);
    if (subId !== undefined) endpointOf.set(subId, endpoint.stripe_id);
  }
  const targets = new Map<string, WebhookSubscription>();
  for (const sub of webhooks.getSubscriptions("stripe")) {
    if (sub.repo !== undefined) continue;
    targets.set(endpointOf.get(sub.id) ?? `hook_${sub.id}`, sub);
  }
  return targets;
}

function listens(sub: WebhookSubscription, type: string): boolean {
  return sub.active && (sub.events.includes("*") || sub.events.includes(type));
}

/** The targets an event has, falling back for events stored before targets were recorded. */
function targetsOf(event: StripeEvent, targets: Map<string, WebhookSubscription>): StripeEventWebhookTarget[] {
  if (event.webhook_targets) return event.webhook_targets;
  return [...targets]
    .filter(([, sub]) => listens(sub, event.type))
    .map(([endpoint]) => ({ endpoint, delivered: event.pending_webhooks === 0 }));
}

function recordAttempt(
  store: Store,
  event: StripeEvent,
  fields: Omit<StripeWebhookAttempt, keyof Entity | "event_id" | "type" | "created">,
) {
  getStripeStore(store).webhookAttempts.insert({
    event_id: event.stripe_id,
    type: event.type,
    created: Math.floor(Date.now() / 1000),
    ...fields,
  });
}

export interface DispatchOptions {
  /** Sends of the same body to each endpoint, counting the original, for duplicate chaos. */
  copies?: number;
  /** Send to this one endpoint of the event's targets, even when it already answered 2xx. */
  endpoint?: string;
  /** The dispatcher's subscriptions by target key, when the caller already synced them. */
  targets?: Map<string, WebhookSubscription>;
}

/**
 * Send a stored event to the endpoints it was counted for that have not answered 2xx yet, or
 * to `options.endpoint` alone, and record each attempt in the delivery log. Every endpoint
 * that answers 2xx is marked delivered and leaves `pending_webhooks`. Endpoints created after
 * the event never receive it. Returns the attempts.
 */
export async function dispatchStoredEvent(
  ctx: EventBatchContext,
  event: StripeEvent,
  options: DispatchOptions = {},
): Promise<WebhookDelivery[]> {
  const ss = getStripeStore(ctx.store);
  const current = ss.events.get(event.id) ?? event;
  const targets = options.targets ?? webhookTargets(ctx.store, ctx.webhooks);
  const state = targetsOf(current, targets).map((target) => ({ ...target }));
  const chosen = state.filter((target) =>
    options.endpoint ? target.endpoint === options.endpoint : !target.delivered,
  );
  const payload = formatEvent(current);
  const attempts: WebhookDelivery[] = [];

  for (const target of chosen) {
    const sub = targets.get(target.endpoint);
    if (!sub) continue;
    for (let i = 0; i < (options.copies ?? 1); i++) {
      const delivery = await ctx.webhooks.deliverTo(sub.id, current.type, undefined, payload);
      if (!delivery) continue;
      attempts.push(delivery);
      recordAttempt(ctx.store, current, {
        status: delivery.success ? "succeeded" : "failed",
        url: sub.url,
        status_code: delivery.status_code ?? undefined,
        delivery_id: delivery.id,
      });
      if (delivery.success) target.delivered = true;
    }
  }

  ss.events.update(current.id, {
    webhook_targets: state,
    pending_webhooks: state.filter((target) => !target.delivered).length,
  });
  return attempts;
}

/** Take held events out of the outbox, with their `held` entries in the delivery log. */
export function releaseHeld(store: Store, eventIds?: string[]): HeldEvent[] {
  const taken = takeHeld(store, eventIds);
  const ss = getStripeStore(store);
  for (const entry of taken) {
    for (const attempt of ss.webhookAttempts.findBy("event_id", entry.event_id)) {
      if (attempt.status === "held") ss.webhookAttempts.delete(attempt.id);
    }
  }
  return taken;
}

/**
 * Deliver freshly stored events, applying the chaos settings to the batch as a whole. The
 * delivery log follows the order the events were emitted: a dropped or held event is logged in
 * its place, and the events sent now fill the remaining places in their (possibly reordered)
 * delivery order.
 */
async function deliverBatch(
  ctx: EventBatchContext,
  events: StripeEvent[],
  targets: Map<string, WebhookSubscription>,
): Promise<void> {
  const sendable = events.filter((e) => e.pending_webhooks > 0);
  const plan = planChaos(ctx.store, sendable);
  const dropped = new Set(plan.dropped);
  const held = new Set(plan.held);
  const queue = [...plan.deliver];

  for (const event of sendable) {
    if (dropped.has(event)) {
      for (const target of event.webhook_targets ?? []) {
        recordAttempt(ctx.store, event, { status: "dropped", url: targets.get(target.endpoint)?.url });
      }
    } else if (held.has(event)) {
      holdEvents(ctx.store, [{ event_id: event.stripe_id, type: event.type }]);
      recordAttempt(ctx.store, event, { status: "held" });
    } else {
      const next = queue.shift();
      if (next) await dispatchStoredEvent(ctx, next.item, { copies: next.copies, targets });
    }
  }
}

/**
 * Collect the events a request causes and deliver them as Stripe Event objects. Pass the
 * request context `c` for events an API call triggered; leave it out for events Stripe
 * raises on its own (hosted pages, billing time) so `request` is all null. `at` sets the
 * events' `created`, such as the simulated time of a test clock action; it defaults to the
 * wall clock at commit. A function is read at each emit, so one batch can span several
 * points in simulated time, as a test clock advance does.
 */
export function eventBatch(ctx: EventBatchContext, c?: Context, at?: number | (() => number)): EventBatch {
  const ss = getStripeStore(ctx.store);
  const pending: Array<{ type: string; data: StripeEvent["data"]; created?: number }> = [];

  return {
    emit(type, object, previous) {
      // Snapshot now: a batch that spans several billing actions commits after later changes.
      const data = structuredClone(
        previous && Object.keys(previous).length > 0 ? { object, previous_attributes: previous } : { object },
      );
      pending.push({ type, data, created: typeof at === "function" ? at() : at });
    },

    async commit() {
      const targets = webhookTargets(ctx.store, ctx.webhooks);
      const request = eventRequest(c);
      const apiVersion = getStripeApiVersion(ctx.store);
      const now = Math.floor(Date.now() / 1000);

      const stored = pending.splice(0).map(({ type, data, created }) => {
        const webhookTargets = [...targets]
          .filter(([, sub]) => listens(sub, type))
          .map(([endpoint]) => ({ endpoint, delivered: false }));
        return ss.events.insert({
          stripe_id: stripeId("evt"),
          type,
          api_version: apiVersion,
          created: created ?? now,
          data,
          pending_webhooks: webhookTargets.length,
          request: { ...request },
          webhook_targets: webhookTargets,
        });
      });

      await deliverBatch(ctx, stored, targets);
    },
  };
}
