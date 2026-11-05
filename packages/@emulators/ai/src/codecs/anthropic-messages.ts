import { AiRequestError } from "../errors.js";
import { jsonChunks, payloadChunks } from "../chunks.js";
import type { Codec, CodecContext, Decoded } from "../codec.js";
import { assertSchemaSupported } from "../schema-dialects.js";
import type { SseFrame } from "../sse.js";
import type {
  AIRequest,
  FilePart,
  FinishReason,
  HttpFailure,
  InputPart,
  Json,
  JsonSchema,
  Message,
  OutputSpec,
  Reply,
  ReplyEvent,
  ToolChoice,
  ToolDefinition,
} from "../types.js";

const REQUEST_ID = "req_emulate";

const ERROR_TYPES: Record<number, string> = {
  400: "invalid_request_error",
  401: "authentication_error",
  403: "permission_error",
  404: "not_found_error",
  413: "request_too_large",
  429: "rate_limit_error",
  500: "api_error",
  529: "overloaded_error",
};

interface TextBlock {
  type: "text";
  text: string;
}

interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Json;
}

type ContentBlock = TextBlock | ToolUseBlock;

interface WireMessage {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: ContentBlock[];
  stop_reason: string;
  stop_sequence: string | null;
  usage: { input_tokens: number; output_tokens: number };
}

interface ErrorBody {
  type: "error";
  error: { type: string; message: string };
  request_id: string;
}

function fail(message: string, param?: string): never {
  throw new AiRequestError(message, param);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) fail("Expected a non-empty string.", path);
  return value;
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") fail("Expected a string.", path);
  return value;
}

function requireNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail("Expected a number.", path);
  return value;
}

function optionalBoolean(value: unknown, path: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") fail("Expected a boolean.", path);
  return value;
}

function textOfContent(value: unknown, path: string): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) fail("Expected a string or an array of content blocks.", path);
  return value
    .map((block, index) => {
      if (!isRecord(block)) fail("Expected a content block object.", `${path}.${index}`);
      if (block.type === "text") return requireString(block.text, `${path}.${index}.text`);
      return JSON.stringify(block);
    })
    .join("\n");
}

function decodeFile(block: Record<string, unknown>, path: string, kind: string): FilePart {
  const source = block.source;
  if (!isRecord(source)) fail("Expected a source object.", `${path}.source`);
  if (source.type === "base64") {
    const mediaType = requireString(source.media_type, `${path}.source.media_type`);
    const data = requireString(source.data, `${path}.source.data`);
    return { type: "file", mediaType, source: "inline", bytes: Math.round((data.length * 3) / 4) };
  }
  if (source.type === "url") {
    return {
      type: "file",
      mediaType: kind === "image" ? "image/*" : "application/octet-stream",
      source: "url",
      ref: requireString(source.url, `${path}.source.url`),
    };
  }
  return fail(`Unsupported source type "${String(source.type)}".`, `${path}.source.type`);
}

function decodeBlock(block: unknown, path: string): InputPart {
  if (!isRecord(block)) fail("Expected a content block object.", path);
  switch (block.type) {
    case "text":
      return { type: "text", text: requireString(block.text, `${path}.text`) };
    case "image":
      return decodeFile(block, path, "image");
    case "document":
      return decodeFile(block, path, "document");
    case "tool_use":
      return {
        type: "tool_call",
        id: requireString(block.id, `${path}.id`),
        name: requireString(block.name, `${path}.name`),
        arguments: JSON.stringify(block.input ?? {}),
      };
    case "tool_result": {
      const id = requireString(block.tool_use_id, `${path}.tool_use_id`);
      const output = textOfContent(block.content, `${path}.content`);
      const name = optionalString(block.name, `${path}.name`);
      return {
        type: "tool_result",
        id,
        ...(name === undefined ? {} : { name }),
        output,
        ...(block.is_error === true ? { isError: true } : {}),
      };
    }
    case "thinking":
    case "redacted_thinking":
      return { type: "text", text: typeof block.thinking === "string" ? block.thinking : "" };
    default:
      return fail(`Unsupported content block type "${String(block.type)}".`, `${path}.type`);
  }
}

function decodeContent(content: unknown, path: string): InputPart[] {
  if (content === undefined || content === null) return [];
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) fail("Expected a string or an array of content blocks.", path);
  return content.map((block, index) => decodeBlock(block, `${path}.${index}`));
}

function decodeMessage(raw: unknown, path: string): Message {
  if (!isRecord(raw)) fail("Expected a message object.", path);
  const role = raw.role;
  if (role !== "user" && role !== "assistant") fail('Expected "user" or "assistant".', `${path}.role`);
  return { role, parts: decodeContent(raw.content, `${path}.content`) };
}

function decodeSystem(raw: unknown): InputPart[] {
  if (raw === undefined || raw === null) return [];
  return decodeContent(raw, "system");
}

function decodeTools(raw: unknown): ToolDefinition[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) fail("Expected an array.", "tools");
  return raw.map((tool, index) => {
    const path = `tools.${index}`;
    if (!isRecord(tool)) fail("Expected a tool object.", path);
    const name = requireString(tool.name, `${path}.name`);
    const description = optionalString(tool.description, `${path}.description`);
    const parameters = tool.input_schema;
    if (parameters !== undefined && typeof parameters !== "boolean" && !isRecord(parameters)) {
      fail("Expected a JSON Schema.", `${path}.input_schema`);
    }
    return {
      name,
      ...(description === undefined ? {} : { description }),
      ...(parameters === undefined ? {} : { parameters: parameters as JsonSchema }),
    };
  });
}

function decodeToolChoice(raw: unknown): ToolChoice {
  if (raw === undefined || raw === null) return "auto";
  if (!isRecord(raw)) fail("Expected a tool_choice object.", "tool_choice");
  switch (raw.type) {
    case "auto":
      return "auto";
    case "any":
      return "required";
    case "none":
      return "none";
    case "tool":
      return { name: requireString(raw.name, "tool_choice.name") };
    default:
      return fail(`Unsupported tool choice type "${String(raw.type)}".`, "tool_choice.type");
  }
}

function decodeOutput(raw: unknown): OutputSpec | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw)) fail("Expected an output_config object.", "output_config");
  const format = raw.format;
  if (format === undefined || format === null) return undefined;
  if (!isRecord(format)) fail("Expected a format object.", "output_config.format");
  if (format.type === "text") return undefined;
  if (format.type !== "json_schema") {
    fail(`Unsupported output format "${String(format.type)}".`, "output_config.format.type");
  }
  const schema = format.schema;
  if (typeof schema !== "boolean" && !isRecord(schema)) fail("Expected a JSON Schema.", "output_config.format.schema");
  assertSchemaSupported("anthropic", schema as JsonSchema, "response", "output_config.format.schema");
  return { kind: "json_schema", schema: schema as JsonSchema };
}

function decodeStopSequences(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) fail("Expected an array of strings.", "stop_sequences");
  return raw.map((value, index) => requireString(value, `stop_sequences.${index}`));
}

function decode(body: unknown, ctx: CodecContext): Decoded {
  void ctx;
  if (!isRecord(body)) fail("Expected a JSON object body.");
  const model = requireString(body.model, "model");
  const maxTokens = requireNumber(body.max_tokens, "max_tokens");
  if (!Number.isInteger(maxTokens) || maxTokens <= 0) fail("Expected a positive integer.", "max_tokens");
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    fail("Expected a non-empty array of messages.", "messages");
  }

  const messages: Message[] = [];
  const system = decodeSystem(body.system);
  if (system.length > 0) messages.push({ role: "system", parts: system });
  messages.push(...body.messages.map((message, index) => decodeMessage(message, `messages.${index}`)));

  const request: AIRequest = {
    format: "anthropic-messages",
    model,
    messages,
    tools: decodeTools(body.tools),
    toolChoice: decodeToolChoice(body.tool_choice),
    parallelToolCalls: true,
    stream: optionalBoolean(body.stream, "stream") ?? false,
    output: decodeOutput(body.output_config),
    reasoning: body.thinking !== undefined && body.thinking !== null,
    maxOutputTokens: maxTokens,
    stop: decodeStopSequences(body.stop_sequences),
    store: false,
    references: [],
    warnings: [],
  };

  return { request, extras: {} };
}

function stopReason(finish: FinishReason): string {
  switch (finish) {
    case "tool_calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "refusal":
    case "content_filter":
      return "refusal";
    default:
      return "end_turn";
  }
}

function toolInput(argumentsText: string): Json {
  try {
    const parsed = JSON.parse(argumentsText) as Json;
    return parsed === null ? {} : parsed;
  } catch {
    return {};
  }
}

function contentBlocks(events: ReplyEvent[]): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  for (const event of events) {
    switch (event.type) {
      case "text":
      case "refusal":
        blocks.push({ type: "text", text: event.text });
        break;
      case "object":
        blocks.push({ type: "text", text: JSON.stringify(event.value) });
        break;
      case "tool_call":
        blocks.push({ type: "tool_use", id: event.id, name: event.name, input: toolInput(event.arguments) });
        break;
      default:
        break;
    }
  }
  return blocks;
}

function usageOf(reply: Reply): { input_tokens: number; output_tokens: number } {
  return { input_tokens: reply.usage.input, output_tokens: reply.usage.output };
}

function encodeJson(reply: Reply, decoded: Decoded, ctx: CodecContext): WireMessage {
  return {
    id: ctx.makeId("msg"),
    type: "message",
    role: "assistant",
    model: decoded.request.model,
    content: contentBlocks(reply.events),
    stop_reason: stopReason(reply.finish),
    stop_sequence: null,
    usage: usageOf(reply),
  };
}

function streamFrames(reply: Reply, decoded: Decoded, ctx: CodecContext): SseFrame[] {
  const frames: SseFrame[] = [];
  const model = decoded.request.model;
  frames.push({
    event: "message_start",
    data: {
      type: "message_start",
      message: {
        id: ctx.makeId("msg"),
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: reply.usage.input, output_tokens: 0 },
      },
    },
  });

  let index = 0;
  const emitText = (text: string, asJson: boolean): void => {
    const pieces = asJson ? jsonChunks(text) : payloadChunks(text);
    frames.push({
      event: "content_block_start",
      data: { type: "content_block_start", index, content_block: { type: "text", text: "" } },
    });
    for (const piece of pieces) {
      frames.push({
        event: "content_block_delta",
        data: { type: "content_block_delta", index, delta: { type: "text_delta", text: piece } },
        content: piece,
      });
    }
    frames.push({ event: "content_block_stop", data: { type: "content_block_stop", index } });
    index += 1;
  };

  for (const event of reply.events) {
    if (event.type === "text" || event.type === "refusal") emitText(event.text, false);
    else if (event.type === "object") emitText(JSON.stringify(event.value), true);
    else if (event.type === "tool_call") {
      frames.push({
        event: "content_block_start",
        data: {
          type: "content_block_start",
          index,
          content_block: { type: "tool_use", id: event.id, name: event.name, input: {} },
        },
      });
      for (const piece of jsonChunks(event.arguments)) {
        frames.push({
          event: "content_block_delta",
          data: { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: piece } },
          content: piece,
        });
      }
      frames.push({ event: "content_block_stop", data: { type: "content_block_stop", index } });
      index += 1;
    }
  }

  frames.push({
    event: "message_delta",
    data: {
      type: "message_delta",
      delta: { stop_reason: stopReason(reply.finish), stop_sequence: null },
      usage: { output_tokens: reply.usage.output },
    },
  });
  frames.push({ event: "message_stop", data: { type: "message_stop" } });
  return frames;
}

function errorBody(failure: HttpFailure): ErrorBody {
  return {
    type: "error",
    error: { type: failure.type ?? ERROR_TYPES[failure.status] ?? "api_error", message: failure.message },
    request_id: REQUEST_ID,
  };
}

/** The Anthropic Messages wire format codec. */
export const messagesCodec: Codec = {
  format: "anthropic-messages",
  decode,
  encodeJson,
  streamFrames,
  errorBody,
};
