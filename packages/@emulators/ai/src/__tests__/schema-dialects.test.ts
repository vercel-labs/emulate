import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { dialectForModel, schemaFailure } from "../schema-dialects.js";
import type { Json, JsonSchema } from "../types.js";

vi.mock("@emulators/ai", async () => import("../index.js"));

interface EmulatorHandle {
  readonly url: string;
  close(): Promise<void>;
}

let emulator: EmulatorHandle;
let origin: string;

beforeAll(async () => {
  const entry = new URL("../../../../emulate/src/api.ts", import.meta.url).href;
  const { createEmulator } = (await import(entry)) as {
    createEmulator(options: { service: "ai"; port: number }): Promise<EmulatorHandle>;
  };
  emulator = await createEmulator({ service: "ai", port: 0 });
  origin = new URL(emulator.url).origin;
});

afterAll(async () => {
  await emulator.close();
});

beforeEach(async () => {
  const reset = await fetch(`${origin}/_ai/reset`, { method: "POST" });
  expect(reset.status).toBe(200);
});

function objectWith(trip: Record<string, unknown>): JsonSchema {
  return { type: "object", properties: { trip }, required: ["trip"], additionalProperties: false } as JsonSchema;
}

function schema(keyword: string): JsonSchema {
  return objectWith({ [keyword]: [{ type: "string" }, { type: "number" }] });
}

async function chat(body: unknown): Promise<{ status: number; json: Record<string, any> }> {
  const response = await fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as Record<string, any> };
}

function chatBody(schemaValue: JsonSchema, strict?: boolean): Record<string, unknown> {
  return {
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: "hello" }],
    response_format: {
      type: "json_schema",
      json_schema: { name: "trip", ...(strict === undefined ? {} : { strict }), schema: schemaValue },
    },
  };
}

describe("openai schema dialect", () => {
  it("rejects composition keywords with the OpenAI message", async () => {
    const { status, json } = await chat(chatBody(schema("allOf"), true));
    expect(status).toBe(400);
    expect(json.error).toEqual({
      message:
        "Invalid schema for response_format 'trip': In context=('properties', 'trip'), 'allOf' is not permitted.",
      type: "invalid_request_error",
      param: "response_format",
      code: null,
    });
  });

  it("points the Responses error at text.format", async () => {
    const response = await fetch(`${origin}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        input: "hello",
        text: { format: { type: "json_schema", name: "trip", strict: true, schema: schema("allOf") } },
      }),
    });
    const json = (await response.json()) as Record<string, any>;
    expect(response.status).toBe(400);
    expect(json.error.param).toBe("text.format");
    expect(json.error.message).toBe(
      "Invalid schema for response_format 'trip': In context=('properties', 'trip'), 'allOf' is not permitted.",
    );
  });

  it("leaves non-strict schemas unchecked", async () => {
    await fetch(`${origin}/_ai/rules`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        rules: [{ id: "trip", match: { textContains: "hello" }, reply: [{ type: "text", text: "ok" }] }],
      }),
    });
    const { status } = await chat(chatBody(schema("allOf"), false));
    expect(status).toBe(200);
  });

  it("accepts the keywords OpenAI added later", async () => {
    const email = await chat(chatBody(objectWith({ type: "string", format: "email" }), true));
    expect(email.status).toBe(200);
    expect(email.json.choices[0].message.content).toBe('{"trip":"user@example.com"}');

    const pattern = await chat(chatBody(objectWith({ type: "string", pattern: "^a+$" }), true));
    expect(pattern.status).toBe(200);

    const oneOf = await chat(chatBody(objectWith({ oneOf: [{ type: "string" }, { type: "number" }] }), true));
    expect(oneOf.status).toBe(200);
    expect(oneOf.json.choices[0].message.content).toBe('{"trip":"hello"}');
  });
});

describe("schema sampling", () => {
  const fields = Array.from({ length: 40 }, (_, index) => `field${index}`);

  function fieldsSchema(): JsonSchema {
    return {
      type: "object",
      properties: Object.fromEntries(fields.map((field) => [field, { type: "string" }])),
      required: fields,
      additionalProperties: false,
    } as JsonSchema;
  }

  it("samples a short slice of the prompt for each string field", async () => {
    const { status, json } = await chat({
      ...chatBody(fieldsSchema()),
      messages: [{ role: "user", content: "x".repeat(7000) }],
    });
    expect(status).toBe(200);
    const value = JSON.parse(json.choices[0].message.content);
    expect(value.field0).toBe("x".repeat(64));
    expect(value.field39).toBe("x".repeat(64));
  });

  it("rejects a const nested past the depth bound with a client error", async () => {
    let nested: Json = null;
    for (let index = 0; index < 5000; index += 1) nested = [nested];
    const { status, json } = await chat(
      chatBody({
        type: "object",
        properties: { trip: { const: nested } },
        required: ["trip"],
        additionalProperties: false,
      } as JsonSchema),
    );
    expect(status).toBe(400);
    expect(json.error.type).toBe("invalid_request_error");
    expect(json.error.message).toContain("value nesting exceeds 32 levels");
  });
});

describe("anthropic schema dialect", () => {
  it("is chosen by the model name, the way a compatible gateway does", () => {
    expect(dialectForModel("claude-opus-5-5")).toBe("anthropic");
    expect(dialectForModel("gpt-4o-mini")).toBe("openai");
  });

  it("names the keyword with the Anthropic message shape", () => {
    expect(schemaFailure("anthropic", schema("oneOf"), "trip")).toBe("Schema type 'oneOf' is not supported");
  });

  it("reports type-specific constraints", () => {
    const schemaValue = objectWith({ type: "string", minLength: 5 });
    expect(schemaFailure("anthropic", schemaValue, "trip")).toBe(
      "For 'string' type, property 'minLength' is not supported",
    );
  });

  it("accepts formats and anyOf", () => {
    const schemaValue = objectWith({
      anyOf: [{ type: "string", format: "email" }, { type: "number" }],
    });
    expect(schemaFailure("anthropic", schemaValue, "trip")).toBeNull();
  });
});

describe("anthropic rules on the OpenAI wire", () => {
  function claudeBody(schemaValue: JsonSchema, strict?: boolean) {
    const body = chatBody(schemaValue, strict);
    body.model = "claude-opus-5-5";
    return body;
  }

  it("keeps the OpenAI envelope and uses the Anthropic message", async () => {
    const { status, json } = await chat(
      claudeBody(objectWith({ oneOf: [{ type: "string" }, { type: "number" }] }), true),
    );
    expect(status).toBe(400);
    expect(json.error).toEqual({
      message: "Schema type 'oneOf' is not supported",
      type: "invalid_request_error",
      param: "response_format",
      code: null,
    });
  });

  it("rejects constraints Anthropic does not support", async () => {
    const { status, json } = await chat(claudeBody(objectWith({ type: "number", minimum: 3 }), true));
    expect(status).toBe(400);
    expect(json.error.message).toBe("For 'number' type, property 'minimum' is not supported");
  });

  it("rejects json_object and missing strict", async () => {
    const object = await chat({
      ...claudeBody(objectWith({ type: "string" })),
      response_format: { type: "json_object" },
    });
    expect(object.status).toBe(400);
    expect(object.json.error.message).toBe("Expected a json_schema format with strict set to true.");

    const loose = await chat(claudeBody(objectWith({ type: "string" }), false));
    expect(loose.status).toBe(400);
    expect(loose.json.error.param).toBe("response_format.json_schema.strict");
  });

  it("still accepts the same schema for an OpenAI model", async () => {
    const { status } = await chat(chatBody(objectWith({ oneOf: [{ type: "string" }, { type: "number" }] }), true));
    expect(status).toBe(200);
  });
});
