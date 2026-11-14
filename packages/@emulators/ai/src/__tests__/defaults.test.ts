import { describe, expect, it } from "vitest";
import { defaultEvents, sampleSchema } from "../defaults.js";
import { AiRequestError } from "../errors.js";
import type { AIRequest, JsonSchema } from "../types.js";

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

  it("keeps a stricter sibling maxLength next to $ref", () => {
    const schema: JsonSchema = {
      maxLength: 2,
      $ref: "#/$defs/s",
      $defs: { s: { type: "string", maxLength: 100 } },
    };
    expect(sampleSchema(schema, "hello")).toBe("he");
  });

  it("keeps a stricter sibling maxLength next to anyOf and oneOf", () => {
    const branch: JsonSchema = { type: "string", maxLength: 100 };
    expect(sampleSchema({ anyOf: [branch], maxLength: 2 }, "hello")).toBe("he");
    expect(sampleSchema({ oneOf: [branch], maxLength: 2 }, "hello")).toBe("he");
  });

  it("keeps a larger sibling minimum next to $ref", () => {
    const schema: JsonSchema = {
      minimum: 7,
      $ref: "#/$defs/n",
      $defs: { n: { type: "number", minimum: 1 } },
    };
    expect(sampleSchema(schema, "hello")).toBe(7);
  });

  it("intersects sibling types and enums next to $ref", () => {
    const schema: JsonSchema = {
      type: "number",
      enum: [1.5, 2, 3],
      $ref: "#/$defs/n",
      $defs: { n: { type: "integer", enum: [3, 2, 1.5] } },
    };
    expect(sampleSchema(schema, "hello")).toBe(2);
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

describe("sampleSchema patterns", () => {
  it("picks an enum value that satisfies the pattern", () => {
    const schema: JsonSchema = { type: "string", pattern: "^a+$", enum: ["zzz", "aaa"] };
    expect(sampleSchema(schema, "seed")).toBe("aaa");
  });

  it("rejects an enum whose values all violate the pattern", () => {
    const schema: JsonSchema = { type: "string", pattern: "^a+$", enum: ["zzz"] };
    const error = thrown(() => sampleSchema(schema, "seed"));
    expect(error.message).toContain("no enum value satisfies the schema");
  });

  it("rejects a const that violates the pattern", () => {
    const schema: JsonSchema = { type: "string", pattern: "^a+$", const: "zzz" };
    const error = thrown(() => sampleSchema(schema, "seed"));
    expect(error.message).toContain("const does not satisfy the schema");
  });

  it("keeps a format sample that satisfies the pattern", () => {
    const schema: JsonSchema = { type: "string", format: "email", pattern: "@" };
    expect(sampleSchema(schema, "seed")).toBe("user@example.com");
  });

  it("rejects a format sample that violates the pattern", () => {
    const schema: JsonSchema = { type: "string", format: "email", pattern: "^a+$" };
    const error = thrown(() => sampleSchema(schema, "seed"));
    expect(error.message).toContain("constraints do not permit the generated sample");
  });

  it("accepts a pattern that is only valid without the unicode flag", () => {
    const schema: JsonSchema = { type: "string", pattern: "^\\d{3}\\-\\d{4}$", enum: ["555-1234"] };
    expect(sampleSchema(schema, "seed")).toBe("555-1234");
  });

  it("stops a pathological pattern at the time limit", () => {
    const schema: JsonSchema = { type: "string", pattern: "^(a+)+$", enum: [`${"a".repeat(40)}!`] };
    const started = performance.now();
    const error = thrown(() => sampleSchema(schema, "seed"));
    expect(error.param?.endsWith(".pattern")).toBe(true);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it("samples many patterned properties without exhausting the pattern budget", () => {
    const properties: Record<string, JsonSchema> = {};
    for (let index = 0; index < 100; index++) {
      properties[`day${index}`] = { type: "string", format: "date", pattern: "^\\d{4}-\\d{2}-\\d{2}$" };
    }
    const schema: JsonSchema = { type: "object", properties, required: Object.keys(properties) };
    expect(Object.keys(sampleSchema(schema, "seed") as object)).toHaveLength(100);
  });

  it("rejects an invalid pattern with its own path", () => {
    const schema: JsonSchema = { type: "string", pattern: "(", enum: ["a"] };
    const error = thrown(() => sampleSchema(schema, "seed"));
    expect(error.param?.endsWith(".pattern")).toBe(true);
  });
});

describe("defaultEvents kinds", () => {
  function base(overrides: Partial<AIRequest> = {}): AIRequest {
    return {
      format: "openai-chat",
      model: "gpt-4o",
      messages: [{ role: "user", parts: [{ type: "text", text: "hello" }] }],
      tools: [],
      toolChoice: "auto",
      parallelToolCalls: false,
      stream: false,
      reasoning: false,
      store: false,
      references: [],
      warnings: [],
      ...overrides,
    };
  }

  const makeId = (prefix: string) => `${prefix}_1`;

  it("samples an object for forced tool parameters without a type", () => {
    const schemas: JsonSchema[] = [{}, { properties: { q: { type: "string" } }, required: ["q"] }];
    for (const parameters of schemas) {
      const { events } = defaultEvents(base({ tools: [{ name: "ping", parameters }], toolChoice: "required" }), makeId);
      const args = JSON.parse((events[0] as { arguments: string }).arguments);
      expect(args).not.toBeNull();
      expect(typeof args).toBe("object");
    }
  });

  it("reports the kind for each permissive default", () => {
    const tool = {
      name: "search",
      parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
    };
    const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };

    expect(defaultEvents(base({ tools: [tool], toolChoice: "required" }), makeId).kind).toBe("forced_tool");
    expect(defaultEvents(base({ output: { kind: "json_object" } }), makeId).kind).toBe("json_object");
    expect(defaultEvents(base({ output: { kind: "json_schema", schema } }), makeId).kind).toBe("json_schema");
    expect(
      defaultEvents(
        base({ messages: [{ role: "tool", parts: [{ type: "tool_result", id: "call_1", output: "ok" }] }] }),
        makeId,
      ).kind,
    ).toBe("tool_result");
    expect(
      defaultEvents(
        base({ messages: [{ role: "user", parts: [{ type: "file", mediaType: "image/png", source: "inline" }] }] }),
        makeId,
      ).kind,
    ).toBe("attachments");
    expect(defaultEvents(base(), makeId).kind).toBe("echo");
  });

  it("acknowledges a tool result that carries a file", () => {
    const { kind, events } = defaultEvents(
      base({
        messages: [
          { role: "user", parts: [{ type: "text", text: "chart?" }] },
          { role: "assistant", parts: [{ type: "tool_call", id: "call_1", name: "render", arguments: "{}" }] },
          {
            role: "tool",
            parts: [
              { type: "file", mediaType: "image/png", name: "chart.png", source: "inline" },
              { type: "tool_result", id: "call_1", output: "rendered" },
            ],
          },
        ],
      }),
      makeId,
    );

    expect(kind).toBe("tool_result");
    expect(events).toEqual([{ type: "text", text: "Received the result of render." }]);
  });
});

describe("defaultEvents tool results", () => {
  function request(messages: AIRequest["messages"]): AIRequest {
    return {
      format: "openai-chat",
      model: "gpt-4o",
      messages,
      tools: [],
      toolChoice: "auto",
      parallelToolCalls: false,
      stream: false,
      reasoning: false,
      store: false,
      references: [],
      warnings: [],
    };
  }

  it("uses the name from the matching tool call", () => {
    const { events } = defaultEvents(
      request([
        { role: "user", parts: [{ type: "text", text: "weather?" }] },
        { role: "assistant", parts: [{ type: "tool_call", id: "call_1", name: "get_weather", arguments: "{}" }] },
        { role: "tool", parts: [{ type: "tool_result", id: "call_1", output: "18C" }] },
      ]),
      (prefix) => `${prefix}_1`,
    );
    expect(events).toEqual([{ type: "text", text: "Received the result of get_weather." }]);
  });

  it("falls back to the id when no tool call matches", () => {
    const { events } = defaultEvents(
      request([{ role: "tool", parts: [{ type: "tool_result", id: "call_missing", output: "18C" }] }]),
      (prefix) => `${prefix}_1`,
    );
    expect(events).toEqual([{ type: "text", text: "Received the result of call_missing." }]);
  });
});
