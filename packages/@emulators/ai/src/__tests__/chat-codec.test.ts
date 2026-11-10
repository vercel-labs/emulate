import { Store } from "@emulators/core";
import { describe, expect, it } from "vitest";
import { CREATED_AT, type CodecContext, type Decoded } from "../codec.js";
import { chatCodec } from "../codecs/openai-chat.js";
import { AiRequestError } from "../errors.js";
import { parseConfig } from "../rules.js";
import { resetAiState } from "../state.js";
import type { SseFrame } from "../sse.js";
import type { FinishReason, Reply, ReplyEvent, Usage } from "../types.js";

interface ToolDelta {
  index: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface ChunkDelta {
  role?: string;
  content?: string | null;
  refusal?: string;
  tool_calls?: ToolDelta[];
}

interface ChunkChoice {
  index: number;
  delta: ChunkDelta;
  finish_reason: string | null;
}

interface ChatChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: ChunkChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_tokens_details?: { cached_tokens: number };
    completion_tokens_details?: { reasoning_tokens: number };
  } | null;
}

interface CompletionBody {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: {
    index: number;
    message: {
      role: string;
      content: string | null;
      refusal: string | null;
      tool_calls?: { id: string; type: string; function: { name: string; arguments: string } }[];
    };
    finish_reason: string | null;
  }[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_tokens_details: { cached_tokens: number };
    completion_tokens_details: { reasoning_tokens: number };
  };
}

const baseBody = { model: "gpt-x", messages: [{ role: "user", content: "Hi" }] };
const usage: Usage = { input: 5, output: 2, reasoning: 1 };

function makeContext(): CodecContext {
  const store = new Store();
  const state = resetAiState(store, parseConfig({}));
  let next = 0;
  return {
    store,
    state,
    path: "/v1/chat/completions",
    makeId: (prefix) => `${prefix}_${(next += 1)}`,
  };
}

function reply(events: ReplyEvent[], finish: FinishReason = "stop", replyUsage: Usage = usage): Reply {
  return { events, finish, usage: replyUsage };
}

function decodedOf(body: Record<string, unknown> = baseBody): { ctx: CodecContext; decoded: Decoded } {
  const ctx = makeContext();
  return { ctx, decoded: chatCodec.decode(body, ctx) };
}

function chunkOf(frame: SseFrame): ChatChunk {
  return frame.data as ChatChunk;
}

function decodeError(body: unknown): AiRequestError {
  try {
    chatCodec.decode(body, makeContext());
  } catch (error) {
    if (error instanceof AiRequestError) return error;
    throw error;
  }
  throw new Error("expected decode to fail");
}

describe("chatCodec.decode", () => {
  it("normalizes a full request", () => {
    const decoded = chatCodec.decode(
      {
        model: "gpt-x",
        messages: [
          { role: "system", content: "be brief" },
          { role: "user", content: [{ type: "text", text: "Hi" }] },
          {
            role: "assistant",
            content: "calling",
            tool_calls: [{ id: "call_a", type: "function", function: { name: "lookup", arguments: '{"q":1}' } }],
          },
          { role: "tool", tool_call_id: "call_a", content: "result" },
        ],
        tools: [{ type: "function", function: { name: "lookup", description: "d", parameters: { type: "object" } } }],
        tool_choice: "auto",
        stream: true,
        stream_options: { include_usage: true },
        max_completion_tokens: 64,
        stop: "END",
        reasoning_effort: "low",
      },
      makeContext(),
    );

    expect(decoded.request.model).toBe("gpt-x");
    expect(decoded.request.messages).toEqual([
      { role: "system", parts: [{ type: "text", text: "be brief" }] },
      { role: "user", parts: [{ type: "text", text: "Hi" }] },
      {
        role: "assistant",
        parts: [
          { type: "text", text: "calling" },
          { type: "tool_call", id: "call_a", name: "lookup", arguments: '{"q":1}' },
        ],
      },
      { role: "tool", parts: [{ type: "tool_result", id: "call_a", output: "result" }] },
    ]);
    expect(decoded.request.tools).toEqual([{ name: "lookup", description: "d", parameters: { type: "object" } }]);
    expect(decoded.request.toolChoice).toBe("auto");
    expect(decoded.request.stream).toBe(true);
    expect(decoded.request.parallelToolCalls).toBe(true);
    expect(decoded.request.store).toBe(false);
    expect(decoded.request.reasoning).toBe(true);
    expect(decoded.request.maxOutputTokens).toBe(64);
    expect(decoded.request.stop).toEqual(["END"]);
    expect(decoded.extras).toEqual({ includeUsage: true });
  });

  it("rejects a missing or empty model", () => {
    const missing = decodeError({ messages: [{ role: "user", content: "Hi" }] });
    expect(missing.message).toBe("Expected a string.");
    expect(missing.param).toBe("model");

    const empty = decodeError({ ...baseBody, model: "" });
    expect(empty.message).toBe("Expected a non-empty string.");
    expect(empty.param).toBe("model");
  });

  it("rejects an unsupported message role", () => {
    const error = decodeError({ ...baseBody, messages: [{ role: "robot", content: "Hi" }] });

    expect(error.message).toBe('Unsupported message role "robot".');
    expect(error.param).toBe("messages[0].role");
  });

  it("rejects an empty messages array", () => {
    const error = decodeError({ ...baseBody, messages: [] });

    expect(error.message).toBe("Expected a non-empty array of messages.");
    expect(error.param).toBe("messages");
  });

  it("rejects a tool result without a preceding tool call", () => {
    const error = decodeError({
      ...baseBody,
      messages: [
        { role: "user", content: "Hi" },
        { role: "tool", tool_call_id: "x", content: "result" },
      ],
    });

    expect(error.message).toBe(
      "Invalid parameter: messages with role 'tool' must be a response to a preceding message with 'tool_calls'.",
    );
    expect(error.param).toBe("messages[1].role");
  });

  it("rejects unanswered tool calls", () => {
    const error = decodeError({
      ...baseBody,
      messages: [
        { role: "user", content: "Hi" },
        {
          role: "assistant",
          tool_calls: [
            { id: "a", type: "function", function: { name: "f", arguments: "{}" } },
            { id: "b", type: "function", function: { name: "f", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "a", content: "result" },
      ],
    });

    expect(error.param).toBe("messages[1].role");
    expect(error.message).toContain("did not have response messages: b");
  });

  it("rejects an unsupported feature with its parameter", () => {
    const error = decodeError({ ...baseBody, n: 2 });

    expect(error.message).toBe("Unsupported Chat Completions feature: multiple candidates (n).");
    expect(error.param).toBe("n");
    expect(error.code).toBe("unsupported_feature");
    expect(error.status).toBe(400);
  });
});

describe("chatCodec.encodeJson", () => {
  it("renders a text reply with message, finish reason, and usage", () => {
    const { ctx, decoded } = decodedOf();

    const body = chatCodec.encodeJson(reply([{ type: "text", text: "Hello there" }]), decoded, ctx) as CompletionBody;

    expect(body.id).toBe("chatcmpl-1");
    expect(body.object).toBe("chat.completion");
    expect(body.created).toBe(CREATED_AT);
    expect(body.model).toBe("gpt-x");
    expect(body.choices).toHaveLength(1);
    expect(body.choices[0].index).toBe(0);
    expect(body.choices[0].message.role).toBe("assistant");
    expect(body.choices[0].message.content).toBe("Hello there");
    expect(body.choices[0].message.refusal).toBeNull();
    expect(body.choices[0].finish_reason).toBe("stop");
    expect(body.usage).toEqual({
      prompt_tokens: 5,
      completion_tokens: 2,
      total_tokens: 7,
      prompt_tokens_details: { cached_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 1 },
    });
  });

  it("renders tool calls alongside any text", () => {
    const { ctx, decoded } = decodedOf();

    const body = chatCodec.encodeJson(
      reply(
        [
          { type: "text", text: "Let me check." },
          { type: "tool_call", id: "call_1", name: "lookup", arguments: '{"city":"Paris"}' },
        ],
        "tool_calls",
      ),
      decoded,
      ctx,
    ) as CompletionBody;

    expect(body.choices[0].message.content).toBe("Let me check.");
    expect(body.choices[0].message.tool_calls).toEqual([
      { id: "call_1", type: "function", function: { name: "lookup", arguments: '{"city":"Paris"}' } },
    ]);
    expect(body.choices[0].finish_reason).toBe("tool_calls");
  });

  it("renders a refusal as native refusal content", () => {
    const { ctx, decoded } = decodedOf();

    const body = chatCodec.encodeJson(
      reply([{ type: "refusal", text: "I cannot help with that." }], "refusal"),
      decoded,
      ctx,
    ) as CompletionBody;

    expect(body.choices[0].message.content).toBeNull();
    expect(body.choices[0].message.refusal).toBe("I cannot help with that.");
    expect(body.choices[0].finish_reason).toBe("stop");
  });
});

describe("chatCodec.streamFrames", () => {
  it("writes role, content, finish, usage, then DONE in order", () => {
    const { ctx, decoded } = decodedOf({
      ...baseBody,
      stream: true,
      stream_options: { include_usage: true },
    });

    const frames = chatCodec.streamFrames(reply([{ type: "text", text: "Hello brave world" }]), decoded, ctx);

    expect(frames).toHaveLength(7);
    expect(frames.at(-1)?.data).toBe("[DONE]");

    const chunks = frames.slice(0, -1).map(chunkOf);
    for (const chunk of chunks) {
      expect(chunk.id).toBe("chatcmpl-1");
      expect(chunk.object).toBe("chat.completion.chunk");
      expect(chunk.created).toBe(CREATED_AT);
      expect(chunk.model).toBe("gpt-x");
    }

    expect(chunks[0].choices[0].delta).toEqual({ role: "assistant", content: "" });
    expect(chunks[0].choices[0].finish_reason).toBeNull();
    expect(frames[0].content).toBeUndefined();

    const contentChunks = chunks.slice(1, 4);
    expect(contentChunks.map((chunk) => chunk.choices[0].delta.content)).toEqual(["Hello ", "brave ", "world"]);
    expect(contentChunks.map((chunk) => chunk.choices[0].finish_reason)).toEqual([null, null, null]);
    expect(frames.slice(1, 4).map((frame) => frame.content)).toEqual(["Hello ", "brave ", "world"]);
    expect(contentChunks[0].choices[0].delta.role).toBeUndefined();

    expect(chunks[4].choices[0].delta).toEqual({});
    expect(chunks[4].choices[0].finish_reason).toBe("stop");
    expect(frames[4].content).toBeUndefined();

    expect(chunks[5].choices).toEqual([]);
    expect(chunks[5].usage?.total_tokens).toBe(7);
  });

  it("omits the usage chunk when include_usage is not set", () => {
    const { ctx, decoded } = decodedOf({ ...baseBody, stream: true });

    const frames = chatCodec.streamFrames(reply([{ type: "text", text: "Hello brave world" }]), decoded, ctx);

    expect(frames).toHaveLength(6);
    expect(frames.at(-1)?.data).toBe("[DONE]");
    for (const frame of frames.slice(0, -1)) {
      expect("usage" in chunkOf(frame)).toBe(false);
    }
  });

  it("streams tool call deltas with stable indexes and joined arguments", () => {
    const { ctx, decoded } = decodedOf({ ...baseBody, stream: true });

    const frames = chatCodec.streamFrames(
      reply(
        [
          { type: "tool_call", id: "call_a", name: "lookup", arguments: '{"city":"Paris"}' },
          { type: "tool_call", id: "call_b", name: "clock", arguments: "{}" },
        ],
        "tool_calls",
      ),
      decoded,
      ctx,
    );

    const toolDeltas = frames.slice(1, -2).map((frame) => chunkOf(frame).choices[0].delta.tool_calls?.[0]);
    expect(toolDeltas.map((delta) => delta?.index)).toEqual([0, 0, 1, 1]);
    expect(toolDeltas.map((delta) => delta?.id)).toEqual(["call_a", undefined, "call_b", undefined]);
    expect(toolDeltas[0]).toEqual({
      index: 0,
      id: "call_a",
      type: "function",
      function: { name: "lookup", arguments: "" },
    });

    const argsFor = (index: number) =>
      toolDeltas
        .filter((delta) => delta?.index === index)
        .map((delta) => delta?.function?.arguments ?? "")
        .join("");
    expect(argsFor(0)).toBe('{"city":"Paris"}');
    expect(JSON.parse(argsFor(0))).toEqual({ city: "Paris" });
    expect(argsFor(1)).toBe("{}");

    expect(chunkOf(frames.at(-2) as SseFrame).choices[0].finish_reason).toBe("tool_calls");
    expect(frames.at(-1)?.data).toBe("[DONE]");
  });

  it("splits a JSON reply between structural characters", () => {
    const { ctx, decoded } = decodedOf({ ...baseBody, stream: true });
    const value = { alpha: 1, beta: [2, 3], gamma: "x,y" };

    const frames = chatCodec.streamFrames(reply([{ type: "object", value }]), decoded, ctx);

    const contentFrames = frames.slice(1, -2);
    expect(contentFrames.length).toBeGreaterThan(1);
    expect(contentFrames.map((frame) => frame.content ?? "").join("")).toBe(JSON.stringify(value));
    expect(contentFrames.map((frame) => chunkOf(frame).choices[0].delta.content ?? "").join("")).toBe(
      JSON.stringify(value),
    );
    expect(frames.at(-1)?.data).toBe("[DONE]");
  });
});
