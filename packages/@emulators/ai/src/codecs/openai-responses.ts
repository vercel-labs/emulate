import type { Store } from "@emulators/core";
import { assertOutputSupported, assertToolsSupported } from "../schema-dialects.js";
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
import { CREATED_AT, type Codec, type CodecContext, type Decoded } from "../codec.js";
import { AiRequestError, defaultErrorType } from "../errors.js";
import { decodeResponsesAttachment } from "../attachments.js";
import type { SseFrame } from "../sse.js";
import { jsonChunks, payloadChunks, textChunks } from "../chunks.js";
import { REASONING_EFFORTS } from "./openai-chat.js";
import { STORED_RESPONSE_LIMIT, type AiState } from "../state.js";
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
  StoredResponse,
  ToolChoice as AiToolChoice,
  ToolDefinition,
  Usage,
} from "../types.js";

const FORMAT = "openai-responses";

type WireResponse = Omit<OpenAIResponse, "output_text">;

type WireToolChoice = ToolChoiceOptions | ToolChoiceFunction;

type WireReasoning = NonNullable<OpenAIResponse["reasoning"]>;

type WireMetadata = NonNullable<OpenAIResponse["metadata"]>;

type WireResponseEvent<T extends { response: OpenAIResponse }> = Omit<T, "response"> & {
  response: WireResponse;
};

type Unsequenced<T> = Omit<T, "sequence_number">;

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
  truncation: "auto" | "disabled";
  inputItems: Json[];
  gaps: number[];
}

interface PreparedReply {
  id: string;
  createdAt: number;
  output: ResponseOutputItem[];
  structured: Set<ResponseOutputText>;
  response: WireResponse;
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

function invalid(message: string, param?: string, code?: string): never {
  throw new AiRequestError(message, param, code);
}

function requireString(value: unknown, param: string, nonEmpty = false): string {
  if (typeof value !== "string") invalid(`Expected a string for '${param}'.`, param);
  if (nonEmpty && value.length === 0) invalid(`Expected a non-empty string for '${param}'.`, param);
  return value;
}

function optionalString(value: unknown, param: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireString(value, param);
}

function requireBoolean(value: unknown, param: string): boolean {
  if (typeof value !== "boolean") invalid(`Expected a boolean for '${param}'.`, param);
  return value;
}

function requireNumber(value: unknown, param: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) invalid(`Expected a number for '${param}'.`, param);
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

const LIST = new Intl.ListFormat("en", { style: "long", type: "conjunction" });

/** Returns the raw value when it is one of `values`; anything else is the native invalid_value error. */
function optionalEnum<T extends string>(raw: unknown, param: string, values: readonly T[]): T | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!values.includes(raw as T)) {
    invalid(
      `Invalid value: '${textOf(raw)}'. Supported values are: ${LIST.format(values.map((value) => `'${value}'`))}.`,
      param,
      "invalid_value",
    );
  }
  return raw as T;
}

/** Returns the number when it lies within `min` and `max`; outside that range it is the native decimal error. */
function optionalDecimal(raw: unknown, param: string, min: number, max: number): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  const value = requireNumber(raw, param);
  if (value > max) {
    invalid(
      `Invalid '${param}': decimal above maximum value. Expected a value <= ${max}, but got ${value} instead.`,
      param,
      "decimal_above_max_value",
    );
  }
  if (value < min) {
    invalid(
      `Invalid '${param}': decimal below minimum value. Expected a value >= ${min}, but got ${value} instead.`,
      param,
      "decimal_below_min_value",
    );
  }
  return value;
}

function functionOutput(output: unknown, path: string): { text: string; files: InputPart[] } {
  if (typeof output === "string") return { text: output, files: [] };
  if (!Array.isArray(output)) invalid(`Expected a string or array for '${path}.output'.`, `${path}.output`);
  const text: string[] = [];
  const files: InputPart[] = [];
  output.forEach((part, index) => {
    const partPath = `${path}.output[${index}]`;
    if (typeof part === "string") {
      text.push(part);
      return;
    }
    if (!isRecord(part)) invalid(`Expected a content part for '${partPath}'.`, partPath);
    if (part.type === "input_text" || part.type === "output_text" || part.type === "text") {
      if (typeof part.text !== "string") invalid(`Expected a string for '${partPath}.text'.`, `${partPath}.text`);
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
  if (!isRecord(raw)) invalid("Expected an object for 'reasoning'.", "reasoning");
  const reasoning: WireReasoning = {};
  const effort = optionalEnum(raw.effort, "reasoning.effort", REASONING_EFFORTS);
  if (effort !== undefined) reasoning.effort = effort;
  const summary = optionalEnum(raw.summary, "reasoning.summary", ["auto", "concise", "detailed"] as const);
  if (summary !== undefined) reasoning.summary = summary;
  const generateSummary = optionalEnum(raw.generate_summary, "reasoning.generate_summary", [
    "auto",
    "concise",
    "detailed",
  ] as const);
  if (generateSummary !== undefined) reasoning.generate_summary = generateSummary;
  const context = optionalEnum(raw.context, "reasoning.context", ["auto", "current_turn", "all_turns"] as const);
  if (context !== undefined) reasoning.context = context;
  const mode = optionalString(raw.mode, "reasoning.mode");
  if (mode !== undefined) reasoning.mode = mode;
  return reasoning;
}

function decodeMetadata(raw: unknown): WireMetadata {
  if (raw === undefined || raw === null) return {};
  if (!isRecord(raw)) invalid("Expected an object for 'metadata'.", "metadata");
  const metadata: WireMetadata = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== "string") invalid(`Expected a string for 'metadata.${key}'.`, `metadata.${key}`);
    metadata[key] = value;
  }
  return metadata;
}

function decodeTruncation(raw: unknown): "auto" | "disabled" {
  return optionalEnum(raw, "truncation", ["auto", "disabled"] as const) ?? "disabled";
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

function decodeTools(raw: unknown): { tools: Tool[]; definitions: ToolDefinition[] } {
  if (raw === undefined || raw === null) return { tools: [], definitions: [] };
  if (!Array.isArray(raw)) invalid("Expected an array of tools for 'tools'.", "tools");
  const tools: Tool[] = [];
  const definitions: ToolDefinition[] = [];
  raw.forEach((tool, index) => {
    const path = `tools[${index}]`;
    if (!isRecord(tool)) invalid(`Expected an object for '${path}'.`, path);
    if (tool.type !== "function") {
      const name = typeof tool.type === "string" ? tool.type : "unknown";
      unsupported(`tool type "${name}"`, `${path}.type`);
    }
    const name = requireString(tool.name, `${path}.name`, true);
    const description = optionalString(tool.description, `${path}.description`);
    let parameters: JsonSchema | undefined;
    if (tool.parameters !== undefined && tool.parameters !== null) {
      if (typeof tool.parameters !== "boolean" && !isRecord(tool.parameters)) {
        invalid(`Expected a JSON Schema object for '${path}.parameters'.`, `${path}.parameters`);
      }
      parameters = tool.parameters as JsonSchema;
    }
    const strict =
      tool.strict === undefined || tool.strict === null ? false : requireBoolean(tool.strict, `${path}.strict`);
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
      ...(strict ? { strict: true } : {}),
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
  invalid("Expected a tool choice string or function object for 'tool_choice'.", "tool_choice");
}

function decodeOutput(raw: unknown): OutputSpec | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw)) invalid("Expected an object for 'text'.", "text");
  optionalEnum(raw.verbosity, "text.verbosity", ["low", "medium", "high"] as const);
  const format = raw.format;
  if (format === undefined || format === null) return undefined;
  if (!isRecord(format)) invalid("Expected an object for 'text.format'.", "text.format");
  if (format.type === "text" || format.type === undefined) return undefined;
  if (format.type === "json_object") return { kind: "json_object" };
  if (format.type === "json_schema") {
    const name = optionalString(format.name, "text.format.name");
    optionalString(format.description, "text.format.description");
    const schema = format.schema;
    if (typeof schema !== "boolean" && !isRecord(schema)) {
      invalid("Expected a JSON Schema for 'text.format.schema'.", "text.format.schema");
    }
    if (format.strict !== undefined && format.strict !== null && typeof format.strict !== "boolean") {
      invalid("Expected a boolean for 'text.format.strict'.", "text.format.strict");
    }
    return {
      kind: "json_schema",
      ...(name === undefined ? {} : { name }),
      ...(format.strict === true ? { strict: true } : {}),
      schema: schema as JsonSchema,
    };
  }
  invalid(`Unsupported text format "${String(format.type)}".`, "text.format.type");
}

/** Builds the response's `text` field from validated values only, so unknown request keys are never echoed. */
function textWire(raw: unknown): ResponsesExtras["text"] {
  if (!isRecord(raw)) return { format: { type: "text" } };
  const verbosity = optionalEnum(raw.verbosity, "text.verbosity", ["low", "medium", "high"] as const);
  const wire: Record<string, unknown> = {};
  if (verbosity !== undefined) wire.verbosity = verbosity;
  const format = raw.format;
  if (isRecord(format)) {
    if (format.type === "json_object") wire.format = { type: "json_object" };
    else if (format.type === "json_schema") {
      const description = optionalString(format.description, "text.format.description");
      wire.format = {
        type: "json_schema",
        ...(typeof format.name === "string" ? { name: format.name } : {}),
        ...(description === undefined ? {} : { description }),
        schema: format.schema,
        ...(typeof format.strict === "boolean" ? { strict: format.strict } : {}),
      };
    } else wire.format = { type: "text" };
  }
  return wire as ResponsesExtras["text"];
}

function decodeMessageItem(item: Record<string, unknown>, path: string): Message {
  const role =
    item.role === "system" || item.role === "developer" || item.role === "assistant" || item.role === "user"
      ? item.role
      : undefined;
  if (!role) invalid(`Unsupported message role for '${path}.role'.`, `${path}.role`);
  const parts: InputPart[] = [];
  const content = item.content;
  if (content === undefined || content === null) {
    invalid(`Missing required parameter: '${path}.content'.`, `${path}.content`);
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
      if (!isRecord(part)) invalid(`Expected a content part for '${partPath}'.`, partPath);
      if (part.type === "input_audio") unsupported("audio input", `${partPath}.type`);
      if (part.type === "input_text" || part.type === "output_text" || part.type === "text") {
        if (typeof part.text !== "string") invalid(`Expected a string for '${partPath}.text'.`, `${partPath}.text`);
        parts.push({ type: "text", text: part.text });
        return;
      }
      const attachment = decodeResponsesAttachment(part, partPath);
      if (attachment) {
        parts.push(attachment);
        return;
      }
      if (part.type === "refusal") {
        if (typeof part.refusal !== "string")
          invalid(`Expected a string for '${partPath}.refusal'.`, `${partPath}.refusal`);
        parts.push({ type: "text", text: part.refusal });
        return;
      }
      unsupported(`input content type "${String(part.type)}"`, `${partPath}.type`);
    });
  } else {
    invalid(`Expected a string or array for '${path}.content'.`, `${path}.content`);
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
    invalid(`Missing required parameter: '${path}.output'.`, `${path}.output`);
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

interface ReplayedHistory {
  messages: Message[];
  gaps: number[];
  itemIds: Set<string>;
  missingParentId?: string;
}

function replayStoredHistory(state: AiState, id: string): ReplayedHistory | undefined {
  const head = state.responses.get(id);
  if (!head) return undefined;
  const chain: StoredResponse[] = [];
  const seen = new Set<string>();
  let current: StoredResponse | undefined = head;
  let missingParentId: string | undefined;
  while (current !== undefined && chain.length < state.responses.size) {
    if (seen.has(current.id)) {
      missingParentId = current.id;
      break;
    }
    seen.add(current.id);
    chain.push(current);
    const parentId = current.previousResponseId;
    if (parentId === undefined) break;
    const parent = state.responses.get(parentId);
    if (!parent) missingParentId = parentId;
    current = parent;
  }
  const messages: Message[] = [];
  const gaps: number[] = missingParentId === undefined ? [] : [0];
  const itemIds = new Set<string>();
  for (const entry of chain.reverse()) {
    const base = messages.length;
    for (const message of decodeStoredMessages(entry.inputItems)) messages.push(message);
    for (const message of storedOutputMessages(entry.outputItems)) messages.push(message);
    for (const gap of entry.gaps ?? []) gaps.push(base + gap);
    for (const item of entry.outputItems) {
      if (isRecord(item) && typeof item.id === "string") itemIds.add(item.id);
    }
  }
  return {
    messages,
    gaps,
    itemIds,
    ...(missingParentId === undefined ? {} : { missingParentId }),
  };
}

/** Removes a stored response, first folding its items into every stored response that links to it. */
function removeStoredResponse(state: AiState, id: string): void {
  const removed = state.responses.get(id);
  if (!removed) return;
  const folded = [...removed.inputItems, ...storedOutputMessages(removed.outputItems).map(messageToJson)];
  for (const child of state.responses.values()) {
    if (child === removed || child.previousResponseId !== id) continue;
    child.inputItems = [...folded, ...child.inputItems];
    const gaps = [...(removed.gaps ?? []), ...(child.gaps ?? []).map((gap) => gap + folded.length)];
    if (gaps.length > 0) child.gaps = gaps;
    if (removed.previousResponseId === undefined) delete child.previousResponseId;
    else child.previousResponseId = removed.previousResponseId;
  }
  state.responses.delete(id);
}

function indexStoredItems(state: AiState): Map<string, Json> {
  const items = new Map<string, Json>();
  for (const stored of state.responses.values()) {
    for (const item of stored.outputItems) {
      if (isRecord(item) && typeof item.id === "string" && !items.has(item.id)) items.set(item.id, item);
    }
  }
  return items;
}

function messageToJson(message: Message): Json {
  return { role: message.role, parts: message.parts } as unknown as Json;
}

function decode(body: unknown, ctx: CodecContext): Decoded {
  if (!isRecord(body)) invalid("Expected a JSON object request body.");
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
    invalid("Expected a non-negative integer for 'max_output_tokens'.", "max_output_tokens");
  }

  const { tools, definitions } = decodeTools(raw.tools);
  assertToolsSupported(model, definitions, (index) => `tools[${index}].parameters`);
  const { choice, wire: toolChoiceWire } = decodeToolChoice(raw.tool_choice);
  const parallelToolCalls =
    raw.parallel_tool_calls === undefined || raw.parallel_tool_calls === null
      ? true
      : requireBoolean(raw.parallel_tool_calls, "parallel_tool_calls");
  const output = decodeOutput(raw.text);
  assertOutputSupported(model, output, { format: "text.format", strict: "text.format.strict" });
  const reasoning = decodeReasoning(raw.reasoning);
  const metadata = decodeMetadata(raw.metadata);
  const previousResponseId = optionalString(raw.previous_response_id, "previous_response_id");
  if (previousResponseId !== undefined && !previousResponseId.startsWith("resp_")) {
    invalid(`Expected a response id starting with 'resp_' for 'previous_response_id'.`, "previous_response_id");
  }

  const messages: Message[] = [];
  if (instructions !== undefined) messages.push({ role: "system", parts: [{ type: "text", text: instructions }] });

  const history: Message[] = [];
  const ownItems: Message[] = [];
  const references: HistoryReference[] = [];
  const warnings: string[] = [];
  const historyGaps: number[] = [];
  const ownGaps: number[] = [];
  const knownItemIds = new Set<string>();
  let storedItems: Map<string, Json> | undefined;

  if (previousResponseId !== undefined) {
    const replay = replayStoredHistory(ctx.state, previousResponseId);
    if (replay) {
      for (const message of replay.messages) history.push(message);
      references.push({ id: previousResponseId, kind: "previous_response", resolved: true });
      for (const gap of replay.gaps) historyGaps.push(gap);
      for (const itemId of replay.itemIds) knownItemIds.add(itemId);
      if (replay.gaps.length > 0) {
        warnings.push(`Response "${previousResponseId}" has unresolved history; continuing with partial context.`);
      }
      if (replay.missingParentId !== undefined) {
        warnings.push(
          `Unknown response "${replay.missingParentId}" in the history chain; continuing with partial context.`,
        );
      }
    } else {
      references.push({ id: previousResponseId, kind: "previous_response", resolved: false });
      ownGaps.push(0);
      warnings.push(`Unknown previous_response_id "${previousResponseId}"; continuing with empty context.`);
    }
  }

  const input = raw.input;
  if (input === undefined || input === null) invalid("Missing required parameter: 'input'.", "input");
  const items: unknown[] = typeof input === "string" ? [{ role: "user", content: input }] : (input as unknown[]);
  if (!Array.isArray(items)) invalid("Expected a string or array for 'input'.", "input");

  items.forEach((entry, index) => {
    const path = `input[${index}]`;
    if (typeof entry === "string") {
      ownItems.push({ role: "user", parts: [{ type: "text", text: entry }] });
      return;
    }
    if (!isRecord(entry)) invalid(`Expected an item for '${path}'.`, path);
    const type = typeof entry.type === "string" ? entry.type : undefined;

    if (type === "item_reference") {
      const id = requireString(entry.id, `${path}.id`, true);
      storedItems ??= indexStoredItems(ctx.state);
      const found = storedItems.get(id);
      if (found !== undefined) {
        references.push({ id, kind: "item", resolved: true });
        if (!knownItemIds.has(id)) {
          knownItemIds.add(id);
          for (const message of storedOutputMessages([found])) ownItems.push(message);
        }
      } else {
        references.push({ id, kind: "item", resolved: false });
        ownGaps.push(ownItems.length);
        warnings.push(`Unknown item_reference "${id}"; dropping it.`);
      }
      return;
    }

    if (type === "function_call") {
      ownItems.push(decodeFunctionCall(entry, path).message);
      return;
    }

    if (type === "function_call_output") {
      ownItems.push(decodeFunctionCallOutput(entry, path));
      return;
    }

    if (type === "reasoning") return;

    if (type === undefined || type === "message") {
      ownItems.push(decodeMessageItem(entry, path));
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

  const historyStart = messages.length;
  for (const message of history) messages.push(message);
  const ownStart = messages.length;
  for (const message of ownItems) messages.push(message);

  const gaps = [...historyGaps.map((gap) => historyStart + gap), ...ownGaps.map((gap) => ownStart + gap)];
  const firstGap = gaps.reduce((least, gap) => Math.min(least, gap), Infinity);
  const lastGap = gaps.reduce((most, gap) => Math.max(most, gap), -Infinity);
  const callNames = new Map<string, string>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "tool_call") callNames.set(part.id, part.name);
    }
  }

  const answered = new Set<string>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "tool_result") answered.add(part.id);
    }
  }
  messages.forEach((message, index) => {
    for (const part of message.parts) {
      if (part.type === "tool_result") {
        const name = callNames.get(part.id);
        if (name !== undefined) {
          part.name = name;
        } else if (index >= firstGap) {
          warnings.push(
            `Tool result "${part.id}" does not match a known call; accepting it because referenced history is missing.`,
          );
        } else {
          invalid(`No function call found for tool output "${part.id}".`, "input");
        }
      } else if (part.type === "tool_call" && !answered.has(part.id) && index >= lastGap) {
        invalid(`No tool output found for function call ${part.id}.`, "input");
      }
    }
  });

  const request: AIRequest = {
    format: FORMAT,
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
    temperature: optionalDecimal(raw.temperature, "temperature", 0, 2) ?? 1,
    topP: optionalDecimal(raw.top_p, "top_p", 0, 1) ?? 1,
    text: textWire(raw.text),
    ...(reasoning === undefined ? {} : { reasoning }),
    metadata,
    truncation: decodeTruncation(raw.truncation),
    inputItems: ownItems.map(messageToJson),
    gaps: ownGaps,
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
  return responseStatus(finish).status;
}

function buildOutput(
  reply: Reply,
  ctx: CodecContext,
): { output: ResponseOutputItem[]; structured: Set<ResponseOutputText> } {
  const output: ResponseOutputItem[] = [];
  const structured = new Set<ResponseOutputText>();
  let text: string[] = [];
  let kind: "text" | "object" | undefined;

  const flushText = () => {
    if (text.length === 0) return;
    const part: ResponseOutputText = {
      type: "output_text",
      text: text.join(""),
      annotations: [],
      logprobs: [],
    };
    if (kind === "object") structured.add(part);
    output.push({
      id: ctx.makeId("msg"),
      type: "message",
      role: "assistant",
      status: itemStatus(reply.finish),
      content: [part],
    });
    text = [];
    kind = undefined;
  };

  for (const event of reply.events) {
    switch (event.type) {
      case "reasoning":
        flushText();
        output.push({
          id: ctx.makeId("rs"),
          type: "reasoning",
          status: itemStatus(reply.finish),
          summary: [{ type: "summary_text", text: event.text }],
        });
        break;
      case "text":
        if (kind === "object") flushText();
        kind = "text";
        text.push(event.text);
        break;
      case "object":
        if (kind === "text") flushText();
        kind = "object";
        text.push(JSON.stringify(event.value));
        break;
      case "tool_call":
        flushText();
        output.push({
          id: ctx.makeId("fc"),
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
          id: ctx.makeId("msg"),
          type: "message",
          role: "assistant",
          status: itemStatus(reply.finish),
          content: [{ type: "refusal", refusal: event.text }],
        });
        break;
    }
  }
  flushText();
  return { output, structured };
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
    previous_response_id: request.previousResponseId ?? null,
    reasoning: extras.reasoning ?? { effort: null, summary: null },
    temperature: extras.temperature,
    text: extras.text,
    tool_choice: extras.toolChoice,
    tools: extras.tools,
    top_p: extras.topP,
    truncation: extras.truncation,
    usage: usageWire(reply.usage),
    max_output_tokens: request.maxOutputTokens ?? null,
  };
}

function preparedFor(reply: Reply, decoded: Decoded, ctx: CodecContext): PreparedReply {
  const cache = decoded.extras as Record<string, unknown>;
  const existing = cache.prepared as PreparedReply | undefined;
  if (existing) return existing;
  const id = ctx.makeId("resp");
  const createdAt = CREATED_AT;
  const { output, structured } = buildOutput(reply, ctx);
  const response = buildResponse(reply, decoded, id, createdAt, output);
  const prepared: PreparedReply = { id, createdAt, output, structured, response };
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

  const created: Unsequenced<WireCreatedEvent> = { type: "response.created", response: emptyResponse(prepared) };
  add(created);
  const inProgress: Unsequenced<WireInProgressEvent> = {
    type: "response.in_progress",
    response: emptyResponse(prepared),
  };
  add(inProgress);

  prepared.output.forEach((item, outputIndex) => {
    if (item.type === "message") {
      const added: Unsequenced<ResponseOutputItemAddedEvent> = {
        type: "response.output_item.added",
        output_index: outputIndex,
        item: { ...item, status: "in_progress", content: [] },
      };
      add(added);
      item.content.forEach((part, contentIndex) => {
        if (part.type === "output_text") {
          const partAdded: Unsequenced<ResponseContentPartAddedEvent> = {
            type: "response.content_part.added",
            item_id: item.id,
            output_index: outputIndex,
            content_index: contentIndex,
            part: { type: "output_text", text: "", annotations: [], logprobs: [] },
          };
          add(partAdded);
          const deltas = prepared.structured.has(part) ? jsonChunks(part.text) : payloadChunks(part.text);
          for (const delta of deltas) {
            const event: Unsequenced<ResponseTextDeltaEvent> = {
              type: "response.output_text.delta",
              item_id: item.id,
              output_index: outputIndex,
              content_index: contentIndex,
              delta,
              logprobs: [],
            };
            add(event, delta);
          }
          const done: Unsequenced<ResponseTextDoneEvent> = {
            type: "response.output_text.done",
            item_id: item.id,
            output_index: outputIndex,
            content_index: contentIndex,
            text: part.text,
            logprobs: [],
          };
          add(done);
          const partDone: Unsequenced<ResponseContentPartDoneEvent> = {
            type: "response.content_part.done",
            item_id: item.id,
            output_index: outputIndex,
            content_index: contentIndex,
            part,
          };
          add(partDone);
        } else {
          const refusalPart = part as ResponseOutputRefusal;
          const partAdded: Unsequenced<ResponseContentPartAddedEvent> = {
            type: "response.content_part.added",
            item_id: item.id,
            output_index: outputIndex,
            content_index: contentIndex,
            part: { type: "refusal", refusal: "" },
          };
          add(partAdded);
          for (const delta of textChunks(refusalPart.refusal)) {
            const event: Unsequenced<ResponseRefusalDeltaEvent> = {
              type: "response.refusal.delta",
              item_id: item.id,
              output_index: outputIndex,
              content_index: contentIndex,
              delta,
            };
            add(event, delta);
          }
          const done: Unsequenced<ResponseRefusalDoneEvent> = {
            type: "response.refusal.done",
            item_id: item.id,
            output_index: outputIndex,
            content_index: contentIndex,
            refusal: refusalPart.refusal,
          };
          add(done);
          const partDone: Unsequenced<ResponseContentPartDoneEvent> = {
            type: "response.content_part.done",
            item_id: item.id,
            output_index: outputIndex,
            content_index: contentIndex,
            part,
          };
          add(partDone);
        }
      });
      const itemDone: Unsequenced<ResponseOutputItemDoneEvent> = {
        type: "response.output_item.done",
        output_index: outputIndex,
        item,
      };
      add(itemDone);
      return;
    }

    if (item.type === "function_call") {
      const added: Unsequenced<ResponseOutputItemAddedEvent> = {
        type: "response.output_item.added",
        output_index: outputIndex,
        item: { ...item, status: "in_progress", arguments: "" },
      };
      add(added);
      for (const delta of chunkArguments(item.arguments)) {
        const event: Unsequenced<ResponseFunctionCallArgumentsDeltaEvent> = {
          type: "response.function_call_arguments.delta",
          item_id: item.id ?? `fc_${outputIndex}`,
          output_index: outputIndex,
          delta,
        };
        add(event, delta);
      }
      const done: Unsequenced<ResponseFunctionCallArgumentsDoneEvent> = {
        type: "response.function_call_arguments.done",
        item_id: item.id ?? `fc_${outputIndex}`,
        output_index: outputIndex,
        arguments: item.arguments,
      };
      add(done);
      const itemDone: Unsequenced<ResponseOutputItemDoneEvent> = {
        type: "response.output_item.done",
        output_index: outputIndex,
        item,
      };
      add(itemDone);
      return;
    }

    const reasoning = item as ResponseReasoningItem;
    const added: Unsequenced<ResponseOutputItemAddedEvent> = {
      type: "response.output_item.added",
      output_index: outputIndex,
      item: { ...reasoning, status: "in_progress", summary: [] },
    };
    add(added);
    reasoning.summary.forEach((summary, summaryIndex) => {
      const partAdded: Unsequenced<ResponseReasoningSummaryPartAddedEvent> = {
        type: "response.reasoning_summary_part.added",
        item_id: reasoning.id,
        output_index: outputIndex,
        summary_index: summaryIndex,
        part: { type: "summary_text", text: "" },
      };
      add(partAdded);
      for (const delta of textChunks(summary.text)) {
        const event: Unsequenced<ResponseReasoningSummaryTextDeltaEvent> = {
          type: "response.reasoning_summary_text.delta",
          item_id: reasoning.id,
          output_index: outputIndex,
          summary_index: summaryIndex,
          delta,
        };
        add(event, delta);
      }
      const textDone: Unsequenced<ResponseReasoningSummaryTextDoneEvent> = {
        type: "response.reasoning_summary_text.done",
        item_id: reasoning.id,
        output_index: outputIndex,
        summary_index: summaryIndex,
        text: summary.text,
      };
      add(textDone);
      const partDone: Unsequenced<ResponseReasoningSummaryPartDoneEvent> = {
        type: "response.reasoning_summary_part.done",
        item_id: reasoning.id,
        output_index: outputIndex,
        summary_index: summaryIndex,
        part: summary,
      };
      add(partDone);
    });
    const itemDone: Unsequenced<ResponseOutputItemDoneEvent> = {
      type: "response.output_item.done",
      output_index: outputIndex,
      item: reasoning,
    };
    add(itemDone);
  });

  const terminal = prepared.response;
  if (terminal.status === "incomplete") {
    const event: Unsequenced<WireIncompleteEvent> = {
      type: "response.incomplete",
      response: terminal,
    };
    add(event);
  } else {
    const event: Unsequenced<WireCompletedEvent> = {
      type: "response.completed",
      response: terminal,
    };
    add(event);
  }
  return frames;
}

function afterReply(reply: Reply, decoded: Decoded, ctx: CodecContext): void {
  if (!decoded.request.store) return;
  const extras = extrasOf(decoded);
  const prepared = preparedFor(reply, decoded, ctx);
  const responses = ctx.state.responses;
  const parent = decoded.request.references.find(
    (reference) => reference.kind === "previous_response" && reference.resolved,
  );
  responses.set(prepared.id, {
    id: prepared.id,
    createdAt: prepared.createdAt,
    model: decoded.request.model,
    ...(extras.instructions === undefined ? {} : { instructions: extras.instructions }),
    ...(parent === undefined ? {} : { previousResponseId: parent.id }),
    inputItems: extras.inputItems,
    outputItems: prepared.output as unknown as Json[],
    response: prepared.response as unknown as Json,
    ...(extras.gaps.length > 0 ? { gaps: extras.gaps } : {}),
  });
  while (responses.size > STORED_RESPONSE_LIMIT) {
    const oldest = responses.keys().next();
    if (oldest.done) break;
    removeStoredResponse(ctx.state, oldest.value);
  }
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
  removeStoredResponse(ctx.state, id);
  return sendJson({ id, object: "response.deleted", deleted: true });
}

/** The OpenAI Responses wire codec, including its stored-response helpers. */
export const responsesCodec: Codec = {
  format: FORMAT,
  decode,
  encodeJson(reply, decoded, ctx) {
    return preparedFor(reply, decoded, ctx).response;
  },
  streamFrames,
  errorBody,
  afterReply,
};
