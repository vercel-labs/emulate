import { createServer } from "@emulators/core";
import { describe, expect, it } from "vitest";
import { aiPlugin } from "../index.js";
import { getAiState, STORED_RESPONSE_LIMIT } from "../state.js";
import type { CallRecord } from "../types.js";

const origin = "http://localhost:4000";
const baseUrl = `${origin}/v1`;
const TURN_PADDING = "x".repeat(4096);

type App = ReturnType<typeof createServer>["app"];

function start() {
  const server = createServer(aiPlugin, { baseUrl });
  return { app: server.app, state: getAiState(server.store) };
}

function turnText(index: number): string {
  return `turn ${index} ${TURN_PADDING}`;
}

async function post(app: App, body: unknown): Promise<{ status: number; json: { id?: string } }> {
  const response = await app.request(`${baseUrl}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as { id?: string } };
}

async function create(app: App, body: unknown): Promise<string> {
  const { status, json } = await post(app, body);
  if (status !== 200 || json.id === undefined) throw new Error(`expected a stored response, got ${status}`);
  return json.id;
}

async function lastCall(app: App): Promise<CallRecord> {
  const response = await app.request(`${origin}/_ai/calls`);
  expect(response.status).toBe(200);
  const calls = (await response.json()) as CallRecord[];
  const call = calls.at(-1);
  if (!call) throw new Error("expected a recorded call");
  return call;
}

function texts(call: CallRecord): string[] {
  return call.messages.flatMap((message) => message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])));
}

describe("stored Responses keep only their own input", () => {
  it("stores a linear amount of input across a long chain and replays it in order", async () => {
    const { app, state } = start();
    const sent: string[] = [];
    let previous: string | undefined;
    for (let index = 0; index < 40; index += 1) {
      const text = turnText(index);
      sent.push(text);
      previous = await create(app, {
        model: "gpt-x",
        input: text,
        ...(previous === undefined ? {} : { previous_response_id: previous }),
      });
    }

    const sentBytes = sent.reduce((total, text) => total + JSON.stringify(text).length, 0);
    const storedBytes = [...state.responses.values()].reduce(
      (total, entry) => total + JSON.stringify(entry.inputItems).length,
      0,
    );
    expect(sentBytes).toBeGreaterThan(150_000);
    expect(storedBytes).toBeLessThan(sentBytes * 3);

    const history = texts(await lastCall(app));
    const first = history.indexOf(turnText(1));
    const last = history.indexOf(turnText(39));
    expect(first).toBeGreaterThanOrEqual(0);
    expect(last).toBeGreaterThan(first);
  });

  it("keeps the history of a deleted mid-chain response for later turns", async () => {
    const { app } = start();
    const ids: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      ids.push(
        await create(app, {
          model: "gpt-x",
          input: turnText(index),
          ...(index === 0 ? {} : { previous_response_id: ids[index - 1] }),
        }),
      );
    }

    const deleted = await app.request(`${baseUrl}/responses/${ids[2]}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);

    await create(app, { model: "gpt-x", input: turnText(5), previous_response_id: ids[4] });
    const expected = [0, 1, 2, 3, 4].map(turnText).flatMap((text) => [text, text]);
    expected.push(turnText(5));
    expect(texts(await lastCall(app))).toEqual(expected);
  });

  it("replays full history after the oldest responses are evicted", async () => {
    const { app, state } = start();
    for (let index = 0; index < STORED_RESPONSE_LIMIT; index += 1) {
      const id = `resp_seed_${index}`;
      state.responses.set(id, {
        id,
        createdAt: 1730000000,
        model: "gpt-x",
        ...(index === 0 ? {} : { previousResponseId: `resp_seed_${index - 1}` }),
        inputItems: [{ role: "user", parts: [{ type: "text", text: `seed ${index}` }] }],
        outputItems: [],
        response: {},
      });
    }

    const final = await create(app, {
      model: "gpt-x",
      input: "final",
      previous_response_id: `resp_seed_${STORED_RESPONSE_LIMIT - 1}`,
    });
    await create(app, { model: "gpt-x", input: "after", previous_response_id: final });

    expect(state.responses.has("resp_seed_0")).toBe(false);
    expect(state.responses.size).toBe(STORED_RESPONSE_LIMIT);
    const history = texts(await lastCall(app));
    expect(history.length).toBe(STORED_RESPONSE_LIMIT + 3);
    expect(history[0]).toBe("seed 0");
    expect(history[STORED_RESPONSE_LIMIT - 1]).toBe(`seed ${STORED_RESPONSE_LIMIT - 1}`);
    expect(history.slice(STORED_RESPONSE_LIMIT)).toEqual(["final", "final", "after"]);
  });

  it("keeps tolerance for orphan tool results across a chain rooted in unknown history", async () => {
    const { app, state } = start();
    const first = await create(app, {
      model: "gpt-x",
      input: [
        { type: "function_call_output", call_id: "call_missing", output: "x" },
        { role: "user", content: "Continue" },
      ],
      previous_response_id: "resp_missing",
    });
    const second = await create(app, {
      model: "gpt-x",
      input: [
        { type: "function_call_output", call_id: "call_other", output: "y" },
        { role: "user", content: "Again" },
      ],
      previous_response_id: first,
    });
    const third = await create(app, {
      model: "gpt-x",
      input: "Once more",
      previous_response_id: second,
    });

    expect([first, second, third].every((id) => id.startsWith("resp_"))).toBe(true);
    expect(state.responses.get(first)?.gaps).toEqual([0]);
    const call = await lastCall(app);
    expect(call.warnings.some((warning) => warning.includes("unresolved history"))).toBe(true);
  });

  it("carries the history gap into a child when its parent is removed", async () => {
    const { app, state } = start();
    const first = await create(app, { model: "gpt-x", input: "Hi", previous_response_id: "resp_missing" });
    const second = await create(app, {
      model: "gpt-x",
      input: [{ type: "function_call_output", call_id: "call_after", output: "z" }],
      previous_response_id: first,
    });
    const deleted = await app.request(`${baseUrl}/responses/${first}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    expect(state.responses.get(second)?.gaps).toEqual([0]);

    await create(app, {
      model: "gpt-x",
      input: [{ type: "function_call_output", call_id: "call_last", output: "w" }],
      previous_response_id: second,
    });
    const call = await lastCall(app);
    expect(call.warnings.some((warning) => warning.includes("unresolved history"))).toBe(true);
  });

  it("does not link to a previous response that was unknown when the request was made", async () => {
    const { app, state } = start();

    const id = await create(app, { model: "gpt-x", previous_response_id: "resp_later", input: "first" });
    const stored = state.responses.get(id);
    expect(stored?.previousResponseId).toBeUndefined();

    state.responses.set("resp_later", { ...stored!, id: "resp_later", inputItems: [], outputItems: [] });
    state.responses.get("resp_later")!.inputItems = [{ role: "user", parts: [{ type: "text", text: "unrelated" }] }];
    await create(app, { model: "gpt-x", previous_response_id: id, input: "second" });

    expect(texts(await lastCall(app))).not.toContain("unrelated");
  });
});
