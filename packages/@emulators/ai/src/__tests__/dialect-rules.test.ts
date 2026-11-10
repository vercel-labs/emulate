import { describe, expect, it } from "vitest";
import { dialectForModel, schemaFailure } from "../schema-dialects.js";
import type { JsonSchema } from "../types.js";

const objectSchema = (trip: JsonSchema): JsonSchema => ({
  type: "object",
  properties: { trip },
  required: ["trip"],
  additionalProperties: false,
});

describe("dialectForModel", () => {
  it("recognizes claude at the start of a model id", () => {
    expect(dialectForModel("claude-opus-5-5")).toBe("anthropic");
  });

  it("recognizes a gateway model id with a claude name after a slash", () => {
    expect(dialectForModel("anthropic/claude-sonnet-4")).toBe("anthropic");
  });

  it("keeps other model ids on the openai dialect", () => {
    expect(dialectForModel("gpt-4o-mini")).toBe("openai");
    expect(dialectForModel("openai/gpt-4o")).toBe("openai");
    expect(dialectForModel("notclaude")).toBe("openai");
  });
});

describe("openai schema rules", () => {
  it("requires additionalProperties to be false on an object", () => {
    const schema: JsonSchema = { type: "object", properties: { city: { type: "string" } }, required: ["city"] };
    expect(schemaFailure("openai", schema, "trip")).toBe(
      "Invalid schema for response_format 'trip': In context=(), 'additionalProperties' is required to be supplied and to be false.",
    );
  });

  it("requires additionalProperties when the type array contains object", () => {
    const schema: JsonSchema = {
      type: ["object", "null"],
      properties: { city: { type: "string" } },
      required: ["city"],
    };
    expect(schemaFailure("openai", schema, "trip")).toBe(
      "Invalid schema for response_format 'trip': In context=(), 'additionalProperties' is required to be supplied and to be false.",
    );
  });

  it("requires every property key in required", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: { city: { type: "string" }, nights: { type: "number" } },
      required: ["city"],
      additionalProperties: false,
    };
    expect(schemaFailure("openai", schema, "trip")).toBe(
      "Invalid schema for response_format 'trip': In context=(), 'required' is required to be supplied and to be an array including every key in properties. Missing 'nights'.",
    );
  });

  it("names the first property key when required is absent", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: { city: { type: "string" }, nights: { type: "number" } },
      additionalProperties: false,
    };
    expect(schemaFailure("openai", schema, "trip")).toBe(
      "Invalid schema for response_format 'trip': In context=(), 'required' is required to be supplied and to be an array including every key in properties. Missing 'city'.",
    );
  });

  it("reports a nested object with its path", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        address: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
      required: ["address"],
      additionalProperties: false,
    };
    expect(schemaFailure("openai", schema, "trip")).toBe(
      "Invalid schema for response_format 'trip': In context=('properties', 'address'), 'additionalProperties' is required to be supplied and to be false.",
    );
  });

  it("reports an object inside $defs with its path", () => {
    const schema: JsonSchema = {
      type: "object",
      additionalProperties: false,
      $defs: {
        strict: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
          additionalProperties: false,
        },
        loose: { type: "object", properties: {} },
      },
    };
    expect(schemaFailure("openai", schema, "trip")).toBe(
      "Invalid schema for response_format 'trip': In context=('$defs', 'loose'), 'additionalProperties' is required to be supplied and to be false.",
    );
  });

  it("reports an object inside anyOf with its path", () => {
    const schema: JsonSchema = {
      type: "object",
      additionalProperties: false,
      anyOf: [{ type: "object", properties: { a: { type: "string" } }, required: ["a"] }],
    };
    expect(schemaFailure("openai", schema, "trip")).toBe(
      "Invalid schema for response_format 'trip': In context=('anyOf', '0'), 'additionalProperties' is required to be supplied and to be false.",
    );
  });

  it("accepts a compliant schema", () => {
    expect(schemaFailure("openai", objectSchema({ type: "string" }), "trip")).toBeNull();
  });
});

describe("anthropic schema rules", () => {
  it("rejects minItems above 1", () => {
    expect(schemaFailure("anthropic", { type: "array", minItems: 2 }, "trip")).toBe(
      "For 'array' type, 'minItems' values other than 0 or 1 are not supported",
    );
  });

  it("accepts minItems 0 and 1", () => {
    expect(schemaFailure("anthropic", { type: "array", minItems: 0 }, "trip")).toBeNull();
    expect(schemaFailure("anthropic", { type: "array", minItems: 1 }, "trip")).toBeNull();
  });

  it("accepts a compliant schema", () => {
    expect(schemaFailure("anthropic", objectSchema({ type: "string" }), "trip")).toBeNull();
  });
});
