import {
  createGateway,
  experimental_decide as decide,
  experimental_generateVideo as generateVideo,
  generateImage,
  generateSpeech,
  generateText,
  Output,
  stepCountIs,
  streamText,
  tool,
  transcribe,
} from "ai";
import { createGateway as createGatewayV6, generateText as generateTextV6 } from "ai-v6";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { imageSize, sniffImageType } from "../media/pixels.js";

vi.mock("@emulators/ai", async () => import("../index.js"));

interface EmulatorHandle {
  readonly url: string;
  close(): Promise<void>;
}

let emulator: EmulatorHandle;
let origin: string;
let gateway: ReturnType<typeof createGateway>;

beforeAll(async () => {
  const entry = new URL("../../../../emulate/src/api.ts", import.meta.url).href;
  const { createEmulator } = (await import(entry)) as {
    createEmulator(options: { service: "ai"; port: number }): Promise<EmulatorHandle>;
  };
  emulator = await createEmulator({ service: "ai", port: 0 });
  origin = new URL(emulator.url).origin;
  gateway = createGateway({ baseURL: `${origin}/v4/ai`, apiKey: "test" });
});

afterAll(async () => {
  await emulator.close();
});

beforeEach(async () => {
  expect((await fetch(`${origin}/_ai/reset`, { method: "POST" })).status).toBe(200);
});

async function putRules(rules: unknown[]): Promise<void> {
  const response = await fetch(`${origin}/_ai/rules`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ rules }),
  });
  expect(response.status).toBe(200);
}

async function lastCall(): Promise<{ format: string; task?: string; model: string; stream: boolean }> {
  const calls = (await (await fetch(`${origin}/_ai/calls`)).json()) as Array<{
    format: string;
    task?: string;
    model: string;
    stream: boolean;
  }>;
  return calls[calls.length - 1];
}

describe("AI Gateway contract", () => {
  it("answers and streams text through the gateway language model protocol", async () => {
    await putRules([
      {
        id: "weather",
        match: { format: "gateway" },
        reply: [
          { type: "reasoning", text: "Thinking." },
          { type: "text", text: "It is sunny." },
        ],
      },
    ]);
    const result = await generateText({ model: gateway("openai/gpt-5.5"), prompt: "Weather?", maxRetries: 0 });
    expect(result.text).toBe("It is sunny.");
    expect(result.reasoningText).toBe("Thinking.");
    expect(result.finishReason).toBe("stop");
    expect(result.providerMetadata?.gateway).toMatchObject({ routing: { finalProvider: "openai" } });
    expect(await lastCall()).toMatchObject({ format: "gateway", model: "openai/gpt-5.5", stream: false });

    const stream = streamText({ model: gateway("anthropic/claude-sonnet-5"), prompt: "Weather?", maxRetries: 0 });
    expect(await stream.text).toBe("It is sunny.");
    expect(await lastCall()).toMatchObject({ model: "anthropic/claude-sonnet-5", stream: true });
  });

  it("runs structured output and tool loops", async () => {
    const object = await generateText({
      model: gateway("openai/gpt-5.5"),
      output: Output.object({ schema: z.object({ city: z.string(), temp: z.number() }) }),
      prompt: "Weather?",
      maxRetries: 0,
    });
    expect(object.output).toEqual({ city: expect.any(String), temp: expect.any(Number) });

    await putRules([
      {
        id: "call",
        match: { format: "gateway", hasToolResult: false },
        reply: [{ type: "tool_call", name: "weather", arguments: { city: "Paris" } }],
      },
      { id: "answer", match: { format: "gateway", hasToolResult: true }, reply: [{ type: "text", text: "21C." }] },
    ]);
    const execute = vi.fn(async () => ({ tempC: 21 }));
    const loop = await generateText({
      model: gateway("openai/gpt-5.5"),
      prompt: "Weather in Paris?",
      tools: { weather: tool({ inputSchema: z.object({ city: z.string() }), execute }) },
      stopWhen: stepCountIs(3),
      maxRetries: 0,
    });
    expect(execute).toHaveBeenCalledWith({ city: "Paris" }, expect.anything());
    expect(loop.text).toBe("21C.");
    expect(loop.steps.map((step) => step.finishReason)).toEqual(["tool-calls", "stop"]);
  });

  it("reads AI SDK 6 file URLs and files inside tool results", async () => {
    const gatewayV6 = createGatewayV6({ baseURL: `${origin}/v4/ai`, apiKey: "test" });
    await generateTextV6({
      model: gatewayV6("openai/gpt-5.5"),
      maxRetries: 0,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "describe" },
            { type: "file", data: new URL("https://example.com/a.pdf?sig=secret"), mediaType: "application/pdf" },
          ],
        },
      ],
    });
    const calls = (await (await fetch(`${origin}/_ai/calls`)).json()) as Array<{
      messages: Array<{ parts: Array<{ type: string; ref?: string }> }>;
    }>;
    expect(calls[calls.length - 1].messages[0].parts[1]).toMatchObject({
      type: "file",
      ref: "https://example.com/a.pdf",
    });

    await putRules([
      {
        id: "shoot",
        match: { format: "gateway", hasToolResult: false },
        reply: [{ type: "tool_call", name: "screenshot", arguments: {} }],
      },
      {
        id: "seen",
        match: { format: "gateway", hasToolResult: true, file: "image/*" },
        reply: [{ type: "text", text: "Saw the screenshot." }],
      },
    ]);
    const png = Buffer.from("iVBORw0KGgo=", "base64").toString("base64");
    const result = await generateText({
      model: gateway("openai/gpt-5.5"),
      prompt: "Take a screenshot",
      tools: {
        screenshot: tool({
          inputSchema: z.object({}),
          execute: async () => "ok",
          toModelOutput: () => ({
            type: "content",
            value: [
              { type: "text", text: "screenshot" },
              { type: "file-data", data: png, mediaType: "image/png" },
            ],
          }),
        }),
      },
      stopWhen: stepCountIs(2),
      maxRetries: 0,
    });
    expect(result.text).toBe("Saw the screenshot.");
  });

  it("returns errors in the gateway envelope the client maps to typed errors", async () => {
    await putRules([{ id: "limited", match: { format: "gateway" }, error: { status: 429, message: "Slow down" } }]);
    await expect(generateText({ model: gateway("openai/gpt-5.5"), prompt: "x", maxRetries: 0 })).rejects.toMatchObject({
      name: "GatewayRateLimitError",
      statusCode: 429,
    });
    const response = await fetch(`${origin}/v4/ai/image-model`, {
      method: "POST",
      headers: { "content-type": "application/json", "ai-model-id": "bfl/flux-2-pro" },
      body: JSON.stringify({ n: 1 }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { type: "invalid_request_error", param: "prompt" } });
  });

  it("answers chat image requests and accepts generated images in later turns", async () => {
    const chat = (messages: unknown[]) =>
      fetch(`${origin}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "google/gemini-3.1-flash-image-preview",
          modalities: ["text", "image"],
          messages,
        }),
      });
    const first = (await (await chat([{ role: "user", content: "Draw a cat" }])).json()) as {
      choices: Array<{ message: { content: string | null; images: Array<{ image_url: { url: string } }> } }>;
    };
    const message = first.choices[0].message;
    expect(message.images[0].image_url.url).toMatch(/^data:image\/png;base64,/);
    const second = await chat([
      { role: "user", content: "Draw a cat" },
      { role: "assistant", content: message.content, images: message.images },
      { role: "user", content: "Make it blue" },
    ]);
    expect(second.status).toBe(200);
  });

  it("generates images, speech, and transcripts", async () => {
    const image = await generateImage({
      model: gateway.image("bfl/flux-2-pro"),
      prompt: "a red panda",
      aspectRatio: "16:9",
      maxRetries: 0,
    });
    expect(sniffImageType(image.image.uint8Array)).toBe("image/png");
    expect(imageSize(image.image.uint8Array)).toEqual({ width: 1024, height: 576 });

    const speech = await generateSpeech({
      model: gateway.speech("openai/tts-1"),
      text: "Hello there.",
      outputFormat: "wav",
      maxRetries: 0,
    });
    expect(speech.audio.mediaType).toBe("audio/wav");

    await putRules([
      {
        id: "heard",
        match: { format: "gateway", task: "transcription" },
        reply: [{ type: "text", text: "Hello there." }],
      },
    ]);
    const transcript = await transcribe({
      model: gateway.transcription("openai/gpt-transcribe"),
      audio: speech.audio.uint8Array,
      maxRetries: 0,
    });
    expect(transcript.text).toBe("Hello there.");
    expect(transcript.durationInSeconds).toBeGreaterThan(0);
    expect(transcript.segments[0]).toMatchObject({ text: "Hello there.", startSecond: 0 });
  });

  it("generates video in one request and as a polled job", async () => {
    const single = await generateVideo({
      model: gateway.video("google/veo-3.1-generate-001"),
      prompt: "A cat",
      duration: 1,
      aspectRatio: "9:16",
      maxRetries: 0,
    });
    expect(single.video.mediaType).toBe("video/mp4");

    const extreme = await fetch(`${origin}/v4/ai/video-model`, {
      method: "POST",
      headers: { "content-type": "application/json", "ai-model-id": "google/veo-3.1-generate-001" },
      body: JSON.stringify({ prompt: "x", n: 1, aspectRatio: "100000:1", duration: 1 }),
    });
    expect((await extreme.text()).length).toBeLessThan(100_000);
    const huge = "9".repeat(400);
    const overflow = await fetch(`${origin}/v4/ai/video-model/start`, {
      method: "POST",
      headers: { "content-type": "application/json", "ai-model-id": "google/veo-3.1-generate-001" },
      body: JSON.stringify({ prompt: "x", n: 1, aspectRatio: `${huge}:${huge}` }),
    });
    expect(overflow.status).toBe(400);

    await putRules([{ id: "slow", match: { format: "gateway", task: "video" }, reply: [{ type: "video", polls: 2 }] }]);
    const polled = await generateVideo({
      model: gateway.video("klingai/kling-v3"),
      prompt: "A cat",
      duration: 1,
      poll: { intervalMs: 1, timeoutMs: 5000 },
      maxRetries: 0,
    });
    expect(polled.video.mediaType).toBe("video/mp4");

    await putRules([
      {
        id: "blocked",
        match: { format: "gateway", task: "video" },
        reply: [{ type: "video_error", code: "content_policy_violation", message: "Blocked by policy" }],
      },
    ]);
    await expect(
      generateVideo({
        model: gateway.video("google/veo-3.1-generate-001"),
        prompt: "x",
        poll: { intervalMs: 1, timeoutMs: 5000 },
        maxRetries: 0,
      }),
    ).rejects.toThrow("Blocked by policy");
    await expect(
      generateVideo({ model: gateway.video("google/veo-3.1-generate-001"), prompt: "x", maxRetries: 0 }),
    ).rejects.toThrow("Blocked by policy");
  });

  it("answers decision questions", async () => {
    await putRules([
      {
        id: "decided",
        match: { format: "gateway", task: "decision" },
        reply: [{ type: "decision", answers: { damaged: 0.97, queue: "shipping", urgency: 2 } }],
      },
    ]);
    const result = await decide({
      model: gateway.decision("typesafe-ai/jev"),
      state: "My package arrived crushed.",
      questions: {
        damaged: { type: "boolean", instructions: "Is it damaged?" },
        queue: { type: "choice", criteria: { billing: null, shipping: null } },
        urgency: { type: "score", criteria: ["low", "medium", "high"] },
      },
      maxRetries: 0,
    });
    expect(result.answers).toMatchObject({
      damaged: { probability: 0.97 },
      queue: { choice: "shipping" },
      urgency: { score: 2 },
    });
    expect(await lastCall()).toMatchObject({ format: "gateway", task: "decision", model: "typesafe-ai/jev" });
  });
});
