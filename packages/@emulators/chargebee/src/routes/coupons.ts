import type { ChargebeeCoupon, CouponItemConstraint, ItemType } from "../entities.js";
import { formatCoupon } from "../formatters.js";
import {
  blankParamError,
  chargebeeList,
  columnar,
  duplicateError,
  jsonValue,
  num,
  paramError,
  parseChargebeeBody,
  str,
  strOrNull,
  stringList,
  type Body,
} from "../helpers.js";
import { chargebeeId } from "../ids.js";
import { nowSeconds, resourceVersion } from "../store.js";
import { api, findCoupon, type ChargebeeRouteContext } from "../route-utils.js";

function parseConstraints(value: unknown): CouponItemConstraint[] {
  return columnar(value)
    .filter((row) => row.item_type && row.constraint)
    .map((row) => ({
      item_type: row.item_type as ItemType,
      constraint: row.constraint as CouponItemConstraint["constraint"],
      item_price_ids: stringList(row.item_price_ids),
    }));
}

function parseCouponFields(body: Body, existing?: ChargebeeCoupon): Partial<ChargebeeCoupon> {
  const fields: Partial<ChargebeeCoupon> = {};
  if (body.name !== undefined) fields.name = str(body.name) ?? existing?.name ?? "";
  if (body.invoice_name !== undefined) fields.invoice_name = strOrNull(body.invoice_name);
  if (body.discount_type !== undefined) {
    const value = str(body.discount_type);
    if (value !== "fixed_amount" && value !== "percentage")
      throw paramError("discount_type", "must be fixed_amount or percentage");
    fields.discount_type = value;
  }
  if (body.discount_amount !== undefined) fields.discount_amount = num(body.discount_amount) ?? null;
  if (body.discount_percentage !== undefined) fields.discount_percentage = num(body.discount_percentage) ?? null;
  if (body.currency_code !== undefined) fields.currency_code = strOrNull(body.currency_code)?.toUpperCase() ?? null;
  if (body.duration_type !== undefined) {
    const value = str(body.duration_type);
    if (value !== "one_time" && value !== "forever" && value !== "limited_period") {
      throw paramError("duration_type", "must be one_time, forever or limited_period");
    }
    fields.duration_type = value;
  }
  if (body.duration_month !== undefined) fields.duration_month = num(body.duration_month) ?? null;
  if (body.valid_till !== undefined) fields.valid_till = num(body.valid_till) ?? null;
  if (body.max_redemptions !== undefined) fields.max_redemptions = num(body.max_redemptions) ?? null;
  if (body.apply_on !== undefined) {
    const value = str(body.apply_on);
    if (value !== "invoice_amount" && value !== "each_specified_item") {
      throw paramError("apply_on", "must be invoice_amount or each_specified_item");
    }
    fields.apply_on = value;
  }
  if (body.item_constraints !== undefined) fields.item_constraints = parseConstraints(body.item_constraints);
  if (body.meta_data !== undefined) fields.meta_data = jsonValue(body.meta_data);
  if (body.status !== undefined) {
    const value = str(body.status);
    if (value !== "active" && value !== "archived") throw paramError("status", "must be active or archived");
    fields.status = value;
  }
  return fields;
}

export function couponRoutes(rc: ChargebeeRouteContext): void {
  const { app, cs, ctx } = rc;

  const create = api(cs, async (c) => {
    const body = await parseChargebeeBody(c);
    const fields = parseCouponFields(body);
    if (!fields.name) throw blankParamError("name");
    if (!fields.discount_type) throw blankParamError("discount_type");
    if (fields.discount_type === "percentage" && fields.discount_percentage === undefined)
      throw blankParamError("discount_percentage");
    if (fields.discount_type === "fixed_amount" && fields.discount_amount === undefined)
      throw blankParamError("discount_amount");
    if (fields.duration_type === "limited_period" && !fields.duration_month) throw blankParamError("duration_month");
    const id = str(body.id) ?? chargebeeId();
    if (cs.coupons.findOneBy("cb_id", id)) throw duplicateError("id", id);
    const coupon = cs.coupons.insert({
      cb_id: id,
      name: fields.name,
      invoice_name: null,
      discount_type: fields.discount_type,
      discount_amount: null,
      discount_percentage: null,
      currency_code: null,
      duration_type: "forever",
      duration_month: null,
      valid_till: null,
      max_redemptions: null,
      status: "active",
      apply_on: "invoice_amount",
      item_constraints: [],
      redemptions: 0,
      meta_data: null,
      archived_at: null,
      resource_version: resourceVersion(cs),
      ...fields,
    });
    await ctx.emit("coupon_created", { coupon: formatCoupon(coupon) });
    return c.json({ coupon: formatCoupon(coupon) });
  });

  app.post("/api/v2/coupons/create_for_items", create);
  app.post("/api/v2/coupons", create);

  app.get(
    "/api/v2/coupons",
    api(cs, (c) =>
      chargebeeList(
        c,
        cs.coupons.all().filter((coupon) => coupon.status !== "deleted"),
        "coupon",
        (coupon) => ({ coupon: formatCoupon(coupon) }),
      ),
    ),
  );

  app.get(
    "/api/v2/coupons/:id",
    api(cs, (c) => c.json({ coupon: formatCoupon(findCoupon(cs, c.req.param("id"))) })),
  );

  const update = api(cs, async (c) => {
    const coupon = findCoupon(cs, c.req.param("id"));
    const body = await parseChargebeeBody(c);
    const fields = parseCouponFields(body, coupon);
    if (fields.status === "archived" && coupon.status !== "archived") fields.archived_at = nowSeconds(cs);
    if (fields.status === "active") fields.archived_at = null;
    const updated = cs.coupons.update(coupon.id, { ...fields, resource_version: resourceVersion(cs) })!;
    await ctx.emit("coupon_updated", { coupon: formatCoupon(updated) });
    return c.json({ coupon: formatCoupon(updated) });
  });

  app.post("/api/v2/coupons/:id/update_for_items", update);
  app.post("/api/v2/coupons/:id", update);

  app.post(
    "/api/v2/coupons/:id/delete",
    api(cs, async (c) => {
      const coupon = findCoupon(cs, c.req.param("id"));
      const deleted = cs.coupons.update(coupon.id, { status: "deleted", resource_version: resourceVersion(cs) })!;
      cs.coupons.delete(coupon.id);
      await ctx.emit("coupon_deleted", { coupon: formatCoupon(deleted) });
      return c.json({ coupon: formatCoupon(deleted) });
    }),
  );

  app.post(
    "/api/v2/coupons/:id/unarchive",
    api(cs, async (c) => {
      const coupon = findCoupon(cs, c.req.param("id"));
      const updated = cs.coupons.update(coupon.id, {
        status: "active",
        archived_at: null,
        resource_version: resourceVersion(cs),
      })!;
      await ctx.emit("coupon_updated", { coupon: formatCoupon(updated) });
      return c.json({ coupon: formatCoupon(updated) });
    }),
  );
}
