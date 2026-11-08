import type { Context, RouteContext } from "@emulators/core";
import { getStripeStore } from "../store.js";
import { expandedJson, parseStripeBody, readBool, readEnum, stripeError, stripeId, stripeList } from "../helpers.js";
import { formatSetupIntent, stripeExpandResolver } from "../formatters.js";
import { eventBatch } from "../events.js";
import { nowFor } from "../clock.js";
import { attemptSetup, newClientSecret, resolvePaymentMethod } from "../payments.js";
import { mergeMetadata, sendStripeError } from "./payment-methods.js";
import type { SetupIntentStatus, StripePaymentMethod, StripeSetupIntent } from "../entities.js";

const USAGES = ["off_session", "on_session"] as const;
const CANCELLATION_REASONS = ["abandoned", "duplicate", "requested_by_customer"] as const;
const CANCELABLE: readonly SetupIntentStatus[] = [
  "requires_payment_method",
  "requires_confirmation",
  "requires_action",
];

const MISSING_PAYMENT_METHOD =
  "You cannot confirm this SetupIntent because it's missing a payment method. You can either update the SetupIntent with a payment method and then confirm it again, or confirm it again directly with a payment method.";

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function unexpectedState(c: Context, message: string) {
  return stripeError(c, 400, "invalid_request_error", message, "setup_intent_unexpected_state");
}

export function setupIntentRoutes(ctx: RouteContext): void {
  const { app, store, baseUrl } = ctx;
  const ss = getStripeStore(store);
  const expand = stripeExpandResolver(ss, baseUrl);

  const notFound = (c: Context) =>
    stripeError(
      c,
      404,
      "invalid_request_error",
      `No such setupintent: '${c.req.param("id")}'`,
      "resource_missing",
      "intent",
    );

  const noSuchCustomer = (c: Context, id: string) =>
    stripeError(c, 400, "invalid_request_error", `No such customer: '${id}'`, "resource_missing", "customer");

  const confirmAndRespond = async (
    c: Context,
    si: StripeSetupIntent,
    pm: StripePaymentMethod,
    body: Record<string, unknown>,
    ev = eventBatch(ctx, c),
  ) => {
    const attempt = attemptSetup(ctx, ev, si, pm);
    await ev.commit();
    if (attempt.status === "failed") return sendStripeError(c, attempt.error);
    return expandedJson(c, formatSetupIntent(attempt.si), expand, body);
  };

  app.post("/v1/setup_intents", async (c) => {
    const body = await parseStripeBody(c);
    const customerId = readString(body.customer);
    if (customerId && !ss.customers.findOneBy("stripe_id", customerId)) return noSuchCustomer(c, customerId);

    const usage = readEnum(c, body.usage, USAGES, "usage");
    if (usage.error) return usage.error;

    const confirm = readBool(body.confirm) ?? false;
    const requested = readString(body.payment_method);
    if (confirm && !requested) return unexpectedState(c, MISSING_PAYMENT_METHOD);

    let pm: StripePaymentMethod | undefined;
    if (requested) {
      const resolved = resolvePaymentMethod(ss, requested, customerId ?? null);
      if (!resolved.ok) return sendStripeError(c, resolved.error);
      pm = resolved.pm;
    }

    const id = stripeId("seti");
    const si = ss.setupIntents.insert({
      stripe_id: id,
      status: pm ? "requires_confirmation" : "requires_payment_method",
      customer_id: customerId,
      payment_method: pm?.stripe_id,
      usage: usage.value ?? "off_session",
      description: readString(body.description),
      metadata: mergeMetadata({}, body.metadata),
      created: nowFor(ss, { customerId }),
      client_secret: newClientSecret(id),
    });

    const ev = eventBatch(ctx, c);
    ev.emit("setup_intent.created", formatSetupIntent(si));
    if (confirm && pm) return confirmAndRespond(c, si, pm, body, ev);
    await ev.commit();
    return expandedJson(c, formatSetupIntent(si), expand, body);
  });

  app.get("/v1/setup_intents/:id", (c) => {
    const si = ss.setupIntents.findOneBy("stripe_id", c.req.param("id"));
    if (!si) return notFound(c);
    return expandedJson(c, formatSetupIntent(si), expand);
  });

  app.post("/v1/setup_intents/:id", async (c) => {
    const si = ss.setupIntents.findOneBy("stripe_id", c.req.param("id"));
    if (!si) return notFound(c);
    const body = await parseStripeBody(c);

    const updates: Partial<StripeSetupIntent> = {};
    if (body.metadata !== undefined) updates.metadata = mergeMetadata(si.metadata, body.metadata);
    if (body.description !== undefined) updates.description = readString(body.description);

    const customerId = readString(body.customer);
    const requested = readString(body.payment_method);
    if (customerId !== undefined || requested !== undefined) {
      if (si.status === "succeeded" || si.status === "canceled") {
        return unexpectedState(c, `You cannot update this SetupIntent because it has a status of ${si.status}.`);
      }
    }
    if (customerId !== undefined) {
      if (!ss.customers.findOneBy("stripe_id", customerId)) return noSuchCustomer(c, customerId);
      updates.customer_id = customerId;
    }
    if (requested !== undefined) {
      const resolved = resolvePaymentMethod(ss, requested, (updates.customer_id ?? si.customer_id) || null);
      if (!resolved.ok) return sendStripeError(c, resolved.error);
      updates.payment_method = resolved.pm.stripe_id;
      updates.status = "requires_confirmation";
      updates.next_action = undefined;
    }

    const updated = ss.setupIntents.update(si.id, updates)!;
    return expandedJson(c, formatSetupIntent(updated), expand, body);
  });

  app.post("/v1/setup_intents/:id/confirm", async (c) => {
    const si = ss.setupIntents.findOneBy("stripe_id", c.req.param("id"));
    if (!si) return notFound(c);
    const body = await parseStripeBody(c);

    if (si.status === "succeeded") {
      return unexpectedState(
        c,
        "You cannot confirm this SetupIntent because it has already succeeded after being previously confirmed.",
      );
    }
    if (si.status !== "requires_payment_method" && si.status !== "requires_confirmation") {
      return unexpectedState(c, `You cannot confirm this SetupIntent because it has a status of ${si.status}.`);
    }

    const requested = readString(body.payment_method) ?? si.payment_method;
    if (!requested) return unexpectedState(c, MISSING_PAYMENT_METHOD);
    const resolved = resolvePaymentMethod(ss, requested, si.customer_id ?? null);
    if (!resolved.ok) return sendStripeError(c, resolved.error);
    return confirmAndRespond(c, si, resolved.pm, body);
  });

  app.post("/v1/setup_intents/:id/cancel", async (c) => {
    const si = ss.setupIntents.findOneBy("stripe_id", c.req.param("id"));
    if (!si) return notFound(c);
    const body = await parseStripeBody(c);

    if (!CANCELABLE.includes(si.status)) {
      return unexpectedState(c, `You cannot cancel this SetupIntent because it has a status of ${si.status}.`);
    }
    const reason = readEnum(c, body.cancellation_reason, CANCELLATION_REASONS, "cancellation_reason");
    if (reason.error) return reason.error;

    const updated = ss.setupIntents.update(si.id, {
      status: "canceled",
      cancellation_reason: reason.value,
      next_action: undefined,
    })!;
    const ev = eventBatch(ctx, c);
    ev.emit("setup_intent.canceled", formatSetupIntent(updated));
    await ev.commit();
    return expandedJson(c, formatSetupIntent(updated), expand, body);
  });

  app.get("/v1/setup_intents", (c) => {
    const customerId = c.req.query("customer");
    const paymentMethod = c.req.query("payment_method");
    let items = customerId ? ss.setupIntents.findBy("customer_id", customerId) : ss.setupIntents.all();
    if (paymentMethod) items = items.filter((si) => si.payment_method === paymentMethod);
    return stripeList(c, items, "/v1/setup_intents", formatSetupIntent, { created: (si) => si.created, expand });
  });
}
