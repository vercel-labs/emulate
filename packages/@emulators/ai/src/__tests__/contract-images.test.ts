import OpenAI, { toFile } from "openai";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { imageSize, sniffImageType } from "../media/pixels.js";

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

function bytesOf(b64: string | undefined): Uint8Array {
  return new Uint8Array(Buffer.from(b64 ?? "", "base64"));
}

async function putRules(body: unknown): Promise<Response> {
  return fetch(`${origin}/_ai/rules`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("images contract", () => {
  it("renders n distinct images in the requested format and size", async () => {
    const result = await openai.images.generate({
      model: "gpt-image-2",
      prompt: "a fox",
      n: 2,
      size: "1536x1024",
      output_format: "webp",
    });
    const [first, second] = result.data ?? [];
    expect(sniffImageType(bytesOf(first.b64_json))).toBe("image/webp");
    expect(imageSize(bytesOf(first.b64_json))).toEqual({ width: 1536, height: 1024 });
    expect(first.b64_json).not.toBe(second.b64_json);
    expect(result).toMatchObject({ output_format: "webp", size: "1536x1024", background: "opaque" });
  });

  it("accepts multipart edits with several images and a mask", async () => {
    const source = await openai.images.generate({ prompt: "source" });
    const png = bytesOf(source.data?.[0].b64_json);
    const result = await openai.images.edit({
      prompt: "combine",
      image: [await toFile(png, "a.png", { type: "image/png" }), await toFile(png, "b.png", { type: "image/png" })],
      mask: await toFile(png, "mask.png", { type: "image/png" }),
    });
    expect(sniffImageType(bytesOf(result.data?.[0].b64_json))).toBe("image/png");
    const calls = (await (await fetch(`${origin}/_ai/calls`)).json()) as Array<{
      task?: string;
      messages: Array<{ parts: Array<{ type: string }> }>;
    }>;
    const parts = calls.at(-1)?.messages[0].parts ?? [];
    expect(calls.at(-1)?.task).toBe("image");
    expect(parts.filter((part) => part.type === "file")).toHaveLength(3);
  });

  it("streams partial images before each completed event", async () => {
    const stream = await openai.images.generate({ prompt: "stream", stream: true, partial_images: 2 });
    const types: string[] = [];
    for await (const event of stream) types.push(event.type);
    expect(types).toEqual([
      "image_generation.partial_image",
      "image_generation.partial_image",
      "image_generation.completed",
    ]);
  });

  it("answers image requests only from image rules", async () => {
    const fixture = Buffer.from(
      (await openai.images.generate({ prompt: "x", output_format: "jpeg" })).data?.[0].b64_json ?? "",
      "base64",
    );
    const response = await putRules({
      strict: true,
      rules: [
        { id: "text", match: { textContains: "logo" }, reply: [{ type: "text", text: "not an image" }] },
        {
          id: "logo",
          match: { task: "image", textContains: "logo" },
          reply: [{ type: "image", data: fixture.toString("base64") }],
        },
      ],
    });
    expect(response.status).toBe(200);
    const result = await openai.images.generate({ prompt: "a logo" });
    expect(result.data?.[0].b64_json).toBe(fixture.toString("base64"));
    expect(result.output_format).toBe("jpeg");
    await expect(openai.images.generate({ prompt: "unmatched" })).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("task: image"),
    });
  });

  it("rejects text events in image rules and invalid sizes", async () => {
    const response = await putRules({
      rules: [{ id: "x", match: { task: "image" }, reply: [{ type: "text", text: "t" }] }],
    });
    expect(response.status).toBe(400);
    await expect(openai.images.generate({ prompt: "x", size: "1000x1000" })).rejects.toMatchObject({
      status: 400,
      param: "size",
    });
  });
  it("sizes extreme xAI aspect ratios within bounds", async () => {
    const tiny = `0.${"0".repeat(315)}1`;
    const result = await openai.images.generate({
      model: "grok-imagine-image",
      prompt: "x",
      output_format: "jpeg",
      aspect_ratio: `${tiny}:${tiny}`,
    } as never);
    expect(imageSize(bytesOf(result.data?.[0].b64_json))).toEqual({ width: 1024, height: 1024 });
    const huge = "9".repeat(400);
    await expect(
      openai.images.generate({ model: "grok-imagine-image", prompt: "x", aspect_ratio: `${huge}:1` } as never),
    ).rejects.toMatchObject({ status: 400, param: "aspect_ratio" });
  });
  it("keeps multipart field names away from Object.prototype", async () => {
    const form = new FormData();
    form.set("__proto__[stream]", "bogus");
    form.set("prompt", "x");
    form.set("image", new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" }), "a.png");
    expect((await fetch(`${origin}/v1/images/edits`, { method: "POST", body: form })).status).toBe(200);
    expect(({} as Record<string, unknown>).stream).toBeUndefined();
    await expect(openai.images.generate({ prompt: "after" })).resolves.toMatchObject({ created: expect.any(Number) });
  });
});
