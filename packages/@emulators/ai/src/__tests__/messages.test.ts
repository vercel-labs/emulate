import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@emulators/ai", async () => import("../index.js"));

interface EmulatorHandle {
  readonly url: string;
  close(): Promise<void>;
}

let emulator: EmulatorHandle;
let origin: string;
let client: Anthropic;

beforeAll(async () => {
  const entry = new URL("../../../../emulate/src/api.ts", import.meta.url).href;
  const { createEmulator } = (await import(entry)) as {
    createEmulator(options: { service: "ai"; port: number }): Promise<EmulatorHandle>;
  };
  emulator = await createEmulator({ service: "ai", port: 0 });
  origin = new URL(emulator.url).origin;
  client = new Anthropic({ apiKey: "test", baseURL: origin, maxRetries: 0 });
});

afterAll(async () => {
  await emulator.close();
});

beforeEach(async () => {
  const reset = await fetch(`${origin}/_ai/reset`, { method: "POST" });
  expect(reset.status).toBe(200);
});

const weatherTool = {
  name: "get_weather",
  description: "Weather for a city",
  input_schema: {
    type: "object" as const,
    properties: { city: { type: "string" } },
    required: ["city"],
  },
};

async function rejection(promise: Promise<unknown>): Promise<{ status: number; error: Record<string, unknown> }> {
  try {
    await promise;
  } catch (error) {
    return error as { status: number; error: Record<string, unknown> };
  }
  throw new Error("Expected the request to fail.");
}

async function setRules(rules: unknown[]): Promise<void> {
  const response = await fetch(`${origin}/_ai/rules`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ rules }),
  });
  expect(response.status).toBe(200);
}

describe("anthropic messages", () => {
  it("returns a message with text, stop reason, and usage", async () => {
    const message = await client.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 64,
      messages: [{ role: "user", content: "hello there" }],
    });

    expect(message.type).toBe("message");
    expect(message.role).toBe("assistant");
    expect(message.stop_reason).toBe("end_turn");
    expect(message.content).toEqual([{ type: "text", text: "hello there" }]);
    expect(message.usage.input_tokens).toBeGreaterThan(0);
    expect(message.usage.output_tokens).toBeGreaterThan(0);
  });

  it("streams with the documented event order", async () => {
    const stream = client.messages.stream({
      model: "claude-opus-5-5",
      max_tokens: 64,
      messages: [{ role: "user", content: "the quick brown fox" }],
    });
    const seen: string[] = [];
    stream.on("streamEvent", (event) => seen.push(event.type));
    const message = await stream.finalMessage();

    expect(seen[0]).toBe("message_start");
    expect(seen.at(-1)).toBe("message_stop");
    expect(seen).toContain("content_block_delta");
    expect(seen.filter((type) => type === "content_block_delta").length).toBeGreaterThan(1);
    expect(message.content).toEqual([{ type: "text", text: "the quick brown fox" }]);
  });

  it("returns tool use and streams its arguments", async () => {
    await setRules([
      {
        id: "weather",
        match: { textContains: "weather" },
        reply: [{ type: "tool_call", name: "get_weather", arguments: { city: "Paris" } }],
      },
    ]);
    const request = {
      model: "claude-opus-5-5",
      max_tokens: 64,
      messages: [{ role: "user" as const, content: "weather in paris" }],
      tools: [weatherTool],
    };

    const unary = await client.messages.create(request);
    expect(unary.stop_reason).toBe("tool_use");
    const block = unary.content.find((item) => item.type === "tool_use");
    expect(block).toMatchObject({ type: "tool_use", name: "get_weather", input: { city: "Paris" } });

    const streamed = await client.messages.stream(request).finalMessage();
    expect(streamed.content.find((item) => item.type === "tool_use")).toMatchObject({
      name: "get_weather",
      input: { city: "Paris" },
    });
  });

  it("accepts a tool result from a previous turn", async () => {
    const message = await client.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 64,
      messages: [
        { role: "user", content: "weather in paris" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Paris" } }],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "18C and sunny" }] },
      ],
    });
    expect(message.content).toEqual([{ type: "text", text: "Received the result of toolu_1." }]);
  });

  it("fills structured output from the requested schema", async () => {
    const schema = z.object({ city: z.string(), nights: z.number() });
    const message = await client.messages.parse({
      model: "claude-opus-5-5",
      max_tokens: 64,
      messages: [{ role: "user", content: "hello" }],
      output_config: { format: zodOutputFormat(schema) },
    });
    expect(message.parsed_output).toEqual({ city: "hello", nights: 0 });
  });

  it("rejects schemas Anthropic does not support in its own envelope", async () => {
    const error = await rejection(
      client.messages.create({
        model: "claude-opus-5-5",
        max_tokens: 64,
        messages: [{ role: "user", content: "hello" }],
        output_config: {
          format: {
            type: "json_schema",
            schema: { type: "object", properties: { k: { oneOf: [{ type: "string" }] } } },
          },
        },
      }),
    );

    expect(error.status).toBe(400);
    expect(error.error).toMatchObject({
      type: "error",
      error: { type: "invalid_request_error", message: "Schema type 'oneOf' is not supported" },
    });
    expect(typeof (error.error as { request_id?: unknown }).request_id).toBe("string");
  });

  it("reports injected failures with Anthropic error types", async () => {
    await setRules([{ id: "busy", match: { textContains: "busy" }, error: { status: 429, message: "Slow down." } }]);
    const error = await rejection(
      client.messages.create({
        model: "claude-opus-5-5",
        max_tokens: 64,
        messages: [{ role: "user", content: "busy please" }],
      }),
    );

    expect(error.status).toBe(429);
    expect(error.error).toMatchObject({
      error: { type: "rate_limit_error", message: "Slow down." },
    });
  });

  it("requires max_tokens", async () => {
    const response = await fetch(`${origin}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-opus-5-5", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toBe("Expected a number.");
  });
});
