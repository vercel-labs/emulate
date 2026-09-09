import { addCardPaymentSource, deletePaymentSource } from "../cards.js";
import { customerRow, formatCard, formatPaymentSource } from "../formatters.js";
import { blankParamError, bool, chargebeeList, num, parseChargebeeBody, str, strOrNull } from "../helpers.js";
import { resourceVersion } from "../store.js";
import { api, findCustomer, findPaymentSource, nested, type ChargebeeRouteContext } from "../route-utils.js";
import { cardInputFrom } from "./customers.js";

export function paymentSourceRoutes(rc: ChargebeeRouteContext): void {
  const { app, cs, ctx } = rc;

  const createWithCard = api(cs, async (c) => {
    const body = await parseChargebeeBody(c);
    const customerId = str(body.customer_id);
    if (!customerId) throw blankParamError("customer_id");
    const customer = findCustomer(cs, customerId);
    const card = cardInputFrom(body.card) ?? {};
    const paymentIntent = nested(body, "payment_intent");
    const source = await addCardPaymentSource(ctx, customer, card, {
      replacePrimary: bool(body.replace_primary_payment_source) ?? true,
      referenceId: str(body.token_id) ?? str(body.tmp_token) ?? str(body.reference_id) ?? str(paymentIntent.id),
    });
    return c.json({ ...customerRow(cs, cs.customers.get(customer.id)!), payment_source: formatPaymentSource(source) });
  });

  app.post("/api/v2/payment_sources/create_card", createWithCard);
  app.post("/api/v2/payment_sources/create_using_token", createWithCard);
  app.post("/api/v2/payment_sources/create_using_temp_token", createWithCard);
  app.post("/api/v2/payment_sources/create_using_permanent_token", createWithCard);
  app.post("/api/v2/payment_sources/create_using_payment_intent", createWithCard);

  app.get(
    "/api/v2/payment_sources",
    api(cs, (c) =>
      chargebeeList(
        c,
        cs.paymentSources.all().filter((source) => !source.deleted),
        "payment_source",
        (source) => ({ payment_source: formatPaymentSource(source) }),
      ),
    ),
  );

  app.get(
    "/api/v2/payment_sources/:id",
    api(cs, (c) => c.json({ payment_source: formatPaymentSource(findPaymentSource(cs, c.req.param("id"))) })),
  );

  app.post(
    "/api/v2/payment_sources/:id/update_card",
    api(cs, async (c) => {
      const source = findPaymentSource(cs, c.req.param("id"));
      if (!source.card) throw blankParamError("card");
      const body = await parseChargebeeBody(c);
      const card = nested(body, "card");
      const updated = cs.paymentSources.update(source.id, {
        card: {
          ...source.card,
          first_name: card.first_name !== undefined ? strOrNull(card.first_name) : source.card.first_name,
          last_name: card.last_name !== undefined ? strOrNull(card.last_name) : source.card.last_name,
          expiry_month: num(card.expiry_month) ?? source.card.expiry_month,
          expiry_year: num(card.expiry_year) ?? source.card.expiry_year,
        },
        resource_version: resourceVersion(cs),
      })!;
      const customer = findCustomer(cs, source.customer_id);
      await ctx.emit("payment_source_updated", {
        payment_source: formatPaymentSource(updated),
        ...customerRow(cs, customer),
      });
      await ctx.emit("card_updated", { card: formatCard(updated), customer: customerRow(cs, customer).customer });
      return c.json({ ...customerRow(cs, customer), payment_source: formatPaymentSource(updated) });
    }),
  );

  const remove = api(cs, async (c) => {
    const source = findPaymentSource(cs, c.req.param("id"));
    const deleted = await deletePaymentSource(ctx, source);
    const customer = cs.customers.findOneBy("cb_id", source.customer_id);
    return c.json({ ...(customer ? customerRow(cs, customer) : {}), payment_source: formatPaymentSource(deleted) });
  });

  app.post("/api/v2/payment_sources/:id/delete", remove);
  app.post("/api/v2/payment_sources/:id/delete_local", remove);
}
