import type { Delivery, StreamFault, Timing } from "./types.js";

/** One server-sent event; `content` marks a frame that carries generated content for pacing and fault accounting. */
export interface SseFrame {
  event?: string;
  data: unknown;
  content?: string;
}

export interface SseOptions {
  signal?: AbortSignal;
  timing?: Timing;
  fault?: StreamFault;
  onFault?: (kind: "disconnect" | "stall") => void;
  onSettled?: (delivery: Exclude<Delivery, "pending">) => void;
}

function delay(ms: number, signal: AbortSignal): Promise<boolean> {
  if (ms <= 0 || signal.aborted) return Promise.resolve(!signal.aborted);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function formatFrame(frame: SseFrame): string {
  const lines: string[] = [];
  if (frame.event) lines.push(`event: ${frame.event}`);
  const data = typeof frame.data === "string" ? frame.data : JSON.stringify(frame.data);
  lines.push(`data: ${data}`);
  return `${lines.join("\n")}\n\n`;
}

/** Resolves the wait before a frame: `ttftMs` for the first, then `chunkDelayMs` by frame, repeating the last entry. */
function frameDelay(timing: Timing, index: number): number {
  if (index === 0) return timing.ttftMs;
  const delayMs = timing.chunkDelayMs;
  if (typeof delayMs === "number") return delayMs;
  if (delayMs.length === 0) return 0;
  return delayMs[Math.min(index - 1, delayMs.length - 1)];
}

/** Writes frames as a pull-based server-sent event response, paced by `timing` and stopped by `signal`. */
export function sseResponse(frames: SseFrame[], options: SseOptions = {}): Response {
  const encoder = new TextEncoder();
  const timing = options.timing ?? { ttftMs: 0, chunkDelayMs: 0 };
  const stop = new AbortController();
  let index = 0;
  let contentChunks = 0;
  let faultApplied = false;
  let closed = false;
  let settled = false;

  const settle = (delivery: Exclude<Delivery, "pending">) => {
    if (settled) return;
    settled = true;
    options.signal?.removeEventListener("abort", onAbort);
    options.onSettled?.(delivery);
  };

  const onAbort = () => {
    stop.abort();
    settle("client_aborted");
  };

  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener("abort", onAbort, { once: true });

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      /** Ends the stream once. Only a completed reply closes cleanly; an abort or a failure errors the stream, so a cut reply never looks finished. */
      const finish = (delivery: Exclude<Delivery, "pending">, error?: unknown) => {
        settle(delivery);
        if (closed) return;
        closed = true;
        if (delivery === "completed") controller.close();
        else controller.error(error ?? new Error("Stream aborted"));
      };

      try {
        if (closed) return;
        if (stop.signal.aborted) {
          finish("client_aborted");
          return;
        }

        const fault = options.fault;
        if (fault && !faultApplied && contentChunks >= fault.afterChunks) {
          faultApplied = true;
          options.onFault?.(fault.kind);
          if (fault.kind === "disconnect") {
            await new Promise((resolve) => setTimeout(resolve, 0));
            finish("error", new Error("Stream disconnected"));
            return;
          }

          const ready = await delay(fault.stallMs ?? 0, stop.signal);
          if (closed) return;
          if (!ready) {
            finish("client_aborted");
            return;
          }
        }

        const wait = frameDelay(timing, index);
        if (wait > 0) {
          const ready = await delay(wait, stop.signal);
          if (closed) return;
          if (!ready) {
            finish("client_aborted");
            return;
          }
        }

        const frame = frames[index];
        index += 1;
        if (!frame) {
          finish("completed");
          return;
        }

        controller.enqueue(encoder.encode(formatFrame(frame)));
        if (frame.content !== undefined) contentChunks += 1;
        if (index === frames.length) finish("completed");
      } catch (error) {
        finish("error", error);
      }
    },
    cancel() {
      closed = true;
      stop.abort();
      settle("client_aborted");
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
