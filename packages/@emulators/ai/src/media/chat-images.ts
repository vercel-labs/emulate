import { CREATED_AT, type CodecContext, type Decoded } from "../codec.js";
import { chatCodec, SYSTEM_FINGERPRINT } from "../codecs/openai-chat.js";
import type { SseFrame } from "../sse.js";
import type { Json, RuleReplyEvent } from "../types.js";
import { base64Bytes, fail, isRecord, textTokens, toBase64 } from "./fields.js";
import { dimensions } from "./gateway.js";
import { colorFor, renderImage, sniffImageType } from "./pixels.js";
import type { MediaBody, MediaResult, MediaRoute } from "./route.js";

const IMAGE_SIZES: Record<string, number> = { "512": 512, "1K": 1024, "2K": 2048, "4K": 4096 };

interface ChatImageExtras {
  includeUsage: boolean;
  width: number;
  height: number;
}

function wantsImage(body: MediaBody): boolean {
  return (
    body.kind === "json" &&
    isRecord(body.value) &&
    Array.isArray(body.value.modalities) &&
    body.value.modalities.includes("image")
  );
}

function decodeChatImage(body: MediaBody, ctx: CodecContext): Decoded {
  const value = body.kind === "json" && isRecord(body.value) ? body.value : undefined;
  const decoded = chatCodec.decode(value, ctx);
  if (value?.audio !== undefined && value.audio !== null)
    fail("Image output cannot be combined with audio output.", "audio");
  const config = isRecord(value?.image_config) ? value.image_config : {};
  const size = typeof config.image_size === "string" ? config.image_size : "1K";
  const long = IMAGE_SIZES[size];
  if (long === undefined) fail(`Unsupported image_size ${size}.`, "image_config.image_size");
  const aspectRatio = typeof config.aspect_ratio === "string" ? config.aspect_ratio : undefined;
  const { width, height } = dimensions(undefined, aspectRatio, long, "image_config", "image_config.aspect_ratio");
  const extras: ChatImageExtras = { includeUsage: decoded.extras.includeUsage === true, width, height };
  return {
    request: { ...decoded.request, task: "image" },
    extras: extras as unknown as Record<string, unknown>,
  };
}

function promptText(decoded: Decoded): string {
  const user = decoded.request.messages.filter((message) => message.role === "user").at(-1);
  return (user?.parts ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");
}

/** Renders a chat reply carrying generated images in `message.images`, the shape AI Gateway and OpenRouter return. */
function renderChatImage(events: RuleReplyEvent[] | undefined, decoded: Decoded, ctx: CodecContext): MediaResult {
  const extras = decoded.extras as unknown as ChatImageExtras;
  const prompt = promptText(decoded);
  let text = "";
  const images: Json[] = [];
  for (const event of events ?? [{ type: "image" }]) {
    if (event.type === "text") text += event.text;
    if (event.type !== "image") continue;
    const bytes =
      event.data !== undefined
        ? base64Bytes(event.data)
        : renderImage("png", extras.width, extras.height, colorFor(`${prompt}#${images.length}`));
    const url = `data:${sniffImageType(bytes) ?? "image/png"};base64,${toBase64(bytes)}`;
    images.push({ type: "image_url", image_url: { url } });
  }
  const input = textTokens(prompt);
  const output = textTokens(text) + images.length * 1290;
  const usage = { prompt_tokens: input, completion_tokens: output, total_tokens: input + output };
  const id = ctx.makeId("chatcmpl").replace("_", "-");
  const model = decoded.request.model;
  const summary = `${images.length} ${images.length === 1 ? "image" : "images"} (${extras.width}x${extras.height})`;
  const chunk = (delta: Json, finish: string | null): Json => ({
    id,
    object: "chat.completion.chunk",
    created: CREATED_AT,
    model,
    system_fingerprint: SYSTEM_FINGERPRINT,
    choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }],
  });

  if (decoded.request.stream) {
    const frames: SseFrame[] = [{ data: chunk({ role: "assistant", content: "" }, null) }];
    if (text) frames.push({ data: chunk({ content: text }, null), content: text });
    for (const image of images) frames.push({ data: chunk({ images: [image] }, null), content: summary });
    frames.push({ data: chunk({}, "stop") });
    if (extras.includeUsage) {
      frames.push({
        data: {
          id,
          object: "chat.completion.chunk",
          created: CREATED_AT,
          model,
          system_fingerprint: SYSTEM_FINGERPRINT,
          choices: [],
          usage,
        },
      });
    }
    frames.push({ data: "[DONE]" });
    return { kind: "sse", frames, summary };
  }
  return {
    kind: "json",
    summary,
    value: {
      id,
      object: "chat.completion",
      created: CREATED_AT,
      model,
      system_fingerprint: SYSTEM_FINGERPRINT,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: text || null, refusal: null, images },
          logprobs: null,
          finish_reason: "stop",
        },
      ],
      usage,
    },
  };
}

/** Chat Completions requests whose `modalities` include `"image"`, as AI Gateway and OpenRouter accept for image models. */
export const chatImageRoutes: MediaRoute[] = [
  {
    format: "openai-chat",
    task: "image",
    sample: { type: "image" },
    matches: (method, path) =>
      method === "POST" && (path === "/chat/completions" || path.endsWith("/chat/completions")),
    accepts: wantsImage,
    decode: decodeChatImage,
    render: renderChatImage,
    errorBody: (failure, requestId) => chatCodec.errorBody(failure, requestId),
  },
];
