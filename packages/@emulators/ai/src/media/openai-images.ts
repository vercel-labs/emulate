import { imageAttachment } from "../attachments.js";
import { CREATED_AT, type Decoded } from "../codec.js";
import { chatCodec } from "../codecs/openai-chat.js";
import type { SseFrame } from "../sse.js";
import type { AIRequest, FilePart, InputPart, MediaReplyEvent, RuleReplyEvent } from "../types.js";
import {
  base64Bytes,
  fail,
  fieldsOf,
  isRecord,
  optionalBoolean,
  optionalEnum,
  optionalInteger,
  optionalString,
  requiredString,
  textTokens,
  toBase64,
  uploadedPart,
  type Fields,
} from "./fields.js";
import { colorFor, IMAGE_MEDIA_TYPES, imageSize, renderImage, sniffImageType, type ImageFormat } from "./pixels.js";
import type { MediaRoute, MediaResult } from "./route.js";

type ImageEvent = Extract<MediaReplyEvent, { type: "image" }>;

const OUTPUT_FORMATS = ["png", "jpeg", "webp", "gif", "svg"] as const;
const QUALITIES = ["auto", "low", "medium", "high", "xhigh", "max", "standard", "hd"] as const;
const BACKGROUNDS = ["auto", "transparent", "opaque"] as const;
const QUALITY_TOKENS: Record<string, number> = { low: 272, medium: 1056, high: 4160 };
const MAX_SIDE = 3840;

interface ImageRequestExtras {
  operation: "generation" | "edit";
  n: number;
  width: number;
  height: number;
  size: string;
  quality: string;
  background: "transparent" | "opaque";
  outputFormat: ImageFormat;
  responseFormat: "b64_json" | "url";
  stream: boolean;
  partialImages: number;
  prompt: string;
  seed: string;
}

/** Parses `WxH`, enforcing the gpt-image rules: sides divisible by 16, at most 3840, and an aspect ratio within 3:1. */
function parseSize(value: string): { width: number; height: number } {
  const match = /^(\d+)x(\d+)$/.exec(value);
  const width = match ? Number(match[1]) : 0;
  const height = match ? Number(match[2]) : 0;
  if (
    !match ||
    width < 16 ||
    height < 16 ||
    width % 16 !== 0 ||
    height % 16 !== 0 ||
    Math.max(width, height) > MAX_SIDE ||
    Math.max(width, height) > 3 * Math.min(width, height)
  ) {
    fail(
      `Invalid size '${value}'. Use 'auto' or WIDTHxHEIGHT with both sides divisible by 16, each at most ${MAX_SIDE}, and an aspect ratio between 1:3 and 3:1.`,
      "size",
    );
  }
  return { width, height };
}

/** Sizes an xAI-style aspect ratio, rendering `auto` as square, with its long side at 1024 pixels, or 2048 for the `2k` resolution. */
function aspectSize(ratio: string, resolution: string | undefined): { width: number; height: number } {
  const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(ratio === "auto" ? "1:1" : ratio);
  const w = Number(match?.[1]);
  const h = Number(match?.[2]);
  if (!(w > 0 && h > 0 && Number.isFinite(w) && Number.isFinite(h)))
    fail(`Invalid aspect_ratio '${ratio}'.`, "aspect_ratio");
  const long = resolution === "2k" ? 2048 : 1024;
  const top = Math.max(w, h);
  const round = (side: number) => Math.max(16, Math.round((long * (side / top)) / 16) * 16);
  return { width: round(w), height: round(h) };
}

/** Reads one JSON image reference: an OpenAI `{ file_id }` or `{ image_url }` object, or an xAI `{ url }` object. */
function imageReference(entry: unknown, param: string): FilePart {
  if (!isRecord(entry)) fail(`Invalid type for '${param}': expected an object.`, param, "invalid_type");
  if (typeof entry.file_id === "string" && entry.file_id !== "") {
    return { type: "file", mediaType: "image/*", source: "file_id", ref: entry.file_id };
  }
  const url = entry.image_url ?? entry.url;
  return imageAttachment(url, `${param}.${entry.image_url === undefined ? "url" : "image_url"}`);
}

/** The attachments an edit request names: multipart uploads, OpenAI `images` references, or xAI `image`/`images` objects, then the mask. */
function editInputs(fields: Fields): FilePart[] {
  const uploads = [...(fields.files.get("image") ?? [])].map((file) =>
    uploadedPart(file, file.type || sniffImageType(file.bytes)),
  );
  const raw = fields.values.images ?? (fields.values.image === undefined ? undefined : [fields.values.image]);
  if (raw !== undefined && !Array.isArray(raw))
    fail("Invalid type for 'images': expected an array.", "images", "invalid_type");
  const references = (raw ?? []).map((entry, index) => imageReference(entry, `images[${index}]`));
  const inputs = [...uploads, ...references];
  if (inputs.length === 0) fail("Missing required parameter: 'image'.", "image", "missing_required_parameter");
  if (inputs.length > 16) fail("Invalid 'image': at most 16 images may be provided.", "image");
  const mask = fields.files.get("mask")?.[0];
  if (mask) inputs.push({ ...uploadedPart(mask, mask.type || sniffImageType(mask.bytes)), name: mask.name || "mask" });
  else if (fields.values.mask !== undefined)
    inputs.push({ ...imageReference(fields.values.mask, "mask"), name: "mask" });
  return inputs;
}

function decodeImages(operation: "generation" | "edit", fields: Fields): Decoded {
  const prompt = requiredString(fields, "prompt", 32000);
  const model = optionalString(fields, "model") ?? "gpt-image-2";
  const n = optionalInteger(fields, "n", 1, 10) ?? 1;
  const quality = optionalEnum(fields, "quality", QUALITIES) ?? "auto";
  const background = optionalEnum(fields, "background", BACKGROUNDS) ?? "auto";
  const outputFormat = optionalEnum(fields, "output_format", OUTPUT_FORMATS) ?? "png";
  optionalInteger(fields, "output_compression", 0, 100);
  const responseFormat = optionalEnum(fields, "response_format", ["b64_json", "url"] as const) ?? "b64_json";
  const stream = optionalBoolean(fields, "stream") ?? false;
  const partialImages = optionalInteger(fields, "partial_images", 0, 3) ?? 0;
  if (background === "transparent" && (outputFormat === "jpeg" || outputFormat === "svg")) {
    fail(`Transparent backgrounds require output_format 'png', 'webp', or 'gif', not '${outputFormat}'.`, "background");
  }
  const requestedSize = optionalString(fields, "size") ?? "auto";
  const { width, height } =
    requestedSize !== "auto"
      ? parseSize(requestedSize)
      : aspectSize(optionalString(fields, "aspect_ratio") ?? "auto", optionalString(fields, "resolution"));

  const files = operation === "edit" ? editInputs(fields) : [];
  const parts: InputPart[] = [{ type: "text", text: prompt }, ...files];
  const request: AIRequest = {
    format: "openai-images",
    task: "image",
    model,
    messages: [{ role: "user", parts }],
    tools: [],
    toolChoice: "auto",
    parallelToolCalls: false,
    stream,
    reasoning: false,
    store: false,
    references: [],
    warnings: [],
  };
  const extras: ImageRequestExtras = {
    operation,
    n,
    width,
    height,
    size: `${width}x${height}`,
    quality: quality === "auto" || quality === "hd" ? "high" : quality === "standard" ? "medium" : quality,
    background: background === "transparent" ? "transparent" : "opaque",
    outputFormat,
    responseFormat,
    stream,
    partialImages,
    prompt,
    seed: [prompt, ...files.map((file) => file.sha256 ?? file.ref ?? "")].join("|"),
  };
  return { request, extras: extras as unknown as Record<string, unknown> };
}

interface RenderedImage {
  bytes: Uint8Array;
  format: string;
  width: number;
  height: number;
  revisedPrompt?: string;
}

/** Picks the image for slot `index`, cycling through the rule's image events, or renders a solid image when there is no rule. */
function imageAt(events: ImageEvent[] | undefined, index: number, extras: ImageRequestExtras): RenderedImage {
  const event = events && events.length > 0 ? events[index % events.length] : undefined;
  if (event?.data !== undefined) {
    const bytes = base64Bytes(event.data);
    const sniffed = sniffImageType(bytes);
    const format = (Object.keys(IMAGE_MEDIA_TYPES) as ImageFormat[]).find((key) => IMAGE_MEDIA_TYPES[key] === sniffed);
    const size = imageSize(bytes) ?? { width: extras.width, height: extras.height };
    return {
      bytes,
      format: format ?? extras.outputFormat,
      ...size,
      ...(event.revisedPrompt ? { revisedPrompt: event.revisedPrompt } : {}),
    };
  }
  const color = colorFor(`${extras.seed}#${index}`);
  if (extras.background === "transparent") color.a = 128;
  return {
    bytes: renderImage(extras.outputFormat, extras.width, extras.height, color),
    format: extras.outputFormat,
    width: extras.width,
    height: extras.height,
    ...(event?.revisedPrompt ? { revisedPrompt: event.revisedPrompt } : {}),
  };
}

function usageOf(extras: ImageRequestExtras, images: RenderedImage[], inputImages: number) {
  const perPixel = (QUALITY_TOKENS[extras.quality] ?? QUALITY_TOKENS.high) / (1024 * 1024);
  const textTokensIn = textTokens(extras.prompt);
  const imageTokensIn = inputImages * QUALITY_TOKENS.low;
  const output = images.reduce((sum, image) => sum + Math.ceil(image.width * image.height * perPixel), 0);
  return {
    input_tokens: textTokensIn + imageTokensIn,
    input_tokens_details: { image_tokens: imageTokensIn, text_tokens: textTokensIn },
    output_tokens: output,
    output_tokens_details: { image_tokens: output, text_tokens: 0 },
    total_tokens: textTokensIn + imageTokensIn + output,
  };
}

function renderImages(events: RuleReplyEvent[] | undefined, decoded: Decoded): MediaResult {
  const extras = decoded.extras as unknown as ImageRequestExtras;
  const imageEvents = events?.filter((event): event is ImageEvent => event.type === "image");
  const images = Array.from({ length: extras.n }, (_, index) => imageAt(imageEvents, index, extras));
  const inputImages = decoded.request.messages[0].parts.filter((part) => part.type === "file").length;
  const usage = usageOf(extras, images, inputImages);
  const meta = {
    background: extras.background,
    output_format: images[0]?.format ?? extras.outputFormat,
    quality: extras.quality,
    size: images[0] ? sizeOf(images[0]) : extras.size,
  };

  if (extras.stream) {
    const prefix = extras.operation === "edit" ? "image_edit" : "image_generation";
    const frames: SseFrame[] = [];
    images.forEach((image, index) => {
      const b64 = toBase64(image.bytes);
      for (let partial = 0; partial < extras.partialImages; partial += 1) {
        const type = `${prefix}.partial_image`;
        frames.push({
          event: type,
          data: {
            type,
            b64_json: b64,
            created_at: CREATED_AT,
            partial_image_index: partial,
            ...meta,
            output_format: image.format,
            size: sizeOf(image),
          },
          content: b64,
        });
      }
      const type = `${prefix}.completed`;
      frames.push({
        event: type,
        data: {
          type,
          b64_json: b64,
          created_at: CREATED_AT,
          ...meta,
          output_format: image.format,
          size: sizeOf(image),
          usage: index === images.length - 1 ? usage : usageOf(extras, [image], 0),
        },
        content: b64,
      });
    });
    return { kind: "sse", frames, summary: summaryOf(images) };
  }

  return {
    kind: "json",
    summary: summaryOf(images),
    value: {
      created: CREATED_AT,
      ...meta,
      data: images.map((image) => {
        const b64 = toBase64(image.bytes);
        const mediaType = IMAGE_MEDIA_TYPES[image.format as ImageFormat] ?? "image/png";
        return {
          ...(extras.responseFormat === "url" ? { url: `data:${mediaType};base64,${b64}` } : { b64_json: b64 }),
          ...(image.revisedPrompt ? { revised_prompt: image.revisedPrompt } : {}),
        };
      }),
      usage,
    },
  };
}

function sizeOf(image: RenderedImage): string {
  return `${image.width}x${image.height}`;
}

function summaryOf(images: RenderedImage[]): string {
  const formats = [...new Set(images.map((image) => image.format))].join(", ");
  const sizes = [...new Set(images.map(sizeOf))].join(", ");
  return `${images.length} ${images.length === 1 ? "image" : "images"} (${formats}, ${sizes})`;
}

function imagesRoute(suffix: string, operation: "generation" | "edit"): MediaRoute {
  return {
    format: "openai-images",
    task: "image",
    sample: { type: "image" },
    matches: (method, path) => method === "POST" && (path === suffix || path.endsWith(suffix)),
    decode: (body) => decodeImages(operation, fieldsOf(body)),
    render: (events, decoded) => renderImages(events, decoded),
    errorBody: (failure, requestId) => chatCodec.errorBody(failure, requestId),
  };
}

/** OpenAI Images API routes; xAI's OpenAI-compatible image endpoints share them. */
export const imageRoutes: MediaRoute[] = [
  imagesRoute("/images/generations", "generation"),
  imagesRoute("/images/edits", "edit"),
];
