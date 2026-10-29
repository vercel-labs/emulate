/** A JSON value accepted from clients or seed config and produced in replies. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** A JSON Schema as sent by clients for structured output or tool parameters. */
export type JsonSchema = boolean | { [key: string]: Json };

/** The wire format a request arrived in, selected from the request path. */
export type AiFormat = "openai-chat" | "openai-responses";

/** Attachment metadata decoded from a request; file bytes are never kept. */
export interface FilePart {
  type: "file";
  mediaType: string;
  name?: string;
  source: "inline" | "url" | "file_id";
  ref?: string;
  bytes?: number;
  sha256?: string;
}

/** One ordered part of a normalized message. Tool call arguments stay as the JSON text the client sent. */
export type InputPart =
  | { type: "text"; text: string }
  | FilePart
  | { type: "tool_call"; id: string; name: string; arguments: string }
  | { type: "tool_result"; id: string; name?: string; output: string; isError?: boolean };

/** A normalized conversation turn. */
export interface Message {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  parts: InputPart[];
}

/** A function tool the client declared. */
export interface ToolDefinition {
  name: string;
  description?: string;
  parameters?: JsonSchema;
}

/** How the client constrained tool use. */
export type ToolChoice = "auto" | "none" | "required" | { name: string };

/** The structured output the client requested, if any. */
export type OutputSpec = { kind: "json_object" } | { kind: "json_schema"; name?: string; schema: JsonSchema };

/** A reference to earlier history and whether the store resolved it. */
export interface HistoryReference {
  id: string;
  kind: "previous_response" | "item";
  resolved: boolean;
}

/** The format-neutral request every codec decodes into and the engine matches against. */
export interface AIRequest {
  format: AiFormat;
  model: string;
  messages: Message[];
  tools: ToolDefinition[];
  toolChoice: ToolChoice;
  parallelToolCalls: boolean;
  stream: boolean;
  output?: OutputSpec;
  reasoning: boolean;
  maxOutputTokens?: number;
  stop?: string[];
  store: boolean;
  previousResponseId?: string;
  references: HistoryReference[];
  warnings: string[];
}

/** One whole semantic piece of a reply; codecs split it into wire chunks. */
export type ReplyEvent =
  | { type: "reasoning"; text: string }
  | { type: "text"; text: string }
  | { type: "object"; value: Json }
  | { type: "tool_call"; id: string; name: string; arguments: string }
  | { type: "refusal"; text: string };

/** Why a reply ended, in format-neutral terms. */
export type FinishReason = "stop" | "tool_calls" | "length" | "refusal" | "content_filter";

/** Deterministic token estimates; output includes reasoning. */
export interface Usage {
  input: number;
  output: number;
  reasoning: number;
}

/** A complete reply computed before any byte is sent. */
export interface Reply {
  events: ReplyEvent[];
  finish: FinishReason;
  usage: Usage;
}

/** An HTTP error a rule injects or the emulator returns, rendered in the codec's native error body. */
export interface HttpFailure {
  status: number;
  message: string;
  type?: string;
  code?: string;
  param?: string;
  headers?: Record<string, string>;
}

/** A scripted stream fault; afterChunks counts content deltas, not lifecycle events. */
export interface StreamFault {
  afterChunks: number;
  kind: "disconnect" | "stall";
  stallMs?: number;
}

/** Stream pacing; zero means instant. */
export interface Timing {
  ttftMs: number;
  chunkDelayMs: number;
}

/** Conditions a rule requires; every supplied condition must hold. `model` and `tool` accept `*` wildcards. */
export interface RuleMatch {
  model?: string;
  format?: AiFormat;
  stream?: boolean;
  textContains?: string;
  tool?: string;
  hasToolResult?: boolean;
  file?: boolean | string;
}

/** A reply event as written in rules; tool call ids and string arguments are filled in by the engine. */
export type RuleReplyEvent =
  | { type: "reasoning"; text: string }
  | { type: "text"; text: string }
  | { type: "object"; value: Json }
  | { type: "tool_call"; name: string; arguments: Json; id?: string }
  | { type: "refusal"; text: string };

/** One validated rule. Exactly one of `reply` or `error` is set. */
export interface Rule {
  id: string;
  match: RuleMatch;
  times?: number;
  reply?: RuleReplyEvent[];
  finish?: FinishReason;
  error?: HttpFailure;
  fault?: StreamFault;
  timing?: Partial<Timing>;
}

/** The validated service configuration shared by seed config and the runtime rules endpoint. */
export interface AiConfig {
  strict: boolean;
  timing: Timing;
  models: string[];
  rules: Rule[];
}

/** Which rule answered a call, its budget left afterwards (null means unlimited), and a copy of its configuration. */
export interface RuleSnapshot {
  id: string;
  remaining: number | null;
  rule: Rule;
}

/** What the engine decided for one request. */
export type Outcome =
  | { kind: "reply"; reply: Reply; matched: RuleSnapshot | { default: string }; fault?: StreamFault; timing: Timing }
  | { kind: "error"; failure: HttpFailure; matched: RuleSnapshot | { default: string } | null };

/** How a streamed or unary response actually reached the client. */
export type Delivery = "pending" | "completed" | "client_aborted" | "error";

/** One recorded generation request, redacted when written: never keys, auth headers, or file bytes. */
export interface CallRecord {
  seq: number;
  time: string;
  format: AiFormat;
  path: string;
  model: string;
  stream: boolean;
  messages: Message[];
  tools: string[];
  toolChoice: ToolChoice;
  outputSchema?: string;
  previousResponseId?: string;
  references: HistoryReference[];
  store: boolean;
  matched: RuleSnapshot | { default: string } | null;
  reply?: { finish: FinishReason; summary: string };
  status: number;
  fault: "none" | "disconnect" | "stall";
  delivery: Delivery;
  warnings: string[];
}

/** A stored Responses API object with the items needed to resolve later references. */
export interface StoredResponse {
  id: string;
  createdAt: number;
  model: string;
  instructions?: string;
  inputItems: Json[];
  outputItems: Json[];
  response: Json;
}
