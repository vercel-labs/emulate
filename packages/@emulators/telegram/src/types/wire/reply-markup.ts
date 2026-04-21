export interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

export interface ReplyKeyboardButton {
  text: string;
}

export interface ReplyKeyboardMarkup {
  keyboard: ReplyKeyboardButton[][];
  resize_keyboard?: boolean;
  one_time_keyboard?: boolean;
  selective?: boolean;
}

export interface ForceReply {
  force_reply: true;
  selective?: boolean;
}

export interface ReplyKeyboardRemove {
  remove_keyboard: true;
  selective?: boolean;
}

export type ReplyMarkup = InlineKeyboardMarkup | ReplyKeyboardMarkup | ForceReply | ReplyKeyboardRemove;

export type WireInlineKeyboardButton = InlineKeyboardButton;
export type WireInlineKeyboardMarkup = InlineKeyboardMarkup;
export type WireReplyKeyboardButton = ReplyKeyboardButton;
export type WireReplyKeyboardMarkup = ReplyKeyboardMarkup;
export type WireForceReply = ForceReply;
export type WireReplyKeyboardRemove = ReplyKeyboardRemove;
export type WireReplyMarkup = ReplyMarkup;

export const isInlineKeyboardMarkup = (m: ReplyMarkup): m is InlineKeyboardMarkup =>
  "inline_keyboard" in m && Array.isArray((m as InlineKeyboardMarkup).inline_keyboard);

export const isReplyKeyboardMarkup = (m: ReplyMarkup): m is ReplyKeyboardMarkup =>
  "keyboard" in m && Array.isArray((m as ReplyKeyboardMarkup).keyboard);

export const isForceReply = (m: ReplyMarkup): m is ForceReply =>
  "force_reply" in m && (m as ForceReply).force_reply === true;

export const isReplyKeyboardRemove = (m: ReplyMarkup): m is ReplyKeyboardRemove =>
  "remove_keyboard" in m && (m as ReplyKeyboardRemove).remove_keyboard === true;
