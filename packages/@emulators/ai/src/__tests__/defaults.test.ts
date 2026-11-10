import { describe, expect, it } from "vitest";
import { sampleSchema } from "../defaults.js";
import { AiRequestError } from "../errors.js";
import type { JsonSchema } from "../types.js";

function thrown(run: () => unknown): AiRequestError {
  try {
    run();
  } catch (error) {
    if (error instanceof AiRequestError) return error;
    throw error;
  }
  throw new Error("expected an AiRequestError");
}

describe("sampleSchema alternatives", () => {
  it("samples a later anyOf branch when the first cannot be sampled", () => {
    const schema: JsonSchema = { anyOf: [{ type: "string", pattern: "^a+$" }, { type: "number" }] };
    expect(sampleSchema(schema, "hello")).toBe(0);
  });

  it("samples a later anyOf branch when a sibling constraint rejects the first", () => {
    const schema: JsonSchema = {
      anyOf: [
        { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
        { type: "object", properties: {}, required: [], additionalProperties: false },
      ],
      additionalProperties: false,
    };
    expect(sampleSchema(schema, "hello")).toEqual({});
  });

  it("skips a oneOf branch that cannot be sampled", () => {
    const schema: JsonSchema = { oneOf: [{ type: "string", pattern: "^a+$" }, { type: "number" }] };
    expect(sampleSchema(schema, "hello")).toBe(0);
  });

  it("rethrows the first error when every oneOf branch throws", () => {
    const schema: JsonSchema = {
      oneOf: [
        { type: "string", pattern: "^a+$" },
        { type: "string", pattern: "^b+$" },
      ],
    };
    const error = thrown(() => sampleSchema(schema, "hello"));
    expect(error.message).toContain("the sampler cannot generate a string for a pattern");
    expect(error.param).toBe("schema.oneOf[0]");
  });
});

describe("sampleSchema siblings next to composition keywords", () => {
  it("applies a sibling maxLength next to $ref", () => {
    const schema: JsonSchema = {
      $defs: { name: { type: "string" } },
      $ref: "#/$defs/name",
      maxLength: 3,
    };
    expect(sampleSchema(schema, "hello")).toBe("hel");
  });

  it("applies a sibling minimum next to anyOf", () => {
    const schema: JsonSchema = {
      anyOf: [{ type: "number", maximum: 0 }, { type: "number" }],
      minimum: 5,
    };
    expect(sampleSchema(schema, "hello")).toBe(5);
  });

  it("keeps a branch constraint that is tighter than its sibling", () => {
    const schema: JsonSchema = { anyOf: [{ type: "integer", minimum: 5 }], minimum: 0 };
    expect(sampleSchema(schema, "hello")).toBe(5);
  });
});

describe("sampleSchema core behavior", () => {
  it("samples required properties", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: { name: { type: "string" }, age: { type: "number" } },
      required: ["name"],
    };
    expect(sampleSchema(schema, "ab")).toEqual({ name: "ab" });
  });

  it("takes the first enum value and clones a const", () => {
    expect(sampleSchema({ enum: ["b", "a"] }, "seed")).toBe("b");
    expect(sampleSchema({ const: { nested: [1, 2] } }, "seed")).toEqual({ nested: [1, 2] });
  });

  it("respects numeric bounds", () => {
    expect(sampleSchema({ type: "integer", minimum: 3, maximum: 10 }, "seed")).toBe(3);
    expect(sampleSchema({ type: "number", maximum: -2 }, "seed")).toBe(-2);
  });

  it("fills arrays to minItems", () => {
    expect(sampleSchema({ type: "array", minItems: 2, items: { type: "string" } }, "ab")).toEqual(["ab", "ab"]);
  });

  it("returns null for a nullable schema", () => {
    expect(sampleSchema({ type: "string", nullable: true }, "hello")).toBeNull();
  });

  it("reports an unsupported keyword with its path", () => {
    const error = thrown(() => sampleSchema({ type: "string", minProperties: 1 }, "hello"));
    expect(error.param).toBe("schema.minProperties");
    expect(error.message).toContain("unsupported schema keyword");
  });

  it("stays bounded for a recursive $ref", () => {
    const error = thrown(() => sampleSchema({ $ref: "#" }, "hello"));
    expect(error.message).toContain("recursion depth");
  });

  it("returns the same value for the same input", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: { tags: { type: "array", minItems: 2, items: { type: "string" } }, level: { type: "integer" } },
      required: ["tags", "level"],
    };
    expect(sampleSchema(schema, "repeat")).toEqual(sampleSchema(schema, "repeat"));
  });
});
