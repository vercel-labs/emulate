import { Store } from "@emulators/core";
import { describe, expect, it } from "vitest";
import type { CodecContext, Decoded } from "../codec.js";
import { deleteStoredResponse, responsesCodec } from "../codecs/openai-responses.js";
import { AiRequestError, defaultErrorType } from "../errors.js";
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
  metadata?: Record<string, string>;
  text: unknown;
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

  it("enforces the metadata limits", () => {
    const pairs = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, n) => [`k${n}`, "v"]));
    const ok = { [`k`.repeat(64)]: "v".repeat(512), ...pairs(15) };
    const { ctx, decoded } = decodedOf({ ...baseBody, metadata: ok });
    expect(encode(decoded, ctx, [{ type: "text", text: "hi" }]).metadata).toEqual(ok);
    for (const metadata of [pairs(17), { ["k".repeat(65)]: "v" }, { a: "v".repeat(513) }, { a: 1 }]) {
      expect(decodeError({ ...baseBody, metadata }).param).toMatch(/^metadata/);
    }
  });

  it("warns when a tool call receives two outputs", () => {
    const call = { type: "function_call", call_id: "call_a", name: "f", arguments: "{}" };
    const output = { type: "function_call_output", call_id: "call_a", output: "x" };
    const { decoded } = decodedOf({ ...baseBody, input: [call, output, output] });
    expect(decoded.request.warnings).toEqual(['Duplicate tool output for "call_a"; keeping both outputs.']);
  });

  it("echoes only validated text options", () => {
    const { ctx, decoded } = decodedOf({
      ...baseBody,
      text: { bogus: { a: 1 }, verbosity: "low", format: { type: "text", bogus: 1 } },
    });

    expect(encode(decoded, ctx, [{ type: "text", text: "ok" }]).text).toEqual({
      verbosity: "low",
      format: { type: "text" },
    });
  });

  it("always returns a text format, even when the request sets only verbosity or nothing", () => {
    const low = decodedOf({ ...baseBody, text: { verbosity: "low" } });
    expect(encode(low.decoded, low.ctx, [{ type: "text", text: "ok" }]).text).toEqual({
      verbosity: "low",
      format: { type: "text" },
    });

    const empty = decodedOf({ ...baseBody, text: {} });
    expect(encode(empty.decoded, empty.ctx, [{ type: "text", text: "ok" }]).text).toEqual({
      format: { type: "text" },
    });
  });

  it("echoes a json_schema text format without unknown keys", () => {
    const schema = { type: "object", additionalProperties: false };
    const { ctx, decoded } = decodedOf({
      ...baseBody,
      text: { format: { type: "json_schema", name: "n", description: "d", strict: true, schema, bogus: 1 } },
    });

    expect(encode(decoded, ctx, [{ type: "text", text: "{}" }]).text).toEqual({
      format: { type: "json_schema", name: "n", description: "d", schema, strict: true },
    });
  });

  it("rejects provider-incompatible strict tool and structured output schemas", () => {
    const loose = { type: "object", properties: { city: { type: "string" } } };

    const tool = decodeError({
      ...baseBody,
      tools: [{ type: "function", name: "lookup", parameters: loose, strict: true }],
    });
    expect(tool.param).toBe("tools[0].parameters");
    expect(tool.code).toBe("invalid_function_parameters");

    const output = decodeError({
      ...baseBody,
      text: { format: { type: "json_schema", name: "answer", schema: loose, strict: true } },
    });
    expect(output.param).toBe("text.format");
  });

  it("wraps a failure in the native error envelope", () => {
    expect(
      responsesCodec.errorBody({
        status: 400,
        type: "invalid_request_error",
        message: "Bad.",
        param: "input",
        code: "x",
      }),
    ).toEqual({
      error: { message: "Bad.", type: "invalid_request_error", param: "input", code: "x" },
    });
    expect(responsesCodec.errorBody({ status: 500, message: "Boom." })).toEqual({
      error: { message: "Boom.", type: defaultErrorType(500), param: null, code: null },
    });
  });

  it("names an unsupported feature with the unsupported_feature code", () => {
    const error = decodeError({ ...baseBody, background: true });
    expect(error.code).toBe("unsupported_feature");
    expect(error.param).toBe("background");
  });

  it("validates text.verbosity", () => {
    const error = decodeError({ ...baseBody, text: { verbosity: "loud" } });
    expect(error.message).toBe("Invalid value: 'loud'. Supported values are: 'low', 'medium', and 'high'.");
    expect(error.param).toBe("text.verbosity");
    for (const verbosity of ["low", "medium", "high"]) {
      expect(() => decodedOf({ ...baseBody, text: { verbosity } })).not.toThrow();
    }
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

  it("counts only text and tool argument deltas toward a stream fault", () => {
    const { frames } = streamOf([
      { type: "reasoning", text: "thinking hard about it" },
      { type: "text", text: "Answer" },
      { type: "tool_call", id: "call_a", name: "lookup", arguments: '{"city":"Paris"}' },
    ]);
    const counted = frames
      .filter((frame) => frame.content !== undefined)
      .map((frame) => (frame.data as { type: string }).type);

    expect(new Set(counted)).toEqual(new Set(["response.output_text.delta", "response.function_call_arguments.delta"]));
  });

  it("never splits streamed tool arguments inside a JSON string", () => {
    const args = '{"city":"San Francisco, California"}';
    const { frames } = streamOf([{ type: "tool_call", id: "call_a", name: "lookup", arguments: args }], "tool_calls");
    const deltas = frames
      .map((frame) => frame.data as { type: string; delta?: string })
      .filter((data) => data.type === "response.function_call_arguments.delta")
      .map((data) => data.delta ?? "");

    expect(deltas.join("")).toBe(args);
    expect(deltas.some((delta) => delta.includes('"San Francisco, California"'))).toBe(true);
  });
});

function storeBody(ctx: CodecContext, body: Record<string, unknown>, events: ReplyEvent[]): ResponseBody {
  const decoded = responsesCodec.decode(body, ctx);
  const turnReply = reply(events, "tool_calls");
  const encoded = responsesCodec.encodeJson(turnReply, decoded, ctx) as ResponseBody & {
    output: { type: string; id: string }[];
  };
  responsesCodec.afterReply?.(turnReply, decoded, ctx, encoded);
  return encoded;
}

describe("responsesCodec stored responses", () => {
  it("replays the previous turn when previous_response_id is set", () => {
    const ctx = makeContext();
    const id = storeTurn(ctx, "First question");

    const decoded = responsesCodec.decode({ model: "gpt-x", input: "Second question", previous_response_id: id }, ctx);

    expect(messageTexts(decoded)).toEqual(["First question", "answer First question", "Second question"]);
    expect(decoded.request.references).toEqual([{ id, kind: "previous_response", resolved: true }]);
    expect(decoded.request.warnings).toEqual([]);
  });

  it("shares replayed message objects between requests", () => {
    const ctx = makeContext();
    const id = storeTurn(ctx, "First question");

    const first = responsesCodec.decode({ model: "gpt-x", input: "a", previous_response_id: id }, ctx);
    const second = responsesCodec.decode({ model: "gpt-x", input: "b", previous_response_id: id }, ctx);

    expect(second.request.messages[0]).toBe(first.request.messages[0]);
    expect(second.request.messages[1]).toBe(first.request.messages[1]);
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
  }, 60_000);

  it("still rejects an unanswered function call after an earlier unknown item_reference", () => {
    const ctx = makeContext();
    const first = storeBody(ctx, { model: "gpt-x", input: [{ type: "item_reference", id: "fc_missing" }] }, [
      { type: "text", text: "ok" },
    ]);
    const call = storeBody(ctx, { model: "gpt-x", input: "go", previous_response_id: first.id }, [
      { type: "tool_call", id: "call_a", name: "lookup", arguments: "{}" },
    ]);

    expect(() => responsesCodec.decode({ model: "gpt-x", input: "next", previous_response_id: call.id }, ctx)).toThrow(
      AiRequestError,
    );
  });

  it("rejects unpaired tool items after an unknown item_reference", () => {
    const missing = { type: "item_reference", id: "fc_missing" };

    const orphanOutput = decodeError({
      model: "gpt-x",
      input: [missing, { type: "function_call_output", call_id: "call_gone", output: "x" }],
    });
    expect(orphanOutput.message).toBe('No function call found for tool output "call_gone".');
    expect(orphanOutput.param).toBe("input");

    const unanswered = decodeError({
      model: "gpt-x",
      input: [missing, { type: "function_call", call_id: "call_a", name: "lookup", arguments: "{}" }],
    });
    expect(unanswered.message).toBe("No tool output found for function call call_a.");
  });

  it("keeps an unknown item_reference as a dropped reference with a warning", () => {
    const { decoded } = decodedOf({
      model: "gpt-x",
      input: [
        { type: "item_reference", id: "fc_missing" },
        { role: "user", content: "hi" },
      ],
    });

    expect(decoded.request.warnings).toEqual(['Unknown item_reference "fc_missing"; dropping it.']);
    expect(decoded.request.references).toEqual([{ id: "fc_missing", kind: "item", resolved: false }]);
  });

  it("still relaxes tool pairing after an unknown previous_response_id", () => {
    const { decoded } = decodedOf({
      model: "gpt-x",
      previous_response_id: "resp_missing",
      input: [{ type: "function_call_output", call_id: "call_gone", output: "x" }],
    });

    expect(decoded.request.warnings).toContain(
      'Tool result "call_gone" does not match a known call; accepting it because referenced history is missing.',
    );
  });

  it("adds a referenced item once when previous_response_id already replays it", () => {
    const ctx = makeContext();
    const call = storeBody(ctx, { model: "gpt-x", input: "go" }, [
      { type: "tool_call", id: "call_a", name: "lookup", arguments: "{}" },
    ]);
    const itemId = (call as unknown as { output: { id: string }[] }).output[0].id;
    const reference = { type: "item_reference", id: itemId };

    const decoded = responsesCodec.decode(
      {
        model: "gpt-x",
        previous_response_id: call.id,
        input: [reference, reference, { type: "function_call_output", call_id: "call_a", output: "x" }],
      },
      ctx,
    );

    const calls = decoded.request.messages.flatMap((message) =>
      message.parts.filter((part) => part.type === "tool_call"),
    );
    expect(calls).toHaveLength(1);
    expect(decoded.request.references.filter((entry) => entry.kind === "item")).toHaveLength(2);
  });

  it("keeps a removed response's item resolvable through the child that folded it", () => {
    const ctx = makeContext();
    const first = storeBody(ctx, { model: "gpt-x", input: "first" }, [{ type: "text", text: "one" }]);
    const itemId = (first as unknown as { output: { id: string }[] }).output[0].id;
    const second = storeBody(ctx, { model: "gpt-x", input: "second", previous_response_id: first.id }, [
      { type: "text", text: "two" },
    ]);
    deleteStoredResponse(ctx, first.id);

    const decoded = responsesCodec.decode(
      { model: "gpt-x", previous_response_id: second.id, input: [{ type: "item_reference", id: itemId }, "third"] },
      ctx,
    );

    expect(messageTexts(decoded)).toEqual(["first", "one", "second", "two", "third"]);
    expect(decoded.request.references).toContainEqual({ id: itemId, kind: "item", resolved: true });
    expect(decoded.request.warnings).toEqual([]);
  });

  it("keeps item ids through two folds", () => {
    const ctx = makeContext();
    const first = storeBody(ctx, { model: "gpt-x", input: "first" }, [{ type: "text", text: "one" }]);
    const itemId = (first as unknown as { output: { id: string }[] }).output[0].id;
    const second = storeBody(ctx, { model: "gpt-x", input: "second", previous_response_id: first.id }, [
      { type: "text", text: "two" },
    ]);
    const third = storeBody(ctx, { model: "gpt-x", input: "third", previous_response_id: second.id }, [
      { type: "text", text: "four" },
    ]);
    deleteStoredResponse(ctx, first.id);
    deleteStoredResponse(ctx, second.id);

    const decoded = responsesCodec.decode(
      { model: "gpt-x", previous_response_id: third.id, input: [{ type: "item_reference", id: itemId }] },
      ctx,
    );

    expect(messageTexts(decoded)).toEqual(["first", "one", "second", "two", "third", "four"]);
    expect(decoded.request.references).toContainEqual({ id: itemId, kind: "item", resolved: true });
    expect(decoded.request.warnings).toEqual([]);
  });

  it("resolves an item from an unrelated stored response only until that response is deleted", () => {
    const ctx = makeContext();
    const first = storeBody(ctx, { model: "gpt-x", input: "first" }, [{ type: "text", text: "one" }]);
    const itemId = (first as unknown as { output: { id: string }[] }).output[0].id;
    const request = { model: "gpt-x", input: [{ type: "item_reference", id: itemId }, "third"] };

    const stored = responsesCodec.decode(request, ctx);
    expect(messageTexts(stored)).toEqual(["one", "third"]);
    expect(stored.request.references).toEqual([{ id: itemId, kind: "item", resolved: true }]);

    deleteStoredResponse(ctx, first.id);
    const deleted = responsesCodec.decode(request, ctx);
    expect(messageTexts(deleted)).toEqual(["third"]);
    expect(deleted.request.references).toEqual([{ id: itemId, kind: "item", resolved: false }]);
    expect(deleted.request.warnings).toEqual([`Unknown item_reference "${itemId}"; dropping it.`]);
  });
});
