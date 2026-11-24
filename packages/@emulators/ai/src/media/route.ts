import type { CodecContext, Decoded } from "../codec.js";
import type { SseFrame } from "../sse.js";
import type { AiFormat, AiTask, HttpFailure, RuleReplyEvent } from "../types.js";

/** One uploaded multipart file, read into memory. */
export interface UploadedFile {
  name: string;
  type: string;
  bytes: Uint8Array;
}

/** A multipart body with repeated fields kept in order; `key[]` and `key` are stored under their literal names. */
export interface MediaForm {
  fields: Map<string, string[]>;
  files: Map<string, UploadedFile[]>;
}

/** The parsed body of a media request: JSON, multipart form fields, or none for a bodiless request. */
export type MediaBody = { kind: "json"; value: unknown } | ({ kind: "form" } & MediaForm) | { kind: "none" };

/** What a media route renders for a decided request; `summary` is the one-line description the call record keeps. */
export type MediaResult = { summary?: string } & (
  | { kind: "json"; value: unknown; status?: number; headers?: Record<string, string> }
  | { kind: "bytes"; data: Uint8Array; contentType: string; headers?: Record<string, string> }
  | { kind: "text"; text: string; contentType: string }
  | { kind: "sse"; frames: SseFrame[] }
);

/**
 * One media endpoint. The dispatcher owns the request lifecycle (rule matching, call records, pacing, errors) and the
 * route owns the wire shapes.
 */
export interface MediaRoute {
  format: AiFormat;
  task: AiTask;
  /** The reply event a strict-mode miss suggests for this task. */
  sample: RuleReplyEvent;
  matches(method: string, path: string): boolean;
  /** When several routes share a path, picks this one only for bodies in its wire format. */
  accepts?(body: MediaBody): boolean;
  /** Validates the request into the shared shape rules match on; throws AiRequestError for client errors. */
  decode(body: MediaBody, ctx: CodecContext, query: URLSearchParams): Decoded;
  /** Renders the reply; `events` is absent when the emulator generates the output itself. */
  render(events: RuleReplyEvent[] | undefined, decoded: Decoded, ctx: CodecContext): MediaResult;
  errorBody(failure: HttpFailure, requestId: string): unknown;
  /** The header carrying the deterministic request id; defaults to x-request-id. */
  requestIdHeader?: string;
}

/** A read or housekeeping endpoint over stored media state, such as polling a job; it is answered without rules or a call record. */
export interface StateRoute {
  matches(method: string, path: string): boolean;
  handle(
    input: { method: string; path: string; body: MediaBody; query: URLSearchParams },
    ctx: CodecContext,
  ): Exclude<MediaResult, { kind: "sse" }>;
  errorBody(failure: HttpFailure, requestId: string): unknown;
}
