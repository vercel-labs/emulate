import { z } from "zod";

// Bot API `chat_id` accepts either a numeric id or a digit-string; some
// SDKs also pass @username but the emulator currently rejects those.
// Coerce digit-strings to number so downstream handlers see one type.
export const zChatId = z.union([
  z.number().int(),
  z
    .string()
    .regex(/^-?\d+$/, "chat_id must be an integer")
    .transform((s) => Number(s)),
]);

export type ChatIdInput = z.infer<typeof zChatId>;

export const zMessageId = z.number().int().positive();

// Multipart upload scalar placed in a body field by parseTelegramBody's
// form-data branch. The __file brand disambiguates from string file_ids.
export const zMultipartFile = z.object({
  __file: z.literal(true),
  name: z.string(),
  type: z.string(),
  // parseTelegramBody puts a Node Buffer here. Buffer extends Uint8Array
  // at runtime; typing it as Uint8Array keeps validators portable.
  bytes: z.custom<Buffer>((v) => v instanceof Uint8Array, "expected Buffer"),
});

export type MultipartFileRef = z.infer<typeof zMultipartFile>;
