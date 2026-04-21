import type { Entity } from "@emulators/core";

export interface TelegramFile extends Entity {
  file_id: string;
  file_unique_id: string;
  owner_bot_id: number | null;
  mime_type: string;
  file_size: number;
  width: number;
  height: number;
  file_path: string;
  bytes_base64: string;
  kind: "photo" | "document" | "voice" | "video" | "audio" | "sticker" | "animation";
  file_name?: string;
  duration?: number;
  is_animated?: boolean;
  is_video?: boolean;
  // For photos, the full PhotoSize[] so echoes can reuse the same tiers.
  photo_sizes_json?: string;
}
