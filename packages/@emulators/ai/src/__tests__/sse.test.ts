import { afterEach, describe, expect, it, vi } from "vitest";
import { sseResponse, type SseFrame } from "../sse.js";

const decoder = new TextDecoder();

async function readFrame(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const { value, done } = await reader.read();
  if (done) throw new Error("stream ended without a frame");
  return decoder.decode(value);
}

function readerOf(response: Response): ReadableStreamDefaultReader<Uint8Array> {
  return (response.body as ReadableStream<Uint8Array>).getReader();
}

function collect(response: Response): { frames: string[]; loop: Promise<void> } {
  const reader = readerOf(response);
  const frames: string[] = [];
  const loop = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      frames.push(decoder.decode(value));
    }
  })();
  loop.catch(() => undefined);
  return { frames, loop };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("sseResponse framing", () => {
  it("writes frames in order with the event and data lines it documents", async () => {
    const response = sseResponse([{ event: "message", data: { a: 1 } }, { data: { b: 2 } }, { data: "[DONE]" }]);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(response.headers.get("x-accel-buffering")).toBe("no");

    const { frames, loop } = collect(response);
    await loop;

    expect(frames).toEqual(['event: message\ndata: {"a":1}\n\n', 'data: {"b":2}\n\n', "data: [DONE]\n\n"]);
  });

  it("closes the stream and reports completion once every frame is written", async () => {
    const settled: string[] = [];
    const response = sseResponse([{ data: { a: 1 } }, { data: { b: 2 } }], {
      onSettled: (delivery) => settled.push(delivery),
    });

    const { frames, loop } = collect(response);
    await loop;

    expect(frames).toHaveLength(2);
    expect(settled).toEqual(["completed"]);
  });
});

describe("sseResponse pacing", () => {
  it("waits ttftMs before the first frame", async () => {
    vi.useFakeTimers();
    const response = sseResponse([{ data: { n: 1 } }], { timing: { ttftMs: 50, chunkDelayMs: 0 } });
    const { frames, loop } = collect(response);

    await vi.advanceTimersByTimeAsync(49);
    expect(frames).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(frames).toEqual(['data: {"n":1}\n\n']);

    await loop;
  });

  it("spaces following frames by a delay list and repeats its last entry", async () => {
    vi.useFakeTimers();
    const response = sseResponse(
      [1, 2, 3, 4].map((n) => ({ data: { n } })),
      { timing: { ttftMs: 0, chunkDelayMs: [10, 20] } },
    );
    const { frames, loop } = collect(response);

    await vi.advanceTimersByTimeAsync(0);
    expect(frames).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(9);
    expect(frames).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(frames).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(19);
    expect(frames).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(1);
    expect(frames).toHaveLength(3);

    await vi.advanceTimersByTimeAsync(19);
    expect(frames).toHaveLength(3);

    await vi.advanceTimersByTimeAsync(1);
    expect(frames).toHaveLength(4);

    await loop;
    expect(frames).toEqual(['data: {"n":1}\n\n', 'data: {"n":2}\n\n', 'data: {"n":3}\n\n', 'data: {"n":4}\n\n']);
  });
});

describe("sseResponse cancellation", () => {
  it("writes nothing when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const settled: string[] = [];
    const response = sseResponse([{ data: { n: 1 } }], {
      signal: controller.signal,
      onSettled: (delivery) => settled.push(delivery),
    });

    const { frames, loop } = collect(response);
    await loop;

    expect(frames).toEqual([]);
    expect(settled).toEqual(["client_aborted"]);
  });

  it("stops after the frame in flight when the client aborts", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const settled: string[] = [];
    const response = sseResponse(
      [1, 2, 3].map((n) => ({ data: { n } })),
      {
        signal: controller.signal,
        timing: { ttftMs: 0, chunkDelayMs: 100 },
        onSettled: (delivery) => settled.push(delivery),
      },
    );
    const { frames, loop } = collect(response);

    await vi.advanceTimersByTimeAsync(0);
    expect(frames).toHaveLength(1);

    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    await loop;

    expect(frames).toHaveLength(1);
    expect(settled).toEqual(["client_aborted"]);
  });
});

describe("sseResponse faults", () => {
  const frames: SseFrame[] = [
    { data: { delta: "role" } },
    { data: { delta: "a" }, content: "a" },
    { data: { delta: "b" }, content: "b" },
    { data: "[DONE]" },
  ];

  it("disconnects after the configured number of content chunks", async () => {
    const faults: string[] = [];
    const settled: string[] = [];
    const response = sseResponse(frames, {
      fault: { afterChunks: 1, kind: "disconnect" },
      onFault: (kind) => faults.push(kind),
      onSettled: (delivery) => settled.push(delivery),
    });
    const reader = readerOf(response);

    expect(await readFrame(reader)).toBe('data: {"delta":"role"}\n\n');
    expect(await readFrame(reader)).toBe('data: {"delta":"a"}\n\n');
    await expect(reader.read()).rejects.toThrow("Stream disconnected");

    expect(faults).toEqual(["disconnect"]);
    expect(settled).toEqual(["error"]);
  });

  it("stalls after the configured number of content chunks and then continues", async () => {
    vi.useFakeTimers();
    const faults: string[] = [];
    const settled: string[] = [];
    const response = sseResponse(frames, {
      fault: { afterChunks: 1, kind: "stall", stallMs: 300 },
      timing: { ttftMs: 0, chunkDelayMs: 0 },
      onFault: (kind) => faults.push(kind),
      onSettled: (delivery) => settled.push(delivery),
    });
    const reader = readerOf(response);

    expect(await readFrame(reader)).toBe('data: {"delta":"role"}\n\n');
    expect(await readFrame(reader)).toBe('data: {"delta":"a"}\n\n');

    let arrived = false;
    const pending = readFrame(reader).then((frame) => {
      arrived = true;
      return frame;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(faults).toEqual(["stall"]);
    await vi.advanceTimersByTimeAsync(299);
    expect(arrived).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toBe('data: {"delta":"b"}\n\n');
    expect(await readFrame(reader)).toBe("data: [DONE]\n\n");
    expect((await reader.read()).done).toBe(true);

    expect(settled).toEqual(["completed"]);
  });

  it("ends the stream when the client aborts during a stall", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const settled: string[] = [];
    const response = sseResponse(frames, {
      signal: controller.signal,
      fault: { afterChunks: 1, kind: "stall", stallMs: 300 },
      timing: { ttftMs: 0, chunkDelayMs: 0 },
      onSettled: (delivery) => settled.push(delivery),
    });
    const { frames: written, loop } = collect(response);

    await vi.advanceTimersByTimeAsync(0);
    expect(written).toHaveLength(2);

    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    await loop;

    expect(written).toHaveLength(2);
    expect(settled).toEqual(["client_aborted"]);
  });
});
