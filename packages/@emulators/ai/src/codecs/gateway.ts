import { inlineFilePart, redactedReference } from "../attachments.js";
import { jsonChunks, textChunks } from "../chunks.js";
import { CREATED_AT, type Codec, type CodecContext, type Decoded } from "../codec.js";
import { AiRequestError } from "../errors.js";
import { assertOutputSupported, assertToolsSupported } from "../schema-dialects.js";
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
  ToolChoice,
  ToolDefinition,
} from "../types.js";

const FORMAT = "gateway";
const MAX_FILE_BYTES = 512_000_000;

const ERROR_TYPES: Record<number, string> = {
  400: "invalid_request_error",
  401: "authentication_error",
  403: "forbidden",
  404: "not_found",
  424: "failed_dependency",
  429: "rate_limit_exceeded",
};

const FINISH_REASONS: Record<FinishReason, string> = {
  stop: "stop",
  tool_calls: "tool-calls",
  length: "length",
  refusal: "content-filter",
  content_filter: "content-filter",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string, param?: string, code?: string): never {
  throw new AiRequestError(message, param, code);
}

function expectString(value: unknown, path: string, nonEmpty = false): string {
  if (typeof value !== "string") fail("Expected a string.", path);
  if (nonEmpty && value.length === 0) fail("Expected a non-empty string.", path);
  return value;
}

function expectArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail("Expected an array.", path);
  return value;
}

/** The AI Gateway error envelope the `@ai-sdk/gateway` client maps to its typed errors by `error.type`. */
export function gatewayErrorBody(failure: HttpFailure, requestId: string): unknown {
  const type =
    failure.type ??
    ERROR_TYPES[failure.status] ??
    (failure.status >= 500 ? "internal_server_error" : "invalid_request_error");
  return {
    error: { message: failure.message, type, param: failure.param ?? null, code: failure.code ?? null },
    generationId: `gen_${requestId}`,
  };
}

/** The model id the gateway client sends in a header rather than the body. */
export function gatewayModel(ctx: CodecContext, header = "ai-model-id"): string {
  const model = ctx.headers?.get(header);
  if (!model) fail(`Missing ${header} header.`, header);
  return model;
}

/** Routing and cost metadata the gateway attaches to every result under `providerMetadata.gateway`. */
export function gatewayMetadata(model: string, generationId: string): Record<string, Json> {
  const provider = model.includes("/") ? model.slice(0, model.indexOf("/")) : model;
  return {
    gateway: {
      routing: { originalModelId: model, resolvedProvider: provider, canonicalSlug: model, finalProvider: provider },
      cost: "0",
      marketCost: "0",
      generationId,
    },
  };
}

/** Reads one AI SDK file part's data into attachment metadata; URLs are kept without their query or credentials. */
export function gatewayFile(data: unknown, mediaType: string, path: string, name?: string): FilePart {
  if (typeof data === "string") return inlineFilePart(data, mediaType, path, MAX_FILE_BYTES, name);
  if (!isRecord(data)) fail("Expected file data.", path);
  switch (data.type) {
    case "data":
      return inlineFilePart(expectString(data.data, `${path}.data`), mediaType, `${path}.data`, MAX_FILE_BYTES, name);
    case "url":
      return {
        type: "file",
        mediaType,
        ...(name === undefined ? {} : { name }),
        source: "url",
        ref: redactedReference(data.url, `${path}.url`),
      };
    case "reference":
      return { type: "file", mediaType, ...(name === undefined ? {} : { name }), source: "file_id" };
    case "text": {
      const text = expectString(data.text, `${path}.text`);
      return inlineFilePart(Buffer.from(text).toString("base64"), mediaType, path, MAX_FILE_BYTES, name);
    }
    default:
      return fail("Expected file data of type data, url, reference, or text.", `${path}.type`);
  }
}

function filePart(part: Record<string, unknown>, path: string): FilePart {
  const mediaType = expectString(part.mediaType, `${path}.mediaType`, true);
  const name = part.filename === undefined ? undefined : expectString(part.filename, `${path}.filename`);
  return gatewayFile(part.data, mediaType, `${path}.data`, name);
}

function toolOutput(output: unknown, path: string): { output: string; isError?: boolean } {
  if (!isRecord(output)) fail("Expected a tool result output.", path);
  switch (output.type) {
    case "text":
      return { output: expectString(output.value, `${path}.value`) };
    case "json":
      return { output: JSON.stringify(output.value) };
    case "error-text":
      return { output: expectString(output.value, `${path}.value`), isError: true };
    case "error-json":
      return { output: JSON.stringify(output.value), isError: true };
    case "execution-denied":
      return { output: typeof output.reason === "string" ? output.reason : "Tool execution denied.", isError: true };
    case "content":
      return {
        output: expectArray(output.value, `${path}.value`)
          .map((item) => (isRecord(item) && item.type === "text" && typeof item.text === "string" ? item.text : ""))
          .join(""),
      };
    default:
      return fail("Expected a tool result output type.", `${path}.type`);
  }
}

function contentPart(part: unknown, role: Message["role"], path: string): InputPart[] {
  if (!isRecord(part)) fail("Expected a content part.", path);
  switch (part.type) {
    case "text":
      if (role === "tool") break;
      return [{ type: "text", text: expectString(part.text, `${path}.text`) }];
    case "reasoning":
      if (role !== "assistant") break;
      return [];
    case "file":
      if (role === "tool") break;
      return [filePart(part, path)];
    case "reasoning-file":
    case "custom":
    case "tool-approval-response":
      return [];
    case "tool-call":
      if (role !== "assistant") break;
      return [
        {
          type: "tool_call",
          id: expectString(part.toolCallId, `${path}.toolCallId`, true),
          name: expectString(part.toolName, `${path}.toolName`, true),
          arguments: typeof part.input === "string" ? part.input : JSON.stringify(part.input ?? {}),
        },
      ];
    case "tool-result":
      if (role !== "assistant" && role !== "tool") break;
      return [
        {
          type: "tool_result",
          id: expectString(part.toolCallId, `${path}.toolCallId`, true),
          name: expectString(part.toolName, `${path}.toolName`, true),
          ...toolOutput(part.output, `${path}.output`),
        },
      ];
  }
  return fail(`Unsupported ${role} content part "${String(part.type)}".`, `${path}.type`);
}

function decodeMessage(raw: unknown, index: number): Message {
  const path = `prompt[${index}]`;
  if (!isRecord(raw)) fail("Expected a message object.", path);
  const role = raw.role;
  if (role === "system") return { role, parts: [{ type: "text", text: expectString(raw.content, `${path}.content`) }] };
  if (role !== "user" && role !== "assistant" && role !== "tool") {
    fail(`Unsupported message role "${String(role)}".`, `${path}.role`);
  }
  const parts = expectArray(raw.content, `${path}.content`).flatMap((part, at) =>
    contentPart(part, role, `${path}.content[${at}]`),
  );
  return { role, parts };
}

function decodeTools(raw: unknown): ToolDefinition[] {
  if (raw === undefined || raw === null) return [];
  return expectArray(raw, "tools").map((tool, index) => {
    const at = `tools[${index}]`;
    if (!isRecord(tool)) fail("Expected a tool object.", at);
    if (tool.type !== "function") {
      throw new AiRequestError(`Unsupported tool type "${String(tool.type)}".`, `${at}.type`, "unsupported_feature");
    }
    const schema = tool.inputSchema;
    if (schema !== undefined && typeof schema !== "boolean" && !isRecord(schema)) {
      fail("Expected a JSON Schema object.", `${at}.inputSchema`);
    }
    return {
      name: expectString(tool.name, `${at}.name`, true),
      ...(tool.description === undefined ? {} : { description: expectString(tool.description, `${at}.description`) }),
      ...(schema === undefined ? {} : { parameters: schema as JsonSchema }),
      ...(tool.strict === true ? { strict: true } : {}),
    };
  });
}

function decodeToolChoice(raw: unknown, hasTools: boolean): ToolChoice {
  if (raw === undefined || raw === null) return hasTools ? "auto" : "none";
  if (!isRecord(raw)) fail("Expected a tool choice.", "toolChoice");
  if (raw.type === "auto" || raw.type === "none" || raw.type === "required") return raw.type;
  if (raw.type === "tool") return { name: expectString(raw.toolName, "toolChoice.toolName", true) };
  return fail("Expected a tool choice of auto, none, required, or tool.", "toolChoice.type");
}

function decodeOutput(raw: unknown): OutputSpec | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw)) fail("Expected a responseFormat object.", "responseFormat");
  if (raw.type === "text") return undefined;
  if (raw.type !== "json") fail("Expected a responseFormat of text or json.", "responseFormat.type");
  if (raw.schema === undefined) return { kind: "json_object" };
  if (typeof raw.schema !== "boolean" && !isRecord(raw.schema))
    fail("Expected a JSON Schema.", "responseFormat.schema");
  return {
    kind: "json_schema",
    ...(raw.name === undefined ? {} : { name: expectString(raw.name, "responseFormat.name", true) }),
    schema: raw.schema as JsonSchema,
  };
}

function decodeLanguage(body: unknown, ctx: CodecContext): Decoded {
  if (!isRecord(body)) fail("Expected a JSON object request body.", "body");
  const model = gatewayModel(ctx, "ai-language-model-id");
  const prompt = expectArray(body.prompt, "prompt");
  if (prompt.length === 0) fail("Expected a non-empty prompt.", "prompt");
  const messages = prompt.map((message, index) => decodeMessage(message, index));
  const tools = decodeTools(body.tools);
  assertToolsSupported(model, tools, (index) => `tools[${index}].inputSchema`);
  const output = decodeOutput(body.responseFormat);
  assertOutputSupported(model, output, { format: "responseFormat", strict: "responseFormat.schema" });
  const maxOutputTokens = body.maxOutputTokens;
  if (maxOutputTokens !== undefined && (typeof maxOutputTokens !== "number" || !Number.isInteger(maxOutputTokens))) {
    fail("Expected an integer.", "maxOutputTokens");
  }
  const stop =
    body.stopSequences === undefined
      ? undefined
      : expectArray(body.stopSequences, "stopSequences").map((value, index) =>
          expectString(value, `stopSequences[${index}]`),
        );
  const reasoning = body.reasoning;
  if (reasoning !== undefined && typeof reasoning !== "string") fail("Expected a string.", "reasoning");
  const request: AIRequest = {
    format: FORMAT,
    model,
    messages,
    tools,
    toolChoice: decodeToolChoice(body.toolChoice, tools.length > 0),
    parallelToolCalls: true,
    stream: ctx.headers?.get("ai-language-model-streaming") === "true",
    ...(output === undefined ? {} : { output }),
    reasoning: reasoning !== undefined && reasoning !== "none" && reasoning !== "provider-default",
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens: maxOutputTokens as number }),
    ...(stop === undefined ? {} : { stop }),
    store: false,
    references: [],
    warnings: [],
  };
  return { request, extras: {} };
}

function finishOf(reply: Reply): Json {
  return { unified: FINISH_REASONS[reply.finish], raw: reply.finish };
}

function usageOf(reply: Reply): Json {
  const { input, output, reasoning } = reply.usage;
  return {
    inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: output, text: output - reasoning, reasoning },
  };
}

function encodeJson(reply: Reply, decoded: Decoded, ctx: CodecContext): unknown {
  const content = reply.events.map((event): Json => {
    switch (event.type) {
      case "reasoning":
        return { type: "reasoning", text: event.text };
      case "text":
      case "refusal":
        return { type: "text", text: event.text };
      case "object":
        return { type: "text", text: JSON.stringify(event.value) };
      case "tool_call":
        return { type: "tool-call", toolCallId: event.id, toolName: event.name, input: event.arguments };
    }
  });
  return {
    content,
    finishReason: finishOf(reply),
    usage: usageOf(reply),
    providerMetadata: gatewayMetadata(decoded.request.model, ctx.makeId("gen")),
    warnings: [],
  };
}

function streamFrames(reply: Reply, decoded: Decoded, ctx: CodecContext): SseFrame[] {
  const metadata = gatewayMetadata(decoded.request.model, ctx.makeId("gen"));
  const frames: SseFrame[] = [
    { data: { type: "stream-start", warnings: [] } },
    {
      data: {
        type: "response-metadata",
        id: ctx.makeId("resp"),
        modelId: decoded.request.model,
        timestamp: new Date(CREATED_AT * 1000).toISOString(),
      },
    },
  ];
  let first = true;
  const start = (part: Record<string, Json>): Record<string, Json> => {
    if (!first) return part;
    first = false;
    return { ...part, providerMetadata: metadata };
  };
  reply.events.forEach((event, index) => {
    const id = String(index);
    if (event.type === "tool_call") {
      frames.push({ data: start({ type: "tool-input-start", id: event.id, toolName: event.name }) });
      for (const delta of jsonChunks(event.arguments)) {
        frames.push({ data: { type: "tool-input-delta", id: event.id, delta }, content: delta });
      }
      frames.push({ data: { type: "tool-input-end", id: event.id } });
      frames.push({
        data: { type: "tool-call", toolCallId: event.id, toolName: event.name, input: event.arguments },
      });
      return;
    }
    const kind = event.type === "reasoning" ? "reasoning" : "text";
    const text = event.type === "object" ? JSON.stringify(event.value) : event.text;
    frames.push({ data: start({ type: `${kind}-start`, id }) });
    for (const delta of event.type === "object" ? jsonChunks(text) : textChunks(text)) {
      frames.push({ data: { type: `${kind}-delta`, id, delta }, content: delta });
    }
    frames.push({ data: { type: `${kind}-end`, id } });
  });
  frames.push({
    data: { type: "finish", finishReason: finishOf(reply), usage: usageOf(reply), providerMetadata: metadata },
  });
  return frames;
}

/** The AI Gateway language model protocol `@ai-sdk/gateway` speaks: AI SDK call options in, AI SDK results out. */
export const gatewayCodec: Codec = {
  format: FORMAT,
  decode: decodeLanguage,
  encodeJson,
  streamFrames,
  errorBody: gatewayErrorBody,
};
