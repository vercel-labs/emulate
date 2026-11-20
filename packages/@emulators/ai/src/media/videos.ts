import { imageAttachment, redactedReference } from "../attachments.js";
import { CREATED_AT, type CodecContext, type Decoded } from "../codec.js";
import { chatCodec } from "../codecs/openai-chat.js";
import type { FilePart, HttpFailure, InputPart, MediaReplyEvent, RuleReplyEvent } from "../types.js";
import {
  base64Bytes,
  fail,
  fieldsOf,
  isRecord,
  mediaRequest,
  optionalEnum,
  optionalInteger,
  optionalString,
  requiredString,
  toBase64,
  uploadedPart,
  type Fields,
} from "./fields.js";
import { advance, isTerminal, type JobOutcome, type VideoJob } from "./jobs.js";
import { renderImage } from "./pixels.js";
import type { MediaResult, MediaRoute, StateRoute } from "./route.js";
import { renderVideo } from "./video.js";

const OPENAI_SECONDS = ["4", "8", "12", "16", "20"];
const OPENAI_SIZES = ["720x1280", "1280x720", "1024x1792", "1792x1024", "1080x1920", "1920x1080"];
const XAI_ASPECT_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3"] as const;
const XAI_RESOLUTIONS = ["480p", "720p"] as const;
const POLL_AFTER_MS = "10";
const EXPIRY_SECONDS = 3600;
const GRAY = { r: 128, g: 128, b: 128, a: 255 };
const VIDEO_ID = /\/videos\/([^/]+)$/;
const VIDEO_CONTENT = /\/videos\/([^/]+)\/content$/;
const VIDEO_REMIX = /\/videos\/([^/]+)\/remix$/;
const GEMINI_START = /^\/(v1|v1beta|v1alpha)\/models\/([^/:]+):predictLongRunning$/;
const GEMINI_OPERATION = /^\/(?:v1|v1beta|v1alpha)\/(?:models\/[^/]+\/)?operations\/([a-z0-9]+)$/;
const GEMINI_FILE = /^\/(?:v1|v1beta|v1alpha)\/files\/([a-z0-9]+):download$/;
const VERTEX_START = /\/publishers\/google\/models\/([^/:]+):predictLongRunning$/;
const VERTEX_FETCH = /\/publishers\/google\/models\/([^/:]+):fetchPredictOperation$/;

type VideoEvent = Extract<MediaReplyEvent, { type: "video" | "video_error" }>;

interface VideoExtras {
  job: Omit<VideoJob, "id" | "outcome" | "polls" | "reads" | "status" | "progress" | "createdAt">;
}

function videoEvent(events: RuleReplyEvent[] | undefined): VideoEvent | undefined {
  return events?.find((event): event is VideoEvent => event.type === "video" || event.type === "video_error");
}

/** Stores a new queued job whose outcome and pacing come from the matching rule, or a rendered video after one poll. */
export function createJob(
  events: RuleReplyEvent[] | undefined,
  decoded: Decoded,
  ctx: CodecContext,
  id: string,
): VideoJob {
  const { job } = decoded.extras as unknown as VideoExtras;
  const event = videoEvent(events);
  const outcome: JobOutcome =
    event?.type === "video_error"
      ? { kind: "error", code: event.code, message: event.message }
      : { kind: "video", ...(event?.data === undefined ? {} : { data: event.data }) };
  const created: VideoJob = {
    ...job,
    id,
    status: "queued",
    progress: 0,
    polls: event?.polls ?? 1,
    reads: 0,
    outcome,
    createdAt: CREATED_AT,
  };
  ctx.state.jobs.set(id, created);
  return created;
}

/** The job's video file: the rule's bytes, or a gray H.264 MP4 at the job's size and length. */
export function videoBytes(job: VideoJob): Uint8Array {
  if (job.outcome.kind === "video" && job.outcome.data !== undefined) return base64Bytes(job.outcome.data);
  return renderVideo(job.width, job.height, job.seconds);
}

function lookup(ctx: CodecContext, id: string, provider?: VideoJob["provider"]): VideoJob {
  const job = ctx.state.jobs.get(id);
  if (!job || (provider !== undefined && job.provider !== provider))
    fail(`Video with id '${id}' not found.`, "video_id", "not_found", 404);
  return job;
}

function decodeId(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return fail("Malformed video id.", "video_id", "invalid_id");
  }
}

function parseSize(value: string, param = "size"): { width: number; height: number } {
  const match = /^(\d+)x(\d+)$/.exec(value);
  if (!match) fail(`Invalid value for '${param}': '${value}'.`, param);
  return { width: Number(match[1]), height: Number(match[2]) };
}

/** The input reference of an OpenAI video request: an uploaded image, or an `image_url` or `file_id` object. */
function inputReference(fields: Fields): FilePart[] {
  const upload = fields.files.get("input_reference")?.[0];
  if (upload) return [uploadedPart(upload)];
  const reference = fields.values.input_reference;
  if (reference === undefined || reference === null) return [];
  if (!isRecord(reference))
    fail("Invalid 'input_reference': expected an object or an uploaded image.", "input_reference");
  if (typeof reference.file_id === "string" && reference.file_id !== "") {
    return [{ type: "file", mediaType: "image/*", source: "file_id", ref: reference.file_id }];
  }
  return [imageAttachment(reference.image_url, "input_reference.image_url")];
}

function seconds(fields: Fields, fallback: string): number {
  const raw = fields.values.seconds;
  const value = raw === undefined || raw === null ? fallback : String(raw);
  if (!OPENAI_SECONDS.includes(value)) {
    fail(
      `Invalid value for 'seconds': '${value}'. Supported values are: ${OPENAI_SECONDS.map((item) => `'${item}'`).join(", ")}.`,
      "seconds",
    );
  }
  return Number(value);
}

function openaiCreate(fields: Fields): Decoded {
  const prompt = requiredString(fields, "prompt", 32000);
  const model = optionalString(fields, "model") ?? "sora-2";
  const size = optionalString(fields, "size") ?? "720x1280";
  if (!OPENAI_SIZES.includes(size)) {
    fail(
      `Invalid value for 'size': '${size}'. Supported values are: ${OPENAI_SIZES.map((item) => `'${item}'`).join(", ")}.`,
      "size",
    );
  }
  const files = inputReference(fields);
  return openaiDecoded(model, prompt, files, { seconds: seconds(fields, "4"), ...parseSize(size) });
}

function openaiDecoded(
  model: string,
  prompt: string,
  files: InputPart[],
  shape: { seconds: number; width: number; height: number },
  remixedFrom?: string,
): Decoded {
  const extras: VideoExtras = {
    job: { provider: "openai", model, prompt, samples: 1, ...shape, ...(remixedFrom ? { remixedFrom } : {}) },
  };
  return {
    request: mediaRequest("openai-videos", "video", model, [{ type: "text", text: prompt }, ...files], false),
    extras: extras as unknown as Record<string, unknown>,
  };
}

/** Remixes, edits, and extensions start from a completed video named by the path or by `video.id`. */
function openaiDerived(kind: "remix" | "edit" | "extend", fields: Fields, ctx: CodecContext): Decoded {
  const prompt = requiredString(fields, "prompt", 32000);
  const reference = fields.values.video;
  const pathId = VIDEO_REMIX.exec(ctx.path)?.[1];
  const id =
    kind === "remix" && pathId
      ? decodeId(pathId)
      : isRecord(reference) && typeof reference.id === "string"
        ? reference.id
        : undefined;
  const upload = fields.files.get("video")?.[0];
  if (id === undefined && !upload) fail("Missing required parameter: 'video'.", "video", "missing_required_parameter");
  const source = id === undefined ? undefined : lookup(ctx, id, "openai");
  if (source && source.status !== "completed") {
    fail(
      `Video '${source.id}' is ${source.status}; only a completed video can be used.`,
      "video",
      "invalid_video_state",
    );
  }
  const base = source ?? { model: "sora-2", seconds: 4, width: 720, height: 1280 };
  const added = kind === "extend" ? seconds(fields, "4") : 0;
  return openaiDecoded(
    optionalString(fields, "model") ?? base.model,
    prompt,
    upload ? [uploadedPart(upload, upload.type || "video/mp4")] : [],
    { seconds: base.seconds + added, width: base.width, height: base.height },
    source?.id,
  );
}

function openaiObject(job: VideoJob) {
  return {
    id: job.id,
    object: "video",
    model: job.model,
    status: job.status,
    progress: job.progress,
    created_at: job.createdAt,
    completed_at: job.status === "completed" || job.status === "failed" ? (job.completedAt ?? null) : null,
    expires_at: job.status === "completed" && job.completedAt !== undefined ? job.completedAt + EXPIRY_SECONDS : null,
    seconds: String(job.seconds),
    size: `${job.width}x${job.height}`,
    prompt: job.prompt,
    remixed_from_video_id: job.remixedFrom ?? null,
    error:
      job.status === "failed" && job.outcome.kind === "error"
        ? { code: job.outcome.code, message: job.outcome.message }
        : null,
  };
}

function pollHeaders(): Record<string, string> {
  return { "openai-poll-after-ms": POLL_AFTER_MS };
}

function openaiRender(events: RuleReplyEvent[] | undefined, decoded: Decoded, ctx: CodecContext): MediaResult {
  const job = createJob(events, decoded, ctx, ctx.makeId("video"));
  return { kind: "json", value: openaiObject(job), headers: pollHeaders(), summary: `video job ${job.id}` };
}

function openaiError(failure: HttpFailure, requestId: string): unknown {
  return chatCodec.errorBody(failure, requestId);
}

function openaiCreateRoute(
  matches: (path: string) => boolean,
  decode: (fields: Fields, ctx: CodecContext) => Decoded,
): MediaRoute {
  return {
    format: "openai-videos",
    task: "video",
    sample: { type: "video" },
    matches: (method, path) => method === "POST" && matches(path),
    decode: (body, ctx) => decode(fieldsOf(body), ctx),
    render: openaiRender,
    errorBody: openaiError,
  };
}

function xaiCreate(fields: Fields): Decoded {
  const prompt = requiredString(fields, "prompt");
  const model = optionalString(fields, "model") ?? "grok-imagine-video";
  const duration = optionalInteger(fields, "duration", 1, 15) ?? 8;
  const ratio = optionalEnum(fields, "aspect_ratio", XAI_ASPECT_RATIOS) ?? "16:9";
  const resolution = optionalEnum(fields, "resolution", XAI_RESOLUTIONS) ?? "720p";
  const files: InputPart[] = [];
  const image = fields.values.image;
  if (isRecord(image)) files.push(imageAttachment(image.url, "image.url"));
  const extras: VideoExtras = {
    job: { provider: "xai", model, prompt, samples: 1, seconds: duration, ...aspectSize(ratio, resolution) },
  };
  return {
    request: mediaRequest("xai-videos", "video", model, [{ type: "text", text: prompt }, ...files], false),
    extras: extras as unknown as Record<string, unknown>,
  };
}

/** Sizes a Veo or xAI aspect ratio and resolution, such as 16:9 at 720p for 1280x720. */
function aspectSize(ratio: string, resolution: string): { width: number; height: number } {
  const short = { "360p": 360, "480p": 480, "720p": 720, "1080p": 1080, "4k": 2160 }[resolution.toLowerCase()];
  if (short === undefined) fail(`Invalid resolution '${resolution}'.`, "resolution");
  const match = /^(\d+):(\d+)$/.exec(ratio);
  if (!match || Number(match[1]) === 0 || Number(match[2]) === 0)
    fail(`Invalid aspect ratio '${ratio}'.`, "aspect_ratio");
  const w = Number(match[1]);
  const h = Number(match[2]);
  const long = Math.round((short * Math.max(w, h)) / Math.min(w, h) / 2) * 2;
  return w >= h ? { width: long, height: short } : { width: short, height: long };
}

function xaiRender(events: RuleReplyEvent[] | undefined, decoded: Decoded, ctx: CodecContext): MediaResult {
  const sequence = ctx.makeId("x").slice(2).padStart(12, "0");
  const job = createJob(events, decoded, ctx, `00000000-0000-4000-8000-${sequence}`);
  return { kind: "json", value: { request_id: job.id }, summary: `video job ${job.id}` };
}

function xaiObject(job: VideoJob, ctx: CodecContext) {
  if (job.status === "queued" || job.status === "in_progress") return { status: "pending" };
  if (job.outcome.kind === "error")
    return { status: "failed", error: { code: job.outcome.code, message: job.outcome.message } };
  return {
    status: "done",
    video: { url: `${ctx.origin ?? ""}/v1/videos/${job.id}/content`, duration: job.seconds, respect_moderation: true },
    model: job.model,
  };
}

/** Reads a Veo request: `instances[0]` for the prompt and images, `parameters` for shape and count. */
function veoDecode(provider: "gemini" | "vertex", model: string, fields: Fields): Decoded {
  const instances = fields.values.instances;
  if (!Array.isArray(instances) || instances.length === 0 || !isRecord(instances[0])) {
    fail("instances: expected a non-empty list.", "instances");
  }
  const instance = instances[0];
  if (typeof instance.prompt !== "string" || instance.prompt === "")
    fail("instances[0].prompt is required.", "instances[0].prompt");
  const parameters = isRecord(fields.values.parameters) ? fields.values.parameters : {};
  const count = parameters.sampleCount ?? parameters.numberOfVideos ?? 1;
  if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > 4) {
    fail("parameters.sampleCount must be an integer from 1 to 4.", "parameters.sampleCount");
  }
  const duration = parameters.durationSeconds ?? 8;
  if (typeof duration !== "number" || !Number.isInteger(duration) || duration < 1 || duration > 8) {
    fail("parameters.durationSeconds must be an integer from 1 to 8.", "parameters.durationSeconds");
  }
  const ratio = typeof parameters.aspectRatio === "string" ? parameters.aspectRatio : "16:9";
  if (ratio !== "16:9" && ratio !== "9:16")
    fail("parameters.aspectRatio must be 16:9 or 9:16.", "parameters.aspectRatio");
  const resolution = typeof parameters.resolution === "string" ? parameters.resolution : "720p";
  const files: InputPart[] = ["image", "lastFrame", "video"].flatMap((key): InputPart[] => {
    const media = instance[key];
    if (!isRecord(media)) return [];
    const inline = isRecord(media.inlineData) ? media.inlineData : media;
    const mediaType = String(inline.mimeType ?? media.mimeType ?? (key === "video" ? "video/mp4" : "image/png"));
    const ref = media.gcsUri ?? media.uri;
    return typeof ref === "string"
      ? [{ type: "file", mediaType, source: "url", ref: redactedReference(ref, `instances[0].${key}`) }]
      : [{ type: "file", mediaType, source: "inline", name: key }];
  });
  const storage = parameters.storageUri ?? parameters.gcsOutputDirectory;
  const extras: VideoExtras = {
    job: {
      provider,
      model,
      prompt: instance.prompt,
      samples: count,
      seconds: duration,
      ...aspectSize(ratio, resolution),
      ...(provider === "vertex" && typeof storage === "string"
        ? { storageUri: storage.endsWith("/") ? storage : `${storage}/` }
        : {}),
    },
  };
  return {
    request: mediaRequest(
      provider === "gemini" ? "gemini-veo" : "vertex-veo",
      "video",
      model,
      [{ type: "text", text: instance.prompt }, ...files],
      false,
    ),
    extras: extras as unknown as Record<string, unknown>,
  };
}

/** The resource name that prefixes a Vertex operation: everything up to and including the model. */
function vertexModelPath(path: string): string {
  return path
    .slice(path.indexOf("projects/") >= 0 ? path.indexOf("projects/") : path.indexOf("publishers/"))
    .replace(/:predictLongRunning$/, "");
}

function veoOperation(job: VideoJob, name: string, ctx: CodecContext): Record<string, unknown> {
  if (!isTerminal(job)) return { name };
  if (job.outcome.kind === "error")
    return { name, done: true, error: { code: 3, message: job.outcome.message, status: "INVALID_ARGUMENT" } };
  const samples = Array.from({ length: job.samples }, (_, index) => index);
  if (job.provider === "gemini") {
    const version = /^\/(v1|v1beta|v1alpha)\//.exec(ctx.path)?.[1] ?? "v1beta";
    return {
      name,
      done: true,
      response: {
        "@type": "type.googleapis.com/google.ai.generativelanguage.v1beta.PredictLongRunningResponse",
        generateVideoResponse: {
          generatedSamples: samples.map((index) => ({
            video: { uri: `${ctx.origin ?? ""}/${version}/files/${job.id}s${index}:download?alt=media` },
          })),
        },
      },
    };
  }
  const bytes = job.storageUri ? undefined : toBase64(videoBytes(job));
  return {
    name,
    done: true,
    response: {
      "@type": "type.googleapis.com/cloud.ai.large_models.vision.GenerateVideoResponse",
      raiMediaFilteredCount: 0,
      videos: samples.map((index) =>
        bytes === undefined
          ? { gcsUri: `${job.storageUri}${job.id}/sample_${index}.mp4`, mimeType: "video/mp4" }
          : { bytesBase64Encoded: bytes, mimeType: "video/mp4" },
      ),
    },
  };
}

const GOOGLE_STATUS: Record<number, string> = {
  400: "INVALID_ARGUMENT",
  401: "UNAUTHENTICATED",
  403: "PERMISSION_DENIED",
  404: "NOT_FOUND",
  409: "ABORTED",
  429: "RESOURCE_EXHAUSTED",
  500: "INTERNAL",
  503: "UNAVAILABLE",
};

/** Google's error envelope with the canonical status for the HTTP code. */
export function googleError(failure: HttpFailure): unknown {
  return {
    error: {
      code: failure.status,
      message: failure.message,
      status: failure.type ?? GOOGLE_STATUS[failure.status] ?? "UNKNOWN",
    },
  };
}

/** Video job creation routes for OpenAI, xAI, the Gemini API, and Vertex AI. */
export const videoCreateRoutes: MediaRoute[] = [
  openaiCreateRoute(
    (path) => path.endsWith("/videos/edits"),
    (fields, ctx) => openaiDerived("edit", fields, ctx),
  ),
  openaiCreateRoute(
    (path) => path.endsWith("/videos/extensions"),
    (fields, ctx) => openaiDerived("extend", fields, ctx),
  ),
  openaiCreateRoute(
    (path) => VIDEO_REMIX.test(path),
    (fields, ctx) => openaiDerived("remix", fields, ctx),
  ),
  {
    format: "xai-videos",
    task: "video",
    sample: { type: "video" },
    matches: (method, path) => method === "POST" && path.endsWith("/videos/generations"),
    decode: (body) => xaiCreate(fieldsOf(body)),
    render: xaiRender,
    errorBody: openaiError,
  },
  openaiCreateRoute(
    (path) => path === "/videos" || path.endsWith("/videos"),
    (fields) => openaiCreate(fields),
  ),
  {
    format: "gemini-veo",
    task: "video",
    sample: { type: "video" },
    matches: (method, path) => method === "POST" && GEMINI_START.test(path),
    decode: (body, ctx) => veoDecode("gemini", GEMINI_START.exec(ctx.path)?.[2] ?? "", fieldsOf(body)),
    render: (events, decoded, ctx) => {
      const job = createJob(events, decoded, ctx, `veo${ctx.makeId("op").slice(3)}`);
      return {
        kind: "json",
        value: { name: `models/${job.model}/operations/${job.id}` },
        summary: `video job ${job.id}`,
      };
    },
    errorBody: googleError,
  },
  {
    format: "vertex-veo",
    task: "video",
    sample: { type: "video" },
    matches: (method, path) => method === "POST" && VERTEX_START.test(path),
    decode: (body, ctx) => veoDecode("vertex", VERTEX_START.exec(ctx.path)?.[1] ?? "", fieldsOf(body)),
    render: (events, decoded, ctx) => {
      const job = createJob(
        events,
        decoded,
        ctx,
        `00000000-0000-4000-8000-${ctx.makeId("op").slice(3).padStart(12, "0")}`,
      );
      return {
        kind: "json",
        value: { name: `${vertexModelPath(ctx.path)}/operations/${job.id}` },
        summary: `video job ${job.id}`,
      };
    },
    errorBody: googleError,
  },
];

function listVideos(ctx: CodecContext, query: URLSearchParams): Exclude<MediaResult, { kind: "sse" }> {
  const order = query.get("order") ?? "desc";
  if (order !== "asc" && order !== "desc") fail(`Invalid value for 'order': '${order}'.`, "order");
  const limit = Number(query.get("limit") ?? "20");
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    fail("Invalid 'limit': expected an integer from 1 to 100.", "limit");
  const all = [...ctx.state.jobs.values()].filter((job) => job.provider === "openai");
  if (order === "desc") all.reverse();
  const after = query.get("after");
  const start = after === null ? 0 : all.findIndex((job) => job.id === after) + 1;
  const page = all.slice(start, start + limit);
  return {
    kind: "json",
    value: {
      object: "list",
      data: page.map(openaiObject),
      first_id: page[0]?.id ?? null,
      last_id: page.at(-1)?.id ?? null,
      has_more: start + limit < all.length,
    },
  };
}

/** Polling, listing, deleting, and downloading video jobs. */
export const videoStateRoutes: StateRoute[] = [
  {
    matches: (method, path) => method === "GET" && VIDEO_CONTENT.test(path),
    handle: ({ path, query }, ctx) => {
      const job = lookup(ctx, decodeId(VIDEO_CONTENT.exec(path)?.[1] ?? ""));
      if (job.status !== "completed")
        fail(
          `Video '${job.id}' is ${job.status}; content is available once it completes.`,
          "video_id",
          "video_not_ready",
        );
      const variant = query.get("variant") ?? "video";
      if (variant === "thumbnail")
        return { kind: "bytes", data: renderImage("webp", job.width, job.height, GRAY), contentType: "image/webp" };
      if (variant === "spritesheet")
        return { kind: "bytes", data: renderImage("jpeg", job.width, job.height, GRAY), contentType: "image/jpeg" };
      if (variant !== "video") fail(`Invalid value for 'variant': '${variant}'.`, "variant");
      return { kind: "bytes", data: videoBytes(job), contentType: "video/mp4" };
    },
    errorBody: openaiError,
  },
  {
    matches: (method, path) =>
      (method === "GET" || method === "DELETE") && VIDEO_ID.test(path) && !path.endsWith("/videos/generations"),
    handle: ({ method, path }, ctx) => {
      const job = lookup(ctx, decodeId(VIDEO_ID.exec(path)?.[1] ?? ""));
      if (method === "DELETE") {
        if (job.provider !== "openai") fail(`Video with id '${job.id}' not found.`, "video_id", "not_found", 404);
        if (!isTerminal(job))
          fail(
            `Video '${job.id}' is ${job.status}; only a completed or failed video can be deleted.`,
            "video_id",
            "invalid_video_state",
          );
        ctx.state.jobs.delete(job.id);
        return { kind: "json", value: { id: job.id, object: "video.deleted", deleted: true } };
      }
      advance(job);
      return job.provider === "xai"
        ? { kind: "json", value: xaiObject(job, ctx) }
        : { kind: "json", value: openaiObject(job), headers: pollHeaders() };
    },
    errorBody: openaiError,
  },
  {
    matches: (method, path) => method === "GET" && path.endsWith("/videos"),
    handle: ({ query }, ctx) => listVideos(ctx, query),
    errorBody: openaiError,
  },
  {
    matches: (method, path) => method === "GET" && GEMINI_OPERATION.test(path),
    handle: ({ path }, ctx) => {
      const id = GEMINI_OPERATION.exec(path)?.[1] ?? "";
      const job = ctx.state.jobs.get(id);
      if (!job || job.provider !== "gemini") fail(`Operation ${id} not found.`, undefined, undefined, 404);
      return { kind: "json", value: veoOperation(advance(job), `models/${job.model}/operations/${job.id}`, ctx) };
    },
    errorBody: googleError,
  },
  {
    matches: (method, path) => method === "GET" && GEMINI_FILE.test(path),
    handle: ({ path }, ctx) => {
      const file = GEMINI_FILE.exec(path)?.[1] ?? "";
      const match = /^(veo\d+)s(\d+)$/.exec(file);
      const job = match ? ctx.state.jobs.get(match[1]) : undefined;
      if (!job || job.status !== "completed" || Number(match?.[2]) >= job.samples)
        fail(`File ${file} not found.`, undefined, undefined, 404);
      return { kind: "bytes", data: videoBytes(job), contentType: "video/mp4" };
    },
    errorBody: googleError,
  },
  {
    matches: (method, path) => method === "POST" && VERTEX_FETCH.test(path),
    handle: ({ body }, ctx) => {
      const fields = fieldsOf(body);
      const name = typeof fields.values.operationName === "string" ? fields.values.operationName : "";
      const id = /\/operations\/([^/]+)$/.exec(name)?.[1] ?? "";
      const job = ctx.state.jobs.get(id);
      if (!job || job.provider !== "vertex")
        fail(`Operation ${name || "(missing operationName)"} not found.`, undefined, undefined, 404);
      return { kind: "json", value: veoOperation(advance(job), name, ctx) };
    },
    errorBody: googleError,
  },
];
