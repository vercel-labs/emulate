import { beforeEach, afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import OpenAI from "openai";
import type { ResponseInputItem } from "openai/resources/responses/responses";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAI as createOpenAIv3 } from "ai-sdk-openai-v3";
import { generateObject, generateText, streamText, tool } from "ai";
import {
  generateObject as generateObjectV6,
  generateText as generateTextV6,
  streamText as streamTextV6,
  tool as toolV6,
} from "ai-v6";
import { z } from "zod";
import { STORED_RESPONSE_LIMIT } from "../state.js";
import type { CallRecord } from "../types.js";

vi.mock("@emulators/ai", async () => import("../index.js"));

interface EmulatorHandle {
  readonly url: string;
  close(): Promise<void>;
}

let emulator: EmulatorHandle;
let origin: string;
let baseURL: string;

const scriptedRules = [
  {
    id: "tool-result",
    match: { hasToolResult: true },
    reply: [{ type: "text", text: "The weather is 20 C." }],
  },
  {
    id: "refusal",
    match: { textContains: "refuse" },
    reply: [{ type: "refusal", text: "I can't help with that." }],
  },
  {
    id: "reasoning",
    match: { textContains: "think" },
    reply: [
      { type: "reasoning", text: "Checking the question." },
      { type: "text", text: "The answer is 42." },
    ],
  },
  {
    id: "weather",
    match: { textContains: "weather", tool: "get_weather" },
    reply: [{ type: "tool_call", id: "call_weather", name: "get_weather", arguments: { city: "Paris" } }],
  },
  {
    id: "length",
    match: { textContains: "long" },
    reply: [{ type: "text", text: "Partial answer" }],
    finish: "length",
  },
];

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
  const reset = await fetch(`${origin}/_ai/reset`, { method: "POST" });
  expect(reset.status).toBe(200);
  const rules = await fetch(`${origin}/_ai/rules`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ rules: scriptedRules }),
  });
  expect(rules.status).toBe(200);
});

async function lastCall(): Promise<CallRecord> {
  const response = await fetch(`${origin}/_ai/calls`);
  expect(response.status).toBe(200);
  const calls = (await response.json()) as CallRecord[];
  const call = calls.at(-1);
  if (!call) throw new Error("expected at least one recorded call");
  return call;
}

function openaiClient(): OpenAI {
  return new OpenAI({ apiKey: "test", baseURL });
}

describe("OpenAI Responses codec", () => {
  it("serves unary text through the official client", async () => {
    const client = openaiClient();
    const response = await client.responses.create({ model: "anthropic/claude-sonnet-5", input: "Hi" });

    expect(response.output_text).toBe("Hi");
    expect(response.model).toBe("anthropic/claude-sonnet-5");
    expect(response.status).toBe("completed");
    expect(response.usage?.total_tokens).toBe(
      (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0),
    );
  });

  it("streams contiguous sequence numbers and ends with response.completed", async () => {
    const client = openaiClient();
    const stream = await client.responses.create({ model: "gpt-x", input: "Hi there", stream: true });

    const events: Array<{ type: string; sequence_number?: number }> = [];
    let text = "";
    for await (const event of stream) {
      events.push(event as { type: string; sequence_number?: number });
      if (event.type === "response.output_text.delta") text += event.delta;
    }

    expect(events[0]?.type).toBe("response.created");
    expect(events.every((event, index) => event.sequence_number === index)).toBe(true);
    expect(events.at(-1)?.type).toBe("response.completed");
    expect(text).toBe("Hi there");
  });

  it("adds function call items without arguments and then a full done item", async () => {
    const client = openaiClient();
    const stream = await client.responses.create({
      model: "gpt-x",
      input: "weather in Paris",
      stream: true,
      tools: [
        {
          type: "function",
          name: "get_weather",
          description: "Get the weather",
          parameters: { type: "object", properties: { city: { type: "string" } } },
          strict: false,
        },
      ],
    });

    let addedArguments: string | undefined;
    let doneArguments: string | undefined;
    let callId: string | undefined;
    for await (const event of stream) {
      if (event.type === "response.output_item.added" && event.item.type === "function_call") {
        addedArguments = event.item.arguments;
        callId = event.item.call_id;
      }
      if (event.type === "response.output_item.done" && event.item.type === "function_call") {
        doneArguments = event.item.arguments;
      }
    }

    expect(addedArguments).toBe("");
    expect(doneArguments).toBe('{"city":"Paris"}');
    expect(callId).toBe("call_weather");
  });

  it("resolves item references and pairs tool results with their calls", async () => {
    const client = openaiClient();
    const tools = [
      {
        type: "function" as const,
        name: "get_weather",
        description: "Get the weather",
        parameters: { type: "object", properties: { city: { type: "string" } } },
        strict: false,
      },
    ];
    const first = await client.responses.create({ model: "gpt-x", input: "weather in Paris", tools });
    const call = first.output.find((item) => item.type === "function_call");
    if (!call || call.type !== "function_call") throw new Error("expected a function call");

    const input: ResponseInputItem[] = [
      { type: "item_reference", id: call.id ?? "missing" },
      { type: "function_call_output", call_id: call.call_id, output: '{"tempC":20}' },
      { role: "user", content: "What is the temperature?" },
    ];
    const second = await client.responses.create({ model: "gpt-x", input, tools });

    expect(second.output_text).toBe("The weather is 20 C.");
    const request = await lastCall();
    expect(request.references).toEqual([{ id: call.id ?? "missing", kind: "item", resolved: true }]);
    const result = request.messages.flatMap((message) => message.parts).find((part) => part.type === "tool_result");
    expect(result).toMatchObject({ type: "tool_result", id: "call_weather", name: "get_weather" });
  });

  it("prepends stored history for a known previous_response_id without inheriting instructions", async () => {
    const client = openaiClient();
    const first = await client.responses.create({
      model: "gpt-x",
      input: "My name is Ada",
      instructions: "Be concise.",
    });

    const second = await client.responses.create({
      model: "gpt-x",
      input: "What is my name?",
      previous_response_id: first.id,
    });

    expect(second.output_text).toBe("What is my name?");
    const request = await lastCall();
    expect(request.references).toEqual([{ id: first.id, kind: "previous_response", resolved: true }]);
    expect(request.messages.some((message) => message.role === "system")).toBe(false);
    const text = request.messages.flatMap((message) =>
      message.parts.filter((part) => part.type === "text").map((part) => part.text),
    );
    expect(text).toEqual(["My name is Ada", "My name is Ada", "What is my name?"]);
  });

  it("continues with empty context when previous_response_id is unknown", async () => {
    const client = openaiClient();
    const response = await client.responses.create({
      model: "gpt-x",
      input: "Hi",
      previous_response_id: "resp_missing",
    });

    expect(response.output_text).toBe("Hi");
    const request = await lastCall();
    expect(request.references).toEqual([{ id: "resp_missing", kind: "previous_response", resolved: false }]);
    expect(request.warnings.length).toBe(1);
  });

  it("rejects an orphan tool result when all history is resolved", async () => {
    const client = openaiClient();
    await expect(
      client.responses.create({
        model: "gpt-x",
        input: [{ type: "function_call_output", call_id: "call_missing", output: "x" }],
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("tolerates an orphan tool result when referenced history is missing", async () => {
    const client = openaiClient();
    const response = await client.responses.create({
      model: "gpt-x",
      input: [
        { type: "item_reference", id: "fc_missing" },
        { type: "function_call_output", call_id: "call_missing", output: "x" },
        { role: "user", content: "Continue" },
      ],
    });

    expect(response.output_text).toBe("The weather is 20 C.");
    const request = await lastCall();
    expect(request.references[0]?.resolved).toBe(false);
    expect(request.warnings.some((warning) => warning.includes("accepting it"))).toBe(true);
  });

  it("stores, retrieves, and deletes responses", async () => {
    const client = openaiClient();
    const created = await client.responses.create({ model: "gpt-x", input: "Hi" });

    const retrieved = await client.responses.retrieve(created.id);
    expect(retrieved.output_text).toBe("Hi");

    const deleted = await client.responses.delete(created.id);
    expect(deleted).toEqual({ id: created.id, object: "response.deleted", deleted: true });

    await expect(client.responses.retrieve(created.id)).rejects.toMatchObject({ status: 404 });
    await expect(client.responses.delete(created.id)).rejects.toMatchObject({ status: 404 });
  });

  it("evicts the oldest stored responses past the limit", async () => {
    const client = openaiClient();
    const first = await client.responses.create({ model: "gpt-x", input: "Hi" });
    let last = first;
    for (let index = 0; index < STORED_RESPONSE_LIMIT; index++) {
      last = await client.responses.create({ model: "gpt-x", input: "Hi" });
    }
    await expect(client.responses.retrieve(first.id)).rejects.toMatchObject({ status: 404 });
    expect((await client.responses.retrieve(last.id)).id).toBe(last.id);
  }, 60_000);

  it("replies to a request with 130000 input items", async () => {
    const response = await fetch(`${baseURL}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-x", input: Array.from({ length: 130_000 }, () => "a") }),
    });
    expect(response.status).toBe(200);
  });

  it("pins created_at so replies repeat exactly", async () => {
    const client = openaiClient();
    const first = await client.responses.create({ model: "gpt-x", input: "Hi" });
    const second = await client.responses.create({ model: "gpt-x", input: "Hi" });
    expect(first.created_at).toBe(1730000000);
    expect(second.created_at).toBe(first.created_at);
  });

  it("names the bare JSON path in validation errors", async () => {
    const post = async (body: string) => {
      const response = await fetch(`${baseURL}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      return {
        status: response.status,
        json: (await response.json()) as { error: { message: string; param: unknown } },
      };
    };

    const missing = await post(JSON.stringify({ model: "gpt-x", input: [{ role: "user" }] }));
    expect(missing.status).toBe(400);
    expect(missing.json.error.param).toBe("input[0].content");
    expect(missing.json.error.message).toBe("Missing required parameter: 'input[0].content'.");

    const model = await post(JSON.stringify({ input: "Hi" }));
    expect(model.json.error.message).toBe("Expected a string for 'model'.");

    const array = await post("[]");
    expect(array.status).toBe(400);
    expect(array.json.error.param).toBeNull();
  });

  it("echoes previous_response_id, max_output_tokens, and truncation on the response", async () => {
    const client = openaiClient();
    const plain = await client.responses.create({ model: "gpt-x", input: "Hi" });
    expect(plain.previous_response_id).toBeNull();
    expect(plain.max_output_tokens).toBeNull();
    expect(plain.truncation).toBe("disabled");

    const auto = await client.responses.create({
      model: "gpt-x",
      input: "Hi",
      truncation: "auto",
      max_output_tokens: 50,
    });
    expect(auto.truncation).toBe("auto");
    expect(auto.max_output_tokens).toBe(50);
  });

  it("does not store store:false responses", async () => {
    const client = openaiClient();
    const created = await client.responses.create({ model: "gpt-x", input: "Hi", store: false });
    await expect(client.responses.retrieve(created.id)).rejects.toMatchObject({ status: 404 });
  });

  it("streams reasoning summaries through the official client", async () => {
    const client = openaiClient();
    const stream = await client.responses.create({ model: "gpt-x", input: "think about it", stream: true });

    let reasoning = "";
    let text = "";
    for await (const event of stream) {
      if (event.type === "response.reasoning_summary_text.delta") reasoning += event.delta;
      if (event.type === "response.output_text.delta") text += event.delta;
    }

    expect(reasoning).toBe("Checking the question.");
    expect(text).toBe("The answer is 42.");
  });

  it("streams native refusal parts for the official client", async () => {
    const client = openaiClient();
    const stream = await client.responses.create({ model: "gpt-x", input: "refuse this", stream: true });

    let refusal = "";
    let text = "";
    let terminal = "";
    for await (const event of stream) {
      if (event.type === "response.refusal.delta") refusal += event.delta;
      if (event.type === "response.output_text.delta") text += event.delta;
      if (event.type === "response.completed" || event.type === "response.incomplete") terminal = event.type;
    }

    expect(refusal).toBe("I can't help with that.");
    expect(text).toBe("");
    expect(terminal).toBe("response.completed");
  });

  it("marks length replies incomplete", async () => {
    const client = openaiClient();
    const response = await client.responses.create({ model: "gpt-x", input: "make it long" });

    expect(response.status).toBe("incomplete");
    expect(response.incomplete_details?.reason).toBe("max_output_tokens");
    expect(response.output_text).toBe("Partial answer");
  });

  it("decodes attachments as metadata without keeping bytes", async () => {
    const client = openaiClient();
    const pdfBytes = Buffer.from("%PDF-1.4 test");
    const pngBytes = Buffer.from("not really a png");
    const pdf = pdfBytes.toString("base64");
    const png = pngBytes.toString("base64");

    const input: ResponseInputItem[] = [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "Read these" },
          { type: "input_file", filename: "report.pdf", file_data: `data:application/pdf;base64,${pdf}` },
          { type: "input_image", detail: "auto", image_url: `data:image/png;base64,${png}` },
        ],
      },
    ];
    await client.responses.create({ model: "gpt-x", input });

    const request = await lastCall();
    const files = request.messages.flatMap((message) => message.parts.filter((part) => part.type === "file"));
    expect(files).toEqual([
      {
        type: "file",
        mediaType: "application/pdf",
        name: "report.pdf",
        source: "inline",
        bytes: 13,
        sha256: "d663640088750cf16276d623c2588d7233f2b84b45f4b2e20832f47b16aa5618",
      },
      {
        type: "file",
        mediaType: "image/png",
        source: "inline",
        bytes: 16,
        sha256: "e90137d39de304eefbbe788bc535c7e82f27abbf8069505fbbd8a9dcdc4f2024",
      },
    ]);
  });

  it("rejects malformed inline attachment data", async () => {
    const client = openaiClient();
    await expect(
      client.responses.create({
        model: "gpt-x",
        input: [
          {
            role: "user",
            content: [
              { type: "input_file", filename: "bad.pdf", file_data: "data:application/pdf;base64,!!!notbase64" },
            ],
          },
        ],
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("OpenAI Responses through the AI SDK", () => {
  it("returns text and model ids through @ai-sdk/openai 4.x", async () => {
    const provider = createOpenAI({ apiKey: "test", baseURL });

    const result = await generateText({ model: provider("anthropic/claude-sonnet-5"), prompt: "Hi" });
    expect(result.text).toBe("Hi");
    expect(result.response.modelId).toBe("anthropic/claude-sonnet-5");

    const streamed = streamText({ model: provider("gpt-x"), prompt: "Hi there" });
    expect(await streamed.text).toBe("Hi there");
    expect(await streamed.finishReason).toBe("stop");
  });

  it("returns text through @ai-sdk/openai 3.x with ai 6", async () => {
    const provider = createOpenAIv3({ apiKey: "test", baseURL });

    const result = await generateTextV6({ model: provider("anthropic/claude-sonnet-5"), prompt: "Hi" });
    expect(result.text).toBe("Hi");
    expect(result.response.modelId).toBe("anthropic/claude-sonnet-5");

    const streamed = streamTextV6({ model: provider("gpt-x"), prompt: "Hi there" });
    expect(await streamed.text).toBe("Hi there");
    expect(await streamed.finishReason).toBe("stop");
  });

  it("surfaces reasoning summaries to @ai-sdk/openai 4.x", async () => {
    const provider = createOpenAI({ apiKey: "test", baseURL });
    const result = await generateText({ model: provider("gpt-x"), prompt: "think about it" });
    expect(result.reasoningText).toContain("Checking the question.");
    expect(result.text).toBe("The answer is 42.");

    const streamed = streamText({ model: provider("gpt-x"), prompt: "think about it" });
    expect(await streamed.reasoningText).toContain("Checking the question.");
    expect(await streamed.text).toBe("The answer is 42.");
  });

  it("surfaces reasoning summaries to @ai-sdk/openai 3.x", async () => {
    const provider = createOpenAIv3({ apiKey: "test", baseURL });
    const result = await generateTextV6({ model: provider("gpt-x"), prompt: "think about it" });
    expect(result.reasoningText).toContain("Checking the question.");
    expect(result.text).toBe("The answer is 42.");

    const streamed = streamTextV6({ model: provider("gpt-x"), prompt: "think about it" });
    expect(await streamed.reasoningText).toContain("Checking the question.");
    expect(await streamed.text).toBe("The answer is 42.");
  });

  it("parses tool calls through @ai-sdk/openai 4.x", async () => {
    const provider = createOpenAI({ apiKey: "test", baseURL });
    const result = await generateText({
      model: provider("gpt-x"),
      prompt: "weather in Paris",
      tools: {
        get_weather: tool({
          description: "Get the weather",
          inputSchema: z.object({ city: z.string() }),
        }),
      },
    });
    expect(result.toolCalls[0]).toMatchObject({ toolName: "get_weather", input: { city: "Paris" } });
    expect(result.finishReason).toBe("tool-calls");
  });

  it("parses tool calls through @ai-sdk/openai 3.x", async () => {
    const provider = createOpenAIv3({ apiKey: "test", baseURL });
    const result = await generateTextV6({
      model: provider("gpt-x"),
      prompt: "weather in Paris",
      tools: {
        get_weather: toolV6({
          description: "Get the weather",
          inputSchema: z.object({ city: z.string() }),
        }),
      },
    });
    expect(result.toolCalls[0]).toMatchObject({ toolName: "get_weather", input: { city: "Paris" } });
    expect(result.finishReason).toBe("tool-calls");
  });

  it("generates identical schema-valid objects through @ai-sdk/openai 4.x", async () => {
    const provider = createOpenAI({ apiKey: "test", baseURL });
    const schema = z.object({ name: z.string(), minutes: z.number() });
    const first = await generateObject({ model: provider("gpt-x"), schema, prompt: "meeting" });
    const second = await generateObject({ model: provider("gpt-x"), schema, prompt: "meeting" });
    expect(schema.parse(first.object)).toEqual(first.object);
    expect(second.object).toEqual(first.object);
  });

  it("generates identical schema-valid objects through @ai-sdk/openai 3.x", async () => {
    const provider = createOpenAIv3({ apiKey: "test", baseURL });
    const schema = z.object({ name: z.string(), minutes: z.number() });
    const first = await generateObjectV6({ model: provider("gpt-x"), schema, prompt: "meeting" });
    const second = await generateObjectV6({ model: provider("gpt-x"), schema, prompt: "meeting" });
    expect(schema.parse(first.object)).toEqual(first.object);
    expect(second.object).toEqual(first.object);
  });

  it("keeps native refusals for the official client and fails the AI SDK parser", async () => {
    const client = openaiClient();
    const response = await client.responses.create({ model: "gpt-x", input: "refuse this" });
    const message = response.output[0];
    expect(message?.type).toBe("message");
    if (message?.type === "message")
      expect(message.content[0]).toMatchObject({ type: "refusal", refusal: "I can't help with that." });

    const provider = createOpenAI({ apiKey: "test", baseURL });
    await expect(generateText({ model: provider("gpt-x"), prompt: "refuse this" })).rejects.toThrow();

    const providerV3 = createOpenAIv3({ apiKey: "test", baseURL });
    await expect(generateTextV6({ model: providerV3("gpt-x"), prompt: "refuse this" })).rejects.toThrow();
  });

  it("reports length as the AI SDK length finish reason", async () => {
    const provider = createOpenAI({ apiKey: "test", baseURL });
    const streamed = streamText({ model: provider("gpt-x"), prompt: "make it long" });
    expect(await streamed.text).toBe("Partial answer");
    expect(await streamed.finishReason).toBe("length");
  });
});
