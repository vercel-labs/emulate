import type { RouteContext } from "@emulators/core";
import { getStripeStore } from "../store.js";
import {
  stripeId,
  parseStripeBody,
  parseStripeQuery,
  stripeError,
  stripeList,
  expandedJson,
  readBool,
  readStringList,
} from "../helpers.js";
import { formatPrice, formatProduct, stripeExpandResolver } from "../formatters.js";
import { eventBatch, previousAttributes } from "../events.js";
import { readPriceParams } from "../pricing.js";
import { insertProduct, readProductParams } from "./products.js";

/** Stripe accepts at most ten `lookup_keys` in one list request. */
const MAX_LOOKUP_KEYS = 10;

export function priceRoutes(ctx: RouteContext): void {
  const { app, store, baseUrl } = ctx;
  const ss = getStripeStore(store);
  const expand = stripeExpandResolver(ss, baseUrl);

  app.post("/v1/prices", async (c) => {
    const body = await parseStripeBody(c);
    const badParam = (message: string, param: string, code?: string) =>
      stripeError(c, 400, "invalid_request_error", message, code, param);

    const productId = typeof body.product === "string" && body.product !== "" ? body.product : undefined;
    const productData = body.product_data;
    if (!productId && productData === undefined) {
      return badParam("Missing required param: product.", "product", "parameter_missing");
    }
    if (productId && productData !== undefined) {
      return badParam("You may only specify one of these parameters: product, product_data.", "product");
    }
    if (productId && !ss.products.findOneBy("stripe_id", productId)) {
      return badParam(`No such product: '${productId}'`, "product", "resource_missing");
    }
    const newProduct = productData !== undefined ? readProductParams(productData, "product_data") : undefined;
    if (newProduct?.error) return badParam(newProduct.error.message, newProduct.error.param, newProduct.error.code);

    const parsed = readPriceParams(body);
    if (parsed.error) return badParam(parsed.error.message, parsed.error.param, parsed.error.code);
    const definition = parsed.price!;

    const holder = definition.lookup_key
      ? ss.prices.all().find((p) => p.lookup_key === definition.lookup_key)
      : undefined;
    const transfer = readBool(body.transfer_lookup_key) === true;
    if (holder && !transfer) {
      return badParam(
        `A price (\`${holder.stripe_id}\`) already uses that lookup key.`,
        "lookup_key",
        "lookup_key_already_used",
      );
    }

    const ev = eventBatch(ctx, c);
    if (holder) {
      const before = formatPrice(holder);
      const updated = ss.prices.update(holder.id, { lookup_key: undefined })!;
      const after = formatPrice(updated);
      ev.emit("price.updated", after, previousAttributes(before, after));
    }

    let product = productId;
    if (newProduct?.product) {
      const inserted = insertProduct(ss, newProduct.product);
      ev.emit("product.created", formatProduct(inserted));
      product = inserted.stripe_id;
    }

    const price = ss.prices.insert({ stripe_id: stripeId("price"), product_id: product!, ...definition });
    ev.emit("price.created", formatPrice(price));
    await ev.commit();

    return expandedJson(c, formatPrice(price), expand, body);
  });

  app.get("/v1/prices/:id", (c) => {
    const price = ss.prices.findOneBy("stripe_id", c.req.param("id"));
    if (!price)
      return stripeError(c, 404, "invalid_request_error", `No such price: '${c.req.param("id")}'`, "resource_missing");
    return expandedJson(c, formatPrice(price), expand);
  });

  app.get("/v1/prices", (c) => {
    const query = parseStripeQuery(c);
    let items = ss.prices.all();

    const productId = typeof query.product === "string" ? query.product : undefined;
    if (productId) items = items.filter((p) => p.product_id === productId);

    const active = readBool(query.active);
    if (active !== undefined) items = items.filter((p) => p.active === active);

    const currency = typeof query.currency === "string" ? query.currency.toLowerCase() : undefined;
    if (currency) items = items.filter((p) => p.currency === currency);

    const type = query.type;
    if (type === "one_time" || type === "recurring") items = items.filter((p) => p.type === type);

    const lookupKeys = readStringList(query.lookup_keys);
    if (lookupKeys.length > MAX_LOOKUP_KEYS) {
      return stripeError(
        c,
        400,
        "invalid_request_error",
        `You may only specify up to ${MAX_LOOKUP_KEYS} lookup_keys.`,
        undefined,
        "lookup_keys",
      );
    }
    if (lookupKeys.length > 0) items = items.filter((p) => p.lookup_key && lookupKeys.includes(p.lookup_key));

    const recurring = query.recurring;
    if (recurring && typeof recurring === "object" && !Array.isArray(recurring)) {
      const filter = recurring as Record<string, unknown>;
      for (const key of ["interval", "usage_type", "meter"] as const) {
        const wanted = filter[key];
        if (typeof wanted === "string" && wanted !== "") {
          items = items.filter((p) => p.recurring?.[key] === wanted);
        }
      }
    }

    return stripeList(c, items, "/v1/prices", formatPrice, { expand });
  });
}
