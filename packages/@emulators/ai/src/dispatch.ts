import type { AppEnv, Context, Hono, Store } from "@emulators/core";
import type { Codec, CodecContext, Decoded } from "./codec.js";
import { messagesCodec } from "./codecs/anthropic-messages.js";
import { chatCodec } from "./codecs/openai-chat.js";
import { deleteStoredResponse, getStoredResponse, responsesCodec } from "./codecs/openai-responses.js";
import { decide } from "./engine.js";
import { AiConfigError, AiRequestError, defaultErrorType } from "./errors.js";
import { parseConfig, rulesView, type RuleView } from "./rules.js";
import { renderAiInspector } from "./routes/inspector.js";
import {
  beginRequest,
  clearCalls,
  getAiState,
  getSeedConfig,
  isCurrentGeneration,
  nextId,
  recordCall,
  resetAiState,
  setAiConfig,
  setSeedConfig,
  settleCall,
  type AiState,
  type CallStamp,
} from "./state.js";
import { sseResponse, type SseOptions } from "./sse.js";
import type { AIRequest, AiConfig, AiFormat, CallRecord, Delivery, HttpFailure, Json, Reply, Rule } from "./types.js";

/** The data paths the service answers; the native 404 and startup output name them. */
export const SUPPORTED_DATA_PATHS =
  "POST .../chat/completions, POST .../responses, POST .../messages, GET .../models, GET or DELETE .../responses/{id}";

/** The OpenAI error envelope both V1 formats share. */
export function aiErrorBody(
  status: number,
  message: string,
  param?: string | null,
  code?: string | null,
): { error: { message: string; type: string; param: string | null; code: string | null } } {
  return {
    error: {
      message,
      type: defaultErrorType(status),
      param: param ?? null,
      code: code ?? null,
    },
  };
}

export interface AiRoutesOptions {
  app: Hono<AppEnv>;
  store: Store;
  baseUrl: string;
}

const CODECS: ReadonlyArray<{ suffix: string; codec: Codec }> = [
  { suffix: "/chat/completions", codec: chatCodec },
  { suffix: "/responses", codec: responsesCodec },
  { suffix: "/messages", codec: messagesCodec },
];

const MAX_SEEN_MODELS = 1000;

const RESPONSE_ID = /(?:^|\/)responses\/([^/]+)$/;

/** Installs the anchored data router and the control routes; control routes are checked first. */
export function registerAiRoutes({ app, store, baseUrl }: AiRoutesOptions): void {
  let expectedOrigin: string | undefined;
  try {
    expectedOrigin = new URL(baseUrl).origin;
  } catch {
    expectedOrigin = undefined;
  }

  app.use("*", async (c, next) => {
    if (c.req.path.startsWith("/_emulate/")) {
      await next();
      return;
    }
    return handleRequest(c, store, expectedOrigin);
  });
}

/** Replaces the seeded configuration; core replays this on every startup and programmatic reset. */
export function setAiSeed(store: Store, config: AiConfig): void {
  setSeedConfig(store, config);
  resetAiState(store, config);
}

/** Restores the seeded rules, budgets, ids, call record, and stored responses. */
export function resetAiToSeed(store: Store): void {
  resetAiState(store, getSeedConfig(store));
}

async function handleRequest(c: Context<AppEnv>, store: Store, expectedOrigin: string | undefined): Promise<Response> {
  const url = new URL(c.req.url);
  const path = url.pathname;
  const requested = c.req.method.toUpperCase();
  const method = requested === "HEAD" ? "GET" : requested;
  const state = getAiState(store);

  if (path === "/_ai" || path.startsWith("/_ai/") || (method === "GET" && path === "/")) {
    if (isForeignOrigin(c.req.header("origin"), expectedOrigin)) {
      return c.json(aiErrorBody(403, "Cross-origin requests are not allowed on AI control routes."), 403);
    }
    return handleControl(c, method, path, store, state);
  }

  if (method === "POST") {
    const codec = CODECS.find(({ suffix }) => hasSuffix(path, suffix))?.codec;
    if (codec) return handleGeneration(c, store, state, codec, path);
  }

  if (method === "GET" || method === "DELETE") {
    const id = responseId(path);
    if (id !== null) {
      const ctx = context(store, state, path);
      return method === "GET" ? getStoredResponse(ctx, id) : deleteStoredResponse(ctx, id);
    }
    if (method === "GET" && hasSuffix(path, "/models")) return listModels(c, state);
  }

  throw unsupportedPath(path);
}

async function handleControl(
  c: Context<AppEnv>,
  method: string,
  path: string,
  store: Store,
  state: AiState,
): Promise<Response> {
  if (path === "/_ai/calls") {
    if (method === "GET") return c.json(state.calls);
    if (method === "DELETE") {
      const deleted = state.calls.length;
      clearCalls(state);
      return c.json({ deleted });
    }
  }

  if (path === "/_ai/rules") {
    if (method === "GET") return c.json(configView(state));
    if (method === "PUT") return replaceRules(c, state);
  }

  if (path === "/_ai/reset" && method === "POST") {
    resetAiToSeed(store);
    return c.json({ reset: true });
  }

  if (path === "/" && method === "GET") {
    const requested = c.req.query("tab");
    const tab = requested === "rules" ? "rules" : "calls";
    const rawSelected = c.req.query("call");
    const selected = rawSelected !== undefined && /^\d+$/.test(rawSelected) ? Number(rawSelected) : undefined;
    return c.html(renderAiInspector({ tab, calls: state.calls, rules: ruleStatuses(state), selected }));
  }

  throw unsupportedPath(path);
}

async function replaceRules(c: Context<AppEnv>, state: AiState): Promise<Response> {
  const generation = state.generation;
  const generationSignal = state.controller.signal;
  const body = await readJson(c);
  if (generationSignal.aborted || !isCurrentGeneration(state, { generation })) throw staleStateError();
  if (!isRecord(body)) {
    throw new AiRequestError("Expected a JSON object rules body.", "config", "invalid_config");
  }
  let config: AiConfig;
  try {
    config = parseConfig(stripBudgets(body));
  } catch (error) {
    if (error instanceof AiConfigError) {
      throw new AiRequestError(error.message, error.path, "invalid_config");
    }
    throw error;
  }
  setAiConfig(state, config);
  return c.json(configView(state));
}

function configView(state: AiState) {
  const { strict, timing, random, models } = state.config;
  return { rules: ruleViews(state), strict, timing, random, models };
}

function ruleViews(state: AiState): RuleView[] {
  return rulesView(state.config, state.budgets);
}

function ruleStatuses(state: AiState): Array<{ rule: Rule; remaining: number | null }> {
  return ruleViews(state).map(({ remaining, ...rule }) => ({ rule, remaining }));
}

function listModels(c: Context<AppEnv>, state: AiState): Response {
  const ids = [...new Set([...state.config.models, ...state.seenModels])];
  return c.json({
    object: "list",
    data: ids.map((id) => ({ id, object: "model", created: 0, owned_by: "emulate" })),
  });
}

async function handleGeneration(
  c: Context<AppEnv>,
  store: Store,
  state: AiState,
  codec: Codec,
  path: string,
): Promise<Response> {
  const scope = beginRequest(state, c.req.raw.signal);
  const stamp: CallStamp = { generation: scope.generation, callsGeneration: scope.callsGeneration };
  const ctx = context(store, state, path);
  let body: unknown;
  let decoded: Decoded;
  try {
    body = await readJson(c);
  } catch (error) {
    const status = error instanceof AiRequestError ? error.status : 500;
    const call = rejectedCall(state, codec.format, path, body, status);
    recordCall(state, call, stamp);
    scope.dispose();
    if (error instanceof AiRequestError) return errorResponse(codec, failureOf(error), call.seq);
    throw error;
  }
  if (scope.signal.aborted || !isCurrentGeneration(state, stamp)) {
    scope.dispose();
    throw staleStateError();
  }
  try {
    decoded = codec.decode(body, ctx);
  } catch (error) {
    const status = error instanceof AiRequestError ? error.status : 500;
    const call = rejectedCall(state, codec.format, path, body, status);
    recordCall(state, call, stamp);
    scope.dispose();
    if (error instanceof AiRequestError) return errorResponse(codec, failureOf(error), call.seq);
    throw error;
  }

  const request = decoded.request;
  state.seenModels.add(request.model);
  while (state.seenModels.size > MAX_SEEN_MODELS) {
    state.seenModels.delete(state.seenModels.values().next().value as string);
  }

  let outcome;
  try {
    outcome = decide(store, request);
  } catch (error) {
    const status = error instanceof AiRequestError ? error.status : 500;
    const call = rejectedCall(state, codec.format, path, body, status);
    fillCall(call, request);
    recordCall(state, call, stamp);
    scope.dispose();
    if (error instanceof AiRequestError) return errorResponse(codec, failureOf(error), call.seq);
    throw error;
  }

  const call = freshCall(state, codec.format, path);
  fillCall(call, request);
  call.matched = outcome.matched;

  if (outcome.kind === "error") {
    call.status = outcome.failure.status;
    call.delivery = "completed";
    recordCall(state, call, stamp);
    scope.dispose();
    return errorResponse(codec, outcome.failure, call.seq);
  }

  call.status = 200;
  call.reply = { finish: outcome.reply.finish, summary: summarize(outcome.reply) };
  let encoded: unknown;
  try {
    encoded = codec.encodeJson(outcome.reply, decoded, ctx);
  } catch (error) {
    scope.dispose();
    throw error;
  }
  if (scope.signal.aborted || !isCurrentGeneration(state, stamp)) {
    scope.dispose();
    throw staleStateError();
  }
  codec.afterReply?.(outcome.reply, decoded, ctx, encoded);
  recordCall(state, call, stamp);

  if (!request.stream) {
    call.delivery = "completed";
    scope.dispose();
    return withRequestId(Response.json(encoded, { status: 200 }), codec, call.seq);
  }

  let frames;
  try {
    frames = codec.streamFrames(outcome.reply, decoded, ctx);
  } catch (error) {
    settleCall(state, call, stamp, "error");
    scope.dispose();
    throw error;
  }
  const options: SseOptions = {
    signal: scope.signal,
    timing: outcome.timing,
    fault: outcome.fault,
    onFault(kind) {
      call.fault = kind;
    },
    onSettled(delivery: Exclude<Delivery, "pending">) {
      settleCall(state, call, stamp, delivery);
      scope.dispose();
    },
  };
  return withRequestId(sseResponse(frames, options), codec, call.seq);
}

function context(store: Store, state: AiState, path: string): CodecContext {
  return {
    store,
    state,
    path,
    makeId(prefix: string): string {
      return `${prefix}_${nextId(state)}`;
    },
  };
}

function freshCall(state: AiState, format: AiFormat, path: string): CallRecord {
  const seq = state.callSeq + 1;
  state.callSeq = seq;
  return {
    seq,
    time: new Date().toISOString(),
    format,
    path,
    model: "",
    stream: false,
    messages: [],
    tools: [],
    toolChoice: "auto",
    references: [],
    store: format === "openai-responses",
    matched: null,
    status: 200,
    fault: "none",
    delivery: "pending",
    warnings: [],
  };
}

function rejectedCall(state: AiState, format: AiFormat, path: string, body: unknown, status: number): CallRecord {
  const call = freshCall(state, format, path);
  call.status = status;
  call.delivery = "completed";
  if (isRecord(body)) {
    if (typeof body.model === "string") call.model = body.model;
    if (typeof body.stream === "boolean") call.stream = body.stream;
    if (typeof body.store === "boolean") call.store = body.store;
  }
  return call;
}

function fillCall(call: CallRecord, request: AIRequest): void {
  call.model = request.model;
  call.stream = request.stream;
  call.messages = request.messages;
  call.tools = request.tools.map((tool) => tool.name);
  call.toolChoice = request.toolChoice;
  call.references = request.references;
  call.store = request.store;
  call.warnings = request.warnings;
  if (request.output) {
    call.outputSchema = request.output.kind === "json_schema" ? (request.output.name ?? "schema") : "json_object";
  }
  if (request.previousResponseId !== undefined) call.previousResponseId = request.previousResponseId;
}

function summarize(reply: Reply): string {
  const text = reply.events
    .map((event) => {
      if (event.type === "text" || event.type === "reasoning" || event.type === "refusal") return event.text;
      if (event.type === "object") return JSON.stringify(event.value);
      return `${event.name}(${event.arguments})`;
    })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 200 ? `${text.slice(0, 197)}...` : text;
}

function failureOf(error: AiRequestError): HttpFailure {
  return {
    status: error.status,
    message: error.message,
    ...(error.param === undefined ? {} : { param: error.param }),
    ...(error.code === undefined ? {} : { code: error.code }),
  };
}

function errorResponse(codec: Codec, failure: HttpFailure, seq: number): Response {
  const headers = new Headers(failure.headers);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json; charset=utf-8");
  return withRequestId(
    new Response(JSON.stringify(codec.errorBody(failure)), {
      status: failure.status,
      headers,
    }),
    codec,
    seq,
  );
}

/** Adds the deterministic request id header for the codec's vendor unless a rule already set it. */
function withRequestId(response: Response, codec: Codec, seq: number): Response {
  const name = codec.format === "anthropic-messages" ? "request-id" : "x-request-id";
  if (!response.headers.has(name)) response.headers.set(name, `req_${seq}`);
  return response;
}

async function readJson(c: Context<AppEnv>): Promise<unknown> {
  const text = await c.req.text();
  try {
    return JSON.parse(text) as Json;
  } catch {
    throw new AiRequestError("Request body must be valid JSON.", undefined, "invalid_json");
  }
}

function hasSuffix(path: string, suffix: string): boolean {
  return path === suffix || path.endsWith(suffix);
}

function responseId(path: string): string | null {
  const match = RESPONSE_ID.exec(path);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    throw new AiRequestError("Malformed response id.", "id", "invalid_id");
  }
}

function unsupportedPath(path: string): AiRequestError {
  return new AiRequestError(
    `Unsupported path ${path}. Supported paths: ${SUPPORTED_DATA_PATHS}.`,
    undefined,
    "unsupported_path",
    404,
  );
}

function staleStateError(): AiRequestError {
  return new AiRequestError(
    "The emulator state was reset while this request was being read.",
    undefined,
    "state_reset",
    409,
  );
}

function isForeignOrigin(origin: string | undefined, expectedOrigin: string | undefined): boolean {
  if (!origin || !expectedOrigin) return false;
  return origin !== expectedOrigin;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripBudgets(body: unknown): unknown {
  if (Array.isArray(body)) return body.map(stripRemaining);
  if (!isRecord(body) || !Array.isArray(body.rules)) return body;
  return { ...body, rules: body.rules.map(stripRemaining) };
}

function stripRemaining(rule: unknown): unknown {
  if (!isRecord(rule)) return rule;
  const { remaining: _remaining, ...rest } = rule;
  return rest;
}
