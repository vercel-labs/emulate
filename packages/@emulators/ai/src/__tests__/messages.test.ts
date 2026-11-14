import Anthropic from "@anthropic-ai/sdk";
import type { DocumentBlockParam } from "@anthropic-ai/sdk/resources/messages";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
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

  it("rejects a hosted server tool in its own envelope", async () => {
    const response = await postMessages(
      JSON.stringify({
        model: "claude-opus-5-5",
        max_tokens: 64,
        messages: [{ role: "user", content: "search the web" }],
        tools: [{ type: "web_search_20250305", name: "web_search" }],
      }),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { type: string; error: { type: string; message: string } };
    expect(body).toMatchObject({ type: "error", error: { type: "invalid_request_error" } });
    expect(body.error.message).toBe("Unsupported Messages feature: hosted tools (tools.0.type).");
  });

  it("accepts a client-run typed tool without a schema and answers it with tool_use", async () => {
    await setRules([
      {
        id: "bash",
        match: { textContains: "list" },
        reply: [{ type: "tool_call", name: "bash", arguments: { command: "ls" } }],
      },
    ]);
    const body = {
      model: "claude-opus-5-5",
      max_tokens: 64,
      messages: [{ role: "user", content: "list files" }],
      tools: [{ type: "bash_20250124", name: "bash" }],
    };
    const ruled = (await (await postMessages(JSON.stringify(body))).json()) as { content: unknown[] };
    expect(ruled.content).toEqual([
      { type: "tool_use", id: expect.any(String), name: "bash", input: { command: "ls" } },
    ]);

    await setRules([]);
    const forced = await postMessages(
      JSON.stringify({
        ...body,
        messages: [{ role: "user", content: "x" }],
        tool_choice: { type: "tool", name: "bash" },
      }),
    );
    expect(forced.status).toBe(200);
    const forcedBody = (await forced.json()) as { stop_reason: string; content: { type: string; input: unknown }[] };
    expect(forcedBody.stop_reason).toBe("tool_use");
    expect(forcedBody.content[0].input).toEqual({});
  });

  it("rejects every server-side tool type and a malformed tool type", async () => {
    const send = (tools: unknown[]) =>
      postMessages(
        JSON.stringify({
          model: "claude-opus-5-5",
          max_tokens: 64,
          messages: [{ role: "user", content: "x" }],
          tools,
        }),
      );
    const message = async (response: Response) =>
      ((await response.json()) as { error: { message: string } }).error.message;

    for (const type of ["tool_search_tool_regex_20251119", "tool_search_tool_bm25_20251119", "mcp_toolset"]) {
      const response = await send([{ type }]);
      expect(response.status).toBe(400);
      expect(await message(response)).toBe("Unsupported Messages feature: hosted tools (tools.0.type).");
    }

    const mixed = await send([
      weatherTool,
      { type: "bash_20250124", name: "bash" },
      { type: "web_search_20250305", name: "w" },
    ]);
    expect(mixed.status).toBe(400);
    expect(await message(mixed)).toContain("tools.2.type");

    for (const type of ["", 5]) {
      const response = await send([{ ...weatherTool, type }]);
      expect(response.status).toBe(400);
      expect(await message(response)).toBe("tools.0.type: Expected a non-empty string.");
    }
  });

  it("generates toolu ids for tool calls and keeps an authored id", async () => {
    const body = {
      model: "claude-opus-5-5",
      max_tokens: 64,
      messages: [{ role: "user", content: "list files" }],
      tools: [{ type: "bash_20250124", name: "bash" }],
    };
    const send = async (extra: object = {}, stream = false) => {
      const response = await postMessages(JSON.stringify({ ...body, ...extra, stream }));
      return stream ? await response.text() : ((await response.json()) as { content: { id?: string }[] });
    };

    const forced = (await send({ tool_choice: { type: "tool", name: "bash" } })) as { content: { id?: string }[] };
    expect(forced.content[0].id).toMatch(/^toolu_\d+$/);

    await setRules([
      { id: "r", match: {}, reply: [{ type: "tool_call", name: "bash", arguments: { command: "ls" } }] },
    ]);
    const ruled = (await send()) as { content: { id?: string }[] };
    expect(ruled.content[0].id).toMatch(/^toolu_\d+$/);
    const streamed = (await send({}, true)) as string;
    expect(streamed).toMatch(/"content_block":\{"type":"tool_use","id":"toolu_\d+"/);

    await setRules([
      { id: "r", match: {}, reply: [{ type: "tool_call", id: "call_mine", name: "bash", arguments: {} }] },
    ]);
    const authored = (await send()) as { content: { id?: string }[] };
    expect(authored.content[0].id).toBe("call_mine");
  });

  it("accepts a custom tool, a null type, and a tool with no type", async () => {
    for (const type of [undefined, null, "custom"]) {
      const response = await postMessages(
        JSON.stringify({
          model: "claude-opus-5-5",
          max_tokens: 64,
          messages: [{ role: "user", content: "weather in paris" }],
          tools: [{ ...weatherTool, ...(type === undefined ? {} : { type }) }],
        }),
      );
      expect(response.status).toBe(200);
      expect((await lastCall()).tools).toEqual(["get_weather"]);
    }
  });

  it("validates the schema of a strict tool and skips it without strict", async () => {
    const tool = {
      name: "get_temperature",
      input_schema: { type: "object", properties: { celsius: { type: "number", minimum: 0 } } },
    };
    const strict = await postMessages(
      JSON.stringify({
        model: "claude-opus-5-5",
        max_tokens: 64,
        messages: [{ role: "user", content: "hello" }],
        tools: [{ ...tool, strict: true }],
      }),
    );
    expect(strict.status).toBe(400);
    const body = (await strict.json()) as { error: { type: string; message: string } };
    expect(body.error).toMatchObject({
      type: "invalid_request_error",
      message: expect.stringContaining("For 'number' type, property 'minimum' is not supported"),
    });

    const loose = await postMessages(
      JSON.stringify({
        model: "claude-opus-5-5",
        max_tokens: 64,
        messages: [{ role: "user", content: "hello" }],
        tools: [tool],
      }),
    );
    expect(loose.status).toBe(200);

    const invalid = await postMessages(
      JSON.stringify({
        model: "claude-opus-5-5",
        max_tokens: 64,
        messages: [{ role: "user", content: "hello" }],
        tools: [{ ...tool, strict: "yes" }],
      }),
    );
    expect(invalid.status).toBe(400);
    const invalidBody = (await invalid.json()) as { error: { message: string } };
    expect(invalidBody.error.message).toBe("tools.0.strict: Expected a boolean.");
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
    expect(message.content).toEqual([{ type: "text", text: "Received the result of get_weather." }]);
  });

  it("records attachments without credentials, query strings, or file bytes", async () => {
    await setRules([{ id: "png", match: { file: "image/png" }, reply: [{ type: "text", text: "png matched" }] }]);

    const urlMessage = await client.messages.create({
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
    expect(urlMessage.content).toEqual([{ type: "text", text: "png matched" }]);
    const urlCall = await lastCall();
    expect(urlCall.messages[0].parts).toEqual([
      { type: "file", mediaType: "image/png", source: "url", ref: "https://example.com/cat.png" },
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
    expect(nested.content).toEqual([{ type: "text", text: "png matched" }]);
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
    expect(message.content).toEqual([{ type: "text", text: "Received the result of read_file." }]);
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

  it("checks the media type of a base64 source against its block kind", async () => {
    const image = (media_type: string, data = PNG) => ({ type: "image", source: { type: "base64", media_type, data } });
    const document = (media_type: string) => ({ type: "document", source: { type: "base64", media_type, data: PDF } });
    const send = (content: unknown) =>
      postMessages(JSON.stringify({ model: "claude-opus-5-5", max_tokens: 64, messages: [{ role: "user", content }] }));

    expect((await send([image("image/png")])).status).toBe(200);
    expect((await send([document("application/pdf")])).status).toBe(200);

    const pdfImage = await send([image("application/pdf")]);
    expect(pdfImage.status).toBe(400);
    expect(await pdfImage.json()).toMatchObject({ error: { type: "invalid_request_error" } });
    expect((await send([image("text/plain")])).status).toBe(400);
    expect((await send([document("image/png")])).status).toBe(400);

    const nested = await send([
      { type: "tool_result", tool_use_id: "toolu_1", content: [image("application/pdf"), document("application/pdf")] },
    ]);
    expect(nested.status).toBe(400);
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

  it("records the media type of a URL document from its path", async () => {
    const message = await client.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 64,
      messages: [
        { role: "user", content: [{ type: "document", source: { type: "url", url: "https://example.com/doc.pdf" } }] },
      ],
    });
    expect(message.type).toBe("message");
    const call = await lastCall();
    expect(call.messages[0].parts).toEqual([
      { type: "file", mediaType: "application/pdf", source: "url", ref: "https://example.com/doc.pdf" },
    ]);
  });

  it("keeps image/* for an image URL with no known extension", async () => {
    const message = await client.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 64,
      messages: [
        { role: "user", content: [{ type: "image", source: { type: "url", url: "https://example.com/cat" } }] },
      ],
    });
    expect(message.type).toBe("message");
    const call = await lastCall();
    expect(call.messages[0].parts).toEqual([
      { type: "file", mediaType: "image/*", source: "url", ref: "https://example.com/cat" },
    ]);
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
    expect(body.error.message).toBe(
      'messages.0.content.0.source.content.0.type: Unsupported content block type "document" in a content source.',
    );
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
      message: expect.stringContaining('Unsupported content block type "document" in a content source.'),
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
      error: {
        type: "invalid_request_error",
        message: expect.stringContaining("Schema type 'oneOf' is not supported"),
      },
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

  it("sends the same request id in a validation error body and header", async () => {
    const response = await postMessages(
      JSON.stringify({ model: "claude-opus-5-5", messages: [{ role: "user", content: "hi" }] }),
    );
    expect(response.status).toBe(400);
    expect(response.headers.get("request-id")).toMatch(/^req_\d+$/);
    const body = (await response.json()) as { request_id: string };
    expect(body.request_id).toBe(response.headers.get("request-id"));
  });

  it("sends the same request id in a rule error body and header", async () => {
    await setRules([{ id: "busy", match: { textContains: "busy" }, error: { status: 429, message: "Slow down." } }]);
    const response = await postMessages(
      JSON.stringify({ model: "claude-opus-5-5", max_tokens: 64, messages: [{ role: "user", content: "busy" }] }),
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("request-id")).toMatch(/^req_\d+$/);
    const body = (await response.json()) as { request_id: string };
    expect(body.request_id).toBe(response.headers.get("request-id"));
  });

  it("keeps a request id header a rule sets in the error body", async () => {
    await setRules([
      {
        id: "broken",
        match: { textContains: "broken" },
        error: { status: 500, message: "Broken.", headers: { "request-id": "req_from_rule" } },
      },
    ]);
    const response = await postMessages(
      JSON.stringify({ model: "claude-opus-5-5", max_tokens: 64, messages: [{ role: "user", content: "broken" }] }),
    );
    expect(response.status).toBe(500);
    expect(response.headers.get("request-id")).toBe("req_from_rule");
    const body = (await response.json()) as { request_id: string };
    expect(body.request_id).toBe("req_from_rule");
  });

  it("renders every non-codec error on the Messages path family in Anthropic's shape", async () => {
    const cases: Array<{
      method: string;
      path: string;
      headers?: Record<string, string>;
      status: number;
      type: string;
    }> = [
      { method: "POST", path: "/v1/messages/count_tokens", status: 404, type: "not_found_error" },
      { method: "GET", path: "/v1/messages", status: 404, type: "not_found_error" },
      { method: "DELETE", path: "/v1/messages", status: 404, type: "not_found_error" },
      { method: "POST", path: "/v1/messages/", status: 404, type: "not_found_error" },
      {
        method: "GET",
        path: "/v1/other",
        headers: { "anthropic-version": "2023-06-01" },
        status: 404,
        type: "not_found_error",
      },
      {
        method: "GET",
        path: "/v1/messages",
        headers: { origin: "https://example.com" },
        status: 403,
        type: "permission_error",
      },
    ];
    for (const item of cases) {
      const response = await fetch(`${origin}${item.path}`, { method: item.method, headers: item.headers });
      expect(response.status).toBe(item.status);
      expect(response.headers.get("request-id")).toMatch(/^req_/);
      expect(await response.json()).toMatchObject({ type: "error", error: { type: item.type } });
    }
    const openai = await fetch(`${origin}/v1/other`, { method: "GET" });
    expect(await openai.json()).toMatchObject({ error: { type: "invalid_request_error", code: "unsupported_path" } });

    const malformed = await postMessages("{");
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ type: "error", error: { type: "invalid_request_error" } });
  });

  it("renders injected rule errors with the Anthropic error type for their status", async () => {
    for (const [status, type] of [
      [401, "authentication_error"],
      [403, "permission_error"],
      [404, "not_found_error"],
      [413, "request_too_large"],
      [429, "rate_limit_error"],
      [500, "api_error"],
      [529, "overloaded_error"],
    ] as const) {
      await setRules([{ id: "boom", match: {}, error: { status, message: "boom" } }]);
      const response = await postMessages(
        JSON.stringify({ model: "m", max_tokens: 8, messages: [{ role: "user", content: "x" }] }),
      );
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ type: "error", error: { type, message: "boom" } });
    }
  });

  it("refuses an untrusted host on the Messages route in Anthropic's shape", async () => {
    const reply = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const url = new URL(`${origin}/v1/messages`);
      const request = httpRequest(
        {
          host: url.hostname,
          port: url.port,
          path: url.pathname,
          method: "POST",
          headers: { host: "evil.example", "content-type": "application/json" },
        },
        (response) => {
          let body = "";
          response.on("data", (chunk) => (body += chunk));
          response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
        },
      );
      request.on("error", reject);
      request.end(JSON.stringify({ model: "m", max_tokens: 8, messages: [{ role: "user", content: "x" }] }));
    });
    expect(reply.status).toBe(403);
    expect(JSON.parse(reply.body)).toMatchObject({ type: "error", error: { type: "permission_error" } });
  });

  it("requires max_tokens", async () => {
    const response = await fetch(`${origin}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-opus-5-5", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toBe("max_tokens: Expected a number.");
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
        message: expect.stringContaining("Expected an HTTP or HTTPS URL."),
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
      message: expect.stringContaining('Unsupported content block type "video" in a tool result.'),
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
    expect(message.content).toEqual([{ type: "text", text: "Received the result of read_file." }]);
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

  describe("thinking", () => {
    const thought = "The user wants the weather, so call the tool before answering.";
    const answer = "It is 20 C in Paris.";

    it("returns scripted reasoning as a signed thinking block, unstreamed and streamed", async () => {
      await setRules([
        {
          id: "think",
          reply: [
            { type: "reasoning", text: thought },
            { type: "text", text: answer },
          ],
        },
      ]);
      const params = {
        model: "claude-opus-5-5",
        max_tokens: 2048,
        thinking: { type: "adaptive" as const },
        messages: [{ role: "user" as const, content: "weather in paris" }],
      };

      const message = await client.messages.create(params);
      expect(message.content).toEqual([
        { type: "thinking", thinking: thought, signature: expect.stringMatching(/^.+$/) },
        { type: "text", text: answer },
      ]);
      expect(message.stop_reason).toBe("end_turn");

      const stream = client.messages.stream(params);
      const order: string[] = [];
      const signatures: string[] = [];
      let streamedThinking = "";
      stream.on("streamEvent", (event) => {
        if (event.type === "content_block_start") order.push(`start:${event.content_block.type}`);
        if (event.type === "content_block_delta") order.push(event.delta.type);
        if (event.type === "content_block_stop") order.push("stop");
      });
      stream.on("thinking", (delta) => {
        streamedThinking += delta;
      });
      stream.on("signature", (signature) => {
        signatures.push(signature);
      });
      const final = await stream.finalMessage();

      expect(final.content).toEqual(message.content);
      expect(streamedThinking).toBe(thought);
      expect(signatures).toHaveLength(1);
      expect([...new Set(order)]).toEqual([
        "start:thinking",
        "thinking_delta",
        "signature_delta",
        "stop",
        "start:text",
        "text_delta",
      ]);
      expect(order.indexOf("signature_delta")).toBe(order.indexOf("stop") - 1);
    });

    it("puts thinking before a tool call and accepts the block when the conversation is sent back", async () => {
      await setRules([
        {
          id: "call",
          match: { hasToolResult: false },
          reply: [
            { type: "reasoning", text: thought },
            { type: "tool_call", name: "get_weather", arguments: { city: "Paris" } },
          ],
        },
        { id: "answer", match: { hasToolResult: true }, reply: [{ type: "text", text: answer }] },
      ]);
      const user = { role: "user" as const, content: "weather in paris" };
      const first = await client.messages.create({
        model: "claude-opus-5-5",
        max_tokens: 2048,
        tools: [weatherTool],
        messages: [user],
      });
      expect(first.content.map((block) => block.type)).toEqual(["thinking", "tool_use"]);
      expect(first.stop_reason).toBe("tool_use");
      const toolUse = first.content.find((block) => block.type === "tool_use");
      if (toolUse?.type !== "tool_use") throw new Error("expected a tool_use block");

      const second = await client.messages.create({
        model: "claude-opus-5-5",
        max_tokens: 2048,
        tools: [weatherTool],
        messages: [
          user,
          { role: "assistant", content: first.content },
          { role: "user", content: [{ type: "tool_result", tool_use_id: toolUse.id, content: "20 C" }] },
        ],
      });
      expect(second.content).toEqual([{ type: "text", text: answer }]);
    });
  });
});
