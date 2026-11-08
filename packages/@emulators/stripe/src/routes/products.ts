import type { RouteContext } from "@emulators/core";
import { getStripeStore, type StripeStore } from "../store.js";
import {
  stripeId,
  parseStripeBody,
  parseStripeQuery,
  stripeError,
  stripeList,
  readBool,
  readStringList,
} from "../helpers.js";
import { formatProduct } from "../formatters.js";
import { eventBatch } from "../events.js";
import type { StripeProduct } from "../entities.js";
import type { PriceParamError } from "../pricing.js";

export type ProductDefinition = Omit<StripeProduct, "id" | "created_at" | "updated_at" | "stripe_id">;

function readText(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Validate product params, from `POST /v1/products` or a price's `product_data`. `prefix`
 * names the enclosing param in errors, as in `product_data[name]`.
 */
export function readProductParams(
  input: unknown,
  prefix?: string,
): { product?: ProductDefinition; error?: PriceParamError } {
  const param = (field: string) => (prefix ? `${prefix}[${field}]` : field);
  const source =
    input !== null && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const name = readText(source.name);
  if (!name) return { error: { message: `Missing required param: ${param("name")}.`, param: param("name") } };

  const product: ProductDefinition = {
    name,
    description: readText(source.description) ?? null,
    active: readBool(source.active) ?? true,
    metadata:
      source.metadata && typeof source.metadata === "object" && !Array.isArray(source.metadata)
        ? Object.fromEntries(Object.entries(source.metadata).map(([k, v]) => [k, String(v)]))
        : {},
  };
  const images = readStringList(source.images);
  if (images.length > 0) product.images = images;
  const shippable = readBool(source.shippable);
  if (shippable !== undefined) product.shippable = shippable;
  for (const field of ["statement_descriptor", "unit_label", "url"] as const) {
    const value = readText(source[field]);
    if (value !== undefined) product[field] = value;
  }
  return { product };
}

export function insertProduct(ss: StripeStore, product: ProductDefinition, id?: string): StripeProduct {
  return ss.products.insert({ stripe_id: id ?? stripeId("prod"), ...product });
}

export function productRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const ss = getStripeStore(store);

  app.post("/v1/products", async (c) => {
    const body = await parseStripeBody(c);
    const parsed = readProductParams(body);
    if (parsed.error) {
      return stripeError(c, 400, "invalid_request_error", parsed.error.message, undefined, parsed.error.param);
    }
    const product = insertProduct(ss, parsed.product!);

    const ev = eventBatch(ctx, c);
    ev.emit("product.created", formatProduct(product));
    await ev.commit();

    return c.json(formatProduct(product), 200);
  });

  app.get("/v1/products/:id", (c) => {
    const product = ss.products.findOneBy("stripe_id", c.req.param("id"));
    if (!product)
      return stripeError(
        c,
        404,
        "invalid_request_error",
        `No such product: '${c.req.param("id")}'`,
        "resource_missing",
      );
    return c.json(formatProduct(product));
  });

  app.get("/v1/products", (c) => {
    let items = ss.products.all();
    const active = readBool(parseStripeQuery(c).active);
    if (active !== undefined) items = items.filter((p) => p.active === active);
    return stripeList(c, items, "/v1/products", formatProduct);
  });
}
