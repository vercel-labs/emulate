import { createHash } from "node:crypto";
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

  it("records Gemini media parts, instruction images, and true inline sizes", async () => {
    await post("/v1beta/decisions", {
      model: "gemini-decision-1",
      input: [
        { type: "document", data: Buffer.from("%PDF-1.7").toString("base64"), mime_type: "application/pdf" },
        { type: "video", uri: "https://bucket.example/v.mp4?sig=SECRET4" },
      ],
      questions: { a: { type: "noul", instructions: "Is it?" } },
    });
    await post("/v1/decisions", {
      model: "gpt-6-luna",
      input: [{ role: "user", content: [{ type: "input_audio", input_audio: { data: "QUJDRA==", format: "wav" } }] }],
      questions: [
        {
          type: "predicate",
          instructions: [
            { type: "input_text", text: "Is it?" },
            { type: "input_image", image_url: "https://bucket.example/q.png?sig=SECRET5" },
          ],
        },
      ],
    });
    const calls = (await (await fetch(`${origin}/_ai/calls`)).json()) as Array<{
      messages: Array<{ parts: Array<Record<string, unknown>> }>;
    }>;
    const [gemini, openaiCall] = calls
      .slice(-2)
      .map((call) => call.messages[0].parts.filter((part) => part.type === "file"));
    expect(gemini).toEqual([
      expect.objectContaining({ mediaType: "application/pdf", source: "inline", bytes: 8 }),
      expect.objectContaining({ mediaType: "video/*", source: "url", ref: "https://bucket.example/v.mp4" }),
    ]);
    expect(openaiCall).toEqual([
      expect.objectContaining({
        mediaType: "audio/wav",
        bytes: 4,
        sha256: createHash("sha256").update("ABCD").digest("hex"),
      }),
      expect.objectContaining({ source: "url", ref: "https://bucket.example/q.png" }),
    ]);
    expect(JSON.stringify(calls)).not.toMatch(/SECRET4|SECRET5|JVBERi0xLjc/);
  });

  it("reads zstd-compressed multipart TypeSafe requests", async () => {
    const form = new FormData();
    form.set("request", JSON.stringify({ model: "jev-latest", state: "x", questions: { a: { type: "noul" } } }));
    form.set("dog", new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" }), "dog.png");
    const encoded = new Response(form);
    const response = await fetch(`${origin}/v1/systemone`, {
      method: "POST",
      headers: { "content-type": encoded.headers.get("content-type") ?? "", "content-encoding": "zstd" },
      body: zstdCompressSync(Buffer.from(await encoded.arrayBuffer())),
    });
    expect(response.status).toBe(200);
  });

  it("records images sent in the assets map", async () => {
    const form = new FormData();
    form.set(
      "request",
      JSON.stringify({
        model: "jev-latest",
        state: { photo: "photo" },
        questions: { a: { type: "noul", instructions: "Is it a dog?" } },
        assets: { photo: { type: "image", part: "asset-0" } },
      }),
    );
    form.set("asset-0", new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" }), "asset-0");
    expect((await fetch(`${origin}/v1/systemone`, { method: "POST", body: form })).status).toBe(200);
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString("base64");
    await post("/api/alpha/decisions", {
      model: "typesafe/jev-latest",
      state: "photo",
      questions: { a: { type: "noul", instructions: "Is it a dog?" } },
      assets: { photo: { type: "image", format: "jpg", data_base64: jpeg } },
    });
    const calls = (await (await fetch(`${origin}/_ai/calls`)).json()) as Array<{
      messages: Array<{ parts: Array<Record<string, unknown>> }>;
    }>;
    const files = calls.slice(-2).map((call) => call.messages[0].parts.filter((part) => part.type === "file"));
    expect(files).toEqual([
      [expect.objectContaining({ mediaType: "image/png", source: "inline", bytes: 4 })],
      [expect.objectContaining({ mediaType: "image/jpeg", source: "inline", bytes: 4 })],
    ]);
  });

  it("records an uploaded asset once however many aliases name it", async () => {
    const form = new FormData();
    const assets = Object.fromEntries(
      Array.from({ length: 50 }, (_, i) => [`alias${i}`, { type: "image", part: "asset-0" }]),
    );
    form.set(
      "request",
      JSON.stringify({ model: "jev-latest", state: "x", questions: { a: { type: "noul" } }, assets }),
    );
    form.set("asset-0", new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" }), "asset-0");
    expect((await fetch(`${origin}/v1/systemone`, { method: "POST", body: form })).status).toBe(200);
    const calls = (await (await fetch(`${origin}/_ai/calls`)).json()) as Array<{
      messages: Array<{ parts: Array<Record<string, unknown>> }>;
    }>;
    expect(calls[calls.length - 1].messages[0].parts.filter((part) => part.type === "file")).toHaveLength(1);
  });

  it("rejects scripted score probabilities that do not sum to one", async () => {
    await fetch(`${origin}/_ai/rules`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        rules: [{ id: "sum", match: { task: "decision" }, reply: [{ type: "decision", answers: { s: [1, 1, 1] } }] }],
      }),
    });
    const result = await post("/v1/systemone", {
      model: "jev",
      state: "x",
      questions: { s: { type: "score", criteria: ["low", "mid", "high"] } },
    });
    expect(result.status).toBe(500);
    expect(result.body.detail).toContain("probabilities that sum to 1");
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
