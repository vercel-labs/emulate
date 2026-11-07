import type { RouteContext } from "@emulators/core";
import { getStripeStore } from "../store.js";
import { stripeId, parseStripeBody, stripeError, stripeList } from "../helpers.js";
import { formatCustomer } from "../formatters.js";
import { eventBatch, previousAttributes } from "../events.js";

export function customerRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const ss = getStripeStore(store);

  app.post("/v1/customers", async (c) => {
    const body = await parseStripeBody(c);
    const customer = ss.customers.insert({
      stripe_id: stripeId("cus"),
      email: (body.email as string) ?? null,
      name: (body.name as string) ?? null,
      description: (body.description as string) ?? null,
      metadata: (body.metadata as Record<string, string>) ?? {},
    });

    const ev = eventBatch(ctx, c);
    ev.emit("customer.created", formatCustomer(customer));
    await ev.commit();

    return c.json(formatCustomer(customer), 200);
  });

  app.get("/v1/customers/:id", (c) => {
    const customer = ss.customers.findOneBy("stripe_id", c.req.param("id"));
    if (!customer)
      return stripeError(
        c,
        404,
        "invalid_request_error",
        `No such customer: '${c.req.param("id")}'`,
        "resource_missing",
      );
    return c.json(formatCustomer(customer));
  });

  app.post("/v1/customers/:id", async (c) => {
    const customer = ss.customers.findOneBy("stripe_id", c.req.param("id"));
    if (!customer)
      return stripeError(
        c,
        404,
        "invalid_request_error",
        `No such customer: '${c.req.param("id")}'`,
        "resource_missing",
      );
    const body = await parseStripeBody(c);
    const updated = ss.customers.update(customer.id, {
      ...(body.email !== undefined && { email: body.email as string }),
      ...(body.name !== undefined && { name: body.name as string }),
      ...(body.description !== undefined && { description: body.description as string }),
      ...(body.metadata !== undefined && { metadata: body.metadata as Record<string, string> }),
    })!;

    const previous = previousAttributes(formatCustomer(customer), formatCustomer(updated));
    if (Object.keys(previous).length > 0) {
      const ev = eventBatch(ctx, c);
      ev.emit("customer.updated", formatCustomer(updated), previous);
      await ev.commit();
    }

    return c.json(formatCustomer(updated));
  });

  app.delete("/v1/customers/:id", async (c) => {
    const customer = ss.customers.findOneBy("stripe_id", c.req.param("id"));
    if (!customer)
      return stripeError(
        c,
        404,
        "invalid_request_error",
        `No such customer: '${c.req.param("id")}'`,
        "resource_missing",
      );

    // Cascade: nullify customer_id on related entities
    for (const pi of ss.paymentIntents.findBy("customer_id", customer.stripe_id)) {
      ss.paymentIntents.update(pi.id, { customer_id: null });
    }
    for (const ch of ss.charges.findBy("customer_id", customer.stripe_id)) {
      ss.charges.update(ch.id, { customer_id: null });
    }
    for (const cs of ss.checkoutSessions.findBy("customer_id", customer.stripe_id)) {
      ss.checkoutSessions.update(cs.id, { customer_id: null });
    }

    ss.customers.delete(customer.id);

    const ev = eventBatch(ctx, c);
    ev.emit("customer.deleted", { ...formatCustomer(customer), deleted: true });
    await ev.commit();

    return c.json({ id: customer.stripe_id, object: "customer", deleted: true });
  });

  app.get("/v1/customers", (c) => {
    let items = ss.customers.all();
    const email = c.req.query("email");
    if (email) items = items.filter((cust) => cust.email === email);
    return stripeList(c, items, "/v1/customers", formatCustomer);
  });
}
