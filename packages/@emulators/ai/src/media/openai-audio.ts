import type { Decoded } from "../codec.js";
import { textChunks } from "../chunks.js";
import { chatCodec } from "../codecs/openai-chat.js";
import type { SseFrame } from "../sse.js";
import type { RuleReplyEvent } from "../types.js";
import {
  base64Bytes,
  fail,
  fieldsOf,
  isRecord,
  mediaRequest,
  optionalBoolean,
  optionalEnum,
  optionalNumber,
  optionalString,
  optionalStrings,
  requiredString,
  textTokens,
  toBase64,
  uploadedPart,
  type Fields,
} from "./fields.js";
import type { MediaResult, MediaRoute } from "./route.js";
import { audioSeconds, renderAudio, sniffAudioType, speechSeconds, type AudioFormat } from "./sound.js";
import { languageName, timedSegments, timedWords, toSrt, toVtt } from "./transcript.js";

const SPEECH_FORMATS = ["mp3", "opus", "aac", "flac", "wav", "pcm"] as const;
const SPEECH_CONTENT_TYPES: Record<(typeof SPEECH_FORMATS)[number], string> = {
  mp3: "audio/mpeg",
  opus: "audio/opus",
  aac: "audio/aac",
  flac: "audio/flac",
  wav: "audio/wav",
  pcm: "audio/pcm",
};
const TRANSCRIPT_FORMATS = ["json", "text", "srt", "verbose_json", "vtt", "diarized_json"] as const;
const WHISPER_FORMATS = ["json", "text", "srt", "verbose_json", "vtt"] as const;
const AUDIO_CHUNK_BYTES = 8192;

type TranscriptFormat = (typeof TRANSCRIPT_FORMATS)[number];

interface SpeechExtras {
  input: string;
  format: (typeof SPEECH_FORMATS)[number];
  seconds: number;
  sse: boolean;
}

interface TranscriptExtras {
  task: "transcribe" | "translate";
  model: string;
  format: TranscriptFormat;
  stream: boolean;
  seconds: number;
  fileName: string;
  language: string;
  granularities: string[];
  logprobs: boolean;
}

function isLegacyTts(model: string): boolean {
  return model === "tts-1" || model === "tts-1-hd";
}

function decodeSpeech(fields: Fields): Decoded {
  const model = requiredString(fields, "model");
  const input = requiredString(fields, "input", 4096);
  const voice = fields.values.voice;
  if (voice === undefined || voice === null || voice === "") {
    fail("Missing required parameter: 'voice'.", "voice", "missing_required_parameter");
  }
  if (typeof voice !== "string" && !(isRecord(voice) && typeof voice.id === "string" && voice.id !== "")) {
    fail("Invalid 'voice': expected a voice name or an object with an id.", "voice", "invalid_type");
  }
  const instructions = optionalString(fields, "instructions");
  if (instructions !== undefined && isLegacyTts(model)) {
    fail(`Instructions are not supported for model '${model}'.`, "instructions", "unsupported_parameter");
  }
  if (instructions !== undefined && instructions.length > 4096) {
    fail("'instructions' is too long. Maximum length is 4096 characters.", "instructions", "string_above_max_length");
  }
  const format = optionalEnum(fields, "response_format", SPEECH_FORMATS) ?? "mp3";
  const speed = optionalNumber(fields, "speed", 0.25, 4) ?? 1;
  const streamFormat = optionalEnum(fields, "stream_format", ["audio", "sse"] as const) ?? "audio";
  if (streamFormat === "sse" && isLegacyTts(model)) {
    fail(`stream_format 'sse' is not supported for model '${model}'.`, "stream_format", "unsupported_parameter");
  }
  const extras: SpeechExtras = { input, format, seconds: speechSeconds(input, speed), sse: streamFormat === "sse" };
  return {
    request: mediaRequest("openai-audio", "speech", model, [{ type: "text", text: input }], streamFormat === "sse"),
    extras: extras as unknown as Record<string, unknown>,
  };
}

/** The audio a speech rule scripted, or silence lasting as long as the input would take to read aloud. */
export function speechBytes(
  events: RuleReplyEvent[] | undefined,
  format: AudioFormat,
  seconds: number,
  sampleRate = 24000,
): Uint8Array {
  const scripted = events?.find((event) => event.type === "audio");
  if (scripted?.type === "audio" && scripted.data !== undefined) return base64Bytes(scripted.data);
  return renderAudio(format, { seconds, sampleRate });
}

function renderSpeech(events: RuleReplyEvent[] | undefined, decoded: Decoded): MediaResult {
  const extras = decoded.extras as unknown as SpeechExtras;
  const audio = speechBytes(events, extras.format, extras.seconds);
  const summary = `${extras.format} audio, ${audio.length} bytes`;
  if (!extras.sse) return { kind: "bytes", data: audio, contentType: SPEECH_CONTENT_TYPES[extras.format], summary };
  const frames: SseFrame[] = [];
  for (let at = 0; at < audio.length; at += AUDIO_CHUNK_BYTES) {
    const chunk = toBase64(audio.subarray(at, at + AUDIO_CHUNK_BYTES));
    frames.push({ data: { type: "speech.audio.delta", audio: chunk }, content: chunk });
  }
  const input = textTokens(extras.input);
  const output = Math.ceil(extras.seconds * 20);
  frames.push({
    data: {
      type: "speech.audio.done",
      usage: { input_tokens: input, output_tokens: output, total_tokens: input + output },
    },
  });
  return { kind: "sse", frames, summary };
}

function allowedFormats(model: string, task: "transcribe" | "translate"): readonly TranscriptFormat[] {
  if (task === "translate") return WHISPER_FORMATS;
  if (model.startsWith("gpt-4o-transcribe-diarize")) return ["json", "text", "diarized_json"];
  if (model.startsWith("gpt-4o-transcribe") || model.startsWith("gpt-4o-mini-transcribe")) return ["json"];
  return WHISPER_FORMATS;
}

function decodeTranscript(task: "transcribe" | "translate", fields: Fields): Decoded {
  const file = fields.files.get("file")?.[0];
  if (!file) fail("Missing required parameter: 'file'.", "file", "missing_required_parameter");
  if (file.bytes.length === 0) fail("The audio file is empty.", "file");
  const model = requiredString(fields, "model");
  const isWhisper = model.startsWith("whisper");
  const format = optionalEnum(fields, "response_format", TRANSCRIPT_FORMATS) ?? "json";
  const allowed = allowedFormats(model, task);
  if (!allowed.includes(format)) {
    fail(
      `response_format '${format}' is not compatible with model '${model}'. Use ${allowed.map((item) => `'${item}'`).join(", ")}.`,
      "response_format",
      "unsupported_value",
    );
  }
  const granularities = optionalStrings(fields, "timestamp_granularities") ?? [];
  for (const granularity of granularities) {
    if (granularity !== "word" && granularity !== "segment") {
      fail(`Invalid value for 'timestamp_granularities': '${granularity}'.`, "timestamp_granularities");
    }
  }
  if (granularities.length > 0 && format !== "verbose_json") {
    fail(
      "timestamp_granularities requires response_format 'verbose_json'.",
      "timestamp_granularities",
      "unsupported_value",
    );
  }
  const include = optionalStrings(fields, "include") ?? [];
  if (include.some((item) => item !== "logprobs")) fail("Invalid value for 'include'.", "include");
  if (include.length > 0 && (format !== "json" || isWhisper)) {
    fail(
      "include[]=logprobs requires response_format 'json' and a gpt-4o transcription model.",
      "include",
      "unsupported_value",
    );
  }
  optionalNumber(fields, "temperature", 0, 1);
  const stream = task === "transcribe" && !isWhisper && (optionalBoolean(fields, "stream") ?? false);
  const language = task === "translate" ? "en" : (optionalString(fields, "language") ?? "en");
  const prompt = optionalString(fields, "prompt");
  const mediaType =
    file.type && file.type !== "application/octet-stream"
      ? file.type
      : (sniffAudioType(file.bytes) ?? "application/octet-stream");
  const extras: TranscriptExtras = {
    task,
    model,
    format,
    stream,
    seconds: audioSeconds(file.bytes),
    fileName: file.name || "audio",
    language,
    granularities,
    logprobs: include.length > 0,
  };
  return {
    request: mediaRequest(
      "openai-audio",
      "transcription",
      model,
      [...(prompt ? [{ type: "text" as const, text: prompt }] : []), uploadedPart(file, mediaType)],
      stream,
    ),
    extras: extras as unknown as Record<string, unknown>,
  };
}

/** The transcript a transcription rule scripted, or a deterministic sentence naming the file. */
export function transcriptText(events: RuleReplyEvent[] | undefined, fileName: string): string {
  const scripted = events?.filter((event) => event.type === "text");
  if (scripted && scripted.length > 0)
    return scripted.map((event) => (event.type === "text" ? event.text : "")).join("");
  return `This is a deterministic transcript of ${fileName}.`;
}

function tokenUsage(text: string, seconds: number) {
  const audio = Math.ceil(seconds * 10);
  const output = textTokens(text);
  return {
    type: "tokens",
    input_tokens: audio,
    input_token_details: { text_tokens: 0, audio_tokens: audio },
    output_tokens: output,
    total_tokens: audio + output,
  };
}

function logprobOf(token: string) {
  return { token, logprob: -0.1, bytes: [...new TextEncoder().encode(token)] };
}

function diarizedSegment(segment: { start: number; end: number; text: string }, index: number) {
  return {
    type: "transcript.text.segment" as const,
    id: `seg_${String(index + 1).padStart(3, "0")}`,
    start: segment.start,
    end: segment.end,
    text: segment.text,
    speaker: "A",
  };
}

function renderTranscript(events: RuleReplyEvent[] | undefined, decoded: Decoded): MediaResult {
  const extras = decoded.extras as unknown as TranscriptExtras;
  const text = transcriptText(events, extras.fileName);
  const segments = timedSegments(text, extras.seconds);
  const usage = extras.model.startsWith("whisper")
    ? { type: "duration", seconds: Math.ceil(extras.seconds) }
    : tokenUsage(text, extras.seconds);
  const summary = text.length > 200 ? `${text.slice(0, 197)}...` : text;

  if (extras.stream) {
    const frames: SseFrame[] = [];
    const deltas: string[] = [];
    const pushDeltas = (value: string, segmentId?: string) => {
      for (const delta of textChunks(value)) {
        deltas.push(delta);
        const logprobs = extras.logprobs ? { logprobs: [logprobOf(delta)] } : {};
        const segment = segmentId === undefined ? {} : { segment_id: segmentId };
        frames.push({ data: { type: "transcript.text.delta", delta, ...logprobs, ...segment }, content: delta });
      }
    };
    if (extras.format === "diarized_json") {
      segments.forEach((segment, index) => {
        const event = diarizedSegment(segment, index);
        pushDeltas(index === 0 ? segment.text : ` ${segment.text}`, event.id);
        frames.push({ data: event });
      });
    } else {
      pushDeltas(text);
    }
    const logprobs = extras.logprobs ? { logprobs: deltas.map(logprobOf) } : {};
    frames.push({ data: { type: "transcript.text.done", text, ...logprobs, usage } });
    return { kind: "sse", frames, summary };
  }

  switch (extras.format) {
    case "text":
      return { kind: "text", text: `${text}\n`, contentType: "text/plain; charset=utf-8", summary };
    case "srt":
      return { kind: "text", text: toSrt(segments), contentType: "text/plain; charset=utf-8", summary };
    case "vtt":
      return { kind: "text", text: toVtt(segments), contentType: "text/plain; charset=utf-8", summary };
    case "verbose_json": {
      const wantWords = extras.granularities.includes("word");
      const wantSegments = extras.granularities.length === 0 || extras.granularities.includes("segment");
      return {
        kind: "json",
        summary,
        value: {
          task: extras.task,
          language: languageName(extras.language),
          duration: extras.seconds,
          text,
          ...(wantSegments
            ? {
                segments: segments.map((segment, id) => ({
                  id,
                  seek: 0,
                  start: segment.start,
                  end: segment.end,
                  text: ` ${segment.text}`,
                  tokens: [],
                  temperature: 0,
                  avg_logprob: -0.1,
                  compression_ratio: 1,
                  no_speech_prob: 0,
                })),
              }
            : {}),
          ...(wantWords ? { words: segments.flatMap((segment) => segment.words) } : {}),
          usage,
        },
      };
    }
    case "diarized_json":
      return {
        kind: "json",
        summary,
        value: {
          task: "transcribe",
          duration: extras.seconds,
          text,
          segments: segments.map(diarizedSegment),
          usage,
        },
      };
    case "json":
      return {
        kind: "json",
        summary,
        value: {
          text,
          ...(extras.logprobs
            ? {
                logprobs: timedWords(text, extras.seconds).map((word) => logprobOf(word.word)),
              }
            : {}),
          ...(extras.task === "translate" ? {} : { usage }),
        },
      };
  }
}

function audioRoute(
  suffix: string,
  task: "speech" | "transcription",
  decode: (fields: Fields) => Decoded,
  render: (events: RuleReplyEvent[] | undefined, decoded: Decoded) => MediaResult,
): MediaRoute {
  return {
    format: "openai-audio",
    task,
    sample: task === "speech" ? { type: "audio" } : { type: "text", text: "Replace with the expected transcript." },
    matches: (method, path) => method === "POST" && (path === suffix || path.endsWith(suffix)),
    decode: (body) => decode(fieldsOf(body)),
    render,
    errorBody: (failure, requestId) => chatCodec.errorBody(failure, requestId),
  };
}

/** OpenAI speech, transcription, and translation routes. */
export const openaiAudioRoutes: MediaRoute[] = [
  audioRoute("/audio/speech", "speech", decodeSpeech, renderSpeech),
  audioRoute(
    "/audio/transcriptions",
    "transcription",
    (fields) => decodeTranscript("transcribe", fields),
    renderTranscript,
  ),
  audioRoute(
    "/audio/translations",
    "transcription",
    (fields) => decodeTranscript("translate", fields),
    renderTranscript,
  ),
];
