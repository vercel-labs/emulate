import OpenAI, { toFile } from "openai";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { audioSeconds, sniffAudioType } from "../media/sound.js";

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

async function putRules(body: unknown): Promise<Response> {
  return fetch(`${origin}/_ai/rules`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function speech(params: Record<string, unknown>): Promise<Uint8Array> {
  const response = await openai.audio.speech.create({
    model: "gpt-4o-mini-tts",
    voice: "alloy",
    input: "x".repeat(30),
    ...params,
  } as Parameters<typeof openai.audio.speech.create>[0]);
  return new Uint8Array(await response.arrayBuffer());
}

describe("audio contract", () => {
  it("speaks in each container with a duration that follows the input", async () => {
    expect(sniffAudioType(await speech({}))).toBe("audio/mpeg");
    expect(sniffAudioType(await speech({ response_format: "flac" }))).toBe("audio/flac");
    expect(sniffAudioType(await speech({ response_format: "opus" }))).toBe("audio/ogg");
    expect(audioSeconds(await speech({ response_format: "wav" }))).toBe(2);
    expect(audioSeconds(await speech({ response_format: "wav", speed: 2 }))).toBe(1);
  });

  it("transcribes with timed words and segments", async () => {
    const wav = await speech({ response_format: "wav", input: "x".repeat(150) });
    const result = await openai.audio.transcriptions.create({
      model: "whisper-1",
      file: await toFile(wav, "call.wav", { type: "audio/wav" }),
      response_format: "verbose_json",
      timestamp_granularities: ["word", "segment"],
    });
    expect(result.text).toBe("This is a deterministic transcript of call.wav.");
    expect(result.duration).toBe(10);
    expect(result.words?.at(-1)?.end).toBe(10);
    expect(result.segments?.[0]).toMatchObject({ start: 0, end: 10 });
  });

  it("offers diarized_json only on the diarize model", async () => {
    const wav = await speech({ response_format: "wav" });
    await expect(
      openai.audio.transcriptions.create({
        model: "whisper-1",
        file: await toFile(wav, "call.wav", { type: "audio/wav" }),
        response_format: "diarized_json",
      } as never),
    ).rejects.toMatchObject({ status: 400, param: "response_format" });
    const diarized = await openai.audio.transcriptions.create({
      model: "gpt-4o-transcribe-diarize",
      file: await toFile(wav, "call.wav", { type: "audio/wav" }),
      response_format: "diarized_json",
    } as never);
    expect(diarized).toMatchObject({ text: expect.any(String) });
  });

  it("answers transcription and speech requests only from rules of their task", async () => {
    const wav = await speech({ response_format: "wav" });
    const response = await putRules({
      strict: true,
      rules: [
        { id: "words", match: { task: "transcription" }, reply: [{ type: "text", text: "Scripted." }] },
        {
          id: "voice",
          match: { task: "speech" },
          reply: [{ type: "audio", data: Buffer.from(wav).toString("base64") }],
        },
      ],
    });
    expect(response.status).toBe(200);
    const text = await openai.audio.transcriptions.create({
      model: "gpt-4o-transcribe",
      file: await toFile(wav, "a.wav"),
    });
    expect(text.text).toBe("Scripted.");
    expect(Buffer.from(await speech({})).equals(Buffer.from(wav))).toBe(true);
    await expect(
      openai.chat.completions.create({ model: "m", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("speaks Chat Completions replies when audio output is requested", async () => {
    const completion = await openai.chat.completions.create({
      model: "gpt-audio-1.5",
      modalities: ["text", "audio"],
      audio: { voice: "alloy", format: "wav" },
      messages: [{ role: "user", content: "Say hello" }],
    });
    const message = completion.choices[0].message;
    expect(message.content).toBeNull();
    expect(message.audio?.transcript).toBe("Say hello");
    expect(sniffAudioType(new Uint8Array(Buffer.from(message.audio?.data ?? "", "base64")))).toBe("audio/wav");
    const followUp = await openai.chat.completions.create({
      model: "gpt-audio-1.5",
      modalities: ["text", "audio"],
      audio: { voice: "alloy", format: "wav" },
      messages: [{ role: "user", content: "Say hello" }, message, { role: "user", content: "Again" }],
    });
    expect(followUp.choices[0].message.audio?.transcript).toBe("Again");
  });

  it("serves ElevenLabs speech at the requested output format and rejects bodies with 422", async () => {
    const response = await fetch(`${origin}/v1/text-to-speech/voice?output_format=wav_16000`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "x".repeat(15) }),
    });
    expect(response.headers.get("content-type")).toBe("audio/wav");
    expect(audioSeconds(new Uint8Array(await response.arrayBuffer()))).toBe(1);
    const invalid = await fetch(`${origin}/v1/text-to-speech/voice`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(invalid.status).toBe(422);
  });
  it("rejects ElevenLabs sample rates the provider does not offer", async () => {
    const response = await fetch(`${origin}/v1/text-to-speech/voice?output_format=ulaw_96000`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "x" }),
    });
    expect(response.status).toBe(422);
  });

  it("speaks for any voice id, including one with a malformed escape", async () => {
    const response = await fetch(`${origin}/v1/text-to-speech/%E0%A4%A`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "x" }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/mpeg");
  });

  it("records ElevenLabs source URLs without credentials or query", async () => {
    const form = new FormData();
    form.set("model_id", "scribe_v2");
    form.set("cloud_storage_url", "https://user:pass@bucket.example/audio.wav?X-Amz-Signature=secret#frag");
    expect((await fetch(`${origin}/v1/speech-to-text`, { method: "POST", body: form })).status).toBe(200);
    const calls = await (await fetch(`${origin}/_ai/calls`)).text();
    expect(calls).toContain("https://bucket.example/audio.wav");
    expect(calls).not.toContain("secret");
    expect(calls).not.toContain("pass@");
  });
});
