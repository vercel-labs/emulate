import type { Context, RouteContext } from "@emulators/core";
import { getStripeStore } from "../store.js";
import { expandedJson, parseStripeBody, readInt, stripeError, stripeList, readString } from "../helpers.js";
import { formatTestClock, stripeExpandResolver } from "../formatters.js";
import { eventBatch } from "../events.js";
import {
  attachCustomerToClock,
  deleteTestClockObjects,
  insertTestClock,
  liveSubscriptionCount,
  maxAdvanceTime,
  MAX_CLOCK_SUBSCRIPTIONS,
} from "../clock.js";
import { runBillingUntil } from "../billing.js";

/** `frozen_time` as an integer, or the 400 Stripe answers for a missing or malformed one. */
function readFrozenTime(c: Context, value: unknown): number | Response {
  if (value === undefined || value === "") {
    return stripeError(
      c,
      400,
      "invalid_request_error",
      "Missing required param: frozen_time.",
      "parameter_missing",
      "frozen_time",
    );
  }
  const frozenTime = readInt(value);
  if (frozenTime === undefined) {
    return stripeError(c, 400, "invalid_request_error", `Invalid integer: ${String(value)}`, undefined, "frozen_time");
  }
  return frozenTime;
}

export function testClockRoutes(ctx: RouteContext): void {
  const { app, store, baseUrl } = ctx;
  const ss = getStripeStore(store);
  const expand = stripeExpandResolver(ss, baseUrl);

  const notFound = (c: Context, id: string) =>
    stripeError(c, 404, "invalid_request_error", `No such test_clock: '${id}'`, "resource_missing", "test_clock");

  app.post("/v1/test_helpers/test_clocks", async (c) => {
    const body = await parseStripeBody(c);
    const frozenTime = readFrozenTime(c, body.frozen_time);
    if (frozenTime instanceof Response) return frozenTime;

    const customerId = readString(body.customer);
    const customer = customerId ? ss.customers.findOneBy("stripe_id", customerId) : undefined;
    if (customerId) {
      if (!customer) {
        return stripeError(
          c,
          400,
          "invalid_request_error",
          `No such customer: '${customerId}'`,
          "resource_missing",
          "customer",
        );
      }
      if (customer.test_clock) {
        return stripeError(
          c,
          400,
          "invalid_request_error",
          "This customer is already attached to a test clock.",
          undefined,
          "customer",
        );
      }
      // An existing customer's objects already carry wall clock times, so its clock cannot start earlier.
      if (frozenTime < Math.floor(Date.now() / 1000)) {
        return stripeError(
          c,
          400,
          "invalid_request_error",
          "The frozen_time of a test clock created for an existing customer cannot be in the past.",
          undefined,
          "frozen_time",
        );
      }
      if (liveSubscriptionCount(ss, customer.stripe_id) > MAX_CLOCK_SUBSCRIPTIONS) {
        return stripeError(
          c,
          400,
          "invalid_request_error",
          `A customer on a test clock can have at most ${MAX_CLOCK_SUBSCRIPTIONS} subscriptions.`,
          undefined,
          "customer",
        );
      }
    }

    const clock = insertTestClock(ss, frozenTime, readString(body.name));
    if (customer) attachCustomerToClock(ss, customer, clock.stripe_id);

    const ev = eventBatch(ctx, c);
    ev.emit("test_helpers.test_clock.created", formatTestClock(clock));
    await ev.commit();
    return expandedJson(c, formatTestClock(clock), expand, body);
  });

  app.get("/v1/test_helpers/test_clocks", (c) =>
    stripeList(c, ss.testClocks.all(), "/v1/test_helpers/test_clocks", (clock) => formatTestClock(clock), {
      created: (clock) => clock.created,
      expand,
    }),
  );

  app.get("/v1/test_helpers/test_clocks/:id", (c) => {
    const id = c.req.param("id");
    const clock = ss.testClocks.findOneBy("stripe_id", id);
    if (!clock) return notFound(c, id);
    return expandedJson(c, formatTestClock(clock), expand);
  });

  app.post("/v1/test_helpers/test_clocks/:id/advance", async (c) => {
    const id = c.req.param("id");
    const clock = ss.testClocks.findOneBy("stripe_id", id);
    if (!clock) return notFound(c, id);
    const body = await parseStripeBody(c);
    const target = readFrozenTime(c, body.frozen_time);
    if (target instanceof Response) return target;

    if (clock.status === "internal_failure") {
      return stripeError(
        c,
        400,
        "invalid_request_error",
        "This test clock failed to advance and can no longer be advanced.",
      );
    }
    if (target <= clock.frozen_time) {
      return stripeError(
        c,
        400,
        "invalid_request_error",
        "The frozen_time must be after the test clock's current frozen_time.",
        undefined,
        "frozen_time",
      );
    }
    const limit = maxAdvanceTime(ss, clock);
    if (target > limit) {
      return stripeError(
        c,
        400,
        "invalid_request_error",
        `Cannot advance the test clock past ${limit}: a test clock advances at most two intervals of the shortest subscription on it, or two years when it has none.`,
        undefined,
        "frozen_time",
      );
    }

    // The advance answers while the clock is still `advancing`; the clock settles before the response.
    const response = formatTestClock(clock, target);
    const started = eventBatch(ctx, c);
    started.emit("test_helpers.test_clock.advancing", response);
    await started.commit();

    ss.testClocks.update(clock.id, { status: "advancing" });
    const finished = await runBillingUntil(ctx, clock.stripe_id, target);
    if (!finished) {
      const failed = ss.testClocks.update(clock.id, { status: "internal_failure" })!;
      const report = eventBatch(ctx);
      report.emit("test_helpers.test_clock.internal_failure", formatTestClock(failed));
      await report.commit();
      return expandedJson(c, response, expand, body);
    }
    const advanced = ss.testClocks.update(clock.id, { frozen_time: target, status: "ready" })!;
    const settled = eventBatch(ctx);
    settled.emit("test_helpers.test_clock.ready", formatTestClock(advanced));
    await settled.commit();

    return expandedJson(c, response, expand, body);
  });

  app.delete("/v1/test_helpers/test_clocks/:id", async (c) => {
    const id = c.req.param("id");
    const clock = ss.testClocks.findOneBy("stripe_id", id);
    if (!clock) return notFound(c, id);
    deleteTestClockObjects(ss, clock);

    const ev = eventBatch(ctx, c);
    ev.emit("test_helpers.test_clock.deleted", formatTestClock(clock));
    await ev.commit();
    return c.json({ id: clock.stripe_id, object: "test_helpers.test_clock", deleted: true });
  });
}
