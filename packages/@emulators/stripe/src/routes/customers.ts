import type { RouteContext } from "@emulators/core";
import { getStripeStore } from "../store.js";
import { stripeId, parseStripeBody, stripeError, stripeList } from "../helpers.js";
import { formatCustomer } from "../formatters.js";

export function customerRoutes({ app, store, webhooks }: RouteContext): void {
  const ss = getStripeStore(store);

  app.post("/v1/customers", async (c) => {
    const body = await parseStripeBody(c);
    const customer = ss.customers.insert({
      stripe_id: stripeId("cus"),
      email: body.email ?? null,
      name: body.name ?? null,
      description: body.description ?? null,
      metadata: body.metadata ?? {},
    });

    await webhooks.dispatch(
      "customer.created",
      undefined,
      { type: "customer.created", data: { object: formatCustomer(customer) } },
      "stripe",
    );

    return c.json(formatCustomer(customer), 200);
  });

  app.get("/v1/customers/:id", (c) => {
    const customer = ss.customers.findOneBy("stripe_id", c.req.param("id"));
    if (!customer) return stripeError(c, 404, "invalid_request_error", `No such customer: '${c.req.param("id")}'`, "resource_missing");
    return c.json(formatCustomer(customer));
  });

  app.post("/v1/customers/:id", async (c) => {
    const customer = ss.customers.findOneBy("stripe_id", c.req.param("id"));
    if (!customer) return stripeError(c, 404, "invalid_request_error", `No such customer: '${c.req.param("id")}'`, "resource_missing");
    const body = await parseStripeBody(c);
    const updated = ss.customers.update(customer.id, {
      ...(body.email !== undefined && { email: body.email }),
      ...(body.name !== undefined && { name: body.name }),
      ...(body.description !== undefined && { description: body.description }),
      ...(body.metadata !== undefined && { metadata: body.metadata }),
    });

    await webhooks.dispatch(
      "customer.updated",
      undefined,
      { type: "customer.updated", data: { object: formatCustomer(updated!) } },
      "stripe",
    );

    return c.json(formatCustomer(updated!));
  });

  app.delete("/v1/customers/:id", async (c) => {
    const customer = ss.customers.findOneBy("stripe_id", c.req.param("id"));
    if (!customer) return stripeError(c, 404, "invalid_request_error", `No such customer: '${c.req.param("id")}'`, "resource_missing");

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

    await webhooks.dispatch(
      "customer.deleted",
      undefined,
      { type: "customer.deleted", data: { object: { ...formatCustomer(customer), deleted: true } } },
      "stripe",
    );

    return c.json({ id: customer.stripe_id, object: "customer", deleted: true });
  });

  app.get("/v1/customers", (c) => {
    let items = ss.customers.all();
    const email = c.req.query("email");
    if (email) items = items.filter((cust) => cust.email === email);
    return stripeList(c, items, "/v1/customers", formatCustomer);
  });
}
