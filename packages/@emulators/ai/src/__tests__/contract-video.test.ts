import OpenAI from "openai";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@emulators/ai", async () => import("../index.js"));

interface EmulatorHandle {
  readonly url: string;
  close(): Promise<void>;
}

let emulator: EmulatorHandle;
let origin: string;
let openai: OpenAI;

beforeAll(async () => {
  const entry = new URL("../../../../emulate/src/api.ts", import.meta.url).href;
  const { createEmulator } = (await import(entry)) as {
    createEmulator(options: { service: "ai"; port: number }): Promise<EmulatorHandle>;
  };
  emulator = await createEmulator({ service: "ai", port: 0 });
  origin = new URL(emulator.url).origin;
  openai = new OpenAI({ baseURL: `${origin}/v1`, apiKey: "test", maxRetries: 0 });
});

afterAll(async () => {
  await emulator.close();
});

beforeEach(async () => {
  expect((await fetch(`${origin}/_ai/reset`, { method: "POST" })).status).toBe(200);
});

async function putRules(body: unknown): Promise<void> {
  const response = await fetch(`${origin}/_ai/rules`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
}

async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await response.json()) as Record<string, unknown>;
}

describe("video contract", () => {
  it("moves an OpenAI video through queued, in_progress, and completed one poll at a time", async () => {
    const created = await openai.videos.create({ prompt: "a cat", seconds: "8", size: "1280x720" });
    expect(created.status).toBe("queued");
    await expect(openai.videos.downloadContent(created.id)).rejects.toMatchObject({ status: 400 });
    expect((await openai.videos.retrieve(created.id)).status).toBe("in_progress");
    const done = await openai.videos.retrieve(created.id);
    expect(done).toMatchObject({ status: "completed", progress: 100 });
    const bytes = new Uint8Array(await (await openai.videos.downloadContent(created.id)).arrayBuffer());
    expect(String.fromCharCode(...bytes.subarray(4, 8))).toBe("ftyp");
    expect((await openai.videos.delete(created.id)).deleted).toBe(true);
    await expect(openai.videos.retrieve(created.id)).rejects.toMatchObject({ status: 404 });
  });

  it("fails a job after the polls a video_error rule asks for", async () => {
    await putRules({
      rules: [
        {
          id: "blocked",
          match: { task: "video" },
          reply: [{ type: "video_error", code: "moderation_blocked", message: "Blocked.", polls: 2 }],
        },
      ],
    });
    const created = await openai.videos.create({ prompt: "x" });
    const statuses = [];
    for (let read = 0; read < 3; read += 1) statuses.push((await openai.videos.retrieve(created.id)).status);
    expect(statuses).toEqual(["in_progress", "in_progress", "failed"]);
    expect((await openai.videos.retrieve(created.id)).error).toEqual({
      code: "moderation_blocked",
      message: "Blocked.",
    });
  });

  it("serves Veo long-running operations with downloadable samples", async () => {
    const started = await post("/v1beta/models/veo-3:predictLongRunning", {
      instances: [{ prompt: "waves" }],
      parameters: { sampleCount: 2, aspectRatio: "9:16" },
    });
    const name = String(started.name);
    const pending = (await (await fetch(`${origin}/v1beta/${name}`)).json()) as Record<string, unknown>;
    expect(pending.done).toBeUndefined();
    const done = (await (await fetch(`${origin}/v1beta/${name}`)).json()) as {
      done: boolean;
      response: { generateVideoResponse: { generatedSamples: Array<{ video: { uri: string } }> } };
    };
    const samples = done.response.generateVideoResponse.generatedSamples;
    expect(samples).toHaveLength(2);
    const file = await fetch(samples[1].video.uri);
    expect(file.headers.get("content-type")).toBe("video/mp4");
  });
});
