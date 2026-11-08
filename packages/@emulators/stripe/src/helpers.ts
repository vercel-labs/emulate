import { createHash, randomBytes } from "crypto";
import type { Context } from "@emulators/core";
import type { ContentfulStatusCode } from "@emulators/core";
import type { Entity } from "@emulators/core";

const NUMERIC_KEYS = new Set([
  "amount",
  "unit_amount",
  "quantity",
  "amount_total",
  "amount_subtotal",
  "application_fee_amount",
  "transfer_amount",
]);

/** Keys that would let a bracket path write through to Object.prototype. */
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Random base62 string. Bytes of 248 and above are rejected so every character is equally likely. */
export function randomBase62(length: number): string {
  let out = "";
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte >= 248) continue;
      out += BASE62[byte % 62];
      if (out.length === length) break;
    }
  }
  return out;
}

export function stripeId(prefix: string, length = 24): string {
  return `${prefix}_${randomBase62(length)}`;
}

/** Eight uppercase hex characters, the shape of Stripe's generated invoice prefixes. */
export function generateInvoicePrefix(): string {
  return randomBytes(4).toString("hex").toUpperCase();
}

/** A stable prefix for customers stored without one, such as seeded customers. */
export function derivedInvoicePrefix(customerId: string): string {
  return createHash("sha256").update(customerId).digest("hex").slice(0, 8).toUpperCase();
}

export function toUnixTimestamp(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000);
}

/** Coerce a form or JSON value to a boolean. Anything other than true/false reads as undefined. */
export function readBool(value: unknown): boolean | undefined {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return undefined;
}

/** Read an enum param. Returns an error response for a value outside `allowed`. */
export function readEnum<T extends string>(
  c: Context,
  value: unknown,
  allowed: readonly T[],
  param: string,
): { value?: T; error?: Response } {
  if (value === undefined || value === "") return {};
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return { value: value as T };
  return {
    error: stripeError(
      c,
      400,
      "invalid_request_error",
      `Invalid ${param}: must be one of ${allowed.join(", ")}`,
      undefined,
      param,
    ),
  };
}

/** Coerce a form or JSON value to an integer. Non-integers read as undefined. */
export function readInt(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isInteger(value) ? value : undefined;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return parseInt(value, 10);
  return undefined;
}

/** Coerce a form or JSON value to a finite number. Anything else reads as undefined. */
export function readNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim() !== "") {
    const num = Number(value);
    return Number.isFinite(num) ? num : undefined;
  }
  return undefined;
}

/** An event type pattern. `*` matches any run of characters, as in `customer.*` or `*`. */
export function eventTypeMatcher(pattern: string): (type: string) => boolean {
  if (!pattern.includes("*")) return (type) => type === pattern;
  const regex = new RegExp(`^${pattern.split("*").map(escapeRegex).join(".*")}$`);
  return (type) => regex.test(type);
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Decode Stripe's bracket encoding (`a[b][0]=c`, `a[]=c`) into nested objects and arrays.
 * Shared by form bodies and query strings, since stripe-node encodes both the same way.
 */
export function parseFormParams(params: URLSearchParams): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of params) {
    if (key.includes("[")) {
      const parts = key.replace(/]/g, "").split("[");
      if (parts.some((part) => UNSAFE_KEYS.has(part))) continue;
      let target: Record<string, unknown> | unknown[] = result;
      for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i];
        const nextIsIndex = /^\d*$/.test(parts[i + 1]);
        const current = (target as Record<string, unknown>)[part];
        if (current === undefined || current === null || typeof current !== "object") {
          (target as Record<string, unknown>)[part] = nextIsIndex ? [] : {};
        }
        target = (target as Record<string, unknown>)[part] as Record<string, unknown> | unknown[];
      }
      const lastKey = parts[parts.length - 1];
      const num = Number(value);
      const coerced = NUMERIC_KEYS.has(lastKey) && Number.isFinite(num) ? num : value;
      if (Array.isArray(target)) {
        const idx = lastKey === "" ? target.length : parseInt(lastKey, 10);
        target[idx] = coerced;
      } else {
        (target as Record<string, unknown>)[lastKey] = coerced;
      }
    } else {
      const num = Number(value);
      result[key] = NUMERIC_KEYS.has(key) && Number.isFinite(num) ? num : value;
    }
  }

  return result;
}

/**
 * Parse request body from either JSON or form-urlencoded format.
 * Stripe's SDK sends application/x-www-form-urlencoded by default,
 * but JSON is also common from direct API calls.
 */
export async function parseStripeBody(c: Context): Promise<Record<string, unknown>> {
  const contentType = c.req.header("Content-Type") ?? "";
  const rawText = await c.req.text();

  if (!rawText) return {};

  if (contentType.includes("application/json")) {
    try {
      const parsed = JSON.parse(rawText);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  return parseFormParams(new URLSearchParams(rawText));
}

/** The query string decoded with the same bracket rules as a form body. */
export function parseStripeQuery(c: Context): Record<string, unknown> {
  return parseFormParams(new URL(c.req.url).searchParams);
}

/** Read a list parameter that may arrive as `name[]`, `name[0]` or a single value. */
export function readStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string" && v !== "");
  if (typeof value === "string" && value !== "") return [value];
  return [];
}

/** Optional fields of a Stripe error body. Card errors carry the decline and the objects involved. */
export interface StripeErrorExtras {
  decline_code?: string;
  doc_url?: string;
  payment_intent?: Record<string, unknown>;
  payment_method?: Record<string, unknown>;
  setup_intent?: Record<string, unknown>;
  charge?: string;
}

/**
 * Return a Stripe-format error response.
 * Stripe errors use { error: { type, message, code?, param?, decline_code?, doc_url?, ... } }
 */
export function stripeError(
  c: Context,
  status: number,
  type: "invalid_request_error" | "card_error" | "api_error",
  message: string,
  code?: string,
  param?: string,
  extras: StripeErrorExtras = {},
) {
  return c.json(
    {
      error: {
        type,
        message,
        ...(code && { code }),
        ...(param && { param }),
        ...(extras.decline_code && { decline_code: extras.decline_code }),
        ...(extras.doc_url && { doc_url: extras.doc_url }),
        ...(extras.charge && { charge: extras.charge }),
        ...(extras.payment_intent && { payment_intent: extras.payment_intent }),
        ...(extras.payment_method && { payment_method: extras.payment_method }),
        ...(extras.setup_intent && { setup_intent: extras.setup_intent }),
      },
    },
    status as ContentfulStatusCode,
  );
}

export interface StripeListOptions<T> {
  /** Unix seconds used for `created[...]` filters. Defaults to the entity's created_at. */
  created?: (item: T) => number;
  /** Resolver used for `expand[]=data.*` on the list response. */
  expand?: ExpandResolver;
}

/**
 * Stripe-style cursor-based list pagination.
 * Supports starting_after, ending_before, limit, and created / created[gt|gte|lt|lte] filtering.
 */
export function stripeList<T extends Entity & { stripe_id: string; created_at: string }>(
  c: Context,
  items: T[],
  url: string,
  formatFn: (item: T) => Record<string, unknown>,
  options: StripeListOptions<T> = {},
) {
  const limit = Math.min(parseInt(c.req.query("limit") ?? "10", 10), 100);
  const startingAfter = c.req.query("starting_after");
  const endingBefore = c.req.query("ending_before");
  const createdOf = options.created ?? ((item: T) => toUnixTimestamp(item.created_at));

  let filtered = items;

  const created = parseStripeQuery(c).created;
  if (typeof created === "string") {
    const exact = readInt(created);
    if (exact !== undefined) filtered = filtered.filter((item) => createdOf(item) === exact);
  } else if (created && typeof created === "object") {
    const range = created as Record<string, unknown>;
    const bound = (key: string) => readInt(range[key]);
    const gt = bound("gt");
    const gte = bound("gte");
    const lt = bound("lt");
    const lte = bound("lte");
    filtered = filtered.filter((item) => {
      const t = createdOf(item);
      if (gt !== undefined && !(t > gt)) return false;
      if (gte !== undefined && !(t >= gte)) return false;
      if (lt !== undefined && !(t < lt)) return false;
      if (lte !== undefined && !(t <= lte)) return false;
      return true;
    });
  }

  // Sort newest first (Stripe default)
  filtered.sort((a, b) => b.id - a.id);

  // Cursor-based pagination
  if (startingAfter) {
    const idx = filtered.findIndex((item) => item.stripe_id === startingAfter);
    if (idx !== -1) {
      filtered = filtered.slice(idx + 1);
    }
  } else if (endingBefore) {
    const idx = filtered.findIndex((item) => item.stripe_id === endingBefore);
    if (idx !== -1) {
      filtered = filtered.slice(0, idx);
      filtered = filtered.slice(-limit);
    }
  }

  const page = filtered.slice(0, limit);
  const hasMore = filtered.length > limit;

  const list: Record<string, unknown> = {
    object: "list",
    url,
    has_more: hasMore,
    data: page.map(formatFn),
  };

  if (options.expand) {
    const paths = parseExpand(c);
    const tooDeep = expandDepthError(c, paths);
    if (tooDeep) return tooDeep;
    return c.json(expandPaths(list, paths, options.expand));
  }

  return c.json(list);
}

/**
 * Resolve one expandable field. `value` is the field's current value: an id string for an
 * expandable reference, or undefined for an includable field that is absent by default.
 * Returning undefined leaves the field as it is.
 */
export type ExpandResolver = (parent: Record<string, unknown>, field: string, value: unknown) => unknown;

/** Stripe allows at most four levels of expansion. `data` segments that step into a list do not count. */
export const MAX_EXPAND_DEPTH = 4;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function expandDepth(path: string): number {
  return path.split(".").filter((segment) => segment !== "data").length;
}

function expandPath(node: unknown, segments: string[], resolve: ExpandResolver): unknown {
  if (segments.length === 0) return node;
  if (Array.isArray(node)) return node.map((item) => expandPath(item, segments, resolve));
  if (!isPlainObject(node)) return node;

  const [field, ...rest] = segments;
  if (field === "id" || field === "object") return node;
  const present = Object.hasOwn(node, field);
  const resolved = resolve(node, field, present ? node[field] : undefined);
  if (resolved === undefined && !present) return node;
  const value = resolved === undefined ? node[field] : resolved;
  return { ...node, [field]: expandPath(value, rest, resolve) };
}

/**
 * Apply dotted expand paths (`customer`, `latest_invoice.payment_intent`, `data.customer`,
 * `items.data.price.product`). Paths that do not resolve are ignored.
 */
export function expandPaths(
  obj: Record<string, unknown>,
  paths: string[],
  resolve: ExpandResolver,
): Record<string, unknown> {
  let result = obj;
  for (const path of paths) {
    result = expandPath(result, path.split("."), resolve) as Record<string, unknown>;
  }
  return result;
}

/** The 400 Stripe returns for an expansion deeper than four levels, or undefined when all are fine. */
export function expandDepthError(c: Context, paths: string[]) {
  const tooDeep = paths.find((path) => expandDepth(path) > MAX_EXPAND_DEPTH);
  if (!tooDeep) return undefined;
  return stripeError(
    c,
    400,
    "invalid_request_error",
    `You cannot expand more than ${MAX_EXPAND_DEPTH} levels of a property. Property: ${tooDeep}`,
    undefined,
    "expand",
  );
}

/**
 * Respond with `obj` after applying the request's expand paths, read from the query string
 * and, for POST requests, from the already parsed body.
 */
export function expandedJson(
  c: Context,
  obj: Record<string, unknown>,
  resolve: ExpandResolver,
  body?: Record<string, unknown>,
) {
  const paths = parseExpand(c, body);
  const tooDeep = expandDepthError(c, paths);
  if (tooDeep) return tooDeep;
  return c.json(expandPaths(obj, paths, resolve));
}

/**
 * Apply Stripe's expand[] parameter to embed related objects.
 * Replaces ID strings with full formatted objects, looked up by field name.
 */
export function applyExpand(
  obj: Record<string, unknown>,
  expandPathList: string[],
  resolvers: Partial<Record<string, (id: string) => Record<string, unknown> | undefined>>,
): Record<string, unknown> {
  if (!expandPathList || expandPathList.length === 0) return obj;
  return expandPaths(obj, expandPathList, (_parent, field, value) => {
    const resolver = Object.hasOwn(resolvers, field) ? resolvers[field] : undefined;
    return resolver && typeof value === "string" ? resolver(value) : undefined;
  });
}

/**
 * Parse expand paths from the query (`expand[]`, `expand[0]`, `expand`) and, when given,
 * from a parsed POST body.
 */
export function parseExpand(c: Context, body?: Record<string, unknown>): string[] {
  const paths = [...readStringList(parseStripeQuery(c).expand), ...readStringList(body?.expand)];
  return [...new Set(paths)];
}
