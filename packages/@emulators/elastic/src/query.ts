import { esBadRequest, readPath, type Json } from "./helpers.js";

type Doc = Json;

function values(doc: Doc, field: string): unknown[] {
  const value = readPath(doc, field);
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function toComparable(value: unknown): number | string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) {
    const parsed = Date.parse(text);
    if (!Number.isNaN(parsed)) return parsed;
  }
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  return text.toLowerCase();
}

function resolveDateMath(value: unknown): unknown {
  if (typeof value !== "string" || !value.startsWith("now")) return value;
  const match = value.match(/^now(?:([+-])(\d+)([smhdwMy]))?(?:\/([smhdwMy]))?$/);
  if (!match) return value;
  let time = Date.now();
  if (match[1]) {
    const amount = Number(match[2]) * (match[1] === "-" ? -1 : 1);
    const unit: Record<string, number> = {
      s: 1000,
      m: 60000,
      h: 3600000,
      d: 86400000,
      w: 604800000,
      M: 2629800000,
      y: 31557600000,
    };
    time += amount * unit[match[3]];
  }
  if (match[4] === "d") time = Math.floor(time / 86400000) * 86400000;
  return new Date(time).toISOString();
}

function wildcardToRegex(pattern: string, caseInsensitive = true): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, caseInsensitive ? "i" : "");
}

export function matchesQuery(doc: Doc, query: Json | undefined): boolean {
  if (!query || Object.keys(query).length === 0) return true;
  const entries = Object.entries(query);
  if (entries.length !== 1) throw esBadRequest("[bool] malformed query, expected a single query clause");
  const [kind, raw] = entries[0];
  const clause = (raw ?? {}) as Json;
  switch (kind) {
    case "match_all":
      return true;
    case "match_none":
      return false;
    case "bool": {
      const list = (value: unknown): Json[] =>
        Array.isArray(value) ? (value as Json[]) : value ? [value as Json] : [];
      if (!list(clause.filter).every((sub) => matchesQuery(doc, sub))) return false;
      if (!list(clause.must).every((sub) => matchesQuery(doc, sub))) return false;
      if (list(clause.must_not).some((sub) => matchesQuery(doc, sub))) return false;
      const should = list(clause.should);
      const minimum = Number(
        clause.minimum_should_match ??
          (should.length > 0 && list(clause.filter).length === 0 && list(clause.must).length === 0 ? 1 : 0),
      );
      if (should.length > 0 && minimum > 0) return should.filter((sub) => matchesQuery(doc, sub)).length >= minimum;
      return true;
    }
    case "term": {
      const [field, spec] = Object.entries(clause)[0] ?? [];
      if (!field) return false;
      const wanted = spec && typeof spec === "object" && !Array.isArray(spec) ? (spec as Json).value : spec;
      const target = toComparable(wanted);
      return values(doc, field).some((value) => toComparable(value) === target);
    }
    case "terms": {
      const [field, spec] = Object.entries(clause).find(([key]) => key !== "boost") ?? [];
      if (!field) return false;
      const wanted = (Array.isArray(spec) ? spec : [spec]).map(toComparable);
      return values(doc, field).some((value) => wanted.includes(toComparable(value)));
    }
    case "exists":
      return values(doc, String(clause.field ?? "")).length > 0;
    case "range": {
      const [field, spec] = Object.entries(clause)[0] ?? [];
      if (!field) return false;
      const bounds = (spec ?? {}) as Json;
      return values(doc, field).some((raw) => {
        const value = toComparable(raw);
        if (value === null) return false;
        const check = (key: string, test: (a: number | string, b: number | string) => boolean) => {
          if (bounds[key] === undefined) return true;
          const bound = toComparable(resolveDateMath(bounds[key]));
          return bound === null ? true : test(value, bound);
        };
        return (
          check("gte", (a, b) => a >= b) &&
          check("gt", (a, b) => a > b) &&
          check("lte", (a, b) => a <= b) &&
          check("lt", (a, b) => a < b)
        );
      });
    }
    case "wildcard": {
      const [field, spec] = Object.entries(clause)[0] ?? [];
      if (!field) return false;
      const pattern =
        spec && typeof spec === "object"
          ? String((spec as Json).value ?? (spec as Json).wildcard ?? "")
          : String(spec ?? "");
      const regex = wildcardToRegex(
        pattern,
        spec && typeof spec === "object" ? (spec as Json).case_insensitive !== false : true,
      );
      return values(doc, field).some((value) => regex.test(String(value)));
    }
    case "prefix": {
      const [field, spec] = Object.entries(clause)[0] ?? [];
      if (!field) return false;
      const prefix = String(spec && typeof spec === "object" ? (spec as Json).value : spec).toLowerCase();
      return values(doc, field).some((value) => String(value).toLowerCase().startsWith(prefix));
    }
    case "match":
    case "match_phrase": {
      const [field, spec] = Object.entries(clause)[0] ?? [];
      if (!field) return false;
      const text = String(spec && typeof spec === "object" ? (spec as Json).query : spec).toLowerCase();
      const tokens = kind === "match" ? text.split(/\s+/).filter(Boolean) : [text];
      return values(doc, field).some((value) => {
        const haystack = String(value).toLowerCase();
        return kind === "match" ? tokens.some((tokenText) => haystack.includes(tokenText)) : haystack.includes(text);
      });
    }
    case "multi_match": {
      const text = String(clause.query ?? "").toLowerCase();
      const fields =
        Array.isArray(clause.fields) && clause.fields.length > 0
          ? (clause.fields as string[]).map((field) => field.replace(/\^\d+$/, ""))
          : Object.keys(doc);
      return fields.some((field) => values(doc, field).some((value) => String(value).toLowerCase().includes(text)));
    }
    case "query_string":
    case "simple_query_string": {
      const text = String(clause.query ?? "")
        .toLowerCase()
        .replace(/"/g, "");
      const fieldMatch = text.match(/^([a-z0-9_.@-]+):(.+)$/);
      if (fieldMatch)
        return values(doc, fieldMatch[1]).some((value) => String(value).toLowerCase().includes(fieldMatch[2].trim()));
      return JSON.stringify(doc).toLowerCase().includes(text);
    }
    case "ids": {
      const ids = Array.isArray(clause.values) ? clause.values.map(String) : [];
      return ids.includes(String(doc._id ?? ""));
    }
    case "nested":
      return matchesQuery(doc, clause.query as Json);
    case "constant_score":
      return matchesQuery(doc, clause.filter as Json);
    default:
      throw esBadRequest(`unknown query [${kind}]`);
  }
}

function bucketKey(value: unknown): string | number {
  return typeof value === "number" ? value : String(value);
}

export function runAggregations(docs: Doc[], aggs: Json | undefined): Json {
  if (!aggs) return {};
  const result: Json = {};
  for (const [name, rawSpec] of Object.entries(aggs)) {
    const spec = (rawSpec ?? {}) as Json;
    const subAggs = (spec.aggs ?? spec.aggregations) as Json | undefined;
    if (spec.terms) {
      const terms = spec.terms as Json;
      const field = String(terms.field ?? "");
      const size = Number(terms.size ?? 10);
      const missing = terms.missing;
      const counts = new Map<string | number, { key: string | number; docs: Doc[] }>();
      for (const doc of docs) {
        const found = values(doc, field);
        const keys = found.length > 0 ? found : missing !== undefined ? [missing] : [];
        for (const key of keys) {
          const normalized = bucketKey(key);
          if (!counts.has(normalized)) counts.set(normalized, { key: normalized, docs: [] });
          counts.get(normalized)!.docs.push(doc);
        }
      }
      const order = (terms.order ?? { _count: "desc" }) as Json;
      const [orderKey, orderDirection] = Object.entries(order)[0] ?? ["_count", "desc"];
      const buckets = [...counts.values()].sort((a, b) => {
        let compare = 0;
        if (orderKey === "_key") compare = String(a.key).localeCompare(String(b.key));
        else compare = a.docs.length - b.docs.length;
        if (compare === 0) compare = String(a.key).localeCompare(String(b.key));
        return orderDirection === "asc" ? compare : -compare;
      });
      const kept = buckets.slice(0, size);
      result[name] = {
        doc_count_error_upper_bound: 0,
        sum_other_doc_count: buckets.slice(size).reduce((sum, bucket) => sum + bucket.docs.length, 0),
        buckets: kept.map((bucket) => ({
          key: bucket.key,
          doc_count: bucket.docs.length,
          ...runAggregations(bucket.docs, subAggs),
        })),
      };
      continue;
    }
    if (spec.missing) {
      const field = String((spec.missing as Json).field ?? "");
      const matched = docs.filter((doc) => values(doc, field).length === 0);
      result[name] = { doc_count: matched.length, ...runAggregations(matched, subAggs) };
      continue;
    }
    if (spec.filter) {
      const matched = docs.filter((doc) => matchesQuery(doc, spec.filter as Json));
      result[name] = { doc_count: matched.length, ...runAggregations(matched, subAggs) };
      continue;
    }
    if (spec.filters) {
      const filters = ((spec.filters as Json).filters ?? {}) as Json;
      const buckets: Json = {};
      for (const [bucketName, filter] of Object.entries(filters)) {
        const matched = docs.filter((doc) => matchesQuery(doc, filter as Json));
        buckets[bucketName] = { doc_count: matched.length, ...runAggregations(matched, subAggs) };
      }
      result[name] = { buckets };
      continue;
    }
    if (spec.cardinality) {
      const field = String((spec.cardinality as Json).field ?? "");
      const unique = new Set<string>();
      for (const doc of docs) for (const value of values(doc, field)) unique.add(String(value).toLowerCase());
      result[name] = { value: unique.size };
      continue;
    }
    if (spec.value_count) {
      const field = String((spec.value_count as Json).field ?? "");
      result[name] = { value: docs.reduce((sum, doc) => sum + values(doc, field).length, 0) };
      continue;
    }
    const metric = ["sum", "avg", "min", "max"].find((candidate) => spec[candidate]);
    if (metric) {
      const field = String((spec[metric] as Json).field ?? "");
      const numbers = docs.flatMap((doc) => values(doc, field).map(Number)).filter(Number.isFinite);
      const value =
        numbers.length === 0
          ? null
          : metric === "sum"
            ? numbers.reduce((sum, item) => sum + item, 0)
            : metric === "avg"
              ? numbers.reduce((sum, item) => sum + item, 0) / numbers.length
              : metric === "min"
                ? Math.min(...numbers)
                : Math.max(...numbers);
      result[name] = { value };
      continue;
    }
    if (spec.date_histogram) {
      const histogram = spec.date_histogram as Json;
      const field = String(histogram.field ?? "@timestamp");
      const interval = String(histogram.calendar_interval ?? histogram.fixed_interval ?? "1d");
      const millis = interval.endsWith("h")
        ? Number(interval.slice(0, -1)) * 3600000
        : interval.endsWith("m")
          ? Number(interval.slice(0, -1)) * 60000
          : interval === "1w" || interval === "week"
            ? 604800000
            : 86400000;
      const buckets = new Map<number, Doc[]>();
      for (const doc of docs)
        for (const value of values(doc, field)) {
          const time = Date.parse(String(value));
          if (Number.isNaN(time)) continue;
          const key = Math.floor(time / millis) * millis;
          if (!buckets.has(key)) buckets.set(key, []);
          buckets.get(key)!.push(doc);
        }
      result[name] = {
        buckets: [...buckets.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([key, bucketDocs]) => ({
            key,
            key_as_string: new Date(key).toISOString(),
            doc_count: bucketDocs.length,
            ...runAggregations(bucketDocs, subAggs),
          })),
      };
      continue;
    }
    if (spec.top_hits) {
      const size = Number((spec.top_hits as Json).size ?? 3);
      result[name] = {
        hits: {
          total: { value: docs.length, relation: "eq" },
          max_score: null,
          hits: docs
            .slice(0, size)
            .map((doc) => ({ _index: doc._index, _id: doc._id, _score: null, _source: doc._source ?? doc })),
        },
      };
      continue;
    }
    throw esBadRequest(`Unknown aggregation type in [${name}]`, "aggregation_execution_exception");
  }
  return result;
}

export function sortDocs(docs: Doc[], sort: unknown): Doc[] {
  if (!sort) return docs;
  const clauses = (Array.isArray(sort) ? sort : [sort]).flatMap((entry) => {
    if (typeof entry === "string") return [{ field: entry, order: "asc" }];
    return Object.entries(entry as Json).map(([field, spec]) => ({
      field,
      order: typeof spec === "string" ? spec : String((spec as Json)?.order ?? "asc"),
    }));
  });
  return [...docs].sort((a, b) => {
    for (const clause of clauses) {
      const left = toComparable(clause.field === "_doc" ? a._sequence : values(a, clause.field)[0]);
      const right = toComparable(clause.field === "_doc" ? b._sequence : values(b, clause.field)[0]);
      if (left === right) continue;
      if (left === null) return 1;
      if (right === null) return -1;
      const compare = left < right ? -1 : 1;
      return clause.order === "desc" ? -compare : compare;
    }
    return 0;
  });
}

export function projectSource(source: Json, spec: unknown): Json | false {
  if (spec === false) return false;
  if (spec === undefined || spec === true) return source;
  const includes = Array.isArray(spec)
    ? spec.map(String)
    : typeof spec === "string"
      ? [spec]
      : Array.isArray((spec as Json).includes)
        ? ((spec as Json).includes as string[])
        : undefined;
  const excludes =
    spec && typeof spec === "object" && Array.isArray((spec as Json).excludes)
      ? ((spec as Json).excludes as string[])
      : [];
  let result: Json = source;
  if (includes) {
    result = {};
    for (const field of includes) {
      const value = readPath(source, field);
      if (value !== undefined) setPath(result, field, value);
    }
  }
  if (excludes.length > 0) {
    result = JSON.parse(JSON.stringify(result));
    for (const field of excludes) deletePath(result, field);
  }
  return result;
}

function setPath(target: Json, path: string, value: unknown): void {
  const parts = path.split(".");
  let current = target;
  for (const part of parts.slice(0, -1)) {
    if (!current[part] || typeof current[part] !== "object") current[part] = {};
    current = current[part] as Json;
  }
  current[parts[parts.length - 1]] = value;
}

function deletePath(target: Json, path: string): void {
  const parts = path.split(".");
  let current: Json | undefined = target;
  for (const part of parts.slice(0, -1)) {
    current = current?.[part] as Json | undefined;
    if (!current) return;
  }
  if (current) delete current[parts[parts.length - 1]];
}
