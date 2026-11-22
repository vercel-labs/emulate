import { getEventListeners } from "node:events";
import { createServer } from "@emulators/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { aiPlugin } from "../index.js";
import { imageSize, sniffImageType } from "../media/pixels.js";
import { getAiState } from "../state.js";

vi.mock("@emulators/ai", async () => import("../index.js"));

interface EmulatorHandle {
  readonly url: string;
  close(): Promise<void>;
}

let emulator: EmulatorHandle;
let origin: string;

beforeAll(async () => {
  const entry = new URL("../../../../emulate/src/api.ts", import.meta.url).href;
  const { createEmulator } = (await import(entry)) as {
    createEmulator(options: { service: "ai"; port: number }): Promise<EmulatorHandle>;
  };
  emulator = await createEmulator({ service: "ai", port: 0 });
  origin = new URL(emulator.url).origin;
});

afterAll(async () => {
  await emulator.close();
});

beforeEach(async () => {
  expect((await fetch(`${origin}/_ai/reset`, { method: "POST" })).status).toBe(200);
});

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
  functionCall?: { name: string; args: Record<string, unknown> };
  thoughtSignature?: string;
}

async function generate(model: string, body: unknown, stream = false): Promise<Response> {
  return fetch(`${origin}/v1beta/models/${model}:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": "test" },
    body: JSON.stringify(body),
  });
}

async function partsOf(response: Response): Promise<GeminiPart[]> {
  const body = (await response.json()) as { candidates: Array<{ content: { parts: GeminiPart[] } }> };
  return body.candidates[0].content.parts;
}

describe("gemini contract", () => {
  it("answers and streams text with the shared rules and defaults", async () => {
    expect(await partsOf(await generate("gemini-3-flash", { contents: [{ parts: [{ text: "hello" }] }] }))).toEqual([
      { text: "hello" },
    ]);
    const stream = await (
      await generate("gemini-3-flash", { contents: [{ parts: [{ text: "two words" }] }] }, true)
    ).text();
    const chunks = stream
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map(
        (line) =>
          JSON.parse(line.slice(6)) as {
            candidates: Array<{ finishReason?: string; content: { parts: GeminiPart[] } }>;
          },
      );
    expect(chunks.map((chunk) => chunk.candidates[0].content.parts[0].text).join("")).toBe("two words");
    expect(chunks.at(-1)?.candidates[0].finishReason).toBe("STOP");
  });

  it("returns function calls with a thought signature when a tool is forced", async () => {
    const parts = await partsOf(
      await generate("gemini-3-flash", {
        contents: [{ parts: [{ text: "weather" }] }],
        tools: [
          {
            functionDeclarations: [
              { name: "get_time" },
              {
                name: "get_weather",
                parameters: { type: "OBJECT", properties: { city: { type: "STRING" } }, propertyOrdering: ["city"] },
              },
            ],
          },
        ],
        toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["get_weather", "get_time"] } },
      }),
    );
    expect(parts[0].functionCall?.name).toBe("get_weather");
    expect(parts[0].thoughtSignature).toEqual(expect.any(String));
  });

  it("reads snake_case field names and keeps schema property names", async () => {
    const forced = await partsOf(
      await generate("gemini-3-flash", {
        contents: [{ parts: [{ text: "weather" }] }],
        tools: [
          {
            function_declarations: [
              {
                name: "get_weather",
                parameters: { type: "OBJECT", properties: { city_name: { type: "STRING" } }, required: ["city_name"] },
              },
            ],
          },
        ],
        tool_config: { function_calling_config: { mode: "ANY" } },
      }),
    );
    expect(forced[0].functionCall?.name).toBe("get_weather");
    expect(Object.keys(forced[0].functionCall?.args ?? {})).toEqual(["city_name"]);
    const image = await partsOf(
      await generate("gemini-3-flash-image", {
        contents: [{ parts: [{ text: "a fox" }] }],
        generation_config: { response_modalities: ["IMAGE"], image_config: { aspect_ratio: "16:9" } },
      }),
    );
    expect(imageSize(new Uint8Array(Buffer.from(image[0].inlineData?.data ?? "", "base64")))).toEqual({
      width: 1024,
      height: 576,
    });
  });

  it("rejects non-string modalities without keeping the request scope", async () => {
    const server = createServer(aiPlugin, { baseUrl: "http://localhost:4000" });
    const state = getAiState(server.store);
    const before = getEventListeners(state.controller.signal, "abort").length;
    for (let i = 0; i < 3; i += 1) {
      const response = await server.app.request("http://localhost:4000/v1beta/models/gemini-3-flash:generateContent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: "x" }] }],
          generationConfig: { responseModalities: [{ toString: 1 }] },
        }),
      });
      expect(response.status).toBe(400);
    }
    expect(getEventListeners(state.controller.signal, "abort")).toHaveLength(before);
  });

  it("routes by the same field spelling decoding uses and releases the scope when matching fails", async () => {
    const server = createServer(aiPlugin, { baseUrl: "http://localhost:4000" });
    const state = getAiState(server.store);
    const before = getEventListeners(state.controller.signal, "abort").length;
    const forced = { tool_config: { function_calling_config: { mode: "ANY", allowed_function_names: ["missing"] } } };
    const conflicting = {
      generationConfig: { responseModalities: ["IMAGE"] },
      generation_config: { response_modalities: ["TEXT"] },
    };
    for (let i = 0; i < 3; i += 1) {
      const response = await server.app.request("http://localhost:4000/v1beta/models/gemini-3-flash:generateContent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: "x" }] }], ...conflicting, ...forced }),
      });
      expect(response.status).toBe(400);
    }
    expect(getEventListeners(state.controller.signal, "abort")).toHaveLength(before);
    expect(state.calls.map((call) => call.task ?? "text")).toEqual(["text", "text", "text"]);
  });

  it("rejects aspect ratios too large to size", async () => {
    const huge = "9".repeat(400);
    const response = await generate("gemini-3-flash-image", {
      contents: [{ parts: [{ text: "a fox" }] }],
      generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: `${huge}:${huge}` } },
    });
    expect(response.status).toBe(400);
  });

  it("renders images and speech for IMAGE and AUDIO response modalities", async () => {
    const image = await partsOf(
      await generate("gemini-3-flash-image", {
        contents: [{ parts: [{ text: "a fox" }] }],
        generationConfig: { responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: "16:9" } },
      }),
    );
    const bytes = new Uint8Array(Buffer.from(image[0].inlineData?.data ?? "", "base64"));
    expect(sniffImageType(bytes)).toBe("image/png");
    expect(imageSize(bytes)).toEqual({ width: 1024, height: 576 });
    const speech = await partsOf(
      await generate("gemini-2.5-flash-preview-tts", {
        contents: [{ parts: [{ text: "x".repeat(30) }] }],
        generationConfig: { responseModalities: ["AUDIO"] },
      }),
    );
    expect(speech[0].inlineData?.mimeType).toBe("audio/L16;codec=pcm;rate=24000");
    expect(Buffer.from(speech[0].inlineData?.data ?? "", "base64").length).toBe(2 * 24000 * 2);
  });
  it("rejects unsupported speech sample rates and redacts file URIs", async () => {
    const speech = await generate("gemini-2.5-flash-preview-tts", {
      contents: [{ parts: [{ text: "x" }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        responseFormat: { audio: { mimeType: "AUDIO_MULAW", sampleRate: 2_000_000_000 } },
      },
    });
    expect(speech.status).toBe(400);
    await generate("gemini-3-flash", {
      contents: [
        {
          parts: [
            { text: "x" },
            { fileData: { mimeType: "audio/wav", fileUri: "https://files.example/a.wav?token=secret" } },
          ],
        },
      ],
    });
    const calls = await (await fetch(`${origin}/_ai/calls`)).text();
    expect(calls).toContain("https://files.example/a.wav");
    expect(calls).not.toContain("secret");
  });
});
