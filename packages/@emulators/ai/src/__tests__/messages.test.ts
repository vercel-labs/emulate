import Anthropic from "@anthropic-ai/sdk";
import type { DocumentBlockParam } from "@anthropic-ai/sdk/resources/messages";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { createHash } from "node:crypto";
import { z } from "zod";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CallRecord } from "../types.js";

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

async function lastCall(): Promise<CallRecord> {
  const response = await fetch(`${origin}/_ai/calls`);
  expect(response.status).toBe(200);
  const calls = (await response.json()) as CallRecord[];
  const call = calls.at(-1);
  if (!call) throw new Error("expected a recorded call");
  return call;
}

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PDF = Buffer.from("%PDF-1.4\n%%EOF\n").toString("base64");

function sha256(base64: string): string {
  return createHash("sha256").update(Buffer.from(base64, "base64")).digest("hex");
}

async function postMessages(body: string): Promise<Response> {
  return fetch(`${origin}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
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

  it("records attachments without credentials, query strings, or file bytes", async () => {
    await setRules([{ id: "png", match: { file: "image/png" }, reply: [{ type: "text", text: "png matched" }] }]);

    await client.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 64,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "url", url: "https://user:pass@example.com/cat.png?sig=secret#frag" } },
          ],
        },
      ],
    });
    const urlCall = await lastCall();
    expect(urlCall.messages[0].parts).toEqual([
      { type: "file", mediaType: "image/*", source: "url", ref: "https://example.com/cat.png" },
    ]);

    const inline = await client.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 64,
      messages: [
        { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: PNG } }] },
      ],
    });
    expect(inline.content).toEqual([{ type: "text", text: "png matched" }]);
    const inlineCall = await lastCall();
    expect(inlineCall.messages[0].parts).toEqual([
      {
        type: "file",
        mediaType: "image/png",
        source: "inline",
        bytes: Buffer.from(PNG, "base64").length,
        sha256: sha256(PNG),
      },
    ]);
    expect(JSON.stringify(inlineCall.messages)).not.toContain(PNG);

    const nested = await client.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 64,
      messages: [
        { role: "user", content: "look" },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "read_file", input: {} }] },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: [
                { type: "text", text: "here it is" },
                { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } },
                { type: "document", source: { type: "base64", media_type: "application/pdf", data: PDF } },
              ],
            },
          ],
        },
      ],
    });
    expect(nested.content).toEqual([{ type: "text", text: "Received the result of toolu_1." }]);
    const nestedCall = await lastCall();
    expect(nestedCall.messages.at(-1)).toEqual({
      role: "tool",
      parts: [
        {
          type: "file",
          mediaType: "image/png",
          source: "inline",
          bytes: Buffer.from(PNG, "base64").length,
          sha256: sha256(PNG),
        },
        {
          type: "file",
          mediaType: "application/pdf",
          source: "inline",
          bytes: Buffer.from(PDF, "base64").length,
          sha256: sha256(PDF),
        },
        { type: "tool_result", id: "toolu_1", output: "here it is" },
      ],
    });
    expect(JSON.stringify(nestedCall.messages)).not.toContain(PNG);
    expect(JSON.stringify(nestedCall.messages)).not.toContain(PDF);
  });

  it("keeps text documents inside a tool result out of the user text", async () => {
    await setRules([
      { id: "tool-text", match: { textContains: "from the tool" }, reply: [{ type: "text", text: "wrong match" }] },
    ]);
    const message = await client.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 64,
      messages: [
        { role: "user", content: "look" },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "read_file", input: {} }] },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: [
                { type: "text", text: "plain from the tool" },
                {
                  type: "document",
                  source: { type: "text", media_type: "text/plain", data: "text doc from the tool" },
                },
                {
                  type: "document",
                  source: { type: "content", content: [{ type: "text", text: "content doc from the tool" }] },
                },
              ],
            },
          ],
        },
      ],
    });
    expect(message.content).toEqual([{ type: "text", text: "Received the result of toolu_1." }]);
    const call = await lastCall();
    expect(call.messages.at(-1)).toEqual({
      role: "tool",
      parts: [
        {
          type: "tool_result",
          id: "toolu_1",
          output: "plain from the tool\ntext doc from the tool\ncontent doc from the tool",
        },
      ],
    });
  });

  it("accepts every document source type", async () => {
    const sources: DocumentBlockParam["source"][] = [
      { type: "base64", media_type: "application/pdf", data: PDF },
      { type: "text", media_type: "text/plain", data: "the document body" },
      {
        type: "content",
        content: [
          { type: "text", text: "block text" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } },
        ],
      },
      { type: "url", url: "https://example.com/doc.pdf" },
      { type: "file", file_id: "file_1" },
    ];

    for (const source of sources) {
      const message = await client.messages.create({
        model: "claude-opus-5-5",
        max_tokens: 64,
        messages: [{ role: "user", content: [{ type: "document", source }] }],
      });
      expect(message.type).toBe("message");
    }

    await client.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 64,
      messages: [{ role: "user", content: [{ type: "document", source: sources[1] }] }],
    });
    const call = await lastCall();
    expect(call.messages[0].parts).toEqual([{ type: "text", text: "the document body" }]);
  });

  it("rejects a document block nested in a content source", async () => {
    const response = await postMessages(
      JSON.stringify({
        model: "claude-opus-5-5",
        max_tokens: 64,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "document",
                source: {
                  type: "content",
                  content: [{ type: "document", source: { type: "text", media_type: "text/plain", data: "inner" } }],
                },
              },
            ],
          },
        ],
      }),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { type: string; error: { type: string; message: string } };
    expect(body).toMatchObject({ type: "error", error: { type: "invalid_request_error" } });
    expect(body.error.message).toBe('Unsupported content block type "document" in a content source.');
  });

  it("rejects a nested document inside a tool result", async () => {
    const response = await postMessages(
      JSON.stringify({
        model: "claude-opus-5-5",
        max_tokens: 64,
        messages: [
          { role: "user", content: "look" },
          { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "read_file", input: {} }] },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_1",
                content: [
                  {
                    type: "document",
                    source: {
                      type: "content",
                      content: [
                        { type: "document", source: { type: "base64", media_type: "application/pdf", data: PDF } },
                      ],
                    },
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { type: string; message: string } };
    expect(body.error).toMatchObject({
      type: "invalid_request_error",
      message: 'Unsupported content block type "document" in a content source.',
    });
  });

  it("accepts text and image blocks in a content source", async () => {
    const message = await client.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 64,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: {
                type: "content",
                content: [
                  { type: "text", text: "block text" },
                  { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(message.type).toBe("message");
    const call = await lastCall();
    expect(call.messages[0].parts).toEqual([
      { type: "text", text: "block text" },
      {
        type: "file",
        mediaType: "image/png",
        source: "inline",
        bytes: Buffer.from(PNG, "base64").length,
        sha256: sha256(PNG),
      },
    ]);
  });

  it("answers deeply nested document sources with 400 instead of overflowing", async () => {
    let block = '{"type":"text","text":"deep"}';
    for (let level = 0; level < 3000; level += 1) {
      block = `{"type":"document","source":{"type":"content","content":[${block}]}}`;
    }
    const response = await postMessages(
      `{"model":"claude-opus-5-5","max_tokens":64,"messages":[{"role":"user","content":[${block}]}]}`,
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { type: string } };
    expect(body.error.type).toBe("invalid_request_error");
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

  it("rejects data URLs in image and document url sources without recording the payload", async () => {
    const dataUrl = `data:image/png;base64,${PNG}`;
    for (const block of [
      { type: "image", source: { type: "url", url: dataUrl } },
      { type: "document", source: { type: "url", url: dataUrl } },
    ]) {
      const response = await postMessages(
        JSON.stringify({
          model: "claude-opus-5-5",
          max_tokens: 64,
          messages: [{ role: "user", content: [block] }],
        }),
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: { type: string; message: string } };
      expect(body.error).toMatchObject({
        type: "invalid_request_error",
        message: "Expected an HTTP or HTTPS URL.",
      });
    }
    const calls = await fetch(`${origin}/_ai/calls`);
    expect(await calls.text()).not.toContain(PNG);
  });

  const searchResult = {
    type: "search_result",
    source: "https://example.com/page?q=secret#frag",
    title: "Search title",
    content: [{ type: "text", text: "search body" }],
  };

  it("records only the title and text of a search result inside a tool result", async () => {
    const response = await postMessages(
      JSON.stringify({
        model: "claude-opus-5-5",
        max_tokens: 64,
        messages: [
          { role: "user", content: "look" },
          { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "search", input: {} }] },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [searchResult] }],
          },
        ],
      }),
    );
    expect(response.status).toBe(200);
    const call = await lastCall();
    expect(call.messages.at(-1)).toEqual({
      role: "tool",
      parts: [{ type: "tool_result", id: "toolu_1", output: "Search title\nsearch body" }],
    });
    const calls = await (await fetch(`${origin}/_ai/calls`)).text();
    expect(calls).not.toContain("q=secret");
    expect(calls).not.toContain("#frag");
    expect(calls).not.toContain("https://example.com/page");
  });

  it("accepts a search result at message level and matches its text", async () => {
    await setRules([
      { id: "search", match: { textContains: "search body" }, reply: [{ type: "text", text: "search matched" }] },
    ]);
    const response = await postMessages(
      JSON.stringify({
        model: "claude-opus-5-5",
        max_tokens: 64,
        messages: [{ role: "user", content: [searchResult] }],
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { content: unknown };
    expect(body.content).toEqual([{ type: "text", text: "search matched" }]);
  });

  it("rejects an unknown block type inside a tool result", async () => {
    const response = await postMessages(
      JSON.stringify({
        model: "claude-opus-5-5",
        max_tokens: 64,
        messages: [
          { role: "user", content: "look" },
          { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "read_file", input: {} }] },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_1",
                content: [{ type: "video", source: "https://example.com/clip" }],
              },
            ],
          },
        ],
      }),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { type: string; message: string } };
    expect(body.error).toMatchObject({
      type: "invalid_request_error",
      message: 'Unsupported content block type "video" in a tool result.',
    });
  });

  it("matches textContains and hasToolResult on a tool continuation", async () => {
    await setRules([
      {
        id: "look-result",
        match: { textContains: "look", hasToolResult: true },
        reply: [{ type: "text", text: "look matched" }],
      },
    ]);
    const message = await client.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 64,
      messages: [
        { role: "user", content: "look" },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "read_file", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "here" }] },
      ],
    });
    expect(message.content).toEqual([{ type: "text", text: "look matched" }]);
  });

  it("replies to a tool result that nests an image by default", async () => {
    const message = await client.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 64,
      messages: [
        { role: "user", content: "look" },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "read_file", input: {} }] },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: PNG } }],
            },
          ],
        },
      ],
    });
    expect(message.content).toEqual([{ type: "text", text: "Received the result of toolu_1." }]);
    const call = await lastCall();
    expect(call.matched).toEqual({ default: "tool_result" });
  });

  it("echoes text that follows a tool result in the same user turn", async () => {
    const message = await client.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 64,
      messages: [
        { role: "user", content: "look" },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "read_file", input: {} }] },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "here" },
            { type: "text", text: "what now" },
          ],
        },
      ],
    });
    expect(message.content).toEqual([{ type: "text", text: "what now" }]);
    const call = await lastCall();
    expect(call.messages.slice(-2)).toEqual([
      { role: "tool", parts: [{ type: "tool_result", id: "toolu_1", output: "here" }] },
      { role: "user", parts: [{ type: "text", text: "what now" }] },
    ]);
  });
});
