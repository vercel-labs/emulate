import type { Decoded } from "../codec.js";
import { redactedReference } from "../attachments.js";
import { AiRequestError } from "../errors.js";
import type { HttpFailure, RuleReplyEvent } from "../types.js";
import {
  fail,
  fieldsOf,
  mediaRequest,
  optionalBoolean,
  optionalEnum,
  optionalNumber,
  optionalString,
  requiredString,
  toBase64,
  uploadedPart,
  type Fields,
} from "./fields.js";
import { speechBytes, transcriptText } from "./openai-audio.js";
import type { MediaResult, MediaRoute } from "./route.js";
import { AUDIO_MEDIA_TYPES, audioSeconds, sniffAudioType, speechSeconds, type AudioFormat } from "./sound.js";
import { timedWords } from "./transcript.js";

const TTS_PATH = /\/v1\/text-to-speech\/([^/]+)(\/stream)?(\/with-timestamps)?$/;
const STT_PATH = /\/v1\/speech-to-text$/;
const PCM_RATES = [8000, 16000, 22050, 24000, 32000, 44100, 48000];
/** The codecs and sample rates ElevenLabs offers in `output_format`. */
const CODECS: Record<string, { format: AudioFormat; rates: readonly number[] }> = {
  mp3: { format: "mp3", rates: [22050, 24000, 44100] },
  pcm: { format: "pcm", rates: PCM_RATES },
  wav: { format: "wav", rates: PCM_RATES },
  ulaw: { format: "ulaw", rates: [8000] },
  alaw: { format: "alaw", rates: [8000] },
  opus: { format: "opus", rates: [48000] },
};

interface TtsExtras {
  text: string;
  format: AudioFormat;
  sampleRate: number;
  contentType: string;
  timestamps: boolean;
}

interface SttExtras {
  seconds: number;
  fileName: string;
  language: string;
  diarize: boolean;
  granularity: "none" | "word" | "character";
}

/** Parses an ElevenLabs `output_format` such as `mp3_44100_128`, `pcm_24000`, or `ulaw_8000`. */
function outputFormat(value: string): { format: AudioFormat; sampleRate: number; contentType: string } {
  const [codec, rate] = value.split("_");
  const sampleRate = Number(rate);
  const spec = Object.hasOwn(CODECS, codec) ? CODECS[codec] : undefined;
  if (!spec || !spec.rates.includes(sampleRate)) {
    fail(`Invalid output_format '${value}'.`, "output_format", "invalid_output_format", 422);
  }
  const format = spec.format;
  return { format, sampleRate, contentType: format === "opus" ? "audio/ogg" : AUDIO_MEDIA_TYPES[format] };
}

function decodeTts(fields: Fields, path: string, query: URLSearchParams): Decoded {
  const match = TTS_PATH.exec(path);
  const voice = decodeURIComponent(match?.[1] ?? "");
  const text = requiredString(fields, "text");
  const model = optionalString(fields, "model_id") ?? "eleven_multilingual_v2";
  const { format, sampleRate, contentType } = outputFormat(query.get("output_format") ?? "mp3_44100_128");
  const extras: TtsExtras = { text, format, sampleRate, contentType, timestamps: match?.[3] !== undefined };
  return {
    request: mediaRequest("elevenlabs", "speech", model, [{ type: "text", text }], match?.[2] !== undefined),
    extras: { ...extras, voice } as unknown as Record<string, unknown>,
  };
}

function renderTts(events: RuleReplyEvent[] | undefined, decoded: Decoded): MediaResult {
  const extras = decoded.extras as unknown as TtsExtras;
  const seconds = speechSeconds(extras.text);
  const audio = speechBytes(events, extras.format, seconds, extras.sampleRate);
  const summary = `${extras.format} audio, ${audio.length} bytes`;
  if (!extras.timestamps) return { kind: "bytes", data: audio, contentType: extras.contentType, summary };
  const characters = [...extras.text];
  const step = characters.length === 0 ? 0 : seconds / characters.length;
  const alignment = {
    characters,
    character_start_times_seconds: characters.map((_, index) => Math.round(index * step * 1000) / 1000),
    character_end_times_seconds: characters.map((_, index) => Math.round((index + 1) * step * 1000) / 1000),
  };
  return {
    kind: "json",
    summary,
    value: { audio_base64: toBase64(audio), alignment, normalized_alignment: alignment },
  };
}

function decodeStt(fields: Fields): Decoded {
  const model = requiredString(fields, "model_id");
  const file = fields.files.get("file")?.[0];
  const sourceUrl = optionalString(fields, "cloud_storage_url") ?? optionalString(fields, "source_url");
  if (!file && !sourceUrl) fail("Provide either file or cloud_storage_url.", "file", "invalid_parameters", 422);
  const granularity = optionalEnum(fields, "timestamps_granularity", ["none", "word", "character"] as const) ?? "word";
  optionalNumber(fields, "num_speakers", 1, 32);
  const extras: SttExtras = {
    seconds: file ? audioSeconds(file.bytes) : 1,
    fileName: file?.name || "audio",
    language: optionalString(fields, "language_code") ?? "en",
    diarize: optionalBoolean(fields, "diarize") ?? false,
    granularity,
  };
  const part = file
    ? uploadedPart(file, file.type && file.type !== "application/octet-stream" ? file.type : sniffAudioType(file.bytes))
    : {
        type: "file" as const,
        mediaType: "audio/*",
        source: "url" as const,
        ref: redactedReference(sourceUrl, "cloud_storage_url"),
      };
  return {
    request: mediaRequest("elevenlabs", "transcription", model, [part], false),
    extras: extras as unknown as Record<string, unknown>,
  };
}

function renderStt(events: RuleReplyEvent[] | undefined, decoded: Decoded): MediaResult {
  const extras = decoded.extras as unknown as SttExtras;
  const text = transcriptText(events, extras.fileName);
  const words =
    extras.granularity === "none"
      ? []
      : timedWords(text, extras.seconds).flatMap((word, index, all) => [
          {
            text: word.word,
            start: word.start,
            end: word.end,
            type: "word",
            logprob: 0,
            ...(extras.diarize ? { speaker_id: "speaker_0" } : {}),
          },
          ...(index < all.length - 1
            ? [
                {
                  text: " ",
                  start: word.end,
                  end: all[index + 1].start,
                  type: "spacing",
                  logprob: 0,
                  ...(extras.diarize ? { speaker_id: "speaker_0" } : {}),
                },
              ]
            : []),
        ]);
  return {
    kind: "json",
    summary: text.length > 200 ? `${text.slice(0, 197)}...` : text,
    value: {
      language_code: extras.language,
      language_probability: 1,
      text,
      words,
      transcription_id: decoded.extras.transcriptionId,
      audio_duration_secs: extras.seconds,
    },
  };
}

/** ElevenLabs rejects invalid bodies with 422, so client errors raised as 400 are reported that way. */
function unprocessable<T>(decode: () => T): T {
  try {
    return decode();
  } catch (error) {
    if (error instanceof AiRequestError && error.status === 400) {
      throw new AiRequestError(error.message, error.param, error.code, 422);
    }
    throw error;
  }
}

function errorBody(failure: HttpFailure): unknown {
  return { detail: { status: failure.code ?? "error", message: failure.message } };
}

/** ElevenLabs text-to-speech and speech-to-text routes. */
export const elevenLabsRoutes: MediaRoute[] = [
  {
    format: "elevenlabs",
    task: "speech",
    sample: { type: "audio" },
    matches: (method, path) => method === "POST" && TTS_PATH.test(path),
    decode: (body, ctx, query) => unprocessable(() => decodeTts(fieldsOf(body), ctx.path, query)),
    render: renderTts,
    errorBody,
    requestIdHeader: "request-id",
  },
  {
    format: "elevenlabs",
    task: "transcription",
    sample: { type: "text", text: "Replace with the expected transcript." },
    matches: (method, path) => method === "POST" && STT_PATH.test(path),
    decode: (body, ctx) => {
      const decoded = unprocessable(() => decodeStt(fieldsOf(body)));
      decoded.extras.transcriptionId = ctx.makeId("transcription");
      return decoded;
    },
    render: renderStt,
    errorBody,
    requestIdHeader: "request-id",
  },
];
