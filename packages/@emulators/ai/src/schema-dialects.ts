import { AiRequestError } from "./errors.js";
import type { Json, JsonSchema, OutputSpec, ToolDefinition } from "./types.js";

/** Which provider's structured output rules apply to a request. */
export type SchemaDialect = "openai" | "anthropic";

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
  return /(^|\/)claude/i.test(model) ? "anthropic" : "openai";
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

function findAnthropicViolation(schema: JsonSchema, depth = 0): string | null {
  if (depth > 40 || typeof schema === "boolean" || !record(schema)) return null;
  if (typeof schema.$ref === "string" && !schema.$ref.startsWith("#")) {
    return "External '$ref' values are not supported";
  }
  for (const keyword of ANTHROPIC_REJECTED) {
    if (Object.hasOwn(schema, keyword)) {
      const type = typeof schema.type === "string" ? schema.type : undefined;
      return type === undefined
        ? `Schema type '${keyword}' is not supported`
        : `For '${type}' type, property '${keyword}' is not supported`;
    }
  }
  if (Object.hasOwn(schema, "minItems") && schema.minItems !== 0 && schema.minItems !== 1) {
    return "For 'array' type, 'minItems' values other than 0 or 1 are not supported";
  }
  for (const [, child] of children(schema)) {
    const message = findAnthropicViolation(child, depth + 1);
    if (message) return message;
  }
  return null;
}

function contextOf(path: string[]): string {
  return `(${path.map((key) => `'${key}'`).join(", ")})`;
}

function isObjectNode(schema: Record<string, Json>): boolean {
  const type = schema.type;
  return type === "object" || (Array.isArray(type) && type.includes("object")) || record(schema.properties);
}

function findOpenaiViolation(
  schema: JsonSchema,
  name: string,
  subject: string,
  path: string[] = [],
  depth = 0,
): string | null {
  if (depth > 40 || typeof schema === "boolean" || !record(schema)) return null;
  const at = (detail: string) => `Invalid schema for ${subject} '${name}': In context=${contextOf(path)}, ${detail}`;
  for (const keyword of OPENAI_REJECTED) {
    if (Object.hasOwn(schema, keyword)) return at(`'${keyword}' is not permitted.`);
  }
  if (isObjectNode(schema)) {
    if (schema.additionalProperties !== false) {
      return at("'additionalProperties' is required to be supplied and to be false.");
    }
    const properties = record(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    const missing = Object.keys(properties).find((key) => !required.includes(key));
    if (missing !== undefined) {
      return at(
        `'required' is required to be supplied and to be an array including every key in properties. Missing '${missing}'.`,
      );
    }
  }
  for (const [segment, child] of children(schema)) {
    const message = findOpenaiViolation(child, name, subject, [...path, ...segment], depth + 1);
    if (message) return message;
  }
  return null;
}

/** Describes why a schema is rejected, in the wording the provider uses, or null when it is acceptable. */
export function schemaFailure(
  dialect: SchemaDialect,
  schema: JsonSchema,
  name: string,
  subject = "response_format",
): string | null {
  if (dialect === "openai") return findOpenaiViolation(schema, name, subject);
  return findAnthropicViolation(schema);
}

/** Applies the model's provider rules to every strict tool schema, naming errors with the caller's param. */
export function assertToolsSupported(model: string, tools: ToolDefinition[], paramOf: (index: number) => string): void {
  const dialect = dialectForModel(model);
  tools.forEach((tool, index) => {
    if (tool.strict !== true || tool.parameters === undefined) return;
    const message = schemaFailure(dialect, tool.parameters, tool.name, "function");
    if (message) {
      throw new AiRequestError(
        message,
        paramOf(index),
        dialect === "openai" ? "invalid_function_parameters" : undefined,
      );
    }
  });
}

/** Throws the provider's schema rejection in the caller's error envelope. */
export function assertSchemaSupported(dialect: SchemaDialect, schema: JsonSchema, name: string, param: string): void {
  const message = schemaFailure(dialect, schema, name);
  if (message) throw new AiRequestError(message, param);
}

/** Applies the model's provider rules to the requested structured output, naming errors with the caller's params. */
export function assertOutputSupported(
  model: string,
  output: OutputSpec | undefined,
  params: { format: string; strict: string },
): void {
  if (dialectForModel(model) === "anthropic") {
    if (output !== undefined && output.kind !== "json_schema") {
      throw new AiRequestError("Expected a json_schema format with strict set to true.", params.format);
    }
    if (output?.kind === "json_schema" && output.strict !== true) {
      throw new AiRequestError("Expected strict to be true.", params.strict);
    }
    if (output?.kind === "json_schema") {
      assertSchemaSupported("anthropic", output.schema, output.name ?? "response", params.format);
    }
    return;
  }
  if (output?.kind === "json_schema" && output.strict === true) {
    assertSchemaSupported("openai", output.schema, output.name ?? "response", params.format);
  }
}
