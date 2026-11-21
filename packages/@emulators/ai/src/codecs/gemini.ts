import { jsonChunks, textChunks } from "../chunks.js";
import type { Codec, CodecContext, Decoded } from "../codec.js";
import { AiRequestError } from "../errors.js";
import { inlineFilePart, redactedReference } from "../attachments.js";
import { googleError } from "../media/videos.js";
import type { SseFrame } from "../sse.js";
import type {
  AIRequest,
  AiTask,
  FilePart,
  FinishReason,
  InputPart,
  Json,
  JsonSchema,
  Message,
  OutputSpec,
  Reply,
  ToolChoice,
  ToolDefinition,
} from "../types.js";

const FORMAT = "gemini";
const MAX_INLINE_BYTES = 100_000_000;
const SAMPLE_RATES = [8000, 16000, 22050, 24000, 32000, 44100, 48000];
const MODEL_PATH = /\/models\/([^/:]+):(stream)?[gG]enerateContent$/;

/** The Gemini-specific settings a reply needs beyond the shared request. */
export interface GeminiExtras {
  task: AiTask;
  modalities: string[];
  includeThoughts: boolean;
  responseId: string;
  speech?: { mimeType: string; sampleRate: number };
  image?: { aspectRatio: string; imageSize: string };
}

function fail(message: string, param?: string): never {
  throw new AiRequestError(message, param);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Lowercases OpenAPI-style `type` values (`OBJECT`, `STRING`) so a Gemini `responseSchema` reads as JSON Schema. */
function jsonSchemaOf(schema: unknown): Json {
  if (Array.isArray(schema)) return schema.map(jsonSchemaOf);
  if (!isRecord(schema)) return schema as Json;
  return Object.fromEntries(
    Object.entries(schema).map(([key, value]) => [
      key,
      key === "type" && typeof value === "string" ? value.toLowerCase() : jsonSchemaOf(value),
    ]),
  );
}

function decodePart(part: unknown, path: string): InputPart[] {
  if (!isRecord(part)) fail("Expected a part object.", path);
  if (part.thought === true) return [];
  if (typeof part.text === "string") return [{ type: "text", text: part.text }];
  const inline = part.inlineData ?? part.inline_data;
  if (isRecord(inline)) {
    const mediaType = String(inline.mimeType ?? inline.mime_type ?? "");
    if (mediaType === "") fail("inlineData.mimeType is required.", `${path}.inlineData.mimeType`);
    if (typeof inline.data !== "string") fail("inlineData.data is required.", `${path}.inlineData.data`);
    return [inlineFilePart(inline.data, mediaType.toLowerCase(), `${path}.inlineData.data`, MAX_INLINE_BYTES)];
  }
  const file = part.fileData ?? part.file_data;
  if (isRecord(file)) {
    const ref = redactedReference(file.fileUri ?? file.file_uri, `${path}.fileData.fileUri`);
    const mediaType = String(file.mimeType ?? file.mime_type ?? "application/octet-stream");
    return [{ type: "file", mediaType, source: "url", ref } satisfies FilePart];
  }
  const call = part.functionCall ?? part.function_call;
  if (isRecord(call)) {
    const name = String(call.name ?? "");
    if (name === "") fail("functionCall.name is required.", `${path}.functionCall.name`);
    return [
      {
        type: "tool_call",
        id: typeof call.id === "string" ? call.id : name,
        name,
        arguments: JSON.stringify(call.args ?? {}),
      },
    ];
  }
  const response = part.functionResponse ?? part.function_response;
  if (isRecord(response)) {
    const name = String(response.name ?? "");
    if (name === "") fail("functionResponse.name is required.", `${path}.functionResponse.name`);
    return [
      {
        type: "tool_result",
        id: typeof response.id === "string" ? response.id : name,
        name,
        output: JSON.stringify(response.response ?? {}),
      },
    ];
  }
  return [];
}

function decodeContents(raw: unknown): Message[] {
  if (!Array.isArray(raw) || raw.length === 0) fail("contents is not specified.", "contents");
  return raw.flatMap((content, index): Message[] => {
    const path = `contents[${index}]`;
    if (!isRecord(content)) fail("Expected a content object.", path);
    if (!Array.isArray(content.parts)) fail("Expected a parts array.", `${path}.parts`);
    const parts = content.parts.flatMap((part, at) => decodePart(part, `${path}.parts[${at}]`));
    if (content.role === "model") return [{ role: "assistant", parts }];
    const results = parts.filter((part) => part.type === "tool_result");
    const rest = parts.filter((part) => part.type !== "tool_result");
    return [
      ...(results.length > 0 ? [{ role: "tool" as const, parts: results }] : []),
      ...(rest.length > 0 || results.length === 0 ? [{ role: "user" as const, parts: rest }] : []),
    ];
  });
}

function decodeTools(raw: unknown): ToolDefinition[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) fail("Expected an array of tools.", "tools");
  return raw.flatMap((tool, index): ToolDefinition[] => {
    if (!isRecord(tool)) fail("Expected a tool object.", `tools[${index}]`);
    const declarations = tool.functionDeclarations ?? tool.function_declarations;
    if (declarations === undefined) return [];
    if (!Array.isArray(declarations))
      fail("Expected an array of function declarations.", `tools[${index}].functionDeclarations`);
    return declarations.map((declaration, at): ToolDefinition => {
      const path = `tools[${index}].functionDeclarations[${at}]`;
      if (!isRecord(declaration) || typeof declaration.name !== "string" || declaration.name === "")
        fail("A function declaration needs a name.", `${path}.name`);
      const parameters =
        declaration.parametersJsonSchema ??
        (declaration.parameters === undefined ? undefined : jsonSchemaOf(declaration.parameters));
      return {
        name: declaration.name,
        ...(typeof declaration.description === "string" ? { description: declaration.description } : {}),
        ...(parameters === undefined ? {} : { parameters: parameters as JsonSchema }),
      };
    });
  });
}

function decodeToolChoice(raw: unknown, tools: ToolDefinition[]): ToolChoice {
  if (!isRecord(raw) || !isRecord(raw.functionCallingConfig)) return "auto";
  const config = raw.functionCallingConfig;
  const allowed = Array.isArray(config.allowedFunctionNames) ? config.allowedFunctionNames : [];
  switch (String(config.mode ?? "AUTO").toUpperCase()) {
    case "NONE":
      return "none";
    case "ANY":
      if (typeof allowed[0] === "string") return { name: allowed[0] };
      return tools.length > 0 ? "required" : "auto";
    default:
      return "auto";
  }
}

function decodeOutput(config: Record<string, unknown>): OutputSpec | undefined {
  if (config.responseMimeType !== "application/json") return undefined;
  const schema =
    config.responseJsonSchema ??
    (config.responseSchema === undefined ? undefined : jsonSchemaOf(config.responseSchema));
  return schema === undefined ? { kind: "json_object" } : { kind: "json_schema", schema: schema as JsonSchema };
}

const AUDIO_TYPES: Record<string, string> = {
  AUDIO_L16: "audio/L16;codec=pcm",
  AUDIO_WAV: "audio/wav",
  AUDIO_MP3: "audio/mpeg",
  AUDIO_OGG_OPUS: "audio/ogg",
  AUDIO_ALAW: "audio/alaw",
  AUDIO_MULAW: "audio/mulaw",
};

function decodeSpeech(config: Record<string, unknown>): { mimeType: string; sampleRate: number } {
  const speech = isRecord(config.speechConfig) ? config.speechConfig : undefined;
  if (speech && isRecord(speech.multiSpeakerVoiceConfig)) {
    if (speech.voiceConfig !== undefined)
      fail("voiceConfig and multiSpeakerVoiceConfig are mutually exclusive.", "generationConfig.speechConfig");
    const speakers = speech.multiSpeakerVoiceConfig.speakerVoiceConfigs;
    if (!Array.isArray(speakers) || speakers.length !== 2) {
      fail(
        "multiSpeakerVoiceConfig needs exactly 2 speakerVoiceConfigs.",
        "generationConfig.speechConfig.multiSpeakerVoiceConfig",
      );
    }
  }
  const format =
    isRecord(config.responseFormat) && isRecord(config.responseFormat.audio) ? config.responseFormat.audio : {};
  const requested = typeof format.mimeType === "string" ? format.mimeType : "AUDIO_L16";
  const mimeType = AUDIO_TYPES[requested];
  if (!mimeType) fail(`Unsupported audio mimeType ${requested}.`, "generationConfig.responseFormat.audio.mimeType");
  const telephony = requested === "AUDIO_ALAW" || requested === "AUDIO_MULAW";
  const sampleRate = format.sampleRate ?? (telephony ? 8000 : 24000);
  if (typeof sampleRate !== "number" || !SAMPLE_RATES.includes(sampleRate)) {
    fail(`Unsupported audio sampleRate ${String(sampleRate)}.`, "generationConfig.responseFormat.audio.sampleRate");
  }
  return { mimeType, sampleRate };
}

/** Validates a generateContent body. `responseModalities` picks the task: IMAGE asks for an image, AUDIO for speech. */
export function decodeGemini(body: unknown, ctx: CodecContext): Decoded {
  if (!isRecord(body)) fail("Expected a JSON object body.");
  const match = MODEL_PATH.exec(ctx.path);
  const model = match?.[1] ?? "";
  const config = isRecord(body.generationConfig) ? body.generationConfig : {};
  const modalities = Array.isArray(config.responseModalities)
    ? config.responseModalities.map((value) => String(value).toUpperCase())
    : ["TEXT"];
  for (const modality of modalities) {
    if (!["TEXT", "IMAGE", "AUDIO"].includes(modality))
      fail(`Unsupported response modality ${modality}.`, "generationConfig.responseModalities");
  }
  if (modalities.includes("AUDIO") && modalities.length > 1)
    fail("AUDIO cannot be combined with other response modalities.", "generationConfig.responseModalities");
  if (typeof config.candidateCount === "number" && config.candidateCount !== 1)
    fail("Multiple candidates are not supported.", "generationConfig.candidateCount");
  const task: AiTask = modalities.includes("AUDIO") ? "speech" : modalities.includes("IMAGE") ? "image" : "text";

  const messages: Message[] = [];
  const system = body.systemInstruction ?? body.system_instruction;
  if (isRecord(system) && Array.isArray(system.parts)) {
    messages.push({
      role: "system",
      parts: system.parts.flatMap((part, at) => decodePart(part, `systemInstruction.parts[${at}]`)),
    });
  }
  messages.push(...decodeContents(body.contents));
  const tools = decodeTools(body.tools);
  const thinking = isRecord(config.thinkingConfig) ? config.thinkingConfig : {};
  const maxOutputTokens = typeof config.maxOutputTokens === "number" ? config.maxOutputTokens : undefined;
  const stop = Array.isArray(config.stopSequences) ? config.stopSequences.map(String) : undefined;
  const output = task === "text" ? decodeOutput(config) : undefined;
  const request: AIRequest = {
    format: FORMAT,
    ...(task === "text" ? {} : { task }),
    model,
    messages,
    tools,
    toolChoice: decodeToolChoice(body.toolConfig, tools),
    parallelToolCalls: true,
    stream: match?.[2] === "stream",
    ...(output ? { output } : {}),
    reasoning: thinking.includeThoughts === true,
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    ...(stop ? { stop } : {}),
    store: false,
    references: [],
    warnings: [],
  };
  const imageConfig = isRecord(config.imageConfig) ? config.imageConfig : {};
  const extras: GeminiExtras = {
    task,
    modalities,
    includeThoughts: thinking.includeThoughts === true,
    responseId: ctx.makeId("resp").replace("_", ""),
    ...(task === "speech" ? { speech: decodeSpeech(config) } : {}),
    ...(task === "image"
      ? {
          image: {
            aspectRatio: typeof imageConfig.aspectRatio === "string" ? imageConfig.aspectRatio : "1:1",
            imageSize: typeof imageConfig.imageSize === "string" ? imageConfig.imageSize : "1K",
          },
        }
      : {}),
  };
  return { request, extras: extras as unknown as Record<string, unknown> };
}

/** Gemini's finish reason for a reply; function calls finish with STOP. */
export function geminiFinish(finish: FinishReason): string {
  if (finish === "length") return "MAX_TOKENS";
  if (finish === "content_filter") return "SAFETY";
  return "STOP";
}

function usageMetadata(reply: Reply) {
  const candidates = reply.usage.output - reply.usage.reasoning;
  return {
    promptTokenCount: reply.usage.input,
    candidatesTokenCount: candidates,
    ...(reply.usage.reasoning > 0 ? { thoughtsTokenCount: reply.usage.reasoning } : {}),
    totalTokenCount: reply.usage.input + reply.usage.output,
  };
}

/** A function call part with the thought signature Gemini 3 models attach, derived from the call id. */
function functionCallPart(id: string, name: string, args: string): Json {
  return {
    functionCall: { id, name, args: JSON.parse(args) as Json },
    thoughtSignature: Buffer.from(`emulate:${id}`).toString("base64"),
  };
}

function eventParts(reply: Reply, extras: GeminiExtras): Json[] {
  return reply.events.flatMap((event): Json[] => {
    switch (event.type) {
      case "text":
      case "refusal":
        return [{ text: event.text }];
      case "object":
        return [{ text: JSON.stringify(event.value) }];
      case "reasoning":
        return extras.includeThoughts ? [{ text: event.text, thought: true }] : [];
      case "tool_call":
        return [functionCallPart(event.id, event.name, event.arguments)];
    }
  });
}

/** One GenerateContentResponse holding `parts` for the single candidate. */
export function geminiResponse(
  model: string,
  responseId: string,
  parts: Json[],
  tail?: Record<string, Json>,
): Record<string, Json> {
  return {
    candidates: [
      {
        content: { role: "model", parts },
        index: 0,
        ...(tail?.finishReason ? { finishReason: tail.finishReason } : {}),
      },
    ],
    ...(tail?.usageMetadata ? { usageMetadata: tail.usageMetadata } : {}),
    modelVersion: model,
    responseId,
  };
}

function encodeJson(reply: Reply, decoded: Decoded): unknown {
  const extras = decoded.extras as unknown as GeminiExtras;
  return geminiResponse(decoded.request.model, extras.responseId, eventParts(reply, extras), {
    finishReason: geminiFinish(reply.finish),
    usageMetadata: usageMetadata(reply),
  });
}

function streamFrames(reply: Reply, decoded: Decoded): SseFrame[] {
  const extras = decoded.extras as unknown as GeminiExtras;
  const model = decoded.request.model;
  const frames: SseFrame[] = [];
  const push = (part: Json, content?: string) =>
    frames.push({
      data: geminiResponse(model, extras.responseId, [part]),
      ...(content === undefined ? {} : { content }),
    });
  for (const event of reply.events) {
    if (event.type === "text" || event.type === "refusal")
      textChunks(event.text).forEach((piece) => push({ text: piece }, piece));
    else if (event.type === "object")
      jsonChunks(JSON.stringify(event.value)).forEach((piece) => push({ text: piece }, piece));
    else if (event.type === "reasoning" && extras.includeThoughts)
      textChunks(event.text).forEach((piece) => push({ text: piece, thought: true }, piece));
    else if (event.type === "tool_call") push(functionCallPart(event.id, event.name, event.arguments), event.arguments);
  }
  const tail = { finishReason: geminiFinish(reply.finish), usageMetadata: usageMetadata(reply) };
  const last = frames.at(-1);
  if (last) {
    const parts = (last.data as { candidates: Array<{ content: { parts: Json[] } }> }).candidates[0].content.parts;
    last.data = geminiResponse(model, extras.responseId, parts, tail);
  } else {
    frames.push({ data: geminiResponse(model, extras.responseId, [{ text: "" }], tail) });
  }
  return frames;
}

/** The Gemini generateContent and streamGenerateContent codec for text replies. */
export const geminiCodec: Codec = {
  format: FORMAT,
  decode: decodeGemini,
  encodeJson,
  streamFrames,
  errorBody: googleError,
};
