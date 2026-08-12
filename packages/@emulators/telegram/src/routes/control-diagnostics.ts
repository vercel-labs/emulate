// Diagnostic control-plane helpers: fault injection + callback-answer
// inspection. Split out of control.ts so the "what to mock / what got
// answered" concern stays visible.
import type { Store } from "@emulators/core";
import { getTelegramStore } from "../store.js";

export interface InjectFaultInput {
  botId: number;
  method: string;
  error_code: number;
  description?: string;
  retry_after?: number;
  count?: number;
}

export function injectFault(store: Store, input: InjectFaultInput): { fault_id: number } {
  const ts = getTelegramStore(store);
  const row = ts.faults.insert({
    bot_id: input.botId,
    method: input.method,
    error_code: input.error_code,
    description:
      input.description ??
      (input.error_code === 429
        ? `Too Many Requests: retry after ${input.retry_after ?? 1}`
        : input.error_code === 401
          ? "Unauthorized"
          : input.error_code === 403
            ? "Forbidden"
            : input.error_code === 404
              ? "Not Found"
              : `Bad Request: injected fault ${input.error_code}`),
    retry_after: input.retry_after ?? null,
    remaining: Math.max(1, input.count ?? 1),
  });
  return { fault_id: row.id };
}

export function clearFaults(store: Store): void {
  const ts = getTelegramStore(store);
  for (const f of ts.faults.all()) ts.faults.delete(f.id);
}

export function getCallbackAnswer(
  store: Store,
  id: string,
): {
  callback_query_id: string;
  answered: boolean;
  answer_text?: string;
  answer_show_alert?: boolean;
  answer_url?: string;
  answer_cache_time?: number;
} | null {
  const ts = getTelegramStore(store);
  const row = ts.callbackQueries.findOneBy("callback_query_id", id);
  if (!row) return null;
  return {
    callback_query_id: row.callback_query_id,
    answered: row.answered,
    answer_text: row.answer_text,
    answer_show_alert: row.answer_show_alert,
    answer_url: row.answer_url,
    answer_cache_time: row.answer_cache_time,
  };
}
