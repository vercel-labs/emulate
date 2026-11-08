import { randomUUID } from "crypto";
import type { Context, RouteContext } from "@emulators/core";
import { getStripeStore } from "../store.js";
import { parseStripeBody, readInt, stripeError } from "../helpers.js";
import { nowFor } from "../clock.js";
import { formatMeterEvent } from "../formatters.js";
import { activeMeterFor, MAX_METER_EVENT_AGE, MAX_METER_EVENT_LEAD, METER_EVENT_WINDOW } from "../metering.js";
import type { StripeMeterEvent } from "../entities.js";

const MAX_NAME_LENGTH = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readText(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** A usage value: a decimal number, possibly negative, sent as a string or a number. */
function readUsageValue(value: string): number | undefined {
  const text = value.trim();
  return /^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(text) ? Number(text) : undefined;
}

export function meterEventRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const ss = getStripeStore(store);

  const invalid = (c: Context, message: string, param?: string, code?: string) =>
    stripeError(c, 400, "invalid_request_error", message, code, param);

  /** Whether an event received at `event.created` still counts as recent on its customer's clock. */
  const withinWindow = (event: StripeMeterEvent) =>
    nowFor(ss, { customerId: event.customer_id }) - event.created < METER_EVENT_WINDOW;

  app.post("/v1/billing/meter_events", async (c) => {
    const body = await parseStripeBody(c);
    const eventName = readText(body.event_name);
    if (!eventName) return invalid(c, "Missing required param: event_name.", "event_name", "parameter_missing");
    if (eventName.length > MAX_NAME_LENGTH) {
      return invalid(c, `Invalid event_name: must be at most ${MAX_NAME_LENGTH} characters.`, "event_name");
    }
    if (!isRecord(body.payload)) return invalid(c, "Missing required param: payload.", "payload", "parameter_missing");
    const payload = Object.fromEntries(Object.entries(body.payload).map(([key, value]) => [key, String(value)]));

    const meters = ss.billingMeters.findBy("event_name", eventName);
    const meter = activeMeterFor(ss, eventName);
    if (!meter) {
      return meters.length > 0
        ? invalid(
            c,
            `The meter for event_name '${eventName}' is inactive and no longer accepts events.`,
            "event_name",
            "archived_meter",
          )
        : invalid(c, `No active meter was found for event_name '${eventName}'.`, "event_name", "no_meter");
    }

    const customerKey = meter.customer_payload_key;
    const customerId = readText(payload[customerKey]);
    if (!customerId) {
      return invalid(
        c,
        `The payload must contain the customer id under '${customerKey}'.`,
        `payload[${customerKey}]`,
        "meter_event_no_customer_defined",
      );
    }
    if (!ss.customers.findOneBy("stripe_id", customerId)) {
      return invalid(
        c,
        `No such customer: '${customerId}'`,
        `payload[${customerKey}]`,
        "meter_event_customer_not_found",
      );
    }

    const valueKey = meter.value_payload_key;
    let value: number | undefined;
    if (payload[valueKey] !== undefined) {
      value = readUsageValue(payload[valueKey]);
      if (value === undefined) {
        return invalid(
          c,
          `The value under '${valueKey}' must be a number.`,
          `payload[${valueKey}]`,
          "meter_event_invalid_value",
        );
      }
    } else if (meter.formula !== "count") {
      return invalid(
        c,
        `The payload must contain the value under '${valueKey}'.`,
        `payload[${valueKey}]`,
        "meter_event_value_not_found",
      );
    }

    const now = nowFor(ss, { customerId });
    let timestamp = now;
    if (body.timestamp !== undefined && body.timestamp !== "") {
      const given = readInt(body.timestamp);
      if (given === undefined) return invalid(c, `Invalid integer: ${String(body.timestamp)}`, "timestamp");
      if (given > now + MAX_METER_EVENT_LEAD) {
        return invalid(
          c,
          "Invalid timestamp: must be no more than 5 minutes in the future.",
          "timestamp",
          "timestamp_in_future",
        );
      }
      if (given < now - MAX_METER_EVENT_AGE) {
        return invalid(
          c,
          "Invalid timestamp: must be within the past 35 days.",
          "timestamp",
          "timestamp_too_far_in_past",
        );
      }
      timestamp = given;
    }

    const identifier = readText(body.identifier) ?? randomUUID();
    if (identifier.length > MAX_NAME_LENGTH) {
      return invalid(c, `Invalid identifier: must be at most ${MAX_NAME_LENGTH} characters.`, "identifier");
    }
    if (ss.meterEvents.findBy("identifier", identifier).some(withinWindow)) {
      return invalid(
        c,
        `A meter event with the identifier '${identifier}' has already been submitted.`,
        "identifier",
        "duplicate_meter_event",
      );
    }

    const event = ss.meterEvents.insert({
      identifier,
      event_name: eventName,
      meter_id: meter.stripe_id,
      customer_id: customerId,
      payload,
      value,
      timestamp,
      created: now,
    });
    return c.json(formatMeterEvent(event));
  });

  app.post("/v1/billing/meter_event_adjustments", async (c) => {
    const body = await parseStripeBody(c);
    const eventName = readText(body.event_name);
    if (!eventName) return invalid(c, "Missing required param: event_name.", "event_name", "parameter_missing");
    if (body.type === undefined || body.type === "") {
      return invalid(c, "Missing required param: type.", "type", "parameter_missing");
    }
    if (body.type !== "cancel") return invalid(c, "Invalid type: must be cancel", "type");
    const identifier = isRecord(body.cancel) ? readText(body.cancel.identifier) : undefined;
    if (!identifier) {
      return invalid(c, "Missing required param: cancel[identifier].", "cancel[identifier]", "parameter_missing");
    }

    const event = ss.meterEvents
      .findBy("identifier", identifier)
      .filter((e) => e.event_name === eventName)
      .sort((a, b) => b.id - a.id)[0];
    if (!event) {
      return invalid(
        c,
        `No meter event with the identifier '${identifier}' was found for event_name '${eventName}'.`,
        "cancel[identifier]",
        "resource_missing",
      );
    }
    if (!withinWindow(event)) {
      return invalid(c, "You can only cancel events within 24 hours of Stripe receiving them.", "cancel[identifier]");
    }
    ss.meterEvents.update(event.id, { canceled: true });
    return c.json({
      object: "billing.meter_event_adjustment",
      livemode: false,
      status: "pending",
      event_name: eventName,
      type: "cancel",
      cancel: { identifier },
    });
  });
}
