import { zstdCompressSync } from "node:zlib";
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

async function post(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe("decision contract", () => {
  it("answers OpenAI decisions in question order with probabilities that sum to one", async () => {
    const decision = await openai.decisions.create({
      model: "gpt-6-luna",
      input: "The box arrived crushed.",
      questions: [
        { type: "predicate", name: "damaged", instructions: "Is it damaged?" },
        { type: "choice", instructions: "Route", choices: [{ value: "billing" }, { value: "shipping" }] },
      ],
    });
    const [predicate, choice] = decision.answers;
    expect(predicate).toMatchObject({ type: "predicate", name: "damaged" });
    if (choice.type !== "choice") throw new Error("expected a choice answer");
    expect(choice.name).toBeNull();
    expect(choice.probabilities.reduce((sum, entry) => sum + entry.probability, 0)).toBeCloseTo(1);
  });

  it("picks the wire format from the body on the shared decisions path", async () => {
    const gemini = await post("/v1/decisions", {
      model: "gemini-decision-1",
      input: "x",
      questions: { a: { type: "noul", instructions: "Is it?" } },
    });
    expect(gemini.body.model).toBeUndefined();
    expect((gemini.body.answers as Record<string, { confidence: number }>).a.confidence).toBeGreaterThanOrEqual(0.5);
    const perplexity = await post("/v1/decisions", {
      model: "pplx-decider-latest",
      state: "x",
      questions: { a: { type: "noul", instructions: "Is it?" } },
    });
    expect(perplexity.body.model).toBe("pplx-decider-latest");
  });

  it("scripts answers by question key and rejects invalid TypeSafe bodies with 422", async () => {
    const response = await fetch(`${origin}/_ai/rules`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        rules: [
          {
            id: "route",
            match: { task: "decision" },
            reply: [{ type: "decision", answers: { team: "billing", refund: 0.9 } }],
          },
        ],
      }),
    });
    expect(response.status).toBe(200);
    const result = await post("/v1/systemone", {
      model: "jev-latest",
      state: "double charge",
      questions: { team: { type: "choice", criteria: { billing: null, technical: null } }, refund: { type: "noul" } },
    });
    expect(result.body.answers).toMatchObject({ team: { choice: "billing", confidence: 1 }, refund: { noul: 0.9 } });
    expect((await post("/v1/systemone", { model: "jev-latest", questions: { a: { type: "noul" } } })).status).toBe(422);
  });
  it("rejects zstd bodies that decompress past the size limit with 413", async () => {
    const response = await fetch(`${origin}/v1/systemone`, {
      method: "POST",
      headers: { "content-type": "application/json", "content-encoding": "zstd" },
      body: zstdCompressSync(Buffer.alloc(80 * 1024 * 1024, 32)),
    });
    expect(response.status).toBe(413);
  });

  it("records decision image URIs without credentials or query", async () => {
    await post("/v1beta/decisions", {
      model: "gemini-decision-1",
      input: [{ type: "image", uri: "https://bucket.example/a.png?sig=secret", mime_type: "image/png" }],
      questions: { a: { type: "noul", instructions: "Is it?" } },
    });
    await post("/v1/decisions", {
      model: "gpt-6-luna",
      input: [
        {
          type: "function_call_output",
          call_id: "c1",
          output: [{ type: "input_image", image_url: "https://bucket.example/b.png?sig=secret" }],
        },
      ],
      questions: [{ type: "predicate", instructions: "Is it?" }],
    });
    const calls = await (await fetch(`${origin}/_ai/calls`)).text();
    expect(calls).toContain("https://bucket.example/a.png");
    expect(calls).not.toContain("secret");
  });

  it("records files, video, audio, and nested images as attachments, never as text", async () => {
    const audio = Buffer.from("RIFF-audio-bytes").toString("base64");
    await post("/v1/decisions", {
      model: "gpt-6-luna",
      input: [
        { role: "user", content: [{ type: "input_file", file_url: "https://bucket.example/a.pdf?sig=SECRET1" }] },
      ],
      questions: [{ type: "predicate", instructions: "i" }],
    });
    await post("/api/alpha/decisions", {
      model: "typesafe/jev-latest",
      state: [
        { type: "video_url", video_url: { url: "https://user:pass@bucket.example/v.mp4?token=SECRET2" } },
        { type: "input_audio", input_audio: { data: audio, format: "wav" } },
        { order: 7, photo: { type: "image_url", image_url: { url: "https://bucket.example/p.png?sig=SECRET3" } } },
      ],
      questions: { a: { type: "noul" } },
    });
    const calls = await (await fetch(`${origin}/_ai/calls`)).text();
    expect(calls).toContain("https://bucket.example/a.pdf");
    expect(calls).toContain("https://bucket.example/v.mp4");
    expect(calls).toContain("https://bucket.example/p.png");
    expect(calls).toContain('{\\"order\\":7}');
    for (const secret of ["SECRET1", "SECRET2", "SECRET3", "pass@", audio]) expect(calls).not.toContain(secret);
  });

  it("rejects mistyped scripted answers", async () => {
    await fetch(`${origin}/_ai/rules`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        rules: [
          { id: "typo", match: { task: "decision" }, reply: [{ type: "decision", answers: { c: { emial: 0.7 } } }] },
        ],
      }),
    });
    const result = await post("/v1/systemone", {
      model: "jev",
      state: "x",
      questions: { c: { type: "choice", criteria: { email: null, phone: null } } },
    });
    expect(result.status).toBe(500);
    expect(result.body.detail).toContain("answer for question 'c' must be probabilities");
  });

  it("accepts rich OpenRouter box instructions", async () => {
    const result = await post("/api/alpha/decisions", {
      model: "typesafe/jev-latest",
      state: [{ type: "image_url", image_url: { url: "https://bucket.example/dog.png" } }],
      questions: { dog: { type: "box", instructions: [{ type: "text", text: "The dog" }] } },
    });
    expect(result.status).toBe(200);
    expect(result.body.answers).toMatchObject({ dog: { type: "box" } });
  });
});
