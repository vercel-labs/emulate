import type { Store } from "@emulators/core";
import type {
  Response as OpenAIResponse,
  ResponseCompletedEvent,
  ResponseContentPartAddedEvent,
  ResponseContentPartDoneEvent,
  ResponseCreatedEvent,
  ResponseFunctionCallArgumentsDeltaEvent,
  ResponseFunctionCallArgumentsDoneEvent,
  ResponseInProgressEvent,
  ResponseIncompleteEvent,
  FunctionTool,
  ResponseOutputItem,
  ResponseOutputItemAddedEvent,
  ResponseOutputItemDoneEvent,
  ResponseOutputMessage,
  ResponseOutputRefusal,
  ResponseOutputText,
  ResponseReasoningItem,
  ResponseReasoningSummaryPartAddedEvent,
  ResponseReasoningSummaryPartDoneEvent,
  ResponseReasoningSummaryTextDeltaEvent,
  ResponseReasoningSummaryTextDoneEvent,
  ResponseRefusalDeltaEvent,
  ResponseRefusalDoneEvent,
  ResponseTextDeltaEvent,
  ResponseTextDoneEvent,
  ResponseUsage,
  Tool,
  ToolChoiceFunction,
  ToolChoiceOptions,
} from "openai/resources/responses/responses";
import type { ErrorObject } from "openai/resources/shared";
import type { Codec, CodecContext, Decoded } from "../codec.js";
import { AiRequestError, defaultErrorType } from "../errors.js";
import { decodeResponsesAttachment } from "../attachments.js";
import type { SseFrame } from "../sse.js";
import { payloadChunks, textChunks } from "../chunks.js";
import type { AiState } from "../state.js";
import type {
  AIRequest,
  FilePart,
  FinishReason,
  HistoryReference,
  HttpFailure,
  InputPart,
  Json,
  JsonSchema,
  Message,
  OutputSpec,
  Reply,
  ToolChoice as AiToolChoice,
  ToolDefinition,
  Usage,
} from "../types.js";

type WireResponse = Omit<OpenAIResponse, "output_text">;

type WireToolChoice = ToolChoiceOptions | ToolChoiceFunction;

type WireReasoning = NonNullable<OpenAIResponse["reasoning"]>;

type WireMetadata = NonNullable<OpenAIResponse["metadata"]>;

type WireResponseEvent<T extends { response: OpenAIResponse }> = Omit<T, "response"> & {
  response: WireResponse;
};

type WireCreatedEvent = WireResponseEvent<ResponseCreatedEvent>;
type WireInProgressEvent = WireResponseEvent<ResponseInProgressEvent>;
type WireCompletedEvent = WireResponseEvent<ResponseCompletedEvent>;
type WireIncompleteEvent = WireResponseEvent<ResponseIncompleteEvent>;

interface ResponsesExtras {
  instructions?: string;
  tools: Tool[];
  toolChoice: WireToolChoice;
  temperature: number | null;
  topP: number | null;
  text: NonNullable<OpenAIResponse["text"]>;
  reasoning?: WireReasoning;
  metadata: WireMetadata;
  inputItems: Json[];
}

interface PreparedReply {
  id: string;
  createdAt: number;
  output: ResponseOutputItem[];
  response: WireResponse;
}

interface StoredLookup {
  item: Json;
}

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

/** Context the dispatcher passes to the stored-response helpers. */
export interface ResponsesStoreContext {
  store: Store;
  state: AiState;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string, param?: string): never {
  throw new AiRequestError(message, param);
}

function requireString(value: unknown, param: string, nonEmpty = false): string {
  if (typeof value !== "string") invalid(`Expected a string for 'input.${param}'.`, param);
  if (nonEmpty && value.length === 0) invalid(`Expected a non-empty string for 'input.${param}'.`, param);
  return value;
}

function optionalString(value: unknown, param: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireString(value, param);
}

function requireBoolean(value: unknown, param: string): boolean {
  if (typeof value !== "boolean") invalid(`Expected a boolean for 'input.${param}'.`, param);
  return value;
}

function requireNumber(value: unknown, param: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) invalid(`Expected a number for 'input.${param}'.`, param);
  return value;
}

function unsupported(feature: string, param: string): never {
  invalid(`Unsupported feature: ${feature}. The AI emulator does not implement it.`, param);
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  return JSON.stringify(value);
}

function functionOutput(output: unknown, path: string): { text: string; files: InputPart[] } {
  if (typeof output === "string") return { text: output, files: [] };
  if (!Array.isArray(output)) invalid(`Expected a string or array for 'input.${path}.output'.`, `${path}.output`);
  const text: string[] = [];
  const files: InputPart[] = [];
  output.forEach((part, index) => {
    const partPath = `${path}.output[${index}]`;
    if (typeof part === "string") {
      text.push(part);
      return;
    }
    if (!isRecord(part)) invalid(`Expected a content part for 'input.${partPath}'.`, partPath);
    if (part.type === "input_text" || part.type === "output_text" || part.type === "text") {
      if (typeof part.text !== "string") invalid(`Expected a string for 'input.${partPath}.text'.`, `${partPath}.text`);
      text.push(part.text);
      return;
    }
    const attachment = decodeResponsesAttachment(part, partPath);
    if (attachment) {
      files.push(attachment);
      return;
    }
    unsupported(`function output content type "${String(part.type)}"`, `${partPath}.type`);
  });
  return { text: text.join(""), files };
}

function decodeReasoning(raw: unknown): WireReasoning | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw)) invalid("Expected an object for 'input.reasoning'.", "reasoning");
  const reasoning: WireReasoning = {};
  const effort = optionalString(raw.effort, "reasoning.effort");
  if (effort !== undefined) reasoning.effort = effort as WireReasoning["effort"];
  const summary = optionalString(raw.summary, "reasoning.summary");
  if (summary !== undefined) reasoning.summary = summary as WireReasoning["summary"];
  const generateSummary = optionalString(raw.generate_summary, "reasoning.generate_summary");
  if (generateSummary !== undefined) reasoning.generate_summary = generateSummary as WireReasoning["generate_summary"];
  const context = optionalString(raw.context, "reasoning.context");
  if (context !== undefined) reasoning.context = context as WireReasoning["context"];
  const mode = optionalString(raw.mode, "reasoning.mode");
  if (mode !== undefined) reasoning.mode = mode;
  return reasoning;
}

function decodeMetadata(raw: unknown): WireMetadata {
  if (raw === undefined || raw === null) return {};
  if (!isRecord(raw)) invalid("Expected an object for 'input.metadata'.", "metadata");
  const metadata: WireMetadata = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== "string") invalid(`Expected a string for 'input.metadata.${key}'.`, `metadata.${key}`);
    metadata[key] = value;
  }
  return metadata;
}

function extrasOf(decoded: Decoded): ResponsesExtras {
  return decoded.extras as unknown as ResponsesExtras;
}

function sendJson(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS });
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

function notFound(id: string): HttpFailure {
  return {
    status: 404,
    type: "invalid_request_error",
    message: `Response with id '${id}' not found.`,
  };
}

function makeId(ctx: CodecContext, prefix: string): string {
  return ctx.makeId(prefix);
}

function decodeTools(raw: unknown): { tools: Tool[]; definitions: ToolDefinition[] } {
  if (raw === undefined || raw === null) return { tools: [], definitions: [] };
  if (!Array.isArray(raw)) invalid("Expected an array of tools for 'input.tools'.", "tools");
  const tools: Tool[] = [];
  const definitions: ToolDefinition[] = [];
  raw.forEach((tool, index) => {
    const path = `tools[${index}]`;
    if (!isRecord(tool)) invalid(`Expected an object for 'input.${path}'.`, path);
    if (tool.type !== "function") {
      const name = typeof tool.type === "string" ? tool.type : "unknown";
      unsupported(`tool type "${name}"`, `${path}.type`);
    }
    const name = requireString(tool.name, `${path}.name`, true);
    const description = optionalString(tool.description, `${path}.description`);
    let parameters: JsonSchema | undefined;
    if (tool.parameters !== undefined && tool.parameters !== null) {
      if (typeof tool.parameters !== "boolean" && !isRecord(tool.parameters)) {
        invalid(`Expected a JSON Schema object for 'input.${path}.parameters'.`, `${path}.parameters`);
      }
      parameters = tool.parameters as JsonSchema;
    }
    const strict = tool.strict === undefined ? false : requireBoolean(tool.strict, `${path}.strict`);
    tools.push({
      type: "function",
      name,
      ...(description === undefined ? {} : { description }),
      parameters: (parameters ?? { type: "object" }) as FunctionTool["parameters"],
      strict,
    });
    definitions.push({
      name,
      ...(description === undefined ? {} : { description }),
      ...(parameters === undefined ? {} : { parameters }),
    });
  });
  return { tools, definitions };
}

function decodeToolChoice(raw: unknown): { choice: AiToolChoice; wire: WireToolChoice } {
  if (raw === undefined || raw === null) return { choice: "auto", wire: "auto" };
  if (typeof raw === "string") {
    if (raw !== "auto" && raw !== "none" && raw !== "required") {
      unsupported(`tool_choice "${raw}"`, "tool_choice");
    }
    return { choice: raw as ToolChoiceOptions, wire: raw as ToolChoiceOptions };
  }
  if (isRecord(raw)) {
    if (raw.type !== "function") {
      const name = typeof raw.type === "string" ? raw.type : "unknown";
      unsupported(`tool_choice type "${name}"`, "tool_choice.type");
    }
    const name = requireString(raw.name, "tool_choice.name", true);
    return { choice: { name }, wire: { type: "function", name } };
  }
  invalid("Expected a tool choice string or function object for 'input.tool_choice'.", "tool_choice");
}

function decodeOutput(raw: unknown): OutputSpec | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw)) invalid("Expected an object for 'input.text'.", "text");
  const format = raw.format;
  if (format === undefined || format === null) return undefined;
  if (!isRecord(format)) invalid("Expected an object for 'input.text.format'.", "text.format");
  if (format.type === "text" || format.type === undefined) return undefined;
  if (format.type === "json_object") return { kind: "json_object" };
  if (format.type === "json_schema") {
    const name = optionalString(format.name, "text.format.name");
    const schema = format.schema;
    if (typeof schema !== "boolean" && !isRecord(schema)) {
      invalid("Expected a JSON Schema for 'input.text.format.schema'.", "text.format.schema");
    }
    return { kind: "json_schema", ...(name === undefined ? {} : { name }), schema: schema as JsonSchema };
  }
  invalid(`Unsupported text format "${String(format.type)}".`, "text.format.type");
}

function decodeMessageItem(item: Record<string, unknown>, path: string): Message {
  const role =
    item.role === "system" || item.role === "developer" || item.role === "assistant" || item.role === "user"
      ? item.role
      : undefined;
  if (!role) invalid(`Unsupported message role for 'input.${path}.role'.`, `${path}.role`);
  const parts: InputPart[] = [];
  const content = item.content;
  if (content === undefined || content === null) {
    invalid(`Missing required parameter: 'input.${path}.content'.`, `${path}.content`);
  }
  if (typeof content === "string") {
    parts.push({ type: "text", text: content });
  } else if (Array.isArray(content)) {
    content.forEach((part, index) => {
      const partPath = `${path}.content[${index}]`;
      if (typeof part === "string") {
        parts.push({ type: "text", text: part });
        return;
      }
      if (!isRecord(part)) invalid(`Expected a content part for 'input.${partPath}'.`, partPath);
      if (part.type === "input_audio") unsupported("audio input", `${partPath}.type`);
      if (part.type === "input_text" || part.type === "output_text" || part.type === "text") {
        if (typeof part.text !== "string")
          invalid(`Expected a string for 'input.${partPath}.text'.`, `${partPath}.text`);
        parts.push({ type: "text", text: part.text });
        return;
      }
      const attachment = decodeResponsesAttachment(part, partPath);
      if (attachment) {
        parts.push(attachment);
        return;
      }
      if (part.type === "refusal") return;
      unsupported(`input content type "${String(part.type)}"`, `${partPath}.type`);
    });
  } else {
    invalid(`Expected a string or array for 'input.${path}.content'.`, `${path}.content`);
  }
  return { role, parts };
}

function decodeFunctionCall(
  item: Record<string, unknown>,
  path: string,
): { message: Message; callId: string; name: string } {
  const callId = requireString(item.call_id, `${path}.call_id`, true);
  const name = requireString(item.name, `${path}.name`, true);
  const args = requireString(item.arguments, `${path}.arguments`);
  return {
    message: { role: "assistant", parts: [{ type: "tool_call", id: callId, name, arguments: args }] },
    callId,
    name,
  };
}

function decodeFunctionCallOutput(item: Record<string, unknown>, path: string): Message {
  const callId = requireString(item.call_id, `${path}.call_id`, true);
  if (item.output === undefined || item.output === null) {
    invalid(`Missing required parameter: 'input.${path}.output'.`, `${path}.output`);
  }
  const { text, files } = functionOutput(item.output, path);
  return { role: "tool", parts: [...files, { type: "tool_result", id: callId, output: text }] };
}

function decodeStoredMessages(items: Json[]): Message[] {
  const messages: Message[] = [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    if (Array.isArray(item.parts) && typeof item.role === "string") {
      const parts: InputPart[] = [];
      for (const part of item.parts) {
        if (!isRecord(part) || typeof part.type !== "string") continue;
        if (part.type === "text" && typeof part.text === "string") parts.push({ type: "text", text: part.text });
        else if (part.type === "tool_call" && typeof part.id === "string" && typeof part.name === "string") {
          parts.push({ type: "tool_call", id: part.id, name: part.name, arguments: textOf(part.arguments) });
        } else if (part.type === "tool_result" && typeof part.id === "string") {
          parts.push({
            type: "tool_result",
            id: part.id,
            ...(typeof part.name === "string" ? { name: part.name } : {}),
            output: textOf(part.output),
          });
        } else if (part.type === "file" && typeof part.mediaType === "string") {
          parts.push(part as unknown as FilePart);
        }
      }
      messages.push({ role: item.role as Message["role"], parts });
    }
  }
  return messages;
}

function storedOutputMessages(items: Json[]): Message[] {
  const messages: Message[] = [];
  for (const item of items) {
    if (!isRecord(item) || typeof item.type !== "string") continue;
    if (item.type === "message" && item.role === "assistant") {
      const parts: InputPart[] = [];
      if (Array.isArray(item.content)) {
        for (const part of item.content) {
          if (!isRecord(part)) continue;
          if (part.type === "output_text" && typeof part.text === "string")
            parts.push({ type: "text", text: part.text });
          else if (part.type === "refusal" && typeof part.refusal === "string")
            parts.push({ type: "text", text: part.refusal });
        }
      }
      messages.push({ role: "assistant", parts });
    } else if (item.type === "function_call") {
      messages.push({
        role: "assistant",
        parts: [
          {
            type: "tool_call",
            id: typeof item.call_id === "string" ? item.call_id : "",
            name: typeof item.name === "string" ? item.name : "",
            arguments: textOf(item.arguments),
          },
        ],
      });
    }
  }
  return messages;
}

function findStoredItem(state: AiState, id: string): StoredLookup | undefined {
  for (const stored of state.responses.values()) {
    for (const item of stored.outputItems) {
      if (isRecord(item) && item.id === id) return { item };
    }
  }
  return undefined;
}

function messageToJson(message: Message): Json {
  return { role: message.role, parts: message.parts } as unknown as Json;
}

function decode(body: unknown, ctx: CodecContext): Decoded {
  if (!isRecord(body)) invalid("Expected a JSON object request body.", "");
  const raw = body;

  if (raw.background === true) unsupported("background mode", "background");
  if (raw.conversation !== undefined && raw.conversation !== null) unsupported("the Conversations API", "conversation");
  if (raw.n !== undefined && raw.n !== null && raw.n !== 1) unsupported("multiple candidates", "n");
  if (raw.audio !== undefined && raw.audio !== null) unsupported("audio input", "audio");
  if (raw.modalities !== undefined && raw.modalities !== null) unsupported("audio output", "modalities");

  const model = requireString(raw.model, "model", true);
  const stream = raw.stream === undefined || raw.stream === null ? false : requireBoolean(raw.stream, "stream");
  const store = raw.store === undefined || raw.store === null ? true : requireBoolean(raw.store, "store");
  const instructions = optionalString(raw.instructions, "instructions");
  const maxOutputTokens =
    raw.max_output_tokens === undefined || raw.max_output_tokens === null
      ? undefined
      : requireNumber(raw.max_output_tokens, "max_output_tokens");
  if (maxOutputTokens !== undefined && (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 0)) {
    invalid("Expected a non-negative integer for 'input.max_output_tokens'.", "max_output_tokens");
  }

  const { tools, definitions } = decodeTools(raw.tools);
  const { choice, wire: toolChoiceWire } = decodeToolChoice(raw.tool_choice);
  const parallelToolCalls =
    raw.parallel_tool_calls === undefined || raw.parallel_tool_calls === null
      ? true
      : requireBoolean(raw.parallel_tool_calls, "parallel_tool_calls");
  const output = decodeOutput(raw.text);
  const reasoning = decodeReasoning(raw.reasoning);
  const metadata = decodeMetadata(raw.metadata);
  const previousResponseId = optionalString(raw.previous_response_id, "previous_response_id");
  if (previousResponseId !== undefined && !previousResponseId.startsWith("resp_")) {
    invalid(`Expected a response id starting with 'resp_' for 'input.previous_response_id'.`, "previous_response_id");
  }

  const messages: Message[] = [];
  if (instructions !== undefined) messages.push({ role: "system", parts: [{ type: "text", text: instructions }] });

  const history: Message[] = [];
  const references: HistoryReference[] = [];
  const warnings: string[] = [];

  if (previousResponseId !== undefined) {
    const stored = ctx.state.responses.get(previousResponseId);
    if (stored) {
      history.push(...decodeStoredMessages(stored.inputItems), ...storedOutputMessages(stored.outputItems));
      references.push({ id: previousResponseId, kind: "previous_response", resolved: true });
    } else {
      references.push({ id: previousResponseId, kind: "previous_response", resolved: false });
      warnings.push(`Unknown previous_response_id "${previousResponseId}"; continuing with empty context.`);
    }
  }

  const input = raw.input;
  if (input === undefined || input === null) invalid("Missing required parameter: 'input'.", "input");
  const items: unknown[] = typeof input === "string" ? [{ role: "user", content: input }] : (input as unknown[]);
  if (!Array.isArray(items)) invalid("Expected a string or array for 'input.input'.", "input");

  items.forEach((entry, index) => {
    const path = `input[${index}]`;
    if (typeof entry === "string") {
      history.push({ role: "user", parts: [{ type: "text", text: entry }] });
      return;
    }
    if (!isRecord(entry)) invalid(`Expected an item for 'input.${path}'.`, path);
    const type = typeof entry.type === "string" ? entry.type : undefined;

    if (type === "item_reference") {
      const id = requireString(entry.id, `${path}.id`, true);
      const found = findStoredItem(ctx.state, id);
      if (found) {
        references.push({ id, kind: "item", resolved: true });
        history.push(...storedOutputMessages([found.item]));
      } else {
        references.push({ id, kind: "item", resolved: false });
        warnings.push(`Unknown item_reference "${id}"; dropping it.`);
      }
      return;
    }

    if (type === "function_call") {
      history.push(decodeFunctionCall(entry, path).message);
      return;
    }

    if (type === "function_call_output") {
      history.push(decodeFunctionCallOutput(entry, path));
      return;
    }

    if (type === "reasoning") return;

    if (type === undefined || type === "message") {
      history.push(decodeMessageItem(entry, path));
      return;
    }

    if (
      type === "computer_call" ||
      type === "computer_call_output" ||
      type === "file_search_call" ||
      type === "web_search_call" ||
      type === "code_interpreter_call" ||
      type === "image_generation_call" ||
      type === "mcp_call" ||
      type === "local_shell_call" ||
      type === "shell_call" ||
      type === "apply_patch_call" ||
      type === "custom_tool_call" ||
      type === "custom_tool_call_output" ||
      type === "tool_search_call"
    ) {
      unsupported(`hosted tool input item "${type}"`, `${path}.type`);
    }

    unsupported(`input item type "${type}"`, `${path}.type`);
  });

  messages.push(...history);

  const callNames = new Map<string, string>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "tool_call") callNames.set(part.id, part.name);
    }
  }

  const unresolvedHistory = references.some((reference) => !reference.resolved);
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "tool_result") continue;
      const name = callNames.get(part.id);
      if (name !== undefined) {
        part.name = name;
        continue;
      }
      if (unresolvedHistory) {
        warnings.push(
          `Tool result "${part.id}" does not match a known call; accepting it because referenced history is missing.`,
        );
        continue;
      }
      invalid(`No function call found for tool output "${part.id}".`, "input");
    }
  }

  const request: AIRequest = {
    format: "openai-responses",
    model,
    messages,
    tools: definitions,
    toolChoice: choice,
    parallelToolCalls,
    stream,
    ...(output === undefined ? {} : { output }),
    reasoning: reasoning !== undefined,
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    store,
    ...(previousResponseId === undefined ? {} : { previousResponseId }),
    references,
    warnings,
  };

  const extras: ResponsesExtras = {
    ...(instructions === undefined ? {} : { instructions }),
    tools,
    toolChoice: toolChoiceWire,
    temperature:
      raw.temperature === undefined || raw.temperature === null ? 1 : requireNumber(raw.temperature, "temperature"),
    topP: raw.top_p === undefined || raw.top_p === null ? 1 : requireNumber(raw.top_p, "top_p"),
    text: isRecord(raw.text)
      ? (raw.text as unknown as NonNullable<OpenAIResponse["text"]>)
      : { format: { type: "text" } },
    ...(reasoning === undefined ? {} : { reasoning }),
    metadata,
    inputItems: history.map(messageToJson),
  };

  return { request, extras: extras as unknown as Record<string, unknown> };
}

function usageWire(usage: Usage): ResponseUsage {
  return {
    input_tokens: usage.input,
    input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
    output_tokens: usage.output,
    output_tokens_details: { reasoning_tokens: usage.reasoning },
    total_tokens: usage.input + usage.output,
  };
}

function itemStatus(finish: FinishReason): ResponseOutputMessage["status"] {
  return finish === "length" || finish === "content_filter" ? "incomplete" : "completed";
}

function buildOutput(reply: Reply, ctx: CodecContext): ResponseOutputItem[] {
  const output: ResponseOutputItem[] = [];
  let text: string[] = [];

  const flushText = () => {
    if (text.length === 0) return;
    const part: ResponseOutputText = {
      type: "output_text",
      text: text.join(""),
      annotations: [],
      logprobs: [],
    };
    output.push({
      id: makeId(ctx, "msg"),
      type: "message",
      role: "assistant",
      status: itemStatus(reply.finish),
      content: [part],
    });
    text = [];
  };

  for (const event of reply.events) {
    switch (event.type) {
      case "reasoning":
        flushText();
        output.push({
          id: makeId(ctx, "rs"),
          type: "reasoning",
          status: itemStatus(reply.finish),
          summary: [{ type: "summary_text", text: event.text }],
        });
        break;
      case "text":
        text.push(event.text);
        break;
      case "object":
        text.push(JSON.stringify(event.value));
        break;
      case "tool_call":
        flushText();
        output.push({
          id: makeId(ctx, "fc"),
          type: "function_call",
          status: itemStatus(reply.finish),
          call_id: event.id,
          name: event.name,
          arguments: event.arguments,
        });
        break;
      case "refusal":
        flushText();
        output.push({
          id: makeId(ctx, "msg"),
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "refusal", refusal: event.text }],
        });
        break;
    }
  }
  flushText();
  return output;
}

function responseStatus(finish: FinishReason): {
  status: "completed" | "incomplete";
  incompleteDetails: WireResponse["incomplete_details"];
} {
  if (finish === "length") {
    return { status: "incomplete", incompleteDetails: { reason: "max_output_tokens" } };
  }
  if (finish === "content_filter") {
    return { status: "incomplete", incompleteDetails: { reason: "content_filter" } };
  }
  return { status: "completed", incompleteDetails: null };
}

function buildResponse(
  reply: Reply,
  decoded: Decoded,
  id: string,
  createdAt: number,
  output: ResponseOutputItem[],
): WireResponse {
  const { request } = decoded;
  const extras = extrasOf(decoded);
  const { status, incompleteDetails } = responseStatus(reply.finish);
  return {
    id,
    object: "response",
    access_programs: null,
    created_at: createdAt,
    status,
    ...(status === "completed" ? { completed_at: createdAt } : {}),
    error: null,
    incomplete_details: incompleteDetails,
    instructions: extras.instructions ?? null,
    metadata: extras.metadata,
    model: request.model,
    output,
    parallel_tool_calls: request.parallelToolCalls,
    ...(request.previousResponseId === undefined ? {} : { previous_response_id: request.previousResponseId }),
    reasoning: extras.reasoning ?? { effort: null, summary: null },
    temperature: extras.temperature,
    text: extras.text,
    tool_choice: extras.toolChoice,
    tools: extras.tools,
    top_p: extras.topP,
    truncation: "disabled",
    usage: usageWire(reply.usage),
    ...(request.maxOutputTokens === undefined ? {} : { max_output_tokens: request.maxOutputTokens }),
  };
}

function preparedFor(reply: Reply, decoded: Decoded, ctx: CodecContext): PreparedReply {
  const cache = decoded.extras as Record<string, unknown>;
  const existing = cache.prepared as PreparedReply | undefined;
  if (existing) return existing;
  const id = makeId(ctx, "resp");
  const createdAt = Math.floor(Date.now() / 1000);
  const output = buildOutput(reply, ctx);
  const response = buildResponse(reply, decoded, id, createdAt, output);
  const prepared: PreparedReply = { id, createdAt, output, response };
  cache.prepared = prepared;
  return prepared;
}

function chunkArguments(value: string): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < value.length; index += 16) chunks.push(value.slice(index, index + 16));
  return chunks;
}

function emptyResponse(prepared: PreparedReply): WireResponse {
  return {
    ...prepared.response,
    status: "in_progress",
    output: [],
    incomplete_details: null,
    usage: undefined,
    completed_at: undefined,
    error: null,
  };
}

function streamFrames(reply: Reply, decoded: Decoded, ctx: CodecContext): SseFrame[] {
  const prepared = preparedFor(reply, decoded, ctx);
  const frames: SseFrame[] = [];
  let sequence = 0;
  const add = (data: { type: string }, content?: string) => {
    frames.push({
      event: data.type,
      data: { ...data, sequence_number: sequence++ },
      ...(content === undefined ? {} : { content }),
    });
  };

  const created: WireCreatedEvent = { type: "response.created", response: emptyResponse(prepared), sequence_number: 0 };
  add(created);
  const inProgress: WireInProgressEvent = {
    type: "response.in_progress",
    response: emptyResponse(prepared),
    sequence_number: 0,
  };
  add(inProgress);

  prepared.output.forEach((item, outputIndex) => {
    if (item.type === "message") {
      const added: ResponseOutputItemAddedEvent = {
        type: "response.output_item.added",
        output_index: outputIndex,
        item: { ...item, status: "in_progress", content: [] },
        sequence_number: 0,
      };
      add(added);
      item.content.forEach((part, contentIndex) => {
        if (part.type === "output_text") {
          const partAdded: ResponseContentPartAddedEvent = {
            type: "response.content_part.added",
            item_id: item.id,
            output_index: outputIndex,
            content_index: contentIndex,
            part: { type: "output_text", text: "", annotations: [], logprobs: [] },
            sequence_number: 0,
          };
          add(partAdded);
          for (const delta of payloadChunks(part.text)) {
            const event: ResponseTextDeltaEvent = {
              type: "response.output_text.delta",
              item_id: item.id,
              output_index: outputIndex,
              content_index: contentIndex,
              delta,
              logprobs: [],
              sequence_number: 0,
            };
            add(event, delta);
          }
          const done: ResponseTextDoneEvent = {
            type: "response.output_text.done",
            item_id: item.id,
            output_index: outputIndex,
            content_index: contentIndex,
            text: part.text,
            logprobs: [],
            sequence_number: 0,
          };
          add(done);
          const partDone: ResponseContentPartDoneEvent = {
            type: "response.content_part.done",
            item_id: item.id,
            output_index: outputIndex,
            content_index: contentIndex,
            part,
            sequence_number: 0,
          };
          add(partDone);
        } else {
          const refusalPart = part as ResponseOutputRefusal;
          const partAdded: ResponseContentPartAddedEvent = {
            type: "response.content_part.added",
            item_id: item.id,
            output_index: outputIndex,
            content_index: contentIndex,
            part: { type: "refusal", refusal: "" },
            sequence_number: 0,
          };
          add(partAdded);
          for (const delta of textChunks(refusalPart.refusal)) {
            const event: ResponseRefusalDeltaEvent = {
              type: "response.refusal.delta",
              item_id: item.id,
              output_index: outputIndex,
              content_index: contentIndex,
              delta,
              sequence_number: 0,
            };
            add(event, delta);
          }
          const done: ResponseRefusalDoneEvent = {
            type: "response.refusal.done",
            item_id: item.id,
            output_index: outputIndex,
            content_index: contentIndex,
            refusal: refusalPart.refusal,
            sequence_number: 0,
          };
          add(done);
          const partDone: ResponseContentPartDoneEvent = {
            type: "response.content_part.done",
            item_id: item.id,
            output_index: outputIndex,
            content_index: contentIndex,
            part,
            sequence_number: 0,
          };
          add(partDone);
        }
      });
      const itemDone: ResponseOutputItemDoneEvent = {
        type: "response.output_item.done",
        output_index: outputIndex,
        item,
        sequence_number: 0,
      };
      add(itemDone);
      return;
    }

    if (item.type === "function_call") {
      const added: ResponseOutputItemAddedEvent = {
        type: "response.output_item.added",
        output_index: outputIndex,
        item: { ...item, status: "in_progress", arguments: "" },
        sequence_number: 0,
      };
      add(added);
      for (const delta of chunkArguments(item.arguments)) {
        const event: ResponseFunctionCallArgumentsDeltaEvent = {
          type: "response.function_call_arguments.delta",
          item_id: item.id ?? `fc_${outputIndex}`,
          output_index: outputIndex,
          delta,
          sequence_number: 0,
        };
        add(event, delta);
      }
      const done: ResponseFunctionCallArgumentsDoneEvent = {
        type: "response.function_call_arguments.done",
        item_id: item.id ?? `fc_${outputIndex}`,
        output_index: outputIndex,
        arguments: item.arguments,
        sequence_number: 0,
      };
      add(done);
      const itemDone: ResponseOutputItemDoneEvent = {
        type: "response.output_item.done",
        output_index: outputIndex,
        item,
        sequence_number: 0,
      };
      add(itemDone);
      return;
    }

    const reasoning = item as ResponseReasoningItem;
    const added: ResponseOutputItemAddedEvent = {
      type: "response.output_item.added",
      output_index: outputIndex,
      item: { ...reasoning, status: "in_progress", summary: [] },
      sequence_number: 0,
    };
    add(added);
    reasoning.summary.forEach((summary, summaryIndex) => {
      const partAdded: ResponseReasoningSummaryPartAddedEvent = {
        type: "response.reasoning_summary_part.added",
        item_id: reasoning.id,
        output_index: outputIndex,
        summary_index: summaryIndex,
        part: { type: "summary_text", text: "" },
        sequence_number: 0,
      };
      add(partAdded);
      for (const delta of textChunks(summary.text)) {
        const event: ResponseReasoningSummaryTextDeltaEvent = {
          type: "response.reasoning_summary_text.delta",
          item_id: reasoning.id,
          output_index: outputIndex,
          summary_index: summaryIndex,
          delta,
          sequence_number: 0,
        };
        add(event, delta);
      }
      const textDone: ResponseReasoningSummaryTextDoneEvent = {
        type: "response.reasoning_summary_text.done",
        item_id: reasoning.id,
        output_index: outputIndex,
        summary_index: summaryIndex,
        text: summary.text,
        sequence_number: 0,
      };
      add(textDone);
      const partDone: ResponseReasoningSummaryPartDoneEvent = {
        type: "response.reasoning_summary_part.done",
        item_id: reasoning.id,
        output_index: outputIndex,
        summary_index: summaryIndex,
        part: summary,
        sequence_number: 0,
      };
      add(partDone);
    });
    const itemDone: ResponseOutputItemDoneEvent = {
      type: "response.output_item.done",
      output_index: outputIndex,
      item: reasoning,
      sequence_number: 0,
    };
    add(itemDone);
  });

  const terminal = prepared.response;
  if (terminal.status === "incomplete") {
    const event: WireIncompleteEvent = {
      type: "response.incomplete",
      response: terminal,
      sequence_number: 0,
    };
    add(event);
  } else {
    const event: WireCompletedEvent = {
      type: "response.completed",
      response: terminal,
      sequence_number: 0,
    };
    add(event);
  }
  return frames;
}

function afterReply(reply: Reply, decoded: Decoded, ctx: CodecContext): void {
  if (!decoded.request.store) return;
  const extras = extrasOf(decoded);
  const prepared = preparedFor(reply, decoded, ctx);
  ctx.state.responses.set(prepared.id, {
    id: prepared.id,
    createdAt: prepared.createdAt,
    model: decoded.request.model,
    ...(extras.instructions === undefined ? {} : { instructions: extras.instructions }),
    inputItems: extras.inputItems,
    outputItems: prepared.output as unknown as Json[],
    response: prepared.response as unknown as Json,
  });
}

/** Looks up a stored Responses object and returns the wire reply, or the native 404. */
export function getStoredResponse(ctx: ResponsesStoreContext, id: string): Response {
  const stored = ctx.state.responses.get(id);
  if (!stored) return sendJson(errorBody(notFound(id)), 404);
  return sendJson(stored.response);
}

/** Deletes a stored Responses object, returning the native deleted object or the native 404. */
export function deleteStoredResponse(ctx: ResponsesStoreContext, id: string): Response {
  const stored = ctx.state.responses.get(id);
  if (!stored) return sendJson(errorBody(notFound(id)), 404);
  ctx.state.responses.delete(id);
  return sendJson({ id, object: "response.deleted", deleted: true });
}

/** The OpenAI Responses wire codec, including its stored-response helpers. */
export const responsesCodec: Codec = {
  format: "openai-responses",
  decode,
  encodeJson(reply, decoded, ctx) {
    return preparedFor(reply, decoded, ctx).response;
  },
  streamFrames,
  errorBody,
  afterReply,
};
