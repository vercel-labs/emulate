import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionMessage,
  ChatCompletionMessageFunctionToolCall,
} from "openai/resources/chat/completions";
import { assertOutputSupported, assertToolsSupported } from "../schema-dialects.js";
import type { CompletionUsage } from "openai/resources/completions";
import type { ErrorObject } from "openai/resources/shared";
import { decodeChatAttachment } from "../attachments.js";
import { jsonChunks, textChunks } from "../chunks.js";
import { CREATED_AT, type Codec, type CodecContext, type Decoded } from "../codec.js";
import { AiRequestError, defaultErrorType } from "../errors.js";
import type { SseFrame } from "../sse.js";
import type {
  AIRequest,
  FinishReason,
  HttpFailure,
  InputPart,
  JsonSchema,
  Message,
  OutputSpec,
  Reply,
  ReplyEvent,
  ToolChoice,
  ToolDefinition,
} from "../types.js";

const FORMAT = "openai-chat";

/** The reasoning efforts OpenAI accepts, shared by the Chat Completions and Responses codecs. */
export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

interface ChatExtras {
  includeUsage: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string, param?: string, code?: string): never {
  throw new AiRequestError(message, param, code);
}

function unsupported(param: string, feature: string): never {
  throw new AiRequestError(
    `Unsupported Chat Completions feature: ${feature} (${param}).`,
    param,
    "unsupported_feature",
  );
}

function expectString(value: unknown, path: string, nonEmpty = false): string {
  if (typeof value !== "string") fail("Expected a string.", path);
  if (nonEmpty && value.length === 0) fail("Expected a non-empty string.", path);
  return value;
}

function expectBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail("Expected a boolean.", path);
  return value;
}

function expectInteger(value: unknown, path: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isInteger(value)) fail("Expected an integer.", path);
  if (value < minimum) fail(`Expected an integer greater than or equal to ${minimum}.`, path);
  return value;
}

function textParts(content: unknown, path: string): InputPart[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) fail("Expected a string or an array of text parts.", path);
  return content.map((part, index) => {
    if (!isRecord(part) || part.type !== "text") fail("Expected a text content part.", `${path}[${index}]`);
    return { type: "text", text: expectString(part.text, `${path}[${index}].text`) };
  });
}

function userParts(content: unknown, path: string): InputPart[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) fail("Expected a string or an array of content parts.", path);
  return content.flatMap((part, index): InputPart[] => {
    const at = `${path}[${index}]`;
    if (!isRecord(part)) fail("Expected a content part.", at);
    switch (part.type) {
      case "text":
        return [{ type: "text", text: expectString(part.text, `${at}.text`) }];
      case "image_url":
      case "file": {
        const file = decodeChatAttachment(part, at);
        if (!file) fail("Expected an attachment part.", at);
        return [file];
      }
      case "input_audio":
        return unsupported(`${at}.input_audio`, "audio input");
      case undefined:
        return fail("Expected a content part type.", `${at}.type`);
      default:
        return unsupported(`${at}.${String(part.type)}`, `content part "${String(part.type)}"`);
    }
  });
}

function assistantParts(message: Record<string, unknown>, path: string): InputPart[] {
  const parts: InputPart[] = [];
  if (message.content !== undefined && message.content !== null) {
    if (typeof message.content === "string") {
      parts.push({ type: "text", text: message.content });
    } else if (Array.isArray(message.content)) {
      message.content.forEach((part, index) => {
        const at = `${path}.content[${index}]`;
        if (!isRecord(part)) fail("Expected a content part.", at);
        if (part.type === "text") parts.push({ type: "text", text: expectString(part.text, `${at}.text`) });
        else if (part.type === "refusal") {
          parts.push({ type: "text", text: expectString(part.refusal, `${at}.refusal`) });
        } else unsupported(`${at}.${String(part.type)}`, `assistant content part "${String(part.type)}"`);
      });
    } else {
      fail("Expected a string or an array of assistant content parts.", `${path}.content`);
    }
  }
  if (message.refusal !== undefined && message.refusal !== null) {
    parts.push({ type: "text", text: expectString(message.refusal, `${path}.refusal`) });
  }
  if (message.function_call !== undefined && message.function_call !== null) {
    unsupported(`${path}.function_call`, "legacy function_call");
  }
  if (message.tool_calls !== undefined) {
    if (!Array.isArray(message.tool_calls)) fail("Expected an array of tool calls.", `${path}.tool_calls`);
    message.tool_calls.forEach((call, index) => {
      const at = `${path}.tool_calls[${index}]`;
      if (!isRecord(call)) fail("Expected a tool call.", at);
      if (call.type !== "function") {
        unsupported(`${at}.type`, call.type === "custom" ? "custom tools" : `tool call type "${String(call.type)}"`);
      }
      const fn = call.function;
      if (!isRecord(fn)) fail("Expected a function object.", `${at}.function`);
      parts.push({
        type: "tool_call",
        id: expectString(call.id, `${at}.id`, true),
        name: expectString(fn.name, `${at}.function.name`, true),
        arguments: expectString(fn.arguments, `${at}.function.arguments`),
      });
    });
  }
  if (parts.length === 0 && message.tool_calls === undefined) {
    fail("Assistant messages require content or tool_calls.", path);
  }
  return parts;
}

function toolParts(message: Record<string, unknown>, path: string): InputPart[] {
  const id = expectString(message.tool_call_id, `${path}.tool_call_id`, true);
  const output = textParts(message.content, `${path}.content`)
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
  return [{ type: "tool_result", id, output }];
}

function decodeMessage(raw: unknown, index: number): Message {
  const path = `messages[${index}]`;
  if (!isRecord(raw)) fail("Expected a message object.", path);
  const role = raw.role;
  switch (role) {
    case "system":
    case "developer":
      return { role, parts: textParts(raw.content, `${path}.content`) };
    case "user":
      return { role, parts: userParts(raw.content, `${path}.content`) };
    case "assistant":
      return { role, parts: assistantParts(raw, path) };
    case "tool":
      return { role, parts: toolParts(raw, path) };
    case "function":
      return unsupported(`${path}.role`, "legacy function messages");
    case undefined:
      return fail("Expected a message role.", `${path}.role`);
    default:
      return fail(`Unsupported message role "${String(role)}".`, `${path}.role`);
  }
}

function checkToolPairing(messages: Message[]): void {
  let pending = new Set<string>();
  let openedAt = -1;
  const unanswered = () =>
    fail(
      `An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'. The following tool_call_ids did not have response messages: ${[...pending].join(", ")}`,
      `messages[${openedAt}].role`,
    );
  messages.forEach((message, index) => {
    if (message.role === "tool") {
      const part = message.parts[0];
      if (part?.type !== "tool_result" || !pending.delete(part.id)) {
        fail(
          "Invalid parameter: messages with role 'tool' must be a response to a preceding message with 'tool_calls'.",
          `messages[${index}].role`,
        );
      }
      return;
    }
    if (pending.size > 0) unanswered();
    const ids = message.parts.flatMap((part) => (part.type === "tool_call" ? [part.id] : []));
    pending = new Set(ids);
    openedAt = index;
  });
  if (pending.size > 0) unanswered();
}

function decodeTools(raw: unknown): ToolDefinition[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) fail("Expected an array of tools.", "tools");
  return raw.map((tool, index) => {
    const at = `tools[${index}]`;
    if (!isRecord(tool)) fail("Expected a tool object.", at);
    if (tool.type !== "function") {
      unsupported(`${at}.type`, tool.type === "custom" ? "custom tools" : "hosted tools");
    }
    const fn = tool.function;
    if (!isRecord(fn)) fail("Expected a function object.", `${at}.function`);
    const parameters = fn.parameters;
    if (parameters !== undefined && typeof parameters !== "boolean" && !isRecord(parameters)) {
      fail("Expected a JSON Schema object.", `${at}.function.parameters`);
    }
    const definition: ToolDefinition = { name: expectString(fn.name, `${at}.function.name`, true) };
    if (fn.description !== undefined) {
      definition.description = expectString(fn.description, `${at}.function.description`);
    }
    if (parameters !== undefined) definition.parameters = parameters as JsonSchema;
    if (fn.strict !== undefined && fn.strict !== null && expectBoolean(fn.strict, `${at}.function.strict`)) {
      definition.strict = true;
    }
    return definition;
  });
}

function decodeToolChoice(raw: unknown, hasTools: boolean): ToolChoice {
  if (raw === undefined || raw === null) return hasTools ? "auto" : "none";
  if (raw === "none" || raw === "auto" || raw === "required") return raw;
  if (!isRecord(raw)) fail("Expected a tool choice.", "tool_choice");
  if (raw.type === "function") {
    if (!isRecord(raw.function)) fail("Expected a function object.", "tool_choice.function");
    return { name: expectString(raw.function.name, "tool_choice.function.name", true) };
  }
  if (raw.type === "allowed_tools") return unsupported("tool_choice.allowed_tools", "allowed tools");
  if (raw.type === "custom") return unsupported("tool_choice", "custom tools");
  return fail("Expected a supported tool choice.", "tool_choice");
}

function decodeOutput(raw: unknown): OutputSpec | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw)) fail("Expected a response_format object.", "response_format");
  switch (raw.type) {
    case "text":
      return undefined;
    case "json_object":
      return { kind: "json_object" };
    case "json_schema": {
      const jsonSchema = raw.json_schema;
      if (!isRecord(jsonSchema)) fail("Expected a json_schema object.", "response_format.json_schema");
      if (jsonSchema.schema === undefined) fail("Expected a schema.", "response_format.json_schema.schema");
      if (typeof jsonSchema.schema !== "boolean" && !isRecord(jsonSchema.schema)) {
        fail("Expected a JSON Schema object.", "response_format.json_schema.schema");
      }
      if (jsonSchema.strict !== undefined && jsonSchema.strict !== null && typeof jsonSchema.strict !== "boolean") {
        fail("Expected a boolean.", "response_format.json_schema.strict");
      }
      return {
        kind: "json_schema",
        ...(jsonSchema.name === undefined
          ? {}
          : { name: expectString(jsonSchema.name, "response_format.json_schema.name", true) }),
        ...(jsonSchema.strict === true ? { strict: true } : {}),
        schema: jsonSchema.schema as JsonSchema,
      };
    }
    default:
      return unsupported(`response_format.${String(raw.type)}`, `response format "${String(raw.type)}"`);
  }
}

function decodeStop(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "string") return [raw];
  if (!Array.isArray(raw)) fail("Expected a string or an array of strings.", "stop");
  return raw.map((value, index) => expectString(value, `stop[${index}]`));
}

function decodeMaxTokens(raw: Record<string, unknown>): number | undefined {
  const value = raw.max_completion_tokens ?? raw.max_tokens;
  if (value === undefined || value === null) return undefined;
  return expectInteger(value, raw.max_completion_tokens !== undefined ? "max_completion_tokens" : "max_tokens");
}

function decodeReasoning(raw: unknown): boolean {
  if (raw === undefined || raw === null) return false;
  const effort = expectString(raw, "reasoning_effort", true);
  if (!(REASONING_EFFORTS as readonly string[]).includes(effort)) {
    fail(`Expected one of ${REASONING_EFFORTS.join(", ")}.`, "reasoning_effort");
  }
  return effort !== "none";
}

function decodeChat(body: unknown): Decoded {
  if (!isRecord(body)) fail("Expected a JSON object request body.", "body");
  if (body.audio !== undefined && body.audio !== null) unsupported("audio", "audio output");
  if (body.modalities !== undefined && body.modalities !== null) {
    const modalities = body.modalities;
    if (!Array.isArray(modalities) || modalities.some((value) => value !== "text")) {
      unsupported("modalities", "audio output");
    }
  }
  if (body.web_search_options !== undefined && body.web_search_options !== null) {
    unsupported("web_search_options", "hosted tools");
  }
  if (body.background === true) unsupported("background", "background mode");
  if (body.conversation !== undefined && body.conversation !== null) unsupported("conversation", "conversations");
  if (body.conversations !== undefined && body.conversations !== null) unsupported("conversations", "conversations");
  if (body.functions !== undefined) {
    if (!Array.isArray(body.functions)) fail("Expected an array of functions.", "functions");
    if (body.functions.length > 0) unsupported("functions", "legacy functions");
  }
  if (body.function_call !== undefined && body.function_call !== null && body.function_call !== "none") {
    unsupported("function_call", "legacy function_call");
  }

  const model = expectString(body.model, "model", true);
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    fail("Expected a non-empty array of messages.", "messages");
  }
  const messages = body.messages.map((message, index) => decodeMessage(message, index));
  checkToolPairing(messages);
  const tools = decodeTools(body.tools);
  assertToolsSupported(model, tools, (index) => `tools[${index}].function.parameters`);
  const toolChoice = decodeToolChoice(body.tool_choice, tools.length > 0);
  const output = decodeOutput(body.response_format);
  assertOutputSupported(model, output, { format: "response_format", strict: "response_format.json_schema.strict" });

  const stream = body.stream === undefined || body.stream === null ? false : expectBoolean(body.stream, "stream");
  const store = body.store === undefined || body.store === null ? false : expectBoolean(body.store, "store");
  const parallelToolCalls =
    body.parallel_tool_calls === undefined ? true : expectBoolean(body.parallel_tool_calls, "parallel_tool_calls");

  let includeUsage = false;
  if (body.stream_options !== undefined && body.stream_options !== null) {
    if (!isRecord(body.stream_options)) fail("Expected a stream_options object.", "stream_options");
    if (body.stream_options.include_usage !== undefined) {
      includeUsage = expectBoolean(body.stream_options.include_usage, "stream_options.include_usage");
    }
  }

  if (body.n !== undefined && body.n !== null) {
    const n = expectInteger(body.n, "n", 1);
    if (n !== 1) unsupported("n", "multiple candidates");
  }

  const maxOutputTokens = decodeMaxTokens(body);
  const stop = decodeStop(body.stop);
  const request: AIRequest = {
    format: FORMAT,
    model,
    messages,
    tools,
    toolChoice,
    parallelToolCalls,
    stream,
    ...(output === undefined ? {} : { output }),
    reasoning: decodeReasoning(body.reasoning_effort),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    ...(stop === undefined ? {} : { stop }),
    store,
    references: [],
    warnings: [],
  };

  const extras: ChatExtras = { includeUsage };
  return { request, extras: extras as unknown as Record<string, unknown> };
}

function usageBody(reply: Reply): CompletionUsage {
  return {
    prompt_tokens: reply.usage.input,
    completion_tokens: reply.usage.output,
    total_tokens: reply.usage.input + reply.usage.output,
    prompt_tokens_details: { cached_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: reply.usage.reasoning },
  };
}

function finishReason(finish: FinishReason): ChatCompletion.Choice["finish_reason"] {
  switch (finish) {
    case "stop":
    case "refusal":
      return "stop";
    case "tool_calls":
      return "tool_calls";
    case "length":
      return "length";
    case "content_filter":
      return "content_filter";
  }
}

function toolCallsOf(events: ReplyEvent[]): ChatCompletionMessageFunctionToolCall[] {
  const calls: ChatCompletionMessageFunctionToolCall[] = [];
  for (const event of events) {
    if (event.type !== "tool_call") continue;
    calls.push({
      id: event.id,
      type: "function",
      function: { name: event.name, arguments: event.arguments },
    });
  }
  return calls;
}

function textOf(events: ReplyEvent[]): { text: string; refusal: string } {
  let text = "";
  let refusal = "";
  for (const event of events) {
    if (event.type === "text") text += event.text;
    else if (event.type === "object") text += JSON.stringify(event.value);
    else if (event.type === "refusal") refusal += event.text;
  }
  return { text, refusal };
}

function encodeJson(reply: Reply, decoded: Decoded, ctx: CodecContext): ChatCompletion {
  const { text, refusal } = textOf(reply.events);
  const toolCalls = toolCallsOf(reply.events);
  const message: ChatCompletionMessage = {
    role: "assistant",
    content: text.length > 0 ? text : null,
    refusal: refusal.length > 0 ? refusal : null,
    annotations: [],
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
  const body: ChatCompletion = {
    id: ctx.makeId("chatcmpl").replace("_", "-"),
    object: "chat.completion",
    created: CREATED_AT,
    model: decoded.request.model,
    choices: [
      {
        index: 0,
        message,
        logprobs: null,
        finish_reason: finishReason(reply.finish),
      },
    ],
    usage: usageBody(reply),
  };
  return body;
}

function chunk(
  id: string,
  model: string,
  delta: ChatCompletionChunk.Choice.Delta,
  choiceFinish: ChatCompletionChunk.Choice["finish_reason"],
  includeUsage: boolean,
  usage: CompletionUsage | null = null,
): ChatCompletionChunk {
  return {
    id,
    object: "chat.completion.chunk",
    created: CREATED_AT,
    model,
    choices: [{ index: 0, delta, logprobs: null, finish_reason: choiceFinish }],
    ...(includeUsage ? { usage } : {}),
  };
}

function streamFrames(reply: Reply, decoded: Decoded, ctx: CodecContext): SseFrame[] {
  const { includeUsage } = decoded.extras as unknown as ChatExtras;
  const id = ctx.makeId("chatcmpl").replace("_", "-");
  const model = decoded.request.model;
  const frames: SseFrame[] = [{ data: chunk(id, model, { role: "assistant", content: "" }, null, includeUsage) }];

  let toolIndex = 0;
  for (const event of reply.events) {
    switch (event.type) {
      case "reasoning":
        break;
      case "text":
      case "object": {
        const text = event.type === "text" ? event.text : JSON.stringify(event.value);
        const pieces = event.type === "text" ? textChunks(text) : jsonChunks(text);
        for (const piece of pieces) {
          frames.push({
            data: chunk(id, model, { content: piece }, null, includeUsage),
            content: piece,
          });
        }
        break;
      }
      case "refusal": {
        for (const piece of textChunks(event.text)) {
          frames.push({
            data: chunk(id, model, { refusal: piece }, null, includeUsage),
            content: piece,
          });
        }
        break;
      }
      case "tool_call": {
        const index = toolIndex;
        toolIndex += 1;
        frames.push({
          data: chunk(
            id,
            model,
            {
              tool_calls: [
                {
                  index,
                  id: event.id,
                  type: "function",
                  function: { name: event.name, arguments: "" },
                },
              ],
            },
            null,
            includeUsage,
          ),
        });
        for (const piece of textChunks(event.arguments)) {
          frames.push({
            data: chunk(id, model, { tool_calls: [{ index, function: { arguments: piece } }] }, null, includeUsage),
            content: piece,
          });
        }
        break;
      }
    }
  }

  frames.push({
    data: chunk(id, model, {}, finishReason(reply.finish), includeUsage),
  });
  if (includeUsage) {
    frames.push({
      data: {
        id,
        object: "chat.completion.chunk",
        created: CREATED_AT,
        model,
        choices: [],
        usage: usageBody(reply),
      } satisfies ChatCompletionChunk,
    });
  }
  frames.push({ data: "[DONE]" });
  return frames;
}

function errorBody(failure: HttpFailure): { error: ErrorObject } {
  return {
    error: {
      message: failure.message,
      type: failure.type ?? defaultErrorType(failure.status),
      param: failure.param ?? null,
      code: failure.code ?? null,
    },
  };
}

/** The OpenAI Chat Completions wire format codec. */
export const chatCodec: Codec = {
  format: FORMAT,
  decode: (body) => decodeChat(body),
  encodeJson,
  streamFrames,
  errorBody,
};
