import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { anthropicSchemaMessage } from "../schema-dialects.js";

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

function objectWith(trip: Record<string, unknown>): Record<string, unknown> {
  return { type: "object", properties: { trip }, required: ["trip"], additionalProperties: false };
}

function schema(keyword: string): Record<string, unknown> {
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

function chatBody(schemaValue: Record<string, unknown>, strict?: boolean): Record<string, unknown> {
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

describe("anthropic schema dialect", () => {
  it("names the keyword with the Anthropic message shape", () => {
    const schemaValue = schema("oneOf");
    const message = anthropicSchemaMessage(schemaValue);
    expect(message).toBe("output_config.format.schema: Schema type 'oneOf' is not supported");
  });

  it("reports type-specific constraints", () => {
    const schemaValue = {
      type: "object",
      properties: { zip: { type: "string", minLength: 5 } },
      required: ["zip"],
      additionalProperties: false,
    };
    expect(anthropicSchemaMessage(schemaValue)).toBe(
      "output_config.format.schema: For 'string' type, property 'minLength' is not supported",
    );
  });

  it("accepts formats and anyOf", () => {
    const schemaValue = {
      type: "object",
      properties: {
        email: { type: "string", format: "email" },
        either: { anyOf: [{ type: "string" }, { type: "number" }] },
      },
      required: ["email", "either"],
      additionalProperties: false,
    };
    expect(anthropicSchemaMessage(schemaValue)).toBeNull();
  });
});
