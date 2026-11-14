import { Store } from "@emulators/core";
import { describe, expect, it } from "vitest";
import type { CodecContext, Decoded } from "../codec.js";
import { responsesCodec } from "../codecs/openai-responses.js";
import { AiRequestError } from "../errors.js";
import { parseConfig } from "../rules.js";
import { resetAiState, STORED_RESPONSE_LIMIT } from "../state.js";
import type { SseFrame } from "../sse.js";
import type { FinishReason, Reply, ReplyEvent, Usage } from "../types.js";

interface ResponseBody {
  id: string;
  object: string;
  status: string;
  model: string;
  output: { type: string; content?: { type: string; text: string }[] }[];
  temperature: number | null;
  top_p: number | null;
  truncation: string;
  reasoning: { effort?: string | null; summary?: string | null };
  previous_response_id: string | null;
  usage?: { total_tokens: number };
}

const baseBody = { model: "gpt-x", input: "Hi" };
const usage: Usage = { input: 5, output: 2, reasoning: 1 };

function makeContext(): CodecContext {
  const store = new Store();
  const state = resetAiState(store, parseConfig({}));
  let next = 0;
  return {
    store,
    state,
    path: "/v1/responses",
    makeId: (prefix) => `${prefix}_${(next += 1)}`,
  };
}

function reply(events: ReplyEvent[], finish: FinishReason = "stop"): Reply {
  return { events, finish, usage };
}

function decodedOf(body: Record<string, unknown> = baseBody): { ctx: CodecContext; decoded: Decoded } {
  const ctx = makeContext();
  return { ctx, decoded: responsesCodec.decode(body, ctx) };
}

function decodeError(body: unknown): AiRequestError {
  try {
    responsesCodec.decode(body, makeContext());
  } catch (error) {
    if (error instanceof AiRequestError) return error;
    throw error;
  }
  throw new Error("expected decode to fail");
}

function encode(
  decoded: Decoded,
  ctx: CodecContext,
  events: ReplyEvent[],
  finish: FinishReason = "stop",
): ResponseBody {
  return responsesCodec.encodeJson(reply(events, finish), decoded, ctx) as ResponseBody;
}

function eventTypes(frames: SseFrame[]): (string | undefined)[] {
  return frames.map((frame) => frame.event);
}

function sequenceNumbers(frames: SseFrame[]): number[] {
  return frames.map((frame) => (frame.data as { sequence_number: number }).sequence_number);
}

function streamOf(
  events: ReplyEvent[],
  finish: FinishReason = "stop",
): { frames: SseFrame[]; types: (string | undefined)[]; numbers: number[] } {
  const { ctx, decoded } = decodedOf();
  const frames = responsesCodec.streamFrames(reply(events, finish), decoded, ctx);
  return { frames, types: eventTypes(frames), numbers: sequenceNumbers(frames) };
}

function messageTexts(decoded: Decoded): string[] {
  return decoded.request.messages.map((message) =>
    message.parts.map((part) => (part.type === "text" ? part.text : "")).join(""),
  );
}

function storeTurn(ctx: CodecContext, text: string, previousResponseId?: string): string {
  const decoded = responsesCodec.decode(
    {
      model: "gpt-x",
      input: text,
      ...(previousResponseId === undefined ? {} : { previous_response_id: previousResponseId }),
    },
    ctx,
  );
  const turnReply = reply([{ type: "text", text: `answer ${text}` }]);
  const body = responsesCodec.encodeJson(turnReply, decoded, ctx) as ResponseBody;
  responsesCodec.afterReply?.(turnReply, decoded, ctx, body);
  return body.id;
}

describe("responsesCodec.decode validation", () => {
  it("rejects temperature and top_p outside their range", () => {
    const high = decodeError({ ...baseBody, temperature: 99 });
    expect(high.param).toBe("temperature");
    expect(high.code).toBe("decimal_above_max_value");

    const low = decodeError({ ...baseBody, temperature: -1 });
    expect(low.param).toBe("temperature");
    expect(low.code).toBe("decimal_below_min_value");

    const topP = decodeError({ ...baseBody, top_p: 3 });
    expect(topP.param).toBe("top_p");
    expect(topP.code).toBe("decimal_above_max_value");
  });

  it("rejects unknown reasoning efforts and summaries", () => {
    const effort = decodeError({ ...baseBody, reasoning: { effort: "bogus" } });
    expect(effort.param).toBe("reasoning.effort");
    expect(effort.code).toBe("invalid_value");
    expect(effort.message).toContain("'bogus'");
    expect(effort.message).toContain("'none'");
    expect(effort.message).toContain("'max'");

    const summary = decodeError({ ...baseBody, reasoning: { summary: "loud" } });
    expect(summary.param).toBe("reasoning.summary");
    expect(summary.code).toBe("invalid_value");
  });

  it("accepts and echoes boundary sampling values and known reasoning fields", () => {
    const upper = decodedOf({ ...baseBody, temperature: 2, top_p: 1, reasoning: { effort: "max", summary: "auto" } });
    const upperBody = encode(upper.decoded, upper.ctx, [{ type: "text", text: "hi" }]);
    expect(upperBody.temperature).toBe(2);
    expect(upperBody.top_p).toBe(1);
    expect(upperBody.reasoning).toEqual({ effort: "max", summary: "auto" });

    const lower = decodedOf({ ...baseBody, temperature: 0, top_p: 0 });
    const lowerBody = encode(lower.decoded, lower.ctx, [{ type: "text", text: "hi" }]);
    expect(lowerBody.temperature).toBe(0);
    expect(lowerBody.top_p).toBe(0);
  });

  it("rejects an unknown truncation value with the native message", () => {
    const error = decodeError({ ...baseBody, truncation: "sometimes" });
    expect(error.message).toBe("Invalid value: 'sometimes'. Supported values are: 'auto' and 'disabled'.");
    expect(error.param).toBe("truncation");
    expect(error.code).toBe("invalid_value");
  });

  it("marks a refusal item incomplete when the reply finishes with length", () => {
    const { ctx, decoded } = decodedOf();
    const body = encode(decoded, ctx, [{ type: "refusal", text: "no" }], "length");
    expect(body.status).toBe("incomplete");
    expect(body.output[0]).toMatchObject({ type: "message", status: "incomplete" });
  });
});

describe("responsesCodec.streamFrames", () => {
  it("orders text reply events and ends with response.completed", () => {
    const { types, numbers } = streamOf([{ type: "text", text: "Hello brave world" }]);

    expect(types).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ]);
    expect(numbers).toEqual(numbers.map((_value, index) => numbers[0] + index));
    expect(types.at(-1)).toBe("response.completed");
  });

  it("orders tool call reply events and ends with response.completed", () => {
    const { types, numbers } = streamOf(
      [{ type: "tool_call", id: "call_a", name: "lookup", arguments: '{"city":"Paris"}' }],
      "tool_calls",
    );

    expect(types).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.done",
      "response.output_item.done",
      "response.completed",
    ]);
    expect(numbers).toEqual(numbers.map((_value, index) => numbers[0] + index));
    expect(types.at(-1)).toBe("response.completed");
  });

  it("orders reasoning before text events and ends with response.completed", () => {
    const { types, numbers } = streamOf([
      { type: "reasoning", text: "thinking hard" },
      { type: "text", text: "Answer" },
    ]);

    expect(types).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.reasoning_summary_part.added",
      "response.reasoning_summary_text.delta",
      "response.reasoning_summary_text.delta",
      "response.reasoning_summary_text.done",
      "response.reasoning_summary_part.done",
      "response.output_item.done",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ]);
    expect(numbers).toEqual(numbers.map((_value, index) => numbers[0] + index));
    expect(types.at(-1)).toBe("response.completed");
  });
});

describe("responsesCodec stored responses", () => {
  it("replays the previous turn when previous_response_id is set", () => {
    const ctx = makeContext();
    const id = storeTurn(ctx, "First question");

    const decoded = responsesCodec.decode({ model: "gpt-x", input: "Second question", previous_response_id: id }, ctx);

    expect(messageTexts(decoded)).toEqual(["First question", "answer First question", "Second question"]);
    expect(decoded.request.references).toEqual([{ id, kind: "previous_response", resolved: true }]);
    expect(decoded.request.warnings).toEqual([]);
  });

  it("keeps the whole conversation after the oldest stored responses are evicted", () => {
    const ctx = makeContext();
    let last = "";
    for (let index = 0; index <= STORED_RESPONSE_LIMIT; index += 1) {
      last = storeTurn(ctx, `turn ${index}`, index === 0 ? undefined : last);
    }

    expect(ctx.state.responses.size).toBe(STORED_RESPONSE_LIMIT);
    expect(ctx.state.responses.has("resp_1")).toBe(false);

    const decoded = responsesCodec.decode({ model: "gpt-x", input: "final", previous_response_id: last }, ctx);
    const texts = messageTexts(decoded);

    expect(texts).toHaveLength(STORED_RESPONSE_LIMIT * 2 + 3);
    expect(texts.slice(0, 4)).toEqual(["turn 0", "answer turn 0", "turn 1", "answer turn 1"]);
    expect(texts.at(-1)).toBe("final");
    expect(decoded.request.references).toEqual([{ id: last, kind: "previous_response", resolved: true }]);
    expect(decoded.request.warnings).toEqual([]);
  });
});
