import { generateObject, generateText, streamText, tool } from "ai";
import { generateObject as generateObjectV3, generateText as generateTextV3, streamText as streamTextV3 } from "ai-v6";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenAI as createOpenAIV3 } from "ai-sdk-openai-v3";
import OpenAI from "openai";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("@emulators/ai", async () => import("../index.js"));

interface EmulatorHandle {
  readonly url: string;
  close(): Promise<void>;
}

let emulator: EmulatorHandle;
let origin: string;
let baseURL: string;

async function startEmulator(): Promise<EmulatorHandle> {
  const entry = new URL("../../../../emulate/src/api.ts", import.meta.url).href;
  const { createEmulator } = (await import(entry)) as {
    createEmulator(options: { service: "ai"; port: number }): Promise<EmulatorHandle>;
  };
  return createEmulator({ service: "ai", port: 0 });
}

beforeAll(async () => {
  emulator = await startEmulator();
  origin = new URL(emulator.url).origin;
  baseURL = `${origin}/v1`;
});

afterAll(async () => {
  await emulator.close();
});

beforeEach(async () => {
  const response = await fetch(`${origin}/_ai/reset`, { method: "POST" });
  expect(response.status).toBe(200);
});

async function configureRules(body: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${origin}/_ai/rules`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
}

function toolRules(): Record<string, unknown>[] {
  return [
    {
      id: "tool-call",
      match: { textContains: "weather" },
      reply: [{ type: "tool_call", id: "call_fixed", name: "get_weather", arguments: { city: "Paris" } }],
    },
    {
      id: "refusal",
      match: { textContains: "refuse" },
      reply: [{ type: "refusal", text: "I cannot help with that." }],
    },
  ];
}

describe("openai Chat Completions codec with the official SDK", () => {
  it("returns unary text, the model id, finish reason, and consistent usage", async () => {
    const client = new OpenAI({ apiKey: "test", baseURL });

    const completion = await client.chat.completions.create({
      model: "echo-model",
      messages: [{ role: "user", content: "Hi there" }],
    });

    expect(completion.object).toBe("chat.completion");
    expect(completion.model).toBe("echo-model");
    expect(completion.choices[0].message.content).toBe("Hi there");
    expect(completion.choices[0].finish_reason).toBe("stop");
    expect(completion.usage?.total_tokens).toBe(
      (completion.usage?.prompt_tokens ?? 0) + (completion.usage?.completion_tokens ?? 0),
    );
  });

  it("streams text with a role chunk, a finish reason, and a requested usage chunk", async () => {
    const client = new OpenAI({ apiKey: "test", baseURL });

    const stream = await client.chat.completions.create({
      model: "echo-model",
      messages: [{ role: "user", content: "Hi there" }],
      stream: true,
      stream_options: { include_usage: true },
    });

    let text = "";
    let finish: string | null = null;
    let usage: number | undefined;
    let firstRole: string | undefined;
    for await (const chunk of stream) {
      if (firstRole === undefined) firstRole = chunk.choices[0]?.delta.role;
      text += chunk.choices[0]?.delta.content ?? "";
      finish = chunk.choices[0]?.finish_reason ?? finish;
      usage = chunk.usage?.total_tokens ?? usage;
    }

    expect(firstRole).toBe("assistant");
    expect(text).toBe("Hi there");
    expect(finish).toBe("stop");
    expect(usage).toBeGreaterThan(0);
  });

  it("returns tool calls and native refusal content", async () => {
    await configureRules({ rules: toolRules() });
    const client = new OpenAI({ apiKey: "test", baseURL });

    const calls = await client.chat.completions.create({
      model: "tool-model",
      messages: [{ role: "user", content: "weather" }],
    });

    expect(calls.choices[0].finish_reason).toBe("tool_calls");
    expect(calls.choices[0].message.tool_calls).toEqual([
      { id: "call_fixed", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } },
    ]);

    const refusal = await client.chat.completions.create({
      model: "refusal-model",
      messages: [{ role: "user", content: "refuse" }],
    });

    expect(refusal.choices[0].message.content).toBeNull();
    expect(refusal.choices[0].message.refusal).toBe("I cannot help with that.");
    expect(refusal.choices[0].finish_reason).toBe("stop");
  });

  it("streams a tool call keyed by index", async () => {
    await configureRules({ rules: toolRules() });
    const client = new OpenAI({ apiKey: "test", baseURL });

    const stream = await client.chat.completions.create({
      model: "tool-model",
      messages: [{ role: "user", content: "weather" }],
      stream: true,
    });

    let name = "";
    let id = "";
    let args = "";
    let finish: string | null = null;
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta.tool_calls?.[0];
      if (delta) {
        id ||= delta.id ?? "";
        name += delta.function?.name ?? "";
        args += delta.function?.arguments ?? "";
      }
      finish = chunk.choices[0]?.finish_reason ?? finish;
    }

    expect(id).toBe("call_fixed");
    expect(name).toBe("get_weather");
    expect(JSON.parse(args)).toEqual({ city: "Paris" });
    expect(finish).toBe("tool_calls");
  });

  it("returns a native 400 for a result-changing unsupported feature", async () => {
    const client = new OpenAI({ apiKey: "test", baseURL });

    await expect(
      client.chat.completions.create({
        model: "echo-model",
        messages: [{ role: "user", content: "Hi" }],
        n: 2,
      }),
    ).rejects.toMatchObject({ status: 400, message: expect.stringContaining("multiple candidates") });
  });

  it("returns a native 400 from strict mode through the server", async () => {
    await configureRules({ strict: true });
    const client = new OpenAI({ apiKey: "test", baseURL });

    const failure = await client.chat.completions
      .create({
        model: "gpt-x",
        messages: [{ role: "user", content: "Hi" }],
        tools: [{ type: "function", function: { name: "search", parameters: { type: "object", properties: {} } } }],
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(failure).toMatchObject({ status: 400 });
    const message = failure instanceof Error ? failure.message : "";
    expect(message).toContain('No AI rule matched model "gpt-x" with tools ["search"]');
    expect(message).toContain("PUT /_ai/rules");
  });
});

describe("openai Chat Completions codec with AI SDK 7", () => {
  const provider = () => createOpenAI({ apiKey: "test", baseURL });

  it("reads unary and streamed text", async () => {
    const unary = await generateText({
      model: provider().chat("gpt-x"),
      prompt: "Hello from AI SDK 7",
      maxRetries: 0,
    });
    expect(unary.text).toBe("Hello from AI SDK 7");
    expect(unary.finishReason).toBe("stop");

    const streamed = streamText({
      model: provider().chat("gpt-x"),
      prompt: "Streaming from AI SDK 7",
      maxRetries: 0,
    });
    expect(await streamed.text).toBe("Streaming from AI SDK 7");
    expect(await streamed.finishReason).toBe("stop");
  });

  it("parses structured output deterministically", async () => {
    const schema = z.object({ name: z.string(), minutes: z.number() });
    const model = provider().chat("gpt-x");
    const first = await generateObject({ model, prompt: "Plan a run", schema, maxRetries: 0 });
    const second = await generateObject({ model, prompt: "Plan a run", schema, maxRetries: 0 });

    expect(schema.parse(first.object)).toEqual(first.object);
    expect(second.object).toEqual(first.object);
  });
});

describe("openai Chat Completions codec with AI SDK 6", () => {
  const provider = () => createOpenAIV3({ apiKey: "test", baseURL });

  it("reads unary and streamed text", async () => {
    const unary = await generateTextV3({
      model: provider().chat("gpt-x"),
      prompt: "Hello from AI SDK 6",
      maxRetries: 0,
    });
    expect(unary.text).toBe("Hello from AI SDK 6");
    expect(unary.finishReason).toBe("stop");

    const streamed = streamTextV3({
      model: provider().chat("gpt-x"),
      prompt: "Streaming from AI SDK 6",
      maxRetries: 0,
    });
    expect(await streamed.text).toBe("Streaming from AI SDK 6");
    expect(await streamed.finishReason).toBe("stop");
  });

  it("parses structured output deterministically", async () => {
    const schema = z.object({ name: z.string(), minutes: z.number() });
    const model = provider().chat("gpt-x");
    const first = await generateObjectV3({ model, prompt: "Plan a run", schema, maxRetries: 0 });
    const second = await generateObjectV3({ model, prompt: "Plan a run", schema, maxRetries: 0 });

    expect(schema.parse(first.object)).toEqual(first.object);
    expect(second.object).toEqual(first.object);
  });
});

describe("openai Chat Completions codec with @ai-sdk/openai-compatible", () => {
  it("streams a parsed tool call with string arguments", async () => {
    const provider = createOpenAICompatible({
      name: "compatible",
      apiKey: "test",
      baseURL,
    });

    const result = streamText({
      model: provider.chatModel("compat-model"),
      prompt: "weather",
      tools: {
        get_weather: tool({
          description: "Get the weather for a city",
          inputSchema: z.object({ city: z.string() }),
        }),
      },
      toolChoice: "required",
      maxRetries: 0,
    });

    const calls = await result.toolCalls;
    expect(calls).toHaveLength(1);
    expect(calls[0]?.toolName).toBe("get_weather");
    expect(calls[0]?.input).toEqual({ city: "weather" });
    expect(await result.finishReason).toBe("tool-calls");
  });
});
