import type { Context, RouteContext } from "@emulators/core";
import { renderCardPage, escapeAttr, escapeHtml } from "@emulators/core";
import { getStripeStore, type StripeStore } from "../store.js";
import {
  expandedJson,
  parseStripeBody,
  readInt,
  stripeError,
  stripeId,
  stripeList,
  isRecord,
  readString,
} from "../helpers.js";
import {
  PORTAL_CANCELLATION_REASONS,
  billingPortalUrl,
  formatBillingPortalConfiguration,
  formatBillingPortalSession,
  formatCustomer,
  formatInvoice,
  formatPaymentMethod,
  formatSetupIntent,
  formatSubscription,
  stripeExpandResolver,
  subscriptionItems,
} from "../formatters.js";
import { eventBatch, previousAttributes, type EventBatch } from "../events.js";
import { nowFor } from "../clock.js";
import { attemptSetup, completeSetupAuthentication, newClientSecret, resolvePaymentMethod } from "../payments.js";
import {
  currentPeriodEnd,
  emitSubscriptionChange,
  isEnded,
  requestedCancellation,
  unscheduleCancellation,
} from "../subscriptions.js";
import { intervalText, productName } from "../lines.js";
import { sendStripeError, type StripeErrorSpec } from "./payment-methods.js";
import { SERVICE_LABEL } from "../checkout.js";
import { cardSelect, day, errorBlock, money, payInvoiceOnPage } from "./hosted-invoices.js";
import type {
  BillingPortalAfterCompletion,
  BillingPortalFlowType,
  StripeBillingPortalConfiguration,
  StripeBillingPortalFlow,
  StripeBillingPortalSession,
  StripeSubscription,
  SubscriptionCancellationFeedback,
} from "../entities.js";

const LOCALES = [
  "auto",
  "bg",
  "cs",
  "da",
  "de",
  "el",
  "en",
  "en-AU",
  "en-CA",
  "en-GB",
  "en-IE",
  "en-IN",
  "en-NZ",
  "en-SG",
  "es",
  "es-419",
  "et",
  "fi",
  "fil",
  "fr",
  "fr-CA",
  "hr",
  "hu",
  "id",
  "it",
  "ja",
  "ko",
  "lt",
  "lv",
  "ms",
  "mt",
  "nb",
  "nl",
  "pl",
  "pt",
  "pt-BR",
  "ro",
  "ru",
  "sk",
  "sl",
  "sv",
  "th",
  "tr",
  "vi",
  "zh",
  "zh-HK",
  "zh-TW",
] as const;

const FLOW_TYPES = [
  "customer_update",
  "payment_method_update",
  "subscription_cancel",
  "subscription_pause",
  "subscription_update",
  "subscription_update_confirm",
] as const;

const AFTER_COMPLETION_TYPES = ["hosted_confirmation", "portal_homepage", "redirect"] as const;

/** Flows the default configuration turns off, with the feature each one needs. */
const DISABLED_FLOWS: Partial<Record<(typeof FLOW_TYPES)[number], string>> = {
  customer_update: "customer_update",
  subscription_pause: "subscription_pause",
};

/** Statuses a customer can cancel from the portal. */
const CANCELABLE = ["active", "trialing", "past_due"];

const LABEL_FEEDBACK: Record<SubscriptionCancellationFeedback, string> = {
  customer_service: "Customer service was lacking",
  low_quality: "Quality was lacking",
  missing_features: "I need more features",
  other: "Other reason",
  switched_service: "I found an alternative",
  too_complex: "It was too complex to use",
  too_expensive: "It's too expensive",
  unused: "I no longer need it",
};

type Parsed<T> = { ok: true; value: T } | { ok: false; error: StripeErrorSpec };

function invalid(message: string, param?: string, code?: string): { ok: false; error: StripeErrorSpec } {
  return { ok: false, error: { status: 400, type: "invalid_request_error", message, code, param } };
}

function missing(param: string): { ok: false; error: StripeErrorSpec } {
  return invalid(`Missing required param: ${param}.`, param, "parameter_missing");
}

/** Stripe accepts only absolute http(s) URLs; anything else (a `javascript:` URL too) answers 400. */
function readUrl(value: unknown, param: string): Parsed<string | undefined> {
  const url = readString(value);
  if (url === undefined) return { ok: true, value: undefined };
  try {
    const { protocol } = new URL(url);
    if (protocol === "http:" || protocol === "https:") return { ok: true, value: url };
  } catch {
    // Not parseable: fall through to the error.
  }
  return invalid("Not a valid URL", param, "url_invalid");
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], param: string): Parsed<T | undefined> {
  if (value === undefined || value === "") return { ok: true, value: undefined };
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) {
    return { ok: true, value: value as T };
  }
  return invalid(`Invalid ${param}: must be one of ${allowed.join(", ")}`, param);
}

/** The emulator's single portal configuration, created the first time it is needed. */
export function defaultPortalConfiguration(ss: StripeStore): StripeBillingPortalConfiguration {
  const existing = ss.billingPortalConfigurations.all().find((config) => config.is_default);
  if (existing) return existing;
  const now = Math.floor(Date.now() / 1000);
  return ss.billingPortalConfigurations.insert({
    stripe_id: stripeId("bpc"),
    is_default: true,
    created: now,
    updated: now,
  });
}

function readAfterCompletion(value: unknown): Parsed<BillingPortalAfterCompletion> {
  const param = "flow_data[after_completion]";
  if (value === undefined || value === "") return { ok: true, value: { type: "portal_homepage" } };
  if (!isRecord(value)) return invalid(`Invalid ${param}: must be an object.`, param);
  if (value.type === undefined || value.type === "") return missing(`${param}[type]`);
  const type = oneOf(value.type, AFTER_COMPLETION_TYPES, `${param}[type]`);
  if (!type.ok) return type;
  if (type.value === "redirect") {
    const redirect = isRecord(value.redirect) ? value.redirect : undefined;
    const url = readUrl(redirect?.return_url, `${param}[redirect][return_url]`);
    if (!url.ok) return url;
    if (!url.value) return missing(`${param}[redirect][return_url]`);
    return { ok: true, value: { type: "redirect", return_url: url.value } };
  }
  if (type.value === "hosted_confirmation") {
    const confirmation = isRecord(value.hosted_confirmation) ? value.hosted_confirmation : undefined;
    const message = readString(confirmation?.custom_message);
    if (message && message.length > 500) {
      return invalid(
        `Invalid ${param}[hosted_confirmation][custom_message]: must be at most 500 characters.`,
        `${param}[hosted_confirmation][custom_message]`,
      );
    }
    return { ok: true, value: { type: "hosted_confirmation", custom_message: message } };
  }
  return { ok: true, value: { type: "portal_homepage" } };
}

/** The subscription a `subscription_cancel` or `subscription_update` flow names. */
function readFlowSubscription(
  ss: StripeStore,
  data: Record<string, unknown>,
  type: "subscription_cancel" | "subscription_update",
  customerId: string,
): Parsed<StripeSubscription> {
  const param = `flow_data[${type}][subscription]`;
  const config = data[type];
  const id = isRecord(config) ? readString(config.subscription) : undefined;
  if (!id) return missing(param);
  const sub = ss.subscriptions.findOneBy("stripe_id", id);
  if (!sub) return invalid(`No such subscription: '${id}'`, param, "resource_missing");
  if (sub.customer_id !== customerId) {
    return invalid(`The subscription ${id} does not belong to the customer ${customerId}.`, param);
  }
  if (isEnded(sub)) return invalid(`The subscription ${id} is ${sub.status} and cannot be changed.`, param);
  if (type === "subscription_cancel") {
    if (sub.cancel_at_period_end || sub.cancel_at !== undefined) {
      return invalid(`The subscription ${id} is already scheduled to cancel.`, param);
    }
    const retention = isRecord(config) ? config.retention : undefined;
    if (retention !== undefined && retention !== "") {
      const offer = isRecord(retention) && isRecord(retention.coupon_offer) ? retention.coupon_offer : undefined;
      const coupon = readString(offer?.coupon);
      const couponParam = `flow_data[${type}][retention][coupon_offer][coupon]`;
      // Coupons are not modelled, so no coupon can be offered.
      return coupon ? invalid(`No such coupon: '${coupon}'`, couponParam, "resource_missing") : missing(couponParam);
    }
  }
  return { ok: true, value: sub };
}

function readFlowData(
  ss: StripeStore,
  value: unknown,
  customerId: string,
): Parsed<StripeBillingPortalFlow | undefined> {
  if (value === undefined || value === "") return { ok: true, value: undefined };
  if (!isRecord(value)) return invalid("Invalid flow_data: must be an object.", "flow_data");
  if (value.type === undefined || value.type === "") return missing("flow_data[type]");
  const type = oneOf(value.type, FLOW_TYPES, "flow_data[type]");
  if (!type.ok) return type;
  const flowType = type.value!;
  const feature = DISABLED_FLOWS[flowType];
  if (feature) {
    return invalid(
      `The portal configuration does not enable features.${feature}, which flow_data[type]=${flowType} needs.`,
      "flow_data[type]",
    );
  }
  if (flowType === "subscription_update_confirm") {
    return invalid("The emulator does not support flow_data[type]=subscription_update_confirm.", "flow_data[type]");
  }
  const after = readAfterCompletion(value.after_completion);
  if (!after.ok) return after;
  const flow: StripeBillingPortalFlow = { type: flowType as BillingPortalFlowType, after_completion: after.value };
  if (flowType === "subscription_cancel" || flowType === "subscription_update") {
    const sub = readFlowSubscription(ss, value, flowType, customerId);
    if (!sub.ok) return sub;
    flow.subscription = sub.value.stripe_id;
  }
  return { ok: true, value: flow };
}

function readAfterExpiration(value: unknown): Parsed<StripeBillingPortalSession["after_expiration"]> {
  if (value === undefined || value === "") return { ok: true, value: undefined };
  if (!isRecord(value)) return invalid("Invalid after_expiration: must be an object.", "after_expiration");
  if (value.type === undefined || value.type === "") return missing("after_expiration[type]");
  const type = oneOf(value.type, ["customer_login"] as const, "after_expiration[type]");
  if (!type.ok) return type;
  const login = isRecord(value.customer_login) ? value.customer_login : undefined;
  const raw = login?.expires_at;
  let expiresAt: number | undefined;
  if (raw !== undefined && raw !== "") {
    expiresAt = readInt(raw);
    if (expiresAt === undefined) {
      return invalid(`Invalid integer: ${String(raw)}`, "after_expiration[customer_login][expires_at]");
    }
  }
  return { ok: true, value: { type: "customer_login", expires_at: expiresAt } };
}

export function billingPortalRoutes(ctx: RouteContext): void {
  const { app, store, baseUrl } = ctx;
  const ss = getStripeStore(store);
  const expand = stripeExpandResolver(ss, baseUrl);
  const renderSession = (session: StripeBillingPortalSession) => formatBillingPortalSession(session, baseUrl);

  app.post("/v1/billing_portal/sessions", async (c) => {
    const body = await parseStripeBody(c);
    if (readString(body.customer_account) && !readString(body.customer)) {
      return sendStripeError(
        c,
        invalid("The emulator does not support customer_account. Pass customer instead.", "customer_account").error,
      );
    }
    const customerId = readString(body.customer);
    if (!customerId) return sendStripeError(c, missing("customer").error);
    if (!ss.customers.findOneBy("stripe_id", customerId)) {
      return sendStripeError(c, invalid(`No such customer: '${customerId}'`, "customer", "resource_missing").error);
    }
    let configuration: StripeBillingPortalConfiguration;
    const configurationId = readString(body.configuration);
    if (configurationId) {
      const found = ss.billingPortalConfigurations.findOneBy("stripe_id", configurationId);
      if (!found) {
        return sendStripeError(
          c,
          invalid(`No such configuration: '${configurationId}'`, "configuration", "resource_missing").error,
        );
      }
      configuration = found;
    } else {
      configuration = defaultPortalConfiguration(ss);
    }
    const returnUrl = readUrl(body.return_url, "return_url");
    if (!returnUrl.ok) return sendStripeError(c, returnUrl.error);
    const locale = oneOf(body.locale, LOCALES, "locale");
    if (!locale.ok) return sendStripeError(c, locale.error);
    const flow = readFlowData(ss, body.flow_data, customerId);
    if (!flow.ok) return sendStripeError(c, flow.error);
    const afterExpiration = readAfterExpiration(body.after_expiration);
    if (!afterExpiration.ok) return sendStripeError(c, afterExpiration.error);

    const session = ss.billingPortalSessions.insert({
      stripe_id: stripeId("bps"),
      customer_id: customerId,
      configuration_id: configuration.stripe_id,
      return_url: returnUrl.value,
      locale: locale.value,
      on_behalf_of: readString(body.on_behalf_of),
      flow: flow.value,
      after_expiration: afterExpiration.value,
      created: nowFor(ss, { customerId }),
    });

    const ev = eventBatch(ctx, c);
    ev.emit("billing_portal.session.created", renderSession(session));
    await ev.commit();
    return expandedJson(c, renderSession(session), expand, body);
  });

  app.get("/v1/billing_portal/configurations", (c) => {
    defaultPortalConfiguration(ss);
    let items = ss.billingPortalConfigurations.all();
    const isDefault = c.req.query("is_default");
    if (isDefault === "true" || isDefault === "false") {
      items = items.filter((config) => config.is_default === (isDefault === "true"));
    }
    if (c.req.query("active") === "false") items = [];
    return stripeList(c, items, "/v1/billing_portal/configurations", formatBillingPortalConfiguration, {
      created: (config) => config.created,
      expand,
    });
  });

  app.get("/v1/billing_portal/configurations/:id", (c) => {
    const id = c.req.param("id");
    const config = ss.billingPortalConfigurations.findOneBy("stripe_id", id);
    if (!config) {
      return stripeError(c, 404, "invalid_request_error", `No such configuration: '${id}'`, "resource_missing", "id");
    }
    return expandedJson(c, formatBillingPortalConfiguration(config), expand);
  });

  // The portal pages. Actions there are the customer's, so their events carry no request.

  const pageNotFound = (c: Context, what = "portal session") =>
    c.html(
      renderCardPage(
        "Not Found",
        `This ${escapeHtml(what)} does not exist.`,
        '<p class="empty">The link is invalid or has been removed.</p>',
        SERVICE_LABEL,
      ),
      404,
    );

  const findSession = (c: Context) => ss.billingPortalSessions.findOneBy("stripe_id", c.req.param("id")!);

  /** One of the session customer's subscriptions, by the `sub` route param. */
  const findSubscription = (c: Context, session: StripeBillingPortalSession) => {
    const sub = ss.subscriptions.findOneBy("stripe_id", c.req.param("sub")!);
    return sub && sub.customer_id === session.customer_id ? sub : undefined;
  };

  /** The flow the page still walks the customer through, if any. */
  const activeFlow = (session: StripeBillingPortalSession) =>
    session.flow && !session.flow_completed ? session.flow : undefined;

  const subscriptionCard = (session: StripeBillingPortalSession, sub: StripeSubscription) => {
    const lines = subscriptionItems(ss, sub.stripe_id).map((item) => {
      const price = ss.prices.findOneBy("stripe_id", item.price_id);
      if (!price) return escapeHtml(item.price_id);
      const amount =
        typeof price.unit_amount === "number" ? money(price.unit_amount * item.quantity, price.currency) : "";
      const every = price.recurring ? ` ${intervalText(price.recurring.interval, price.recurring.interval_count)}` : "";
      const qty = item.quantity > 1 ? `${item.quantity} × ` : "";
      return `${escapeHtml(qty + productName(ss, price))} <span class="user-meta">${escapeHtml(amount + every)}</span>`;
    });
    const scheduled = sub.cancel_at !== undefined;
    const notes: string[] = [];
    if (sub.trial_end !== undefined && sub.status === "trialing") notes.push(`Trial ends ${day(sub.trial_end)}`);
    if (scheduled) notes.push(`Cancels ${day(sub.cancel_at!)}`);
    else {
      const end = currentPeriodEnd(ss, sub);
      if (end !== undefined && sub.status !== "paused") notes.push(`Renews ${day(end)}`);
    }
    const action = (path: string) =>
      `/billing_portal/${escapeAttr(session.stripe_id)}/subscriptions/${escapeAttr(sub.stripe_id)}/${path}`;

    let form = "";
    if (scheduled) {
      form = `<form method="post" action="${action("renew")}" class="user-form">
  <button type="submit" class="checkout-pay-btn">Renew subscription</button>
</form>`;
    } else if (CANCELABLE.includes(sub.status)) {
      const reasons = PORTAL_CANCELLATION_REASONS.map(
        (reason) => `<option value="${reason}">${escapeHtml(LABEL_FEEDBACK[reason])}</option>`,
      ).join("");
      form = `<form method="post" action="${action("cancel")}" class="user-form">
  <div class="checkout-form-section">
    <label class="checkout-form-label">Why are you canceling?</label>
    <select name="feedback" class="checkout-input"><option value="">Prefer not to say</option>${reasons}</select>
  </div>
  <div class="checkout-form-section">
    <input type="text" name="comment" class="checkout-input" placeholder="Anything else? (optional)"/>
  </div>
  <button type="submit" class="checkout-pay-btn">Cancel subscription</button>
</form>`;
    }
    return `<div class="s-card">
  <div class="s-card-header">
    <div>
      <div class="s-title">${lines.join("<br/>")}</div>
      <div class="s-subtitle">${escapeHtml(sub.stripe_id)} <span class="badge badge-granted">${escapeHtml(sub.status)}</span>${notes.length > 0 ? ` ${escapeHtml(notes.join(", "))}` : ""}</div>
    </div>
  </div>
  ${form}
</div>`;
  };

  const paymentMethodCard = (session: StripeBillingPortalSession) => {
    const customer = ss.customers.findOneBy("stripe_id", session.customer_id);
    const pmId = customer?.invoice_settings?.default_payment_method;
    const pm = pmId ? ss.paymentMethods.findOneBy("stripe_id", pmId) : undefined;
    const card = pm ? formatPaymentMethod(pm).card : undefined;
    const current = card
      ? `${card.brand} ending in ${card.last4}, expires ${card.exp_month}/${card.exp_year}`
      : "No default payment method";
    return `<div class="s-card">
  <div class="section-heading">Payment method</div>
  <div class="s-subtitle">${escapeHtml(current)}</div>
  <form method="post" action="/billing_portal/${escapeAttr(session.stripe_id)}/payment_method" class="user-form">
    <div class="checkout-form-section">
      <label class="checkout-form-label">New card</label>
      ${cardSelect()}
    </div>
    <button type="submit" class="checkout-pay-btn">Update payment method</button>
  </form>
</div>`;
  };

  const invoicesCard = (session: StripeBillingPortalSession) => {
    const invoices = ss.invoices
      .findBy("customer_id", session.customer_id)
      .filter((inv) => inv.status !== "draft")
      .sort((a, b) => b.created - a.created || b.id - a.id);
    if (invoices.length === 0) return "";
    const rows = invoices.map((inv) => {
      const wire = formatInvoice(ss, inv, baseUrl);
      const payable = inv.status === "open" || inv.status === "uncollectible";
      const pay = payable
        ? `<form method="post" action="/billing_portal/${escapeAttr(session.stripe_id)}/invoices/${escapeAttr(inv.stripe_id)}/pay" class="user-form">
  <button type="submit" class="checkout-pay-btn">Pay ${escapeHtml(money(wire.amount_remaining, wire.currency))}</button>
</form>`
        : "";
      return `<div class="org-row">
  <div>
    <a class="org-name" href="${escapeAttr(wire.hosted_invoice_url ?? "#")}">${escapeHtml(wire.number ?? inv.stripe_id)}</a>
    <div class="user-meta">${escapeHtml(inv.stripe_id)}, ${escapeHtml(day(inv.created))}, ${escapeHtml(money(wire.total, wire.currency))} <span class="badge badge-requested">${escapeHtml(inv.status)}</span></div>
  </div>
</div>${pay}`;
    });
    return `<div class="s-card"><div class="section-heading">Invoice history</div>${rows.join("")}</div>`;
  };

  const renderPortal = (session: StripeBillingPortalSession, errorMessage?: string) => {
    const customer = ss.customers.findOneBy("stripe_id", session.customer_id);
    const flow = activeFlow(session);
    const subscriptions = ss.subscriptions
      .findBy("customer_id", session.customer_id)
      .filter((sub) => !isEnded(sub))
      .sort((a, b) => b.created - a.created || b.id - a.id);

    let body: string;
    if (flow?.type === "payment_method_update") {
      body = paymentMethodCard(session);
    } else if (flow && flow.subscription) {
      const sub = ss.subscriptions.findOneBy("stripe_id", flow.subscription);
      const note =
        flow.type === "subscription_update"
          ? '<p class="info-text">Changing plans is not available in the emulator portal.</p>'
          : "";
      body = sub ? subscriptionCard(session, sub) + note : '<p class="empty">The subscription no longer exists.</p>';
    } else {
      const subs =
        subscriptions.length > 0
          ? subscriptions.map((sub) => subscriptionCard(session, sub)).join("")
          : '<p class="empty">No current subscriptions</p>';
      body = `<div class="section-heading">Current subscriptions</div>${subs}${paymentMethodCard(session)}${invoicesCard(session)}`;
    }
    const back = session.return_url
      ? `<div class="checkout-cancel"><a href="${escapeAttr(session.return_url)}">Return to ${escapeHtml(session.return_url)}</a></div>`
      : "";
    const who = customer?.email ?? customer?.name ?? session.customer_id;
    return renderCardPage(
      "Billing Portal",
      `Manage billing for ${escapeHtml(who)}.`,
      `${errorBlock(errorMessage)}${body}${back}`,
      SERVICE_LABEL,
    );
  };

  /** Answer a page action with its error, keeping the customer on the portal page. */
  const pageError = (c: Context, session: StripeBillingPortalSession, error: StripeErrorSpec) =>
    c.html(renderPortal(session, error.message), error.status === 402 ? 402 : 400);

  /**
   * Leave a finished action. The step that completes the session's flow applies its
   * `after_completion`; every other action goes back to the portal page.
   */
  const finish = (
    c: Context,
    session: StripeBillingPortalSession,
    completes: (flow: StripeBillingPortalFlow) => boolean,
  ) => {
    const flow = activeFlow(session);
    const url = billingPortalUrl(baseUrl, session.stripe_id);
    if (!flow || !completes(flow)) return c.redirect(url, 303);
    ss.billingPortalSessions.update(session.id, { flow_completed: true });
    const after = flow.after_completion;
    if (after.type === "redirect") return c.redirect(after.return_url, 303);
    if (after.type === "hosted_confirmation") {
      const back = session.return_url
        ? `<div class="checkout-cancel"><a href="${escapeAttr(session.return_url)}">Return to ${escapeHtml(session.return_url)}</a></div>`
        : "";
      return c.html(
        renderCardPage(
          "All Done",
          escapeHtml(after.custom_message ?? "Your changes were saved."),
          `<p class="empty check">Done</p>${back}`,
          SERVICE_LABEL,
        ),
      );
    }
    return c.redirect(url, 303);
  };

  app.get("/billing_portal/:id", (c) => {
    const session = findSession(c);
    if (!session) return pageNotFound(c);
    return c.html(renderPortal(session));
  });

  app.post("/billing_portal/:id/subscriptions/:sub/cancel", async (c) => {
    const session = findSession(c);
    if (!session) return pageNotFound(c);
    const sub = findSubscription(c, session);
    if (!sub) return pageNotFound(c, "subscription");
    const form = await parseStripeBody(c);
    const feedback = oneOf(form.feedback, PORTAL_CANCELLATION_REASONS, "feedback");
    if (!feedback.ok) return pageError(c, session, feedback.error);
    if (!CANCELABLE.includes(sub.status) || sub.cancel_at !== undefined) {
      return pageError(
        c,
        session,
        invalid(
          sub.cancel_at !== undefined
            ? "This subscription is already scheduled to cancel."
            : `A ${sub.status} subscription cannot be canceled here.`,
        ).error,
      );
    }

    const before = formatSubscription(ss, sub);
    const now = nowFor(ss, { customerId: sub.customer_id });
    const updated = ss.subscriptions.update(sub.id, {
      cancel_at_period_end: true,
      cancel_at: currentPeriodEnd(ss, sub),
      canceled_at: now,
      cancellation_details: requestedCancellation({
        ...sub.cancellation_details,
        feedback: feedback.value,
        comment: readString(form.comment),
      }),
    })!;
    const ev = eventBatch(ctx);
    emitSubscriptionChange(ss, ev, updated, before);
    await ev.commit();
    return finish(c, session, (flow) => flow.type === "subscription_cancel" && flow.subscription === sub.stripe_id);
  });

  app.post("/billing_portal/:id/subscriptions/:sub/renew", async (c) => {
    const session = findSession(c);
    if (!session) return pageNotFound(c);
    const sub = findSubscription(c, session);
    if (!sub) return pageNotFound(c, "subscription");
    if (isEnded(sub) || sub.cancel_at === undefined) {
      return pageError(c, session, invalid("This subscription is not scheduled to cancel.").error);
    }
    const before = formatSubscription(ss, sub);
    const updated = ss.subscriptions.update(sub.id, unscheduleCancellation())!;
    const ev = eventBatch(ctx);
    emitSubscriptionChange(ss, ev, updated, before);
    await ev.commit();
    return finish(c, session, () => false);
  });

  app.post("/billing_portal/:id/payment_method", async (c) => {
    const session = findSession(c);
    if (!session) return pageNotFound(c);
    const form = await parseStripeBody(c);
    const requested = readString(form.payment_method) ?? "pm_card_visa";
    const ev = eventBatch(ctx);
    const saved = savePortalCard(ev, session.customer_id, requested);
    await ev.commit();
    if (!saved.ok) return pageError(c, session, saved.error);
    return finish(c, session, (flow) => flow.type === "payment_method_update");
  });

  app.post("/billing_portal/:id/invoices/:invoice/pay", async (c) => {
    const session = findSession(c);
    if (!session) return pageNotFound(c);
    const inv = ss.invoices.findOneBy("stripe_id", c.req.param("invoice"));
    if (!inv || inv.customer_id !== session.customer_id || inv.status === "draft") {
      return pageNotFound(c, "invoice");
    }
    const ev = eventBatch(ctx);
    const result = payInvoiceOnPage(ctx, ev, inv);
    await ev.commit();
    if (!result.ok) return pageError(c, session, result.error);
    return finish(c, session, () => false);
  });

  /**
   * Save a card through a SetupIntent, as the portal does, and make it the customer's invoice
   * default. A subscription's own `default_payment_method` overrides that default, so the portal
   * removes the override and the subscription falls back to the new card, as Stripe's portal
   * integration guide describes. The customer is present, so 3D Secure is approved.
   */
  function savePortalCard(
    ev: EventBatch,
    customerId: string,
    requested: string,
  ): { ok: true } | { ok: false; error: StripeErrorSpec } {
    const resolved = resolvePaymentMethod(ss, requested, customerId);
    if (!resolved.ok) return resolved;
    const id = stripeId("seti");
    const si = ss.setupIntents.insert({
      stripe_id: id,
      status: "requires_confirmation",
      customer_id: customerId,
      payment_method: resolved.pm.stripe_id,
      usage: "off_session",
      metadata: {},
      created: nowFor(ss, { customerId }),
      client_secret: newClientSecret(id),
    });
    ev.emit("setup_intent.created", formatSetupIntent(si));
    const attempt = attemptSetup(ctx, ev, si, resolved.pm);
    if (attempt.status === "failed") return { ok: false, error: attempt.error };
    const done =
      attempt.status === "requires_action" ? completeSetupAuthentication(ctx, ev, attempt.si, "succeed") : attempt.si;
    if (done.status !== "succeeded" || !done.payment_method) {
      return { ok: false, error: invalid("The card could not be saved.").error };
    }
    const pmId = done.payment_method;

    const customer = ss.customers.findOneBy("stripe_id", customerId)!;
    const updated = ss.customers.update(customer.id, {
      invoice_settings: { ...customer.invoice_settings, default_payment_method: pmId },
    })!;
    const after = formatCustomer(updated);
    const previous = previousAttributes(formatCustomer(customer), after);
    if (Object.keys(previous).length > 0) ev.emit("customer.updated", after, previous);

    for (const sub of ss.subscriptions.findBy("customer_id", customerId)) {
      if (isEnded(sub) || !sub.default_payment_method) continue;
      const before = formatSubscription(ss, sub);
      const changed = ss.subscriptions.update(sub.id, { default_payment_method: undefined })!;
      emitSubscriptionChange(ss, ev, changed, before);
    }
    return { ok: true };
  }
}
