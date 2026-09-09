import type { CategoryDirection, PlCategory, PlProduct } from "../entities.js";
import { formatCategory, formatCategoryGroup, formatProduct } from "../formatters.js";
import {
  api,
  listResponse,
  notFound,
  num,
  parseJsonBody,
  requireInt,
  route,
  str,
  strOrNull,
  unprocessable,
} from "../helpers.js";
import { logEvent, nextId } from "../store.js";
import { parseVatRate, type PlRouteContext } from "../route-utils.js";

const DIRECTIONS: CategoryDirection[] = ["expense", "revenue", "both"];

function parseDirection(value: unknown, fallback: CategoryDirection): CategoryDirection {
  const text = str(value);
  if (text === undefined) return fallback;
  if (!DIRECTIONS.includes(text as CategoryDirection))
    throw unprocessable("Validation failed", [
      { field: "direction", message: `must be one of ${DIRECTIONS.join(", ")}` },
    ]);
  return text as CategoryDirection;
}

export function catalogRoutes(rc: PlRouteContext): void {
  const { app, ps, fmt } = rc;

  const findProduct = (id: string): PlProduct => {
    const product = ps.products.findOneBy("pl_id", requireInt(id, "Product"));
    if (!product) throw notFound("Product not found");
    return product;
  };
  const findCategory = (id: string): PlCategory => {
    const category = ps.categories.findOneBy("pl_id", requireInt(id, "Category"));
    if (!category) throw notFound("Category not found");
    return category;
  };

  route(
    app,
    "get",
    "/products",
    api(ps, (c) =>
      listResponse(c, [...ps.products.all()].sort((a, b) => a.id - b.id).map(formatProduct), {
        filters: {
          id: true,
          label: true,
          reference: true,
          external_reference: { operators: ["eq", "in"] },
          created_at: true,
          updated_at: true,
        },
        sortable: ["id", "label", "created_at", "updated_at"],
      }),
    ),
  );

  route(
    app,
    "post",
    "/products",
    api(ps, async (c) => {
      const body = await parseJsonBody(c);
      const label = str(body.label)?.trim();
      if (!label) throw unprocessable("Validation failed", [{ field: "label", message: "can't be blank" }]);
      const price = num(body.price_before_tax) ?? num(body.price);
      if (price === undefined)
        throw unprocessable("Validation failed", [{ field: "price_before_tax", message: "can't be blank" }]);
      const product = ps.products.insert({
        pl_id: nextId(ps),
        label,
        description: strOrNull(body.description),
        price_before_tax: price,
        vat_rate: parseVatRate(body.vat_rate),
        unit: str(body.unit) ?? "piece",
        currency: str(body.currency) ?? "EUR",
        reference: strOrNull(body.reference),
        external_reference: strOrNull(body.external_reference),
        ledger_account_id: num(body.ledger_account_id) ?? null,
      });
      logEvent(ps, "product.created", String(product.pl_id), { label });
      return c.json(formatProduct(product), 201);
    }),
  );

  route(
    app,
    "get",
    "/products/:id",
    api(ps, (c) => c.json(formatProduct(findProduct(c.req.param("id"))))),
  );

  route(
    app,
    "put",
    "/products/:id",
    api(ps, async (c) => {
      const product = findProduct(c.req.param("id"));
      const body = await parseJsonBody(c);
      const label = body.label !== undefined ? (str(body.label)?.trim() ?? "") : product.label;
      if (!label) throw unprocessable("Validation failed", [{ field: "label", message: "can't be blank" }]);
      const updated = ps.products.update(product.id, {
        label,
        description: body.description !== undefined ? strOrNull(body.description) : product.description,
        price_before_tax: num(body.price_before_tax) ?? num(body.price) ?? product.price_before_tax,
        vat_rate: parseVatRate(body.vat_rate, product.vat_rate),
        unit: str(body.unit) ?? product.unit,
        currency: str(body.currency) ?? product.currency,
        reference: body.reference !== undefined ? strOrNull(body.reference) : product.reference,
        external_reference:
          body.external_reference !== undefined ? strOrNull(body.external_reference) : product.external_reference,
        ledger_account_id: num(body.ledger_account_id) ?? product.ledger_account_id,
      })!;
      return c.json(formatProduct(updated));
    }),
  );

  route(
    app,
    "delete",
    "/products/:id",
    api(ps, (c) => {
      const product = findProduct(c.req.param("id"));
      ps.products.delete(product.id);
      return c.body(null, 204);
    }),
  );

  route(
    app,
    "get",
    "/category_groups",
    api(ps, (c) =>
      listResponse(c, [...ps.categoryGroups.all()].sort((a, b) => a.id - b.id).map(formatCategoryGroup), {
        filters: { id: true, label: true, direction: true, external_reference: true },
        sortable: ["id", "label"],
      }),
    ),
  );

  route(
    app,
    "post",
    "/category_groups",
    api(ps, async (c) => {
      const body = await parseJsonBody(c);
      const label = str(body.label)?.trim();
      if (!label) throw unprocessable("Validation failed", [{ field: "label", message: "can't be blank" }]);
      const group = ps.categoryGroups.insert({
        pl_id: nextId(ps),
        label,
        direction: parseDirection(body.direction, "both"),
        external_reference: strOrNull(body.external_reference),
      });
      return c.json(formatCategoryGroup(group), 201);
    }),
  );

  route(
    app,
    "get",
    "/category_groups/:id",
    api(ps, (c) => {
      const group = ps.categoryGroups.findOneBy("pl_id", requireInt(c.req.param("id"), "Category group"));
      if (!group) throw notFound("Category group not found");
      return c.json(formatCategoryGroup(group));
    }),
  );

  route(
    app,
    "get",
    "/categories",
    api(ps, (c) =>
      listResponse(
        c,
        [...ps.categories.all()]
          .sort((a, b) => a.id - b.id)
          .map((category) => ({ ...formatCategory(fmt, category), category_group_id: category.category_group_id })),
        {
          filters: { id: true, label: true, direction: true, external_reference: true, category_group_id: true },
          sortable: ["id", "label"],
        },
      ),
    ),
  );

  route(
    app,
    "post",
    "/categories",
    api(ps, async (c) => {
      const body = await parseJsonBody(c);
      const label = str(body.label)?.trim();
      if (!label) throw unprocessable("Validation failed", [{ field: "label", message: "can't be blank" }]);
      const groupId =
        num(body.category_group_id) ?? num((body.category_group as Record<string, unknown> | undefined)?.id);
      const group = groupId !== undefined ? ps.categoryGroups.findOneBy("pl_id", groupId) : undefined;
      if (groupId !== undefined && !group)
        throw unprocessable("Validation failed", [{ field: "category_group_id", message: "category group not found" }]);
      const category = ps.categories.insert({
        pl_id: nextId(ps),
        label,
        color: str(body.color) ?? "#1f77b4",
        direction: parseDirection(body.direction, group?.direction ?? "both"),
        external_reference: strOrNull(body.external_reference),
        category_group_id: group?.pl_id ?? null,
      });
      logEvent(ps, "category.created", String(category.pl_id), { label });
      return c.json(formatCategory(fmt, category), 201);
    }),
  );

  route(
    app,
    "get",
    "/categories/:id",
    api(ps, (c) => c.json(formatCategory(fmt, findCategory(c.req.param("id"))))),
  );

  route(
    app,
    "put",
    "/categories/:id",
    api(ps, async (c) => {
      const category = findCategory(c.req.param("id"));
      const body = await parseJsonBody(c);
      const label = body.label !== undefined ? (str(body.label)?.trim() ?? "") : category.label;
      if (!label) throw unprocessable("Validation failed", [{ field: "label", message: "can't be blank" }]);
      const updated = ps.categories.update(category.id, {
        label,
        color: str(body.color) ?? category.color,
        direction: parseDirection(body.direction, category.direction),
        external_reference:
          body.external_reference !== undefined ? strOrNull(body.external_reference) : category.external_reference,
        category_group_id: num(body.category_group_id) ?? category.category_group_id,
      })!;
      return c.json(formatCategory(fmt, updated));
    }),
  );

  route(
    app,
    "delete",
    "/categories/:id",
    api(ps, (c) => {
      const category = findCategory(c.req.param("id"));
      for (const invoice of ps.customerInvoices.all())
        if (invoice.categories.some((entry) => entry.category_id === category.pl_id))
          ps.customerInvoices.update(invoice.id, {
            categories: invoice.categories.filter((entry) => entry.category_id !== category.pl_id),
          });
      for (const transaction of ps.transactions.all())
        if (transaction.categories.some((entry) => entry.category_id === category.pl_id))
          ps.transactions.update(transaction.id, {
            categories: transaction.categories.filter((entry) => entry.category_id !== category.pl_id),
          });
      ps.categories.delete(category.id);
      return c.body(null, 204);
    }),
  );
}
