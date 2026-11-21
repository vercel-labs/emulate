import { isIP } from "node:net";
import { zstdDecompressSync } from "node:zlib";
import type { AppEnv, Context, Hono, Store } from "@emulators/core";
import type { Codec, CodecContext, Decoded } from "./codec.js";
import { messagesCodec } from "./codecs/anthropic-messages.js";
import { gatewayCodec } from "./codecs/gateway.js";
import { geminiCodec } from "./codecs/gemini.js";
import { chatCodec } from "./codecs/openai-chat.js";
import { deleteStoredResponse, getStoredResponse, responsesCodec } from "./codecs/openai-responses.js";
import { decide, decideMedia } from "./engine.js";
import { elevenLabsRoutes } from "./media/elevenlabs.js";
import { openaiAudioRoutes } from "./media/openai-audio.js";
import { imageRoutes } from "./media/openai-images.js";
import type { MediaBody, MediaResult, MediaRoute, StateRoute, UploadedFile } from "./media/route.js";
import { decisionRoutes } from "./media/decisions.js";
import { chatImageRoutes } from "./media/chat-images.js";
import { gatewayMediaRoutes, gatewayStateRoutes } from "./media/gateway.js";
import { geminiMediaRoutes } from "./media/gemini.js";
import { videoCreateRoutes, videoStateRoutes } from "./media/videos.js";
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
  takeCallSeq,
  type AiState,
  type CallStamp,
  type RequestScope,
} from "./state.js";
import { delay, sseResponse, type SseOptions } from "./sse.js";
import type { AIRequest, AiConfig, AiFormat, CallRecord, Delivery, HttpFailure, Json, Reply, Rule } from "./types.js";

/** The data paths the service answers; the native 404 and startup output name them. */
export const SUPPORTED_DATA_PATHS =
  "POST .../chat/completions, POST .../responses, POST .../messages, GET .../models, GET or DELETE .../responses/{id}, POST .../images/generations, POST .../images/edits, POST .../audio/speech, POST .../audio/transcriptions, POST .../audio/translations, POST /v1/text-to-speech/{voice_id}, POST /v1/speech-to-text, POST .../videos, GET .../videos, GET or DELETE .../videos/{id}, GET .../videos/{id}/content, POST .../videos/{id}/remix, POST .../videos/edits, POST .../videos/extensions, POST .../videos/generations, POST .../models/{model}:predictLongRunning, GET .../operations/{id}, GET .../files/{id}:download, POST .../models/{model}:fetchPredictOperation, POST .../decisions, POST .../systemone, POST .../alpha/decisions, POST .../models/{model}:generateContent, POST .../models/{model}:streamGenerateContent, POST .../language-model, POST .../image-model, POST .../speech-model, POST .../transcription-model, POST .../video-model, POST .../video-model/start, POST .../video-model/status, POST .../decision-model";

const MEDIA_ROUTES: readonly MediaRoute[] = [
  ...imageRoutes,
  ...openaiAudioRoutes,
  ...elevenLabsRoutes,
  ...videoCreateRoutes,
  ...decisionRoutes,
  ...geminiMediaRoutes,
  ...gatewayMediaRoutes,
  ...chatImageRoutes,
];

const STATE_ROUTES: readonly StateRoute[] = [...videoStateRoutes, ...gatewayStateRoutes];

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
  baseUrlDerived?: boolean;
}

const CODECS: ReadonlyArray<{ suffix: string; codec: Codec }> = [
  { suffix: "/chat/completions", codec: chatCodec },
  { suffix: "/responses", codec: responsesCodec },
  { suffix: "/messages", codec: messagesCodec },
  { suffix: ":generateContent", codec: geminiCodec },
  { suffix: ":streamGenerateContent", codec: geminiCodec },
  { suffix: "/language-model", codec: gatewayCodec },
];

const MESSAGES_FAMILY = /(?:^|\/)messages(?:\/|$)/;

/** The codec whose error shape a request outside the generation routes gets: the Messages route family, or any request carrying `anthropic-version`. */
function errorCodecOf(path: string, anthropicVersion: string | undefined): Codec | undefined {
  if (path === "/_ai" || path.startsWith("/_ai/")) return undefined;
  return MESSAGES_FAMILY.test(path) || anthropicVersion !== undefined ? messagesCodec : undefined;
}

function internalFailure(error: unknown): HttpFailure {
  const status =
    typeof (error as { status?: unknown })?.status === "number" ? (error as { status: number }).status : 500;
  if (status >= 500) console.error("[ai]", error);
  return { status, message: error instanceof Error ? error.message : "Internal Server Error" };
}

/** Renders an error that no call record owns in the codec's shape, taking a new sequence number so the response still carries a request id. */
function unrecordedError(store: Store, codec: Codec, error: unknown): Response {
  const failure = error instanceof AiRequestError ? failureOf(error) : internalFailure(error);
  return errorResponse(codec, failure, takeCallSeq(getAiState(store)));
}

const MAX_SEEN_MODELS = 1000;

/** The largest body a zstd-encoded request may decompress to. */
const MAX_DECOMPRESSED_BYTES = 64 * 1024 * 1024;

const RESPONSE_ID = /(?:^|\/)responses\/([^/]+)$/;

/** Installs the anchored data router and the control routes; control routes are checked first. */
export function registerAiRoutes({ app, store, baseUrl, baseUrlDerived }: AiRoutesOptions): void {
  const configured = baseUrlDerived ? undefined : parseUrl(baseUrl);

  app.use("*", async (c, next) => {
    if (c.req.path.startsWith("/_emulate/")) {
      await next();
      return;
    }
    try {
      return await handleRequest(c, store, configured);
    } catch (error) {
      const codec = errorCodecOf(c.req.path, c.req.header("anthropic-version"));
      if (!codec) throw error;
      return unrecordedError(store, codec, error);
    }
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

async function handleRequest(c: Context<AppEnv>, store: Store, configured: URL | undefined): Promise<Response> {
  const url = new URL(c.req.url);
  const path = url.pathname;
  const requested = c.req.method.toUpperCase();
  const method = requested === "HEAD" ? "GET" : requested;
  const state = getAiState(store);

  const authority = c.req.header("host") ?? url.host;
  const addressed = parseUrl(`${url.protocol}//${authority}`);
  const caller = callerOf(c.req.header("origin"), addressed, configured);

  if (caller === "untrusted-host") {
    const refusal = untrustedHostMessage(authority);
    if (errorCodecOf(path, c.req.header("anthropic-version")))
      throw new AiRequestError(refusal, undefined, undefined, 403);
    return c.json(aiErrorBody(403, refusal), 403);
  }

  if (path === "/_ai" || path.startsWith("/_ai/") || (method === "GET" && path === "/")) {
    if (caller !== "direct" && caller !== "same-origin") {
      return c.json(aiErrorBody(403, "Cross-origin requests are not allowed on AI control routes."), 403);
    }
    return handleControl(c, method, path, store, state);
  }

  if (caller === "foreign") {
    const foreign =
      "Requests from other websites are not allowed on AI data routes. Call the emulator from a server, from its own origin, or from a page served on this machine.";
    if (errorCodecOf(path, c.req.header("anthropic-version")))
      throw new AiRequestError(foreign, undefined, undefined, 403);
    return c.json(aiErrorBody(403, foreign), 403);
  }

  const codec = method === "POST" ? CODECS.find(({ suffix }) => hasSuffix(path, suffix))?.codec : undefined;
  const candidates = MEDIA_ROUTES.filter((route) => route.matches(method, path));
  let preread: Promise<MediaBody> | undefined;
  let scope: RequestScope | undefined;
  if (candidates.length > 0) {
    scope = beginRequest(state, c.req.raw.signal);
    const shared = candidates.some((route) => route.accepts !== undefined);
    const body = shared ? readMediaBody(c) : undefined;
    preread = body;
    const settled = body
      ? await body.then(
          (value) => value,
          () => undefined,
        )
      : undefined;
    const accepted = settled && candidates.find((route) => !route.accepts || route.accepts(settled));
    const mediaRoute = accepted || (codec ? undefined : candidates[0]);
    if (mediaRoute) {
      try {
        return await handleMedia(c, store, state, scope, mediaRoute, path, url, body);
      } catch (error) {
        const failure = error instanceof AiRequestError ? failureOf(error) : internalFailure(error);
        return mediaErrorResponse(mediaRoute, failure, takeCallSeq(state));
      }
    }
  }

  if (codec) {
    try {
      return await handleGeneration(
        c,
        store,
        state,
        scope ?? beginRequest(state, c.req.raw.signal),
        codec,
        path,
        preread,
      );
    } catch (error) {
      return unrecordedError(store, codec, error);
    }
  }

  const stateRoute = STATE_ROUTES.find((route) => route.matches(method, path));
  if (stateRoute) {
    const seq = takeCallSeq(state);
    try {
      const body = await readMediaBody(c);
      const result = stateRoute.handle(
        { method, path, body, query: url.searchParams },
        context(store, state, path, url.origin, c.req.raw.headers),
      );
      const headers = new Headers(result.kind === "text" ? {} : result.headers);
      headers.set("x-request-id", `req_${seq}`);
      if (result.kind === "json") return Response.json(result.value, { status: result.status ?? 200, headers });
      headers.set("Content-Type", result.contentType);
      return new Response(result.kind === "bytes" ? result.data : result.text, { status: 200, headers });
    } catch (error) {
      const failure = error instanceof AiRequestError ? failureOf(error) : internalFailure(error);
      return mediaErrorResponse({ errorBody: stateRoute.errorBody }, failure, seq);
    }
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
  scope: RequestScope,
  codec: Codec,
  path: string,
  preread?: Promise<MediaBody>,
): Promise<Response> {
  const stamp: CallStamp = { generation: scope.generation, callsGeneration: scope.callsGeneration };
  const ctx = context(store, state, path, undefined, c.req.raw.headers);
  let body: unknown;
  let decoded: Decoded;
  try {
    body = preread ? jsonOf(await preread) : await readJson(c);
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
  if (!request.stream) {
    try {
      encoded = codec.encodeJson(outcome.reply, decoded, ctx);
    } catch (error) {
      scope.dispose();
      throw error;
    }
  }
  if (scope.signal.aborted || !isCurrentGeneration(state, stamp)) {
    scope.dispose();
    throw staleStateError();
  }
  codec.afterReply?.(outcome.reply, decoded, ctx);
  recordCall(state, call, stamp);

  if (!request.stream) {
    const sent = await delay(outcome.timing.ttftMs, scope.signal);
    settleCall(state, call, stamp, sent ? "completed" : "client_aborted");
    scope.dispose();
    if (!sent) throw staleStateError();
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

/**
 * Runs one media request through the same lifecycle as a generation: decode, match a rule of the route's task, record the
 * call, pace it, and render the route's wire shape. The caller begins `scope` before reading the body, so a reset during
 * the read ends the request.
 */
async function handleMedia(
  c: Context<AppEnv>,
  store: Store,
  state: AiState,
  scope: RequestScope,
  route: MediaRoute,
  path: string,
  url: URL,
  preread?: Promise<MediaBody>,
): Promise<Response> {
  const stamp: CallStamp = { generation: scope.generation, callsGeneration: scope.callsGeneration };
  const ctx = context(store, state, path, url.origin, c.req.raw.headers);
  let body: MediaBody | undefined;
  let decoded: Decoded;
  try {
    body = await (preread ?? readMediaBody(c));
    decoded = route.decode(body, ctx, url.searchParams);
  } catch (error) {
    const status = error instanceof AiRequestError ? error.status : 500;
    const call = rejectedCall(state, route.format, path, body?.kind === "json" ? body.value : undefined, status);
    call.task = route.task;
    recordCall(state, call, stamp);
    scope.dispose();
    if (error instanceof AiRequestError) return mediaErrorResponse(route, failureOf(error), call.seq);
    throw error;
  }
  if (scope.signal.aborted || !isCurrentGeneration(state, stamp)) {
    scope.dispose();
    throw staleStateError();
  }

  const request = decoded.request;
  state.seenModels.add(request.model);
  while (state.seenModels.size > MAX_SEEN_MODELS) {
    state.seenModels.delete(state.seenModels.values().next().value as string);
  }

  const outcome = decideMedia(store, request, route.sample);
  const call = freshCall(state, route.format, path);
  fillCall(call, request);
  call.task = route.task;
  call.matched = outcome.matched;
  if (outcome.kind === "error") {
    call.status = outcome.failure.status;
    call.delivery = "completed";
    recordCall(state, call, stamp);
    scope.dispose();
    return mediaErrorResponse(route, outcome.failure, call.seq);
  }

  let result: MediaResult;
  try {
    result = route.render(outcome.events, decoded, ctx);
  } catch (error) {
    scope.dispose();
    throw error;
  }
  call.status = result.kind === "json" ? (result.status ?? 200) : 200;
  call.reply = { finish: "stop", summary: result.summary ?? route.task };
  recordCall(state, call, stamp);
  const requestId = { name: route.requestIdHeader ?? "x-request-id", value: `req_${call.seq}` };

  if (result.kind === "sse") {
    const response = sseResponse(result.frames, {
      signal: scope.signal,
      timing: outcome.timing,
      fault: outcome.fault,
      onFault(kind) {
        call.fault = kind;
      },
      onSettled(delivery) {
        settleCall(state, call, stamp, delivery);
        scope.dispose();
      },
    });
    response.headers.set(requestId.name, requestId.value);
    return response;
  }

  const sent = await delay(outcome.timing.ttftMs, scope.signal);
  settleCall(state, call, stamp, sent ? "completed" : "client_aborted");
  scope.dispose();
  if (!sent) throw staleStateError();
  const headers = new Headers(result.kind === "text" ? {} : result.headers);
  headers.set(requestId.name, requestId.value);
  if (result.kind === "json") return Response.json(result.value, { status: call.status, headers });
  headers.set("Content-Type", result.contentType);
  return new Response(result.kind === "bytes" ? result.data : result.text, { status: 200, headers });
}

/** Reads a multipart body into fields and in-memory files, or a JSON body; an empty body reads as none. */
async function readMediaBody(c: Context<AppEnv>): Promise<MediaBody> {
  if (/^multipart\/form-data/i.test(c.req.header("content-type") ?? "")) {
    let form: FormData;
    try {
      form = await c.req.raw.formData();
    } catch {
      throw new AiRequestError("Malformed multipart/form-data body.", undefined, "invalid_multipart");
    }
    const fields = new Map<string, string[]>();
    const files = new Map<string, UploadedFile[]>();
    for (const [name, value] of form.entries()) {
      if (typeof value === "string") {
        fields.set(name, [...(fields.get(name) ?? []), value]);
      } else {
        const file = { name: value.name, type: value.type, bytes: new Uint8Array(await value.arrayBuffer()) };
        files.set(name, [...(files.get(name) ?? []), file]);
      }
    }
    return { kind: "form", fields, files };
  }
  const raw = new Uint8Array(await c.req.arrayBuffer());
  let bytes: Uint8Array = raw;
  if ((c.req.header("content-encoding") ?? "").toLowerCase() === "zstd") {
    try {
      bytes = zstdDecompressSync(raw, { maxOutputLength: MAX_DECOMPRESSED_BYTES });
    } catch (error) {
      if ((error as { code?: unknown }).code === "ERR_BUFFER_TOO_LARGE") {
        throw new AiRequestError(
          `The decompressed request body exceeds ${MAX_DECOMPRESSED_BYTES} bytes.`,
          undefined,
          "request_too_large",
          413,
        );
      }
      throw new AiRequestError("Malformed zstd request body.", undefined, "invalid_encoding");
    }
  }
  const text = new TextDecoder().decode(bytes);
  if (text.trim() === "") return { kind: "none" };
  try {
    return { kind: "json", value: JSON.parse(text) as Json };
  } catch {
    throw new AiRequestError("Request body must be valid JSON.", undefined, "invalid_json");
  }
}

function mediaErrorResponse(
  route: Pick<MediaRoute, "errorBody" | "requestIdHeader">,
  failure: HttpFailure,
  seq: number,
): Response {
  const headers = new Headers(failure.headers);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json; charset=utf-8");
  const name = route.requestIdHeader ?? "x-request-id";
  const requestId = headers.get(name) ?? `req_${seq}`;
  headers.set(name, requestId);
  return new Response(JSON.stringify(route.errorBody(failure, requestId)), { status: failure.status, headers });
}

function context(store: Store, state: AiState, path: string, origin?: string, headers?: Headers): CodecContext {
  return {
    store,
    state,
    path,
    ...(origin === undefined ? {} : { origin }),
    ...(headers === undefined ? {} : { headers }),
    makeId(prefix: string): string {
      return `${prefix}_${nextId(state)}`;
    },
  };
}

function freshCall(state: AiState, format: AiFormat, path: string): CallRecord {
  return {
    seq: takeCallSeq(state),
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
  const name = requestIdHeader(codec);
  const requestId = headers.get(name) ?? `req_${seq}`;
  headers.set(name, requestId);
  return new Response(JSON.stringify(codec.errorBody(failure, requestId)), {
    status: failure.status,
    headers,
  });
}

function requestIdHeader(codec: Codec): string {
  return codec.format === "anthropic-messages" ? "request-id" : "x-request-id";
}

/** Adds the deterministic request id header for the codec's vendor unless a rule already set it. */
function withRequestId(response: Response, codec: Codec, seq: number): Response {
  const name = requestIdHeader(codec);
  if (!response.headers.has(name)) response.headers.set(name, `req_${seq}`);
  return response;
}

/** The JSON value of a body already read for route selection. */
function jsonOf(body: MediaBody): unknown {
  if (body.kind !== "json") throw new AiRequestError("Request body must be valid JSON.", undefined, "invalid_json");
  return body.value;
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
    "The emulator state was reset while this request was in progress.",
    undefined,
    "state_reset",
    409,
  );
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Who sent a request, judged from its Origin header: a client that is not a browser page, one of the emulator's own
 * pages, another page served on this machine, or any other website.
 */
type Caller = "direct" | "same-origin" | "local" | "foreign" | "untrusted-host";

/**
 * Whether the request was addressed to this machine: a loopback name, any IP literal, or the configured host. Any other
 * DNS name is how a rebound website reaches the emulator, so it is never trusted.
 */
function trustedHostname(hostname: string, configuredHost: string | undefined): boolean {
  return (
    LOOPBACK_HOSTS.has(hostname) ||
    hostname.endsWith(".localhost") ||
    isIP(hostname.replace(/^\[|\]$/g, "")) !== 0 ||
    hostname === configuredHost
  );
}

function untrustedHostMessage(host: string): string {
  return `The AI service does not answer on host "${host}". Start the emulator with --base-url http://${host} to allow it, or set publicUrl when embedding it.`;
}

/**
 * Classifies a request from where it was addressed and its Origin. The service's own origins are the trusted address the
 * request was sent to and, when configured, the base URL.
 */
function callerOf(origin: string | undefined, addressed: URL | undefined, configured: URL | undefined): Caller {
  if (!addressed || !trustedHostname(addressed.hostname, configured?.hostname)) return "untrusted-host";
  if (!origin) return "direct";
  const url = parseUrl(origin);
  if (!url) return "foreign";
  const key = originKey(url);
  if (key === originKey(addressed) || (configured && key === originKey(configured))) return "same-origin";
  return LOOPBACK_HOSTS.has(url.hostname) || url.hostname.endsWith(".localhost") ? "local" : "foreign";
}

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

/** Reduces an origin to scheme, host, and port, with every loopback name written as localhost. */
function originKey(url: URL): string {
  const host = LOOPBACK_HOSTS.has(url.hostname) ? "localhost" : url.hostname;
  return `${url.protocol}//${host}:${url.port}`;
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
