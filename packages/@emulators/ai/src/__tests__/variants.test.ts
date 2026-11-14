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

const pickRule = { id: "pick", match: { textContains: "pick" }, variants };

async function configure(seed: number, rules: unknown[] = [pickRule]): Promise<void> {
  const response = await fetch(`${origin}/_ai/rules`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ random: { seed }, rules }),
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

async function seededOrder(seededOrigin: string, count: number): Promise<string[]> {
  const client = new OpenAI({ apiKey: "test", baseURL: `${seededOrigin}/v1` });
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

async function ask(client: OpenAI, content: string): Promise<string> {
  const completion = await client.chat.completions.create({
    model: "pick-model",
    messages: [{ role: "user", content }],
  });
  return completion.choices[0].message.content ?? "";
}

describe("seeded reply variants", () => {
  it("keeps a seeded random seed and variant order across an HTTP reset", async () => {
    const entry = new URL("../../../../emulate/src/api.ts", import.meta.url).href;
    const { createEmulator } = (await import(entry)) as {
      createEmulator(options: {
        service: "ai";
        port: number;
        seed: { ai: Record<string, unknown> };
      }): Promise<EmulatorHandle>;
    };
    const seeded = await createEmulator({
      service: "ai",
      port: 0,
      seed: { ai: { random: { seed: 7 }, rules: [pickRule] } },
    });
    const seededOrigin = new URL(seeded.url).origin;
    try {
      const before = await seededOrder(seededOrigin, 4);
      const rulesBefore = (await (await fetch(`${seededOrigin}/_ai/rules`)).json()) as { random: unknown };
      expect(rulesBefore.random).toEqual({ seed: 7 });

      const reset = await fetch(`${seededOrigin}/_ai/reset`, { method: "POST" });
      expect(reset.status).toBe(200);

      const rulesAfter = (await (await fetch(`${seededOrigin}/_ai/rules`)).json()) as { random: unknown };
      expect(rulesAfter.random).toEqual({ seed: 7 });
      expect(await seededOrder(seededOrigin, 4)).toEqual(before);
    } finally {
      await seeded.close();
    }
  });

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

  it("picks both variants when unrelated calls interleave", async () => {
    const client = new OpenAI({ apiKey: "test", baseURL });
    await configure(7, [{ id: "pick", match: { textContains: "pick" }, variants: variants.slice(0, 2) }]);

    const first = await ask(client, "pick one");
    await ask(client, "unrelated");
    const second = await ask(client, "pick one");

    expect(new Set([first, second])).toEqual(new Set(["one", "two"]));
  });

  it("cycles every variant while unrelated requests interleave", async () => {
    const client = new OpenAI({ apiKey: "test", baseURL });
    await configure(7);

    const picks: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      picks.push(await ask(client, "pick one"));
      await ask(client, "unrelated");
      await ask(client, "unrelated again");
    }

    expect(new Set(picks)).toEqual(new Set(["one", "two", "three"]));
  });

  it("restarts the variant cycle after a reset", async () => {
    const client = new OpenAI({ apiKey: "test", baseURL });
    await configure(7);
    const before = [await ask(client, "pick one"), await ask(client, "pick one")];
    expect(before[0]).not.toBe(before[1]);

    const reset = await fetch(`${origin}/_ai/reset`, { method: "POST" });
    expect(reset.status).toBe(200);
    await configure(7);
    const after = [await ask(client, "pick one"), await ask(client, "pick one")];

    expect(after).toEqual(before);
  });

  it("cycles an injected error among reply variants", async () => {
    const client = new OpenAI({ apiKey: "test", baseURL, maxRetries: 0 });
    await configure(7, [
      {
        id: "flaky",
        match: { textContains: "flaky" },
        variants: [{ reply: [{ type: "text", text: "fine" }] }, { error: { status: 429, message: "Slow down." } }],
      },
    ]);

    const outcomes: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      try {
        const completion = await client.chat.completions.create({
          model: "pick-model",
          messages: [{ role: "user", content: "flaky" }],
        });
        outcomes.push(completion.choices[0].message.content ?? "");
      } catch (error) {
        outcomes.push(String((error as { status?: number }).status));
      }
    }

    expect(outcomes.filter((outcome) => outcome === "429")).toHaveLength(2);
    expect(outcomes.filter((outcome) => outcome === "fine")).toHaveLength(2);
  });

  it("keeps the shape of a tool-call variant", async () => {
    const client = new OpenAI({ apiKey: "test", baseURL });
    await configure(11, [
      {
        id: "caller",
        match: { textContains: "call" },
        variants: [
          { reply: [{ type: "text", text: "no tool" }] },
          { reply: [{ type: "tool_call", name: "lookup", arguments: { id: 1 } }] },
        ],
      },
    ]);

    const shapes: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      const completion = await client.chat.completions.create({
        model: "pick-model",
        messages: [{ role: "user", content: "call" }],
      });
      shapes.push(`${completion.choices[0].finish_reason}:${completion.choices[0].message.tool_calls?.length ?? 0}`);
    }

    expect(new Set(shapes)).toEqual(new Set(["stop:0", "tool_calls:1"]));
  });

  it("applies a finish override from the chosen variant", async () => {
    const client = new OpenAI({ apiKey: "test", baseURL, maxRetries: 0 });
    await configure(2, [
      {
        id: "cut",
        match: { textContains: "cut" },
        variants: [
          { reply: [{ type: "text", text: "short answer" }], finish: "length" },
          { reply: [{ type: "text", text: "full answer" }] },
        ],
      },
    ]);

    const finishes: (string | null)[] = [];
    for (let index = 0; index < 2; index += 1) {
      const completion = await client.chat.completions.create({
        model: "pick-model",
        messages: [{ role: "user", content: "cut" }],
      });
      finishes.push(completion.choices[0].finish_reason);
    }

    expect(new Set(finishes)).toEqual(new Set(["length", "stop"]));
  });

  it("rejects variant overrides that do not apply", async () => {
    const post = (variants: unknown[], match: Record<string, unknown> = {}) =>
      fetch(`${origin}/_ai/rules`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rules: [{ id: "bad", match, variants }] }),
      });

    const errorWithFinish = await post([{ error: { status: 500, message: "boom" }, finish: "length" }]);
    expect(errorWithFinish.status).toBe(400);

    const faultWithoutStream = await post([
      { reply: [{ type: "text", text: "hi" }], fault: { kind: "disconnect", afterChunks: 1 } },
    ]);
    expect(faultWithoutStream.status).toBe(400);

    const faultWithStream = await post(
      [{ reply: [{ type: "text", text: "hi" }], fault: { kind: "disconnect", afterChunks: 1 } }],
      { stream: true },
    );
    expect(faultWithStream.status).toBe(200);
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

  it("rejects a variant with both reply and error", async () => {
    const response = await fetch(`${origin}/_ai/rules`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        rules: [
          {
            id: "conflict",
            match: {},
            variants: [
              {
                reply: [{ type: "text", text: "one" }],
                error: { status: 500, message: "boom" },
              },
            ],
          },
        ],
      }),
    });

    expect(response.status).toBe(400);
  });

  it("rejects tool arguments written as an encoded string", async () => {
    const response = await fetch(`${origin}/_ai/rules`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        rules: [
          {
            id: "encoded",
            match: {},
            reply: [{ type: "tool_call", name: "lookup", arguments: '{"id":1}' }],
          },
        ],
      }),
    });
    const json = (await response.json()) as { error: { message: string } };
    expect(response.status).toBe(400);
    expect(json.error.message).toContain("expected a JSON object for tool arguments");
  });
});

describe("streamed default echo", () => {
  it("streams a whitespace-only message in linear time", async () => {
    const client = new OpenAI({ apiKey: "test", baseURL });
    const text = " ".repeat(200_000);
    const started = performance.now();
    const stream = await client.chat.completions.create({
      model: "pick-model",
      messages: [{ role: "user", content: text }],
      stream: true,
    });
    let received = "";
    for await (const chunk of stream) received += chunk.choices[0]?.delta?.content ?? "";
    expect(received).toBe(text);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
