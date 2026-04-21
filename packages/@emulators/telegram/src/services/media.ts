import type { Store } from "@emulators/core";
import { getTelegramStore } from "../store.js";
import { nextFileId } from "../ids.js";
import type {
  PhotoSize,
  TelegramAnimation,
  TelegramAudio,
  TelegramChat,
  TelegramDocument,
  TelegramSticker,
  TelegramVideo,
  TelegramVoice,
} from "../entities.js";

export type MediaKind = "video" | "animation" | "audio" | "voice" | "sticker" | "document";

export interface MediaFieldInput {
  kind: MediaKind | string;
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  width?: number;
  height?: number;
  duration?: number;
  mime_type?: string;
  file_name?: string;
  performer?: string;
  title?: string;
  emoji?: string;
  is_animated?: boolean;
  is_video?: boolean;
}

// Discriminated union across every kind buildMediaField can emit.
// Each branch is the canonical Bot API wire shape for that field —
// no `kind` tag (the key of TelegramMessage that holds it acts as
// the discriminator in the store row).
export type WireMediaField =
  | TelegramVideo
  | TelegramAnimation
  | TelegramAudio
  | TelegramVoice
  | TelegramSticker
  | TelegramDocument;

/** Build the media field object (video/animation/audio/voice/sticker/document)
 *  that lives on a Message, normalised so both the Bot API surface and
 *  the control-plane simulate routes emit identical shapes. */
export function buildMediaField(input: MediaFieldInput): WireMediaField {
  const base = {
    file_id: input.file_id,
    file_unique_id: input.file_unique_id,
    file_size: input.file_size,
  };
  switch (input.kind) {
    case "video":
    case "animation":
      return {
        ...base,
        width: input.width ?? 0,
        height: input.height ?? 0,
        duration: input.duration ?? 0,
        mime_type: input.mime_type,
        file_name: input.file_name,
      };
    case "audio":
      return {
        ...base,
        duration: input.duration ?? 0,
        performer: input.performer,
        title: input.title,
        mime_type: input.mime_type,
        file_name: input.file_name,
      };
    case "voice":
      return {
        ...base,
        duration: input.duration ?? 0,
        mime_type: input.mime_type,
      };
    case "sticker":
      return {
        ...base,
        width: input.width ?? 0,
        height: input.height ?? 0,
        is_animated: input.is_animated ?? false,
        is_video: input.is_video ?? false,
        emoji: input.emoji,
      };
    case "document":
    default:
      return {
        ...base,
        file_name: input.file_name,
        mime_type: input.mime_type,
      };
  }
}

/** Allocate the next message_id for a chat and advance the per-chat counter.
 *  Consolidates the read-modify-write that was duplicated at 8+ call sites. */
export function allocateMessageId(store: Store, chat: TelegramChat): number {
  const ts = getTelegramStore(store);
  const messageId = chat.next_message_id;
  ts.chats.update(chat.id, { next_message_id: messageId + 1 });
  return messageId;
}

export function buildPhotoSizes(
  store: Store,
  bytes: Buffer,
  botId: number,
  chatId: number,
): { sizes: PhotoSize[]; originalFileId: string; originalUniqueId: string } {
  const { width, height } = readImageDimensions(bytes);
  const tiers: Array<{ tier: string; w: number; h: number }> = [
    { tier: "s", w: Math.min(width, 160), h: Math.max(1, Math.round((Math.min(width, 160) / width) * height)) },
    { tier: "m", w: Math.min(width, 800), h: Math.max(1, Math.round((Math.min(width, 800) / width) * height)) },
    { tier: "x", w: width, h: height },
  ];
  const sizes: PhotoSize[] = [];
  let originalFileId = "";
  let originalUniqueId = "";
  for (const t of tiers) {
    const { file_id, file_unique_id } = nextFileId(store, botId, chatId, t.tier);
    sizes.push({
      file_id,
      file_unique_id,
      width: t.w,
      height: t.h,
      file_size: bytes.length,
    });
    if (t.tier === "x") {
      originalFileId = file_id;
      originalUniqueId = file_unique_id;
    }
  }
  return { sizes, originalFileId, originalUniqueId };
}

export function readImageDimensions(bytes: Buffer): { width: number; height: number } {
  // PNG: width at offset 16 (BE uint32), height at 20
  if (
    bytes.length >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  // JPEG: walk markers
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i < bytes.length) {
      if (bytes[i] !== 0xff) {
        i += 1;
        continue;
      }
      const marker = bytes[i + 1];
      if (
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      ) {
        const height = bytes.readUInt16BE(i + 5);
        const width = bytes.readUInt16BE(i + 7);
        return { width, height };
      }
      const segLen = bytes.readUInt16BE(i + 2);
      i += 2 + segLen;
    }
  }
  // GIF
  if (
    bytes.length >= 10 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46
  ) {
    return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  }
  // WebP (VP8/VP8L/VP8X)
  if (
    bytes.length >= 30 &&
    bytes.slice(0, 4).toString("ascii") === "RIFF" &&
    bytes.slice(8, 12).toString("ascii") === "WEBP"
  ) {
    const chunk = bytes.slice(12, 16).toString("ascii");
    if (chunk === "VP8X") {
      const w = (bytes.readUIntLE(24, 3) + 1) & 0xffffff;
      const h = (bytes.readUIntLE(27, 3) + 1) & 0xffffff;
      return { width: w, height: h };
    }
    if (chunk === "VP8 ") {
      return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
    }
    if (chunk === "VP8L") {
      const b = bytes.slice(21, 25);
      const w = ((b[0] | ((b[1] & 0x3f) << 8)) + 1) & 0xffff;
      const h = ((((b[1] & 0xc0) >> 6) | (b[2] << 2) | ((b[3] & 0x0f) << 10)) + 1) & 0xffff;
      return { width: w, height: h };
    }
  }
  // Fallback for unknown formats (tests often pass tiny bytes)
  return { width: 100, height: 100 };
}

export function defaultMimeForMediaKind(kind: string): string {
  switch (kind) {
    case "video":
      return "video/mp4";
    case "audio":
      return "audio/mpeg";
    case "voice":
      return "audio/ogg";
    case "animation":
      return "video/mp4";
    case "sticker":
      return "image/webp";
    case "document":
      return "application/octet-stream";
    default:
      return "application/octet-stream";
  }
}
