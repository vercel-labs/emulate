import type { CodecContext, Decoded } from "../codec.js";
import { gatewayErrorBody, gatewayFile, gatewayMetadata, gatewayModel } from "../codecs/gateway.js";
import type { FilePart, InputPart, Json, MediaReplyEvent, RuleReplyEvent } from "../types.js";
import { base64Bytes, fail, isRecord, mediaRequest, textTokens, toBase64 } from "./fields.js";
import { advance, type VideoJob } from "./jobs.js";
import { transcriptText } from "./openai-audio.js";
import { colorFor, renderImage, sniffImageType } from "./pixels.js";
import type { MediaBody, MediaResult, MediaRoute, StateRoute } from "./route.js";
import { audioSeconds, renderAudio, speechSeconds, type AudioFormat } from "./sound.js";
import { timedSegments, timedWords } from "./transcript.js";
import { createJob, videoBytes } from "./videos.js";
import { renderVideo } from "./video.js";

type ImageEvent = Extract<MediaReplyEvent, { type: "image" }>;

const SPEECH_FORMATS: Record<string, AudioFormat> = {
  mp3: "mp3",
  wav: "wav",
  pcm: "pcm",
  flac: "flac",
  opus: "opus",
  aac: "aac",
};
const DEFAULT_VIDEO_SECONDS = 5;

interface ImageExtras {
  n: number;
  width: number;
  height: number;
  seed: string;
}

interface SpeechExtras {
  format: AudioFormat;
  seconds: number;
  warnings: Json[];
}

interface TranscriptionExtras {
  seconds: number;
}

function bodyOf(body: MediaBody): Record<string, unknown> {
  if (body.kind !== "json" || !isRecord(body.value)) fail("Expected a JSON object body.", undefined, "invalid_json");
  return body.value;
}

function optionalText(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") fail("Expected a string.", key);
  return value;
}

function count(body: Record<string, unknown>): number {
  const n = body.n ?? 1;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 10) fail("Expected an integer from 1 to 10.", "n");
  return n;
}

/** Reads an AI SDK image or video file input: inline data with a media type, or a URL. */
function modelFile(raw: unknown, path: string): FilePart {
  if (!isRecord(raw)) fail("Expected a file object.", path);
  const mediaType = typeof raw.mediaType === "string" ? raw.mediaType : "image/*";
  if (raw.type === "url") return gatewayFile({ type: "url", url: raw.url }, mediaType, path);
  if (raw.type !== "file") fail("Expected a file of type file or url.", `${path}.type`);
  return gatewayFile(raw.data, mediaType, `${path}.data`);
}

/** Reads an explicit `WxH` size, or sizes an aspect ratio with its long side at `long`; no ratio means a square. */
export function dimensions(
  size: string | undefined,
  aspectRatio: string | undefined,
  long: number,
  path: string,
  aspectPath = "aspectRatio",
) {
  if (size !== undefined) {
    const match = /^(\d+)x(\d+)$/.exec(size);
    if (!match || Number(match[1]) < 1 || Number(match[2]) < 1 || Math.max(Number(match[1]), Number(match[2])) > 4096) {
      fail(`Invalid size '${size}'.`, path);
    }
    return { width: Number(match[1]), height: Number(match[2]) };
  }
  if (aspectRatio === undefined || aspectRatio === "adaptive") return { width: long, height: long };
  const match = /^(\d+):(\d+)$/.exec(aspectRatio);
  if (!match || Number(match[1]) === 0 || Number(match[2]) === 0)
    fail(`Invalid aspect ratio '${aspectRatio}'.`, aspectPath);
  const w = Number(match[1]);
  const h = Number(match[2]);
  const short = Math.max(1, Math.round((long * Math.min(w, h)) / Math.max(w, h)));
  return w >= h ? { width: long, height: short } : { width: short, height: long };
}

function decodeImage(body: MediaBody, ctx: CodecContext): Decoded {
  const value = bodyOf(body);
  const model = gatewayModel(ctx);
  const prompt = optionalText(value, "prompt") ?? "";
  const files = value.files === undefined ? [] : value.files;
  if (!Array.isArray(files)) fail("Expected an array.", "files");
  const inputs = files.map((file, index) => modelFile(file, `files[${index}]`));
  if (value.mask !== undefined) inputs.push(modelFile(value.mask, "mask"));
  if (prompt === "" && inputs.length === 0) fail("Expected a prompt or input files.", "prompt");
  const { width, height } = dimensions(optionalText(value, "size"), optionalText(value, "aspectRatio"), 1024, "size");
  const parts: InputPart[] = [...(prompt ? [{ type: "text" as const, text: prompt }] : []), ...inputs];
  const extras: ImageExtras = {
    n: count(value),
    width,
    height,
    seed: [prompt, ...inputs.map((file) => file.sha256 ?? file.ref ?? ""), String(value.seed ?? "")].join("|"),
  };
  return {
    request: mediaRequest("gateway", "image", model, parts, false),
    extras: extras as unknown as Record<string, unknown>,
  };
}

function renderGatewayImage(events: RuleReplyEvent[] | undefined, decoded: Decoded, ctx: CodecContext): MediaResult {
  const extras = decoded.extras as unknown as ImageExtras;
  const scripted = events?.filter((event): event is ImageEvent => event.type === "image") ?? [];
  const images = Array.from({ length: extras.n }, (_, index) => {
    const event = scripted.length > 0 ? scripted[index % scripted.length] : undefined;
    if (event?.data !== undefined) return base64Bytes(event.data);
    return renderImage("png", extras.width, extras.height, colorFor(`${extras.seed}#${index}`));
  });
  const prompt = decoded.request.messages[0].parts.map((part) => (part.type === "text" ? part.text : "")).join("");
  const input = textTokens(prompt);
  const types = [...new Set(images.map((bytes) => sniffImageType(bytes) ?? "image/png"))].join(", ");
  return {
    kind: "json",
    summary: `${images.length} ${images.length === 1 ? "image" : "images"} (${types}, ${extras.width}x${extras.height})`,
    value: {
      images: images.map(toBase64),
      warnings: [],
      providerMetadata: gatewayMetadata(decoded.request.model, ctx.makeId("gen")),
      usage: { inputTokens: input, outputTokens: images.length * 1290, totalTokens: input + images.length * 1290 },
    },
  };
}

function decodeSpeech(body: MediaBody, ctx: CodecContext): Decoded {
  const value = bodyOf(body);
  const model = gatewayModel(ctx);
  const text = optionalText(value, "text");
  if (!text) fail("Expected non-empty text.", "text");
  const requested = optionalText(value, "outputFormat") ?? "mp3";
  const warnings: Json[] = [];
  const format = SPEECH_FORMATS[requested.toLowerCase()];
  if (!format) {
    warnings.push({
      type: "unsupported",
      feature: "outputFormat",
      details: `Unsupported output format ${requested}; returned mp3.`,
    });
  }
  const speed = value.speed ?? 1;
  if (typeof speed !== "number" || speed <= 0) fail("Expected a positive number.", "speed");
  const instructions = optionalText(value, "instructions");
  const extras: SpeechExtras = { format: format ?? "mp3", seconds: speechSeconds(text, speed), warnings };
  return {
    request: mediaRequest(
      "gateway",
      "speech",
      model,
      [{ type: "text", text }, ...(instructions ? [{ type: "text" as const, text: instructions }] : [])],
      false,
    ),
    extras: extras as unknown as Record<string, unknown>,
  };
}

function renderSpeech(events: RuleReplyEvent[] | undefined, decoded: Decoded, ctx: CodecContext): MediaResult {
  const extras = decoded.extras as unknown as SpeechExtras;
  const scripted = events?.find((event) => event.type === "audio");
  const audio =
    scripted?.type === "audio" && scripted.data !== undefined
      ? base64Bytes(scripted.data)
      : renderAudio(extras.format, { seconds: extras.seconds, sampleRate: 24000 });
  return {
    kind: "json",
    summary: `${extras.format} audio, ${audio.length} bytes`,
    value: {
      audio: toBase64(audio),
      warnings: extras.warnings,
      providerMetadata: gatewayMetadata(decoded.request.model, ctx.makeId("gen")),
    },
  };
}

function decodeTranscription(body: MediaBody, ctx: CodecContext): Decoded {
  const value = bodyOf(body);
  const model = gatewayModel(ctx);
  const mediaType = optionalText(value, "mediaType");
  if (!mediaType) fail("Expected a media type.", "mediaType");
  const file = gatewayFile(value.audio, mediaType, "audio");
  const bytes = typeof value.audio === "string" ? base64Bytes(value.audio) : new Uint8Array();
  const extras: TranscriptionExtras = { seconds: audioSeconds(bytes) };
  return {
    request: mediaRequest("gateway", "transcription", model, [file], false),
    extras: extras as unknown as Record<string, unknown>,
  };
}

function renderTranscription(events: RuleReplyEvent[] | undefined, decoded: Decoded, ctx: CodecContext): MediaResult {
  const extras = decoded.extras as unknown as TranscriptionExtras;
  const text = transcriptText(events, "audio");
  const second = (value: number) => Math.round(value * 1000) / 1000;
  return {
    kind: "json",
    summary: text.length > 200 ? `${text.slice(0, 197)}...` : text,
    value: {
      text,
      segments: timedSegments(text, extras.seconds).map((segment) => ({
        text: segment.text,
        startSecond: second(segment.start),
        endSecond: second(segment.end),
      })),
      words: timedWords(text, extras.seconds).map((word) => ({
        text: word.word,
        startSecond: word.start,
        endSecond: word.end,
      })),
      language: "en",
      durationInSeconds: extras.seconds,
      warnings: [],
      providerMetadata: gatewayMetadata(decoded.request.model, ctx.makeId("gen")),
    },
  };
}

function decodeVideo(body: MediaBody, ctx: CodecContext): Decoded {
  const value = bodyOf(body);
  const model = gatewayModel(ctx);
  const prompt = optionalText(value, "prompt") ?? "";
  const inputs: FilePart[] = [];
  if (value.image !== undefined) inputs.push(modelFile(value.image, "image"));
  for (const [key, list] of [
    ["frameImages", value.frameImages],
    ["inputReferences", value.inputReferences],
  ] as const) {
    if (list === undefined) continue;
    if (!Array.isArray(list)) fail("Expected an array.", key);
    list.forEach((item, index) => {
      const at = `${key}[${index}]`;
      inputs.push(
        key === "frameImages" ? modelFile(isRecord(item) ? item.image : undefined, `${at}.image`) : modelFile(item, at),
      );
    });
  }
  if (prompt === "" && inputs.length === 0) fail("Expected a prompt or input images.", "prompt");
  const duration = value.duration ?? DEFAULT_VIDEO_SECONDS;
  if (typeof duration !== "number" || duration <= 0 || duration > 60)
    fail("Expected a duration from 1 to 60 seconds.", "duration");
  const aspectRatio = optionalText(value, "aspectRatio") ?? "16:9";
  const { width, height } = dimensions(optionalText(value, "resolution"), aspectRatio, 1280, "resolution");
  const job: Omit<VideoJob, "id" | "outcome" | "polls" | "reads" | "status" | "progress" | "createdAt"> = {
    provider: "gateway",
    model,
    prompt,
    seconds: duration,
    width,
    height,
    samples: count(value),
  };
  return {
    request: mediaRequest(
      "gateway",
      "video",
      model,
      [...(prompt ? [{ type: "text" as const, text: prompt }] : []), ...inputs],
      false,
    ),
    extras: { job } as unknown as Record<string, unknown>,
  };
}

function videoFiles(bytes: Uint8Array, samples: number): Json[] {
  const data = toBase64(bytes);
  return Array.from({ length: samples }, () => ({ type: "base64", data, mediaType: "video/mp4" }));
}

/** Answers a single-request video call in one server-sent event, the way the gateway reports a finished provider job. */
function renderVideoSync(events: RuleReplyEvent[] | undefined, decoded: Decoded, ctx: CodecContext): MediaResult {
  const { job } = decoded.extras as unknown as { job: Pick<VideoJob, "width" | "height" | "seconds" | "samples"> };
  const scripted = events?.find((event) => event.type === "video" || event.type === "video_error");
  const summary = `${job.samples} video (${job.width}x${job.height}, ${job.seconds}s)`;
  if (scripted?.type === "video_error") {
    const error = { type: "error", message: scripted.message, errorType: scripted.code, statusCode: 500, param: null };
    return { kind: "sse", frames: [{ data: error }], summary: `video error ${scripted.code}` };
  }
  const bytes =
    scripted?.type === "video" && scripted.data !== undefined
      ? base64Bytes(scripted.data)
      : renderVideo(job.width, job.height, job.seconds);
  const result = {
    type: "result",
    videos: videoFiles(bytes, job.samples),
    warnings: [],
    providerMetadata: gatewayMetadata(decoded.request.model, ctx.makeId("gen")),
  };
  return { kind: "sse", frames: [{ data: result, content: summary }], summary };
}

function renderVideoStart(events: RuleReplyEvent[] | undefined, decoded: Decoded, ctx: CodecContext): MediaResult {
  const job = createJob(events, decoded, ctx, ctx.makeId("vid"));
  return { kind: "json", summary: `video job ${job.id}`, value: { operation: job.id, warnings: [] } };
}

function gatewayRoute(
  suffix: string,
  task: MediaRoute["task"],
  sample: RuleReplyEvent,
  decode: MediaRoute["decode"],
  render: MediaRoute["render"],
): MediaRoute {
  return {
    format: "gateway",
    task,
    sample,
    matches: (method, path) => method === "POST" && (path === suffix || path.endsWith(suffix)),
    decode,
    render,
    errorBody: gatewayErrorBody,
  };
}

/** The AI Gateway model endpoints `@ai-sdk/gateway` calls for images, speech, transcription, and video. */
export const gatewayMediaRoutes: MediaRoute[] = [
  gatewayRoute("/image-model", "image", { type: "image" }, decodeImage, renderGatewayImage),
  gatewayRoute("/speech-model", "speech", { type: "audio" }, decodeSpeech, renderSpeech),
  gatewayRoute(
    "/transcription-model",
    "transcription",
    { type: "text", text: "" },
    decodeTranscription,
    renderTranscription,
  ),
  gatewayRoute("/video-model", "video", { type: "video" }, decodeVideo, renderVideoSync),
  gatewayRoute("/video-model/start", "video", { type: "video" }, decodeVideo, renderVideoStart),
];

/** Polls an asynchronous gateway video job; each read advances it one step through its state machine. */
export const gatewayStateRoutes: StateRoute[] = [
  {
    matches: (method, path) => method === "POST" && path.endsWith("/video-model/status"),
    handle: ({ body }, ctx) => {
      const operation = bodyOf(body).operation;
      const job = typeof operation === "string" ? ctx.state.jobs.get(operation) : undefined;
      if (!job || job.provider !== "gateway")
        fail(`Video operation '${String(operation)}' not found.`, "operation", "not_found", 404);
      advance(job);
      const providerMetadata = gatewayMetadata(job.model, `gen_${job.id}`);
      if (job.status === "completed") {
        const videos = videoFiles(videoBytes(job), job.samples);
        return { kind: "json", value: { status: "completed", videos, warnings: [], providerMetadata } };
      }
      if (job.status === "failed" && job.outcome.kind === "error") {
        return { kind: "json", value: { status: "error", error: job.outcome.message, providerMetadata } };
      }
      return { kind: "json", value: { status: "pending", warnings: [] } };
    },
    errorBody: gatewayErrorBody,
  },
];
