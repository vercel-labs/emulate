import type { Store } from "@emulators/core";
import type { SseFrame } from "./sse.js";
import type { AiState } from "./state.js";
import type { AIRequest, AiFormat, HttpFailure, Reply } from "./types.js";

/** The fixed `created` timestamp every codec stamps on replies so output repeats exactly. */
export const CREATED_AT = 1730000000;

/** What a codec receives for one request: the store, its state, and a deterministic id factory. */
export interface CodecContext {
  store: Store;
  state: AiState;
  path: string;
  makeId(prefix: string): string;
}

/** A decoded request plus codec-private data the encoder needs, such as Chat's include_usage flag. */
export interface Decoded {
  request: AIRequest;
  extras: Record<string, unknown>;
}

/** One wire format. The dispatcher selects it by path suffix and never sees wire shapes. */
export interface Codec {
  format: AiFormat;
  /** Validates and normalizes a parsed JSON body; throws AiRequestError for client errors. */
  decode(body: unknown, ctx: CodecContext): Decoded;
  /** Renders a complete non-streaming reply body. */
  encodeJson(reply: Reply, decoded: Decoded, ctx: CodecContext): unknown;
  /** Renders a complete reply as ordered SSE frames, ending with the format's terminal event. */
  streamFrames(reply: Reply, decoded: Decoded, ctx: CodecContext): SseFrame[];
  /** Renders an HTTP failure as the format's native error body. */
  errorBody(failure: HttpFailure, requestId: string): unknown;
  /** Called with the encoded reply before any byte is sent, so a codec can persist state such as stored responses. */
  afterReply?(reply: Reply, decoded: Decoded, ctx: CodecContext, body: unknown): void;
}
