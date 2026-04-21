import { z } from "zod";

export const zMessageEntityType = z.enum([
  "mention",
  "hashtag",
  "cashtag",
  "bot_command",
  "url",
  "email",
  "phone_number",
  "bold",
  "italic",
  "underline",
  "strikethrough",
  "spoiler",
  "code",
  "pre",
  "text_link",
  "text_mention",
  "custom_emoji",
  "blockquote",
  "expandable_blockquote",
]);

export const zMessageEntityUser = z.object({
  id: z.number().int(),
  is_bot: z.boolean(),
  first_name: z.string(),
  username: z.string().optional(),
});

export const zMessageEntity = z.object({
  type: zMessageEntityType,
  offset: z.number().int().nonnegative(),
  length: z.number().int().nonnegative(),
  url: z.string().optional(),
  user: zMessageEntityUser.optional(),
  language: z.string().optional(),
});
