import OpenAI from "openai";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@emulators/ai", async () => import("../index.js"));

interface EmulatorHandle {
  readonly url: string;
  close(): Promise<void>;
}

let emulator: EmulatorHandle;
let origin: string;
let baseURL: string;

async function startEmulator(): Promise<EmulatorHandle> {
  const entry = new URL("../../../../emulate/src/api.ts", import.meta.url).href;
  const { createEmulator } = (await import(entry)) as {
    createEmulator(options: { service: "ai"; port: number }): Promise<EmulatorHandle>;
  };
  return createEmulator({ service: "ai", port: 0 });
}

beforeAll(async () => {
  emulator = await startEmulator();
  origin = new URL(emulator.url).origin;
  baseURL = `${origin}/v1`;
});

afterAll(async () => {
  await emulator.close();
});

beforeEach(async () => {
  const response = await fetch(`${origin}/_ai/reset`, { method: "POST" });
  expect(response.status).toBe(200);
});

const variants = ["one", "two", "three"].map((name) => ({ reply: [{ type: "text", text: name }] }));

async function configure(seed: number): Promise<void> {
  const response = await fetch(`${origin}/_ai/rules`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      random: { seed },
      rules: [{ id: "pick", match: { textContains: "pick" }, variants }],
    }),
  });
  expect(response.status).toBe(200);
}

async function sequence(seed: number, count = 3): Promise<string[]> {
  const client = new OpenAI({ apiKey: "test", baseURL });
  await configure(seed);
  const replies: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const completion = await client.chat.completions.create({
      model: "pick-model",
      messages: [{ role: "user", content: "pick one" }],
    });
    replies.push(completion.choices[0].message.content ?? "");
  }
  return replies;
}

describe("seeded reply variants", () => {
  it("replays the same order for a seed and covers every variant", async () => {
    const first = await sequence(7);
    await fetch(`${origin}/_ai/reset`, { method: "POST" });
    const replay = await sequence(7);

    expect(replay).toEqual(first);
    expect(new Set(first)).toEqual(new Set(["one", "two", "three"]));
  });

  it("orders variants differently for a different seed", async () => {
    const seven = await sequence(7);
    await fetch(`${origin}/_ai/reset`, { method: "POST" });
    const other = await sequence(42);

    expect(other).not.toEqual(seven);
  });

  it("rejects a rule that sets both reply and variants", async () => {
    const response = await fetch(`${origin}/_ai/rules`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        rules: [
          {
            id: "both",
            match: {},
            reply: [{ type: "text", text: "one" }],
            variants: [{ reply: [{ type: "text", text: "two" }] }],
          },
        ],
      }),
    });

    expect(response.status).toBe(400);
  });
});
