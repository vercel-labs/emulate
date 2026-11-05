import { AiRequestError } from "./errors.js";
import type { Json, JsonSchema } from "./types.js";

/** Which provider's structured output rules apply to a request. */
export type SchemaDialect = "openai" | "anthropic";

interface Violation {
  keyword: string;
  path: string[];
  type: string | undefined;
}

/** Composition keywords OpenAI rejects in strict mode. */
const OPENAI_REJECTED = ["allOf", "not", "dependentRequired", "dependentSchemas", "if", "then", "else"];

/** Constraint keywords Anthropic rejects in structured output schemas. */
const ANTHROPIC_REJECTED = [
  "oneOf",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "maxItems",
  "uniqueItems",
  "prefixItems",
  "contains",
  "minContains",
  "maxContains",
];

/** Picks the provider rules from the model name, the way an OpenAI-compatible gateway does. */
export function dialectForModel(model: string): SchemaDialect {
  return /^claude/i.test(model) ? "anthropic" : "openai";
}

function record(value: Json | undefined): value is Record<string, Json> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function children(node: Record<string, Json>): Array<[string[], JsonSchema]> {
  const found: Array<[string[], JsonSchema]> = [];
  const push = (path: string[], value: Json | undefined): void => {
    if (typeof value === "boolean" || record(value)) found.push([path, value as JsonSchema]);
  };
  if (record(node.properties)) {
    for (const [key, value] of Object.entries(node.properties)) push(["properties", key], value);
  }
  if (Array.isArray(node.items)) {
    node.items.forEach((value, index) => push(["items", String(index)], value));
  } else {
    push(["items"], node.items);
  }
  for (const keyword of ["anyOf", "oneOf", "allOf"]) {
    const branches = node[keyword];
    if (Array.isArray(branches)) {
      branches.forEach((value, index) => push([keyword, String(index)], value));
    }
  }
  for (const keyword of ["$defs", "definitions"]) {
    const definitions = node[keyword];
    if (record(definitions)) {
      for (const [key, value] of Object.entries(definitions)) push([keyword, key], value);
    }
  }
  push(["additionalProperties"], node.additionalProperties);
  if (record(node.patternProperties)) {
    for (const [key, value] of Object.entries(node.patternProperties)) push(["patternProperties", key], value);
  }
  return found;
}

function findViolation(schema: JsonSchema, rejected: string[], path: string[] = [], depth = 0): Violation | null {
  if (depth > 40 || typeof schema === "boolean" || !record(schema)) return null;
  for (const keyword of rejected) {
    if (Object.hasOwn(schema, keyword)) {
      return { keyword, path, type: typeof schema.type === "string" ? schema.type : undefined };
    }
  }
  for (const [segment, child] of children(schema)) {
    const violation = findViolation(child, rejected, [...path, ...segment], depth + 1);
    if (violation) return violation;
  }
  return null;
}

function contextOf(path: string[]): string {
  return `(${path.map((key) => `'${key}'`).join(", ")})`;
}

/** Describes why a schema is rejected, in the wording the provider uses, or null when it is acceptable. */
export function schemaFailure(dialect: SchemaDialect, schema: JsonSchema, name: string): string | null {
  if (dialect === "openai") {
    const violation = findViolation(schema, OPENAI_REJECTED);
    if (!violation) return null;
    return `Invalid schema for response_format '${name}': In context=${contextOf(violation.path)}, '${violation.keyword}' is not permitted.`;
  }
  const violation = findViolation(schema, ANTHROPIC_REJECTED);
  if (!violation) return null;
  return violation.type === undefined
    ? `Schema type '${violation.keyword}' is not supported`
    : `For '${violation.type}' type, property '${violation.keyword}' is not supported`;
}

/** Throws the provider's schema rejection in the caller's error envelope. */
export function assertSchemaSupported(dialect: SchemaDialect, schema: JsonSchema, name: string, param: string): void {
  const message = schemaFailure(dialect, schema, name);
  if (message) throw new AiRequestError(message, param);
}
