import { AiRequestError } from "./errors.js";
import type { Json, JsonSchema } from "./types.js";

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

/** Rejects schema keywords OpenAI does not accept in strict structured output, using its error text. */
export function assertOpenAiSchema(schema: JsonSchema, name: string, param = "response_format"): void {
  const violation = findViolation(schema, OPENAI_REJECTED);
  if (!violation) return;
  throw new AiRequestError(
    `Invalid schema for response_format '${name}': In context=${contextOf(violation.path)}, '${violation.keyword}' is not permitted.`,
    param,
  );
}

/** Describes an Anthropic structured output rejection, or null when the schema is acceptable. */
export function anthropicSchemaMessage(schema: JsonSchema): string | null {
  const violation = findViolation(schema, ANTHROPIC_REJECTED);
  if (!violation) return null;
  return violation.type === undefined
    ? `output_config.format.schema: Schema type '${violation.keyword}' is not supported`
    : `output_config.format.schema: For '${violation.type}' type, property '${violation.keyword}' is not supported`;
}
