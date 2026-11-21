import type { CodecContext, Decoded } from "../codec.js";
import { decodeGemini, geminiResponse, protoJson, type GeminiExtras } from "../codecs/gemini.js";
import type { Json, RuleReplyEvent } from "../types.js";
import { base64Bytes, fail, isRecord, textTokens, toBase64 } from "./fields.js";
import { colorFor, renderImage, sniffImageType } from "./pixels.js";
import type { MediaBody, MediaResult, MediaRoute } from "./route.js";
import { renderAudio, speechSeconds, type AudioFormat } from "./sound.js";
import { googleError } from "./videos.js";

const GENERATE = /\/models\/[^/:]+:(?:stream)?[gG]enerateContent$/;
const IMAGE_SIZES: Record<string, number> = { "512": 512, "1K": 1024, "2K": 2048, "4K": 4096 };
const AUDIO_FORMATS: Record<string, AudioFormat> = {
  "audio/L16;codec=pcm": "pcm",
  "audio/wav": "wav",
  "audio/mpeg": "mp3",
  "audio/ogg": "opus",
  "audio/alaw": "alaw",
  "audio/mulaw": "ulaw",
};

function modalities(body: MediaBody): string[] {
  const value = body.kind === "json" ? protoJson(body.value) : undefined;
  if (!isRecord(value) || !isRecord(value.generationConfig)) return [];
  const raw = value.generationConfig.responseModalities;
  return Array.isArray(raw) ? raw.map((value) => String(value).toUpperCase()) : [];
}

/** Sizes an aspect ratio with its long side at the requested image size. */
function imageDimensions(aspectRatio: string, imageSize: string): { width: number; height: number } {
  const long = IMAGE_SIZES[imageSize];
  if (long === undefined) fail(`Unsupported imageSize ${imageSize}.`, "generationConfig.imageConfig.imageSize");
  const match = /^(\d+):(\d+)$/.exec(aspectRatio);
  const w = Number(match?.[1]);
  const h = Number(match?.[2]);
  if (!Number.isSafeInteger(w) || !Number.isSafeInteger(h) || w === 0 || h === 0) {
    fail(`Unsupported aspectRatio ${aspectRatio}.`, "generationConfig.imageConfig.aspectRatio");
  }
  const short = Math.max(1, Math.round(long * (Math.min(w, h) / Math.max(w, h))));
  return w >= h ? { width: long, height: short } : { width: short, height: long };
}

function promptText(decoded: Decoded): string {
  const user = decoded.request.messages.filter((message) => message.role === "user").at(-1);
  return (user?.parts ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");
}

function respond(
  decoded: Decoded,
  parts: Json[],
  modality: string,
  outputTokens: number,
  summary: string,
): MediaResult {
  const extras = decoded.extras as unknown as GeminiExtras;
  const input = textTokens(promptText(decoded));
  const tail = {
    finishReason: "STOP",
    usageMetadata: {
      promptTokenCount: input,
      candidatesTokenCount: outputTokens,
      totalTokenCount: input + outputTokens,
      candidatesTokensDetails: [{ modality, tokenCount: outputTokens }],
    },
  };
  const response = geminiResponse(decoded.request.model, extras.responseId, parts, tail);
  if (decoded.request.stream) return { kind: "sse", frames: [{ data: response, content: summary }], summary };
  return { kind: "json", value: response, summary };
}

function renderGeminiImage(events: RuleReplyEvent[] | undefined, decoded: Decoded): MediaResult {
  const extras = decoded.extras as unknown as GeminiExtras;
  const { width, height } = imageDimensions(extras.image?.aspectRatio ?? "1:1", extras.image?.imageSize ?? "1K");
  const parts: Json[] = [];
  const scripted = events ?? [{ type: "image" }];
  for (const event of scripted) {
    if (event.type === "text") parts.push({ text: event.text });
    if (event.type === "image") {
      const bytes =
        event.data !== undefined
          ? base64Bytes(event.data)
          : renderImage("png", width, height, colorFor(`${promptText(decoded)}#${parts.length}`));
      parts.push({ inlineData: { mimeType: sniffImageType(bytes) ?? "image/png", data: toBase64(bytes) } });
    }
  }
  const images = parts.filter((part) => isRecord(part) && "inlineData" in part).length;
  return respond(
    decoded,
    parts,
    "IMAGE",
    images * 1290,
    `${images} ${images === 1 ? "image" : "images"} (${width}x${height})`,
  );
}

function renderGeminiSpeech(events: RuleReplyEvent[] | undefined, decoded: Decoded): MediaResult {
  const extras = decoded.extras as unknown as GeminiExtras;
  const speech = extras.speech ?? { mimeType: "audio/L16;codec=pcm", sampleRate: 24000 };
  const format = AUDIO_FORMATS[speech.mimeType] ?? "pcm";
  const text = promptText(decoded);
  const seconds = speechSeconds(text);
  const scripted = events?.find((event) => event.type === "audio");
  const bytes =
    scripted?.type === "audio" && scripted.data !== undefined
      ? base64Bytes(scripted.data)
      : renderAudio(format, { seconds, sampleRate: speech.sampleRate });
  const mimeType = format === "pcm" ? `${speech.mimeType};rate=${speech.sampleRate}` : speech.mimeType;
  return respond(
    decoded,
    [{ inlineData: { mimeType, data: toBase64(bytes) } }],
    "AUDIO",
    Math.ceil(seconds * 25),
    `${format} audio, ${bytes.length} bytes`,
  );
}

function geminiMediaRoute(task: "image" | "speech", modality: string): MediaRoute {
  return {
    format: "gemini",
    task,
    sample: task === "image" ? { type: "image" } : { type: "audio" },
    matches: (method, path) => method === "POST" && GENERATE.test(path),
    accepts: (body) => modalities(body).includes(modality),
    decode: (body, ctx: CodecContext) => decodeGemini(body.kind === "json" ? body.value : undefined, ctx),
    render: task === "image" ? renderGeminiImage : renderGeminiSpeech,
    errorBody: googleError,
  };
}

/** Gemini generateContent requests whose `responseModalities` ask for an image or for speech. */
export const geminiMediaRoutes: MediaRoute[] = [
  geminiMediaRoute("image", "IMAGE"),
  geminiMediaRoute("speech", "AUDIO"),
];
