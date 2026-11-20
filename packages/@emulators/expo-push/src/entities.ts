import type { Entity } from "@emulators/core";

/** Error values the Expo Push Service puts in `details.error` of a ticket or receipt. */
export const EXPO_PUSH_ERRORS = [
  "DeviceNotRegistered",
  "MessageTooBig",
  "MessageRateExceeded",
  "MismatchSenderId",
  "InvalidCredentials",
] as const;
export type ExpoPushError = (typeof EXPO_PUSH_ERRORS)[number];

export type ExpoPushTicket =
  | { status: "ok"; id: string }
  | { status: "error"; message: string; details: { error: ExpoPushError } };

export type ExpoPushReceipt =
  | { status: "ok" }
  | { status: "error"; message: string; details: { error: ExpoPushError } };

/** A recipient device. Tokens that were never registered are still accepted when well formed. */
export interface ExpoPushDevice extends Entity {
  token: string;
  /** Expo project (`@owner/slug`). Tokens from two projects cannot share one request. */
  project: string | null;
  platform: "ios" | "android" | null;
  /** When false, tickets are `ok` and the receipt reports `DeviceNotRegistered`, as the real service does. */
  registered: boolean;
}

/** One HTTP call to a data route. Failed calls are recorded too. */
export interface ExpoPushRequestRecord extends Entity {
  path: string;
  status: number;
  /** Number of recipients after expanding `to` arrays; 0 when the request was rejected. */
  recipients: number;
  /** Code of the request-level error, or null. */
  error_code: string | null;
}

/** One recipient of one message, as the service saw it. */
export interface ExpoPushMessageRecord extends Entity {
  request_id: number;
  /** Position in the expanded list of the request; matches the ticket index in the response. */
  index: number;
  token: string;
  /** The message as sent, with `to` narrowed to this one recipient. */
  message: Record<string, unknown>;
  ticket: ExpoPushTicket;
  /** Null for error tickets, which have no receipt. */
  receipt: ExpoPushReceipt | null;
}

export type ExpoPushFault =
  | { at: "ok" }
  | { at: "ticket" | "receipt"; error: ExpoPushError; message?: string }
  | { at: "request"; status?: number; code?: string; message?: string };

export interface ExpoPushMatch {
  token?: string;
  /** Substring of `title`. */
  title?: string;
  /** Substring of `body`. */
  body?: string;
  channelId?: string;
  /** Every listed key must equal the same key of `data`. */
  data?: Record<string, unknown>;
}

export interface ExpoPushRule {
  id: string;
  match: ExpoPushMatch;
  /** Apply to the first N matching recipients only. */
  times?: number;
  /** One fault, or several that cycle in a seed-shuffled order. */
  fail: ExpoPushFault | ExpoPushFault[];
}
