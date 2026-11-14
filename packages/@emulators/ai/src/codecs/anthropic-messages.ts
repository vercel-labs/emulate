import { createHash } from "node:crypto";
import { AiRequestError } from "../errors.js";
import { inlineFilePart, redactedUrl, urlAttachment } from "../attachments.js";
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

const MAX_INLINE_BYTES = 32_000_000;

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

interface ThinkingBlock {
  type: "thinking";
  thinking: string;
  signature: string;
}

type ContentBlock = ThinkingBlock | TextBlock | ToolUseBlock;

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

const FORMAT = "anthropic-messages";

function fail(message: string, param?: string): never {
  throw new AiRequestError(message, param);
}

function unsupported(feature: string, param: string): never {
  throw new AiRequestError(`Unsupported Messages feature: ${feature} (${param}).`, param, "unsupported_feature");
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

function textOfContent(value: unknown, path: string, nested: FilePart[]): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) fail("Expected a string or an array of content blocks.", path);
  const texts: string[] = [];
  value.forEach((block, index) => {
    const blockPath = `${path}.${index}`;
    if (!isRecord(block)) fail("Expected a content block object.", blockPath);
    if (block.type === "image") {
      nested.push(decodeFile(block, blockPath, "image"));
      return;
    }
    if (block.type === "document") {
      for (const part of decodeDocument(block, blockPath)) {
        if (part.type === "text") texts.push(part.text);
        else if (part.type === "file") nested.push(part);
      }
      return;
    }
    if (block.type === "text") {
      texts.push(requireString(block.text, `${blockPath}.text`));
      return;
    }
    if (block.type === "search_result") {
      texts.push(searchResultText(block, blockPath));
      return;
    }
    fail(`Unsupported content block type "${String(block.type)}" in a tool result.`, `${blockPath}.type`);
  });
  return texts.join("\n");
}

function searchResultText(block: Record<string, unknown>, path: string): string {
  requireString(block.source, `${path}.source`);
  const title = requireString(block.title, `${path}.title`);
  const content = block.content;
  if (!Array.isArray(content)) fail("Expected an array of text blocks.", `${path}.content`);
  const texts = content.map((item, index) => {
    const itemPath = `${path}.content.${index}`;
    if (!isRecord(item) || item.type !== "text") fail("Expected a text block.", itemPath);
    return requireString(item.text, `${itemPath}.text`);
  });
  return [title, ...texts].join("\n");
}

function decodeFile(block: Record<string, unknown>, path: string, kind: "image" | "document"): FilePart {
  const source = block.source;
  if (!isRecord(source)) fail("Expected a source object.", `${path}.source`);
  if (source.type === "base64") {
    const mediaType = requireString(source.media_type, `${path}.source.media_type`);
    const data = requireString(source.data, `${path}.source.data`);
    return inlineFilePart(data, mediaType, `${path}.source.data`, MAX_INLINE_BYTES);
  }
  if (source.type === "url") {
    return urlAttachment(redactedUrl(source.url, `${path}.source.url`), kind === "image" ? "image" : "file");
  }
  if (source.type === "file") {
    return {
      type: "file",
      mediaType: kind === "image" ? "image/*" : "application/pdf",
      source: "file_id",
      ref: requireString(source.file_id, `${path}.source.file_id`),
    };
  }
  return fail(`Unsupported source type "${String(source.type)}".`, `${path}.source.type`);
}

function decodeContentSource(content: unknown, path: string): InputPart[] {
  if (content === undefined || content === null) return [];
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) fail("Expected a string or an array of text and image blocks.", path);
  return content.flatMap((block, index): InputPart[] => {
    const blockPath = `${path}.${index}`;
    if (!isRecord(block)) fail("Expected a content block object.", blockPath);
    switch (block.type) {
      case "text":
        return [{ type: "text", text: requireString(block.text, `${blockPath}.text`) }];
      case "image":
        return [decodeFile(block, blockPath, "image")];
      default:
        return fail(`Unsupported content block type "${String(block.type)}" in a content source.`, `${blockPath}.type`);
    }
  });
}

function decodeDocument(block: Record<string, unknown>, path: string): InputPart[] {
  const source = block.source;
  if (!isRecord(source)) fail("Expected a source object.", `${path}.source`);
  if (source.type === "text") {
    return [{ type: "text", text: requireString(source.data, `${path}.source.data`) }];
  }
  if (source.type === "content") {
    return decodeContentSource(source.content, `${path}.source.content`);
  }
  return [decodeFile(block, path, "document")];
}

function decodeBlock(block: unknown, path: string): InputPart[] {
  if (!isRecord(block)) fail("Expected a content block object.", path);
  switch (block.type) {
    case "text":
      return [{ type: "text", text: requireString(block.text, `${path}.text`) }];
    case "image":
      return [decodeFile(block, path, "image")];
    case "document":
      return decodeDocument(block, path);
    case "search_result":
      return [{ type: "text", text: searchResultText(block, path) }];
    case "tool_use":
      return [
        {
          type: "tool_call",
          id: requireString(block.id, `${path}.id`),
          name: requireString(block.name, `${path}.name`),
          arguments: JSON.stringify(block.input ?? {}),
        },
      ];
    case "tool_result": {
      const id = requireString(block.tool_use_id, `${path}.tool_use_id`);
      const name = optionalString(block.name, `${path}.name`);
      const nested: FilePart[] = [];
      const output = textOfContent(block.content, `${path}.content`, nested);
      return [
        ...nested,
        {
          type: "tool_result",
          id,
          ...(name === undefined ? {} : { name }),
          output,
          ...(block.is_error === true ? { isError: true } : {}),
        },
      ];
    }
    case "thinking":
    case "redacted_thinking":
      return [{ type: "text", text: typeof block.thinking === "string" ? block.thinking : "" }];
    default:
      return fail(`Unsupported content block type "${String(block.type)}".`, `${path}.type`);
  }
}

function decodeContent(content: unknown, path: string): InputPart[] {
  if (content === undefined || content === null) return [];
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) fail("Expected a string or an array of content blocks.", path);
  return content.flatMap((block, index) => decodeBlock(block, `${path}.${index}`));
}

/** Splits a user turn so tool results sit in a tool message, the way the OpenAI codecs record them. */
function decodeUserMessage(content: unknown, path: string): Message[] {
  if (!Array.isArray(content)) return [{ role: "user", parts: decodeContent(content, path) }];
  const toolParts: InputPart[] = [];
  const userParts: InputPart[] = [];
  content.forEach((block, index) => {
    const parts = decodeBlock(block, `${path}.${index}`);
    if (isRecord(block) && block.type === "tool_result") toolParts.push(...parts);
    else userParts.push(...parts);
  });
  const messages: Message[] = [];
  if (toolParts.length > 0) messages.push({ role: "tool", parts: toolParts });
  if (userParts.length > 0 || messages.length === 0) messages.push({ role: "user", parts: userParts });
  return messages;
}

function decodeMessage(raw: unknown, path: string): Message[] {
  if (!isRecord(raw)) fail("Expected a message object.", path);
  const role = raw.role;
  if (role !== "user" && role !== "assistant") fail('Expected "user" or "assistant".', `${path}.role`);
  if (role === "assistant") return [{ role, parts: decodeContent(raw.content, `${path}.content`) }];
  return decodeUserMessage(raw.content, `${path}.content`);
}

function decodeSystem(raw: unknown): InputPart[] {
  if (raw === undefined || raw === null) return [];
  return decodeContent(raw, "system");
}

/** Anthropic tools the platform runs itself, which the emulator cannot execute. */
function isServerTool(type: unknown): boolean {
  return typeof type === "string" && /^(web_search|web_fetch|code_execution)_/.test(type);
}

function decodeTools(raw: unknown): ToolDefinition[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) fail("Expected an array.", "tools");
  return raw.map((tool, index) => {
    const path = `tools.${index}`;
    if (!isRecord(tool)) fail("Expected a tool object.", path);
    if (isServerTool(tool.type)) unsupported("hosted tools", `${path}.type`);
    const name = requireString(tool.name, `${path}.name`);
    const description = optionalString(tool.description, `${path}.description`);
    const parameters = tool.input_schema;
    if (parameters !== undefined && typeof parameters !== "boolean" && !isRecord(parameters)) {
      fail("Expected a JSON Schema.", `${path}.input_schema`);
    }
    if (optionalBoolean(tool.strict, `${path}.strict`) === true && parameters !== undefined) {
      assertSchemaSupported("anthropic", parameters as JsonSchema, name, `${path}.input_schema`);
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
  body.messages.forEach((message, index) => messages.push(...decodeMessage(message, `messages.${index}`)));

  const request: AIRequest = {
    format: FORMAT,
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

/** Derives a thinking block's opaque signature from its text, so the same thought is signed the same way on every run. */
function signatureOf(thinking: string): string {
  return createHash("sha256").update(thinking).digest("base64");
}

function contentBlocks(events: ReplyEvent[]): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  for (const event of events) {
    switch (event.type) {
      case "reasoning":
        blocks.push({ type: "thinking", thinking: event.text, signature: signatureOf(event.text) });
        break;
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
  const emit = (block: ContentBlock, deltas: Array<{ delta: Record<string, string>; content?: string }>): void => {
    frames.push({ event: "content_block_start", data: { type: "content_block_start", index, content_block: block } });
    for (const { delta, content } of deltas) {
      frames.push({
        event: "content_block_delta",
        data: { type: "content_block_delta", index, delta },
        ...(content === undefined ? {} : { content }),
      });
    }
    frames.push({ event: "content_block_stop", data: { type: "content_block_stop", index } });
    index += 1;
  };
  const textDeltas = (pieces: string[]) =>
    pieces.map((piece) => ({ delta: { type: "text_delta", text: piece }, content: piece }));

  for (const event of reply.events) {
    switch (event.type) {
      case "reasoning":
        emit({ type: "thinking", thinking: "", signature: "" }, [
          ...payloadChunks(event.text).map((piece) => ({
            delta: { type: "thinking_delta", thinking: piece },
            content: piece,
          })),
          { delta: { type: "signature_delta", signature: signatureOf(event.text) } },
        ]);
        break;
      case "text":
      case "refusal":
        emit({ type: "text", text: "" }, textDeltas(payloadChunks(event.text)));
        break;
      case "object":
        emit({ type: "text", text: "" }, textDeltas(jsonChunks(JSON.stringify(event.value))));
        break;
      case "tool_call":
        emit(
          { type: "tool_use", id: event.id, name: event.name, input: {} },
          jsonChunks(event.arguments).map((piece) => ({
            delta: { type: "input_json_delta", partial_json: piece },
            content: piece,
          })),
        );
        break;
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

function errorBody(failure: HttpFailure, requestId: string): ErrorBody {
  return {
    type: "error",
    error: { type: failure.type ?? ERROR_TYPES[failure.status] ?? "api_error", message: failure.message },
    request_id: requestId,
  };
}

/** The Anthropic Messages wire format codec. */
export const messagesCodec: Codec = {
  format: FORMAT,
  decode,
  encodeJson,
  streamFrames,
  errorBody,
};
