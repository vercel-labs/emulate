import type { Store } from "@emulators/core";
import type { SlackJsonObject, SlackView, SlackViewType } from "./entities.js";
import { generateSlackId, generateTs } from "./helpers.js";
import { getSlackStore } from "./store.js";

export interface ParsedViewPayload {
  type: SlackViewType;
  blocks: SlackJsonObject[];
  private_metadata: string;
  callback_id: string;
  external_id: string;
  title: SlackJsonObject | null;
  submit: SlackJsonObject | null;
  close: SlackJsonObject | null;
  state: SlackJsonObject;
  clear_on_close: boolean;
  notify_on_close: boolean;
}

export const MAX_MODAL_STACK_DEPTH = 3;

export function createSlackViewTrigger(
  store: Store,
  options: {
    team_id: string;
    user_id: string;
    app_id: string;
    view_id?: string;
  },
) {
  const ttl = store.getData<number>("slack.view_trigger_ttl_seconds") ?? 3;
  return getSlackStore(store).viewTriggers.insert({
    ...options,
    trigger_id: `${Math.floor(Date.now() / 1000)}.${Math.floor(Math.random() * 1_000_000)
      .toString()
      .padStart(6, "0")}.${generateSlackId("trg").toLowerCase()}`,
    expires_at: Date.now() / 1000 + ttl,
    used: false,
  });
}

export function createSlackView(
  store: Store,
  parsed: ParsedViewPayload,
  options: {
    team_id: string;
    user_id: string;
    app_id: string;
    bot_id: string;
    root_view_id?: string;
    previous_view_id?: string;
  },
): SlackView {
  const viewId = generateSlackId("V");
  const now = Math.floor(Date.now() / 1000);
  return getSlackStore(store).views.insert({
    ...parsed,
    ...options,
    view_id: viewId,
    hash: generateTs(),
    root_view_id: options.root_view_id ?? viewId,
    created: now,
    updated: now,
  });
}

export function parseViewPayload(
  value: unknown,
  expectedType: SlackViewType,
  fallbackType?: SlackViewType,
): { view?: ParsedViewPayload; error?: string } {
  const view = parseViewObject(value);
  if (!view) return { error: "invalid_view" };

  const type = typeof view.type === "string" ? view.type : fallbackType;
  if (type !== expectedType) return { error: "invalid_view" };

  const blocks = view.blocks;
  if (!Array.isArray(blocks) || !blocks.every(isSlackJsonObject)) return { error: "invalid_view" };

  const title = optionalObject(view.title);
  const submit = optionalObject(view.submit);
  const close = optionalObject(view.close);
  const state = optionalObject(view.state) ?? { values: {} };
  if (title === false || submit === false || close === false || state === false) return { error: "invalid_view" };
  if (expectedType === "modal" && title === null) return { error: "invalid_view" };

  return {
    view: {
      type: expectedType,
      blocks,
      private_metadata: stringField(view.private_metadata),
      callback_id: stringField(view.callback_id),
      external_id: stringField(view.external_id),
      title,
      submit,
      close,
      state,
      clear_on_close: booleanField(view.clear_on_close, false),
      notify_on_close: booleanField(view.notify_on_close, false),
    },
  };
}

function parseViewObject(value: unknown): Record<string, unknown> | undefined {
  let parsed = value;
  if (typeof parsed === "string") {
    if (!parsed) return undefined;
    try {
      parsed = JSON.parse(parsed) as unknown;
    } catch {
      return undefined;
    }
  }
  if (!isSlackJsonObject(parsed)) return undefined;
  return parsed;
}

function optionalObject(value: unknown): SlackJsonObject | null | false {
  if (value === undefined || value === null || value === "") return null;
  return isSlackJsonObject(value) ? value : false;
}

function isSlackJsonObject(value: unknown): value is SlackJsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function booleanField(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1" || value === "true") return true;
  if (value === 0 || value === "0" || value === "false") return false;
  return fallback;
}
