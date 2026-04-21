import { z } from "zod";

export const zInlineKeyboardButton = z.object({
  text: z.string(),
  callback_data: z.string().optional(),
  url: z.string().optional(),
});

export const zInlineKeyboardMarkup = z.object({
  inline_keyboard: z.array(z.array(zInlineKeyboardButton)),
});

export const zReplyKeyboardButton = z.object({
  text: z.string(),
});

export const zReplyKeyboardMarkup = z.object({
  keyboard: z.array(z.array(zReplyKeyboardButton)),
  resize_keyboard: z.boolean().optional(),
  one_time_keyboard: z.boolean().optional(),
  selective: z.boolean().optional(),
});

export const zForceReply = z.object({
  force_reply: z.literal(true),
  selective: z.boolean().optional(),
});

export const zReplyKeyboardRemove = z.object({
  remove_keyboard: z.literal(true),
  selective: z.boolean().optional(),
});

// Telegram's reply_markup has no shared discriminator tag — branches
// are distinguished by required-key presence. Ordering matters: match
// the most specific shape first.
export const zReplyMarkup = z.union([
  zInlineKeyboardMarkup,
  zReplyKeyboardMarkup,
  zForceReply,
  zReplyKeyboardRemove,
]);
