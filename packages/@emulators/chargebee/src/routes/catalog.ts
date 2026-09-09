import type { ChargebeeItem, ChargebeeItemPrice, ItemType, PeriodUnit, PriceTier, PricingModel } from "../entities.js";
import { formatItem, formatItemFamily, formatItemPrice } from "../formatters.js";
import {
  blankParamError,
  bool,
  chargebeeList,
  columnar,
  duplicateError,
  jsonValue,
  num,
  operationNotAllowedError,
  paramError,
  parseChargebeeBody,
  pickCustomFields,
  str,
  strOrNull,
  stringList,
  type Body,
} from "../helpers.js";
import { chargebeeId } from "../ids.js";
import { nowSeconds, resourceVersion } from "../store.js";
import { api, findItem, findItemFamily, findItemPrice, type ChargebeeRouteContext } from "../route-utils.js";

const ITEM_TYPES = new Set<string>(["plan", "addon", "charge"]);
const PRICING_MODELS = new Set<string>(["flat_fee", "per_unit", "tiered", "volume", "stairstep"]);
const PERIOD_UNITS = new Set<string>(["day", "week", "month", "year"]);

function periodLabel(period: number, unit: PeriodUnit): string {
  const base = { day: "Daily", week: "Weekly", month: "Monthly", year: "Yearly" }[unit];
  return period === 1 ? base : `${period}-${base}`;
}

function parseTiers(value: unknown): PriceTier[] {
  return columnar(value)
    .map((row) => ({
      starting_unit: num(row.starting_unit) ?? 1,
      ending_unit: row.ending_unit === undefined || row.ending_unit === "" ? null : (num(row.ending_unit) ?? null),
      price: num(row.price) ?? 0,
    }))
    .sort((a, b) => a.starting_unit - b.starting_unit);
}

function parseItemFields(body: Body, existing?: ChargebeeItem): Partial<ChargebeeItem> {
  const fields: Partial<ChargebeeItem> = {};
  if (body.name !== undefined) fields.name = str(body.name) ?? existing?.name ?? "";
  if (body.external_name !== undefined) fields.external_name = strOrNull(body.external_name);
  if (body.description !== undefined) fields.description = strOrNull(body.description);
  if (body.enabled_for_checkout !== undefined) fields.enabled_for_checkout = bool(body.enabled_for_checkout) ?? true;
  if (body.enabled_in_portal !== undefined) fields.enabled_in_portal = bool(body.enabled_in_portal) ?? true;
  if (body.is_shippable !== undefined) fields.is_shippable = bool(body.is_shippable) ?? false;
  if (body.is_giftable !== undefined) fields.is_giftable = bool(body.is_giftable) ?? false;
  if (body.metered !== undefined) fields.metered = bool(body.metered) ?? false;
  if (body.unit !== undefined) fields.unit = strOrNull(body.unit);
  if (body.item_applicability !== undefined) {
    const value = str(body.item_applicability);
    if (value !== "all" && value !== "restricted") throw paramError("item_applicability", "must be all or restricted");
    fields.item_applicability = value;
  }
  if (body.applicable_items !== undefined) fields.applicable_items = stringList(body.applicable_items);
  if (body.metadata !== undefined) fields.metadata = jsonValue(body.metadata);
  if (body.status !== undefined) {
    const value = str(body.status);
    if (value !== "active" && value !== "archived") throw paramError("status", "must be active or archived");
    fields.status = value;
  }
  const customFields = pickCustomFields(body);
  if (Object.keys(customFields).length > 0)
    fields.custom_fields = { ...(existing?.custom_fields ?? {}), ...customFields };
  return fields;
}

function parseItemPriceFields(body: Body, existing?: ChargebeeItemPrice): Partial<ChargebeeItemPrice> {
  const fields: Partial<ChargebeeItemPrice> = {};
  if (body.name !== undefined) fields.name = str(body.name) ?? existing?.name ?? "";
  if (body.external_name !== undefined) fields.external_name = strOrNull(body.external_name);
  if (body.description !== undefined) fields.description = strOrNull(body.description);
  if (body.pricing_model !== undefined) {
    const value = str(body.pricing_model) ?? "";
    if (!PRICING_MODELS.has(value)) throw paramError("pricing_model", "is not a valid pricing model");
    fields.pricing_model = value as PricingModel;
  }
  if (body.price !== undefined) fields.price = num(body.price) ?? 0;
  if (body.currency_code !== undefined) fields.currency_code = (str(body.currency_code) ?? "USD").toUpperCase();
  if (body.period !== undefined) fields.period = num(body.period) ?? null;
  if (body.period_unit !== undefined) {
    const value = str(body.period_unit) ?? "";
    if (!PERIOD_UNITS.has(value)) throw paramError("period_unit", "is not a valid period unit");
    fields.period_unit = value as PeriodUnit;
  }
  if (body.trial_period !== undefined) fields.trial_period = num(body.trial_period) ?? null;
  if (body.trial_period_unit !== undefined) {
    const value = str(body.trial_period_unit);
    if (value !== "day" && value !== "month") throw paramError("trial_period_unit", "must be day or month");
    fields.trial_period_unit = value;
  }
  if (body.free_quantity !== undefined) fields.free_quantity = num(body.free_quantity) ?? 0;
  if (body.tiers !== undefined) fields.tiers = parseTiers(body.tiers);
  if (body.is_taxable !== undefined) fields.is_taxable = bool(body.is_taxable) ?? true;
  if (body.invoice_notes !== undefined) fields.invoice_notes = strOrNull(body.invoice_notes);
  if (body.show_description_in_invoices !== undefined) {
    fields.show_description_in_invoices = bool(body.show_description_in_invoices) ?? false;
  }
  if (body.show_description_in_quotes !== undefined) {
    fields.show_description_in_quotes = bool(body.show_description_in_quotes) ?? false;
  }
  if (body.metadata !== undefined) fields.metadata = jsonValue(body.metadata);
  if (body.status !== undefined) {
    const value = str(body.status);
    if (value !== "active" && value !== "archived") throw paramError("status", "must be active or archived");
    fields.status = value;
  }
  const customFields = pickCustomFields(body);
  if (Object.keys(customFields).length > 0)
    fields.custom_fields = { ...(existing?.custom_fields ?? {}), ...customFields };
  return fields;
}

export function catalogRoutes(rc: ChargebeeRouteContext): void {
  const { app, cs, ctx } = rc;

  app.post(
    "/api/v2/item_families",
    api(cs, async (c) => {
      const body = await parseChargebeeBody(c);
      const name = str(body.name);
      if (!name) throw blankParamError("name");
      const id =
        str(body.id) ??
        name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "");
      if (!id) throw blankParamError("id");
      if (cs.itemFamilies.findOneBy("cb_id", id)) throw duplicateError("id", id);
      const family = cs.itemFamilies.insert({
        cb_id: id,
        name,
        description: strOrNull(body.description),
        status: "active",
        resource_version: resourceVersion(cs),
      });
      await ctx.emit("item_family_created", { item_family: formatItemFamily(family) });
      return c.json({ item_family: formatItemFamily(family) });
    }),
  );

  app.get(
    "/api/v2/item_families",
    api(cs, (c) =>
      chargebeeList(
        c,
        cs.itemFamilies.all().filter((family) => family.status !== "deleted"),
        "item_family",
        (family) => ({ item_family: formatItemFamily(family) }),
      ),
    ),
  );

  app.get(
    "/api/v2/item_families/:id",
    api(cs, (c) => c.json({ item_family: formatItemFamily(findItemFamily(cs, c.req.param("id"))) })),
  );

  app.post(
    "/api/v2/item_families/:id",
    api(cs, async (c) => {
      const family = findItemFamily(cs, c.req.param("id"));
      const body = await parseChargebeeBody(c);
      const updated = cs.itemFamilies.update(family.id, {
        name: str(body.name) ?? family.name,
        description: body.description !== undefined ? strOrNull(body.description) : family.description,
        resource_version: resourceVersion(cs),
      })!;
      await ctx.emit("item_family_updated", { item_family: formatItemFamily(updated) });
      return c.json({ item_family: formatItemFamily(updated) });
    }),
  );

  app.post(
    "/api/v2/item_families/:id/delete",
    api(cs, async (c) => {
      const family = findItemFamily(cs, c.req.param("id"));
      if (cs.items.findBy("item_family_id", family.cb_id).some((item) => item.status !== "deleted")) {
        throw operationNotAllowedError("Item family has items and cannot be deleted");
      }
      const deleted = cs.itemFamilies.update(family.id, { status: "deleted", resource_version: resourceVersion(cs) })!;
      cs.itemFamilies.delete(family.id);
      await ctx.emit("item_family_deleted", { item_family: formatItemFamily(deleted) });
      return c.json({ item_family: formatItemFamily(deleted) });
    }),
  );

  app.post(
    "/api/v2/items",
    api(cs, async (c) => {
      const body = await parseChargebeeBody(c);
      const name = str(body.name);
      if (!name) throw blankParamError("name");
      const type = str(body.type) ?? "";
      if (!ITEM_TYPES.has(type)) throw paramError("type", "must be plan, addon or charge");
      const familyId = str(body.item_family_id);
      if (!familyId) throw blankParamError("item_family_id");
      const family = cs.itemFamilies.findOneBy("cb_id", familyId);
      if (!family || family.status === "deleted") {
        throw paramError("item_family_id", `${familyId} is not a valid item family id`, "resource_not_found");
      }
      const id =
        str(body.id) ??
        name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "");
      if (!id) throw blankParamError("id");
      if (cs.items.findOneBy("cb_id", id)) throw duplicateError("id", id);
      const fields = parseItemFields(body);
      const item = cs.items.insert({
        cb_id: id,
        name,
        external_name: null,
        description: null,
        type: type as ItemType,
        item_family_id: family.cb_id,
        status: "active",
        enabled_for_checkout: true,
        enabled_in_portal: true,
        item_applicability: "all",
        applicable_items: [],
        metered: false,
        unit: null,
        is_shippable: false,
        is_giftable: false,
        metadata: null,
        custom_fields: {},
        archived_at: null,
        resource_version: resourceVersion(cs),
        ...fields,
      });
      await ctx.emit("item_created", { item: formatItem(item) });
      return c.json({ item: formatItem(item) });
    }),
  );

  app.get(
    "/api/v2/items",
    api(cs, (c) =>
      chargebeeList(
        c,
        cs.items.all().filter((item) => item.status !== "deleted"),
        "item",
        (item) => ({ item: formatItem(item) }),
      ),
    ),
  );

  app.get(
    "/api/v2/items/:id",
    api(cs, (c) => c.json({ item: formatItem(findItem(cs, c.req.param("id"))) })),
  );

  app.post(
    "/api/v2/items/:id",
    api(cs, async (c) => {
      const item = findItem(cs, c.req.param("id"));
      const body = await parseChargebeeBody(c);
      const fields = parseItemFields(body, item);
      if (body.item_family_id !== undefined) {
        const familyId = str(body.item_family_id) ?? "";
        if (!cs.itemFamilies.findOneBy("cb_id", familyId)) {
          throw paramError("item_family_id", `${familyId} is not a valid item family id`, "resource_not_found");
        }
        fields.item_family_id = familyId;
      }
      if (fields.status === "archived" && item.status !== "archived") fields.archived_at = nowSeconds(cs);
      if (fields.status === "active") fields.archived_at = null;
      const updated = cs.items.update(item.id, { ...fields, resource_version: resourceVersion(cs) })!;
      await ctx.emit("item_updated", { item: formatItem(updated) });
      return c.json({ item: formatItem(updated) });
    }),
  );

  app.post(
    "/api/v2/items/:id/delete",
    api(cs, async (c) => {
      const item = findItem(cs, c.req.param("id"));
      if (cs.itemPrices.findBy("item_id", item.cb_id).some((price) => price.status !== "deleted")) {
        throw operationNotAllowedError("Item has item prices and cannot be deleted");
      }
      const deleted = cs.items.update(item.id, { status: "deleted", resource_version: resourceVersion(cs) })!;
      cs.items.delete(item.id);
      await ctx.emit("item_deleted", { item: formatItem(deleted) });
      return c.json({ item: formatItem(deleted) });
    }),
  );

  app.post(
    "/api/v2/item_prices",
    api(cs, async (c) => {
      const body = await parseChargebeeBody(c);
      const itemId = str(body.item_id);
      if (!itemId) throw blankParamError("item_id");
      const item = cs.items.findOneBy("cb_id", itemId);
      if (!item || item.status === "deleted")
        throw paramError("item_id", `${itemId} is not a valid item id`, "resource_not_found");
      const fields = parseItemPriceFields(body);
      const pricingModel = fields.pricing_model ?? "flat_fee";
      const currency = fields.currency_code ?? "USD";
      const period = item.type === "charge" ? null : (fields.period ?? 1);
      const periodUnit = item.type === "charge" ? null : (fields.period_unit ?? "month");
      if (
        item.type !== "charge" &&
        body.period_unit === undefined &&
        body.period === undefined &&
        fields.pricing_model === undefined
      ) {
        if (body.price === undefined && body.tiers === undefined) throw blankParamError("price");
      }
      if ((pricingModel === "flat_fee" || pricingModel === "per_unit") && fields.price === undefined) {
        throw blankParamError("price");
      }
      if (pricingModel !== "flat_fee" && pricingModel !== "per_unit" && (fields.tiers ?? []).length === 0) {
        throw blankParamError("tiers[starting_unit][0]");
      }
      const suffix =
        period !== null && periodUnit !== null ? `${currency}-${periodLabel(period, periodUnit)}` : currency;
      let id = str(body.id) ?? `${item.cb_id}-${suffix}`;
      if (str(body.id) === undefined) {
        let counter = 2;
        const base = id;
        while (cs.itemPrices.findOneBy("cb_id", id)) id = `${base}-${counter++}`;
      } else if (cs.itemPrices.findOneBy("cb_id", id)) {
        throw duplicateError("id", id);
      }
      const name = str(body.name) ?? `${item.name} ${suffix}`;
      const itemPrice = cs.itemPrices.insert({
        cb_id: id,
        name,
        external_name: null,
        description: null,
        item_id: item.cb_id,
        item_family_id: item.item_family_id,
        item_type: item.type,
        status: "active",
        price: fields.price ?? null,
        trial_period: null,
        trial_period_unit: null,
        free_quantity: 0,
        tiers: [],
        is_taxable: true,
        show_description_in_invoices: false,
        show_description_in_quotes: false,
        invoice_notes: null,
        metadata: null,
        custom_fields: {},
        archived_at: null,
        resource_version: resourceVersion(cs),
        ...fields,
        pricing_model: pricingModel,
        currency_code: currency,
        period,
        period_unit: periodUnit,
      });
      await ctx.emit("item_price_created", { item_price: formatItemPrice(itemPrice) });
      return c.json({ item_price: formatItemPrice(itemPrice) });
    }),
  );

  app.get(
    "/api/v2/item_prices",
    api(cs, (c) =>
      chargebeeList(
        c,
        cs.itemPrices.all().filter((price) => price.status !== "deleted"),
        "item_price",
        (price) => ({ item_price: formatItemPrice(price) }),
      ),
    ),
  );

  app.get(
    "/api/v2/item_prices/:id",
    api(cs, (c) => c.json({ item_price: formatItemPrice(findItemPrice(cs, c.req.param("id"))) })),
  );

  app.post(
    "/api/v2/item_prices/:id",
    api(cs, async (c) => {
      const price = findItemPrice(cs, c.req.param("id"));
      const body = await parseChargebeeBody(c);
      const fields = parseItemPriceFields(body, price);
      if (fields.status === "archived" && price.status !== "archived") fields.archived_at = nowSeconds(cs);
      if (fields.status === "active") fields.archived_at = null;
      const updated = cs.itemPrices.update(price.id, { ...fields, resource_version: resourceVersion(cs) })!;
      await ctx.emit("item_price_updated", { item_price: formatItemPrice(updated) });
      return c.json({ item_price: formatItemPrice(updated) });
    }),
  );

  app.post(
    "/api/v2/item_prices/:id/delete",
    api(cs, async (c) => {
      const price = findItemPrice(cs, c.req.param("id"));
      const inUse = cs.subscriptions
        .all()
        .some((sub) => sub.subscription_items.some((item) => item.item_price_id === price.cb_id));
      if (inUse) {
        const archived = cs.itemPrices.update(price.id, {
          status: "archived",
          archived_at: nowSeconds(cs),
          resource_version: resourceVersion(cs),
        })!;
        await ctx.emit("item_price_updated", { item_price: formatItemPrice(archived) });
        return c.json({ item_price: formatItemPrice(archived) });
      }
      const deleted = cs.itemPrices.update(price.id, { status: "deleted", resource_version: resourceVersion(cs) })!;
      cs.itemPrices.delete(price.id);
      await ctx.emit("item_price_deleted", { item_price: formatItemPrice(deleted) });
      return c.json({ item_price: formatItemPrice(deleted) });
    }),
  );

  app.get(
    "/api/v2/item_prices/:id/applicable_items",
    api(cs, (c) => {
      const price = findItemPrice(cs, c.req.param("id"));
      const plan = cs.items.findOneBy("cb_id", price.item_id);
      const items = cs.items.all().filter((item) => {
        if (item.status !== "active" || item.type === "plan") return false;
        if (plan?.item_applicability === "restricted") return plan.applicable_items.includes(item.cb_id);
        return true;
      });
      return chargebeeList(c, items, "item", (item) => ({ item: formatItem(item) }));
    }),
  );

  app.get(
    "/api/v2/item_prices/:id/applicable_item_prices",
    api(cs, (c) => {
      const price = findItemPrice(cs, c.req.param("id"));
      const plan = cs.items.findOneBy("cb_id", price.item_id);
      const prices = cs.itemPrices.all().filter((candidate) => {
        if (candidate.status !== "active" || candidate.item_type === "plan") return false;
        if (candidate.currency_code !== price.currency_code) return false;
        if (plan?.item_applicability === "restricted" && !plan.applicable_items.includes(candidate.item_id))
          return false;
        if (candidate.item_type === "charge") return true;
        return candidate.period === price.period && candidate.period_unit === price.period_unit;
      });
      return chargebeeList(c, prices, "item_price", (candidate) => ({ item_price: formatItemPrice(candidate) }));
    }),
  );
}

export function defaultItemPriceId(
  itemId: string,
  currency: string,
  period: number | null,
  unit: PeriodUnit | null,
): string {
  if (period === null || unit === null) return `${itemId}-${currency}`;
  return `${itemId}-${currency}-${periodLabel(period, unit)}`;
}

export const generateCatalogId = chargebeeId;
