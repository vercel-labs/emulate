import { Store } from "@emulators/core";
import { describe, expect, it } from "vitest";
import { decide } from "../engine.js";
import { AiRequestError } from "../errors.js";
import { parseConfig } from "../rules.js";
import { resetAiState, type AiState } from "../state.js";
import type { AIRequest, Outcome } from "../types.js";

function setup(config: Record<string, unknown> = {}): { store: Store; state: AiState } {
  const store = new Store();
  const state = resetAiState(store, parseConfig(config));
  return { store, state };
}

function request(overrides: Partial<AIRequest> = {}): AIRequest {
  return {
    format: "openai-chat",
    model: "gpt-x",
    messages: [{ role: "user", parts: [{ type: "text", text: "hello there" }] }],
    tools: [],
    toolChoice: "auto",
    parallelToolCalls: true,
    stream: false,
    reasoning: false,
    store: false,
    references: [],
    warnings: [],
    ...overrides,
  };
}

function userText(text: string): AIRequest {
  return request({ messages: [{ role: "user", parts: [{ type: "text", text }] }] });
}

function replyOf(outcome: Outcome): Extract<Outcome, { kind: "reply" }> {
  if (outcome.kind !== "reply") throw new Error("expected a reply outcome");
  return outcome;
}

function failureOf(outcome: Outcome): Extract<Outcome, { kind: "error" }> {
  if (outcome.kind !== "error") throw new Error("expected an error outcome");
  return outcome;
}

function textOfEvents(events: Extract<Outcome, { kind: "reply" }>["reply"]["events"]): string {
  return events.map((event) => (event.type === "text" || event.type === "refusal" ? event.text : "")).join("");
}

function replyText(outcome: Outcome): string {
  return textOfEvents(replyOf(outcome).reply.events);
}

function matchedId(outcome: Outcome): string | null {
  const { matched } = outcome;
  if (matched === null || !("id" in matched)) return null;
  return matched.id;
}

function textRule(id: string, text: string, match: Record<string, unknown> = {}) {
  return { id, match, reply: [{ type: "text" as const, text }] };
}

function variantRule() {
  return {
    id: "pick",
    match: { textContains: "pick" },
    variants: [
      { reply: [{ type: "text" as const, text: "one" }] },
      { reply: [{ type: "text" as const, text: "two" }] },
      { reply: [{ type: "text" as const, text: "three" }] },
    ],
  };
}

function pickTexts(store: Store, count: number): string[] {
  const texts: string[] = [];
  for (let index = 0; index < count; index += 1) {
    texts.push(replyText(decide(store, userText("pick one"))));
  }
  return texts;
}

describe("decide", () => {
  it("answers with the first matching rule and reports its remaining budget", () => {
    const { store } = setup({
      timing: { ttftMs: 12, chunkDelayMs: 3 },
      rules: [{ id: "hello", times: 2, match: { textContains: "hello" }, reply: [{ type: "text", text: "matched" }] }],
    });

    const outcome = replyOf(decide(store, request()));

    expect(textOfEvents(outcome.reply.events)).toBe("matched");
    expect(outcome.reply.finish).toBe("stop");
    expect(outcome.timing).toEqual({ ttftMs: 12, chunkDelayMs: 3 });
    expect(outcome.matched).toMatchObject({ id: "hello", remaining: 1 });
  });

  it("picks the first of several matching rules", () => {
    const { store, state } = setup({
      rules: [
        { ...textRule("first", "first reply", { textContains: "hello" }), times: 1 },
        { ...textRule("second", "second reply"), times: 1 },
      ],
    });

    const outcome = decide(store, request());

    expect(matchedId(outcome)).toBe("first");
    expect(replyText(outcome)).toBe("first reply");
    expect(state.budgets.get("first")).toBe(0);
    expect(state.budgets.get("second")).toBe(1);
  });

  it("moves to the next rule when a budget runs out, then to the default reply", () => {
    const { store } = setup({
      rules: [
        { ...textRule("primary", "primary reply"), times: 1 },
        { ...textRule("fallback", "fallback reply"), times: 1 },
      ],
    });

    expect(matchedId(decide(store, request()))).toBe("primary");
    expect(matchedId(decide(store, request()))).toBe("fallback");

    const fallback = replyOf(decide(store, request()));
    expect(fallback.matched).toEqual({ default: "echo" });
    expect(textOfEvents(fallback.reply.events)).toBe("hello there");
  });

  it("returns a strict 400 failure when no rule matches", () => {
    const { store } = setup({ strict: true });

    const outcome = failureOf(decide(store, request()));

    expect(outcome.matched).toBeNull();
    expect(outcome.failure.status).toBe(400);
    expect(outcome.failure.type).toBe("invalid_request_error");
    expect(outcome.failure.message).toContain('No AI rule matched model "gpt-x" with tools []');
    expect(outcome.failure.message).toContain("PUT /_ai/rules");
  });

  it("lists exhausted rules in a strict failure", () => {
    const { store } = setup({ strict: true, rules: [{ ...textRule("once", "once"), times: 1, match: {} }] });

    expect(replyOf(decide(store, request())).reply.events).toHaveLength(1);

    const outcome = failureOf(decide(store, request()));
    expect(outcome.matched).toBeNull();
    expect(outcome.failure.status).toBe(400);
    expect(outcome.failure.message).toContain('Exhausted matching rules: "once".');
  });

  it("echoes the latest user text in the default reply", () => {
    const { store } = setup();
    const messages: AIRequest["messages"] = [
      { role: "user", parts: [{ type: "text", text: "older question" }] },
      { role: "assistant", parts: [{ type: "text", text: "older answer" }] },
      { role: "user", parts: [{ type: "text", text: "latest question" }] },
    ];

    const outcome = replyOf(decide(store, request({ messages })));

    expect(outcome.matched).toEqual({ default: "echo" });
    expect(textOfEvents(outcome.reply.events)).toBe("latest question");
    expect(outcome.reply.finish).toBe("stop");
  });

  it("rejects a forced tool choice when no tool is declared", () => {
    const { store } = setup();

    try {
      decide(store, request({ toolChoice: "required" }));
    } catch (error) {
      expect(error).toBeInstanceOf(AiRequestError);
      expect((error as AiRequestError).param).toBe("tool_choice");
      return;
    }
    throw new Error("expected a forced tool failure");
  });

  it("fills deterministic ids for tool calls across rule hits", () => {
    const { store } = setup({
      rules: [
        {
          id: "calls",
          match: {},
          reply: [
            { type: "tool_call", name: "lookup", arguments: { q: 1 } },
            { type: "tool_call", name: "lookup", arguments: { q: 2 } },
          ],
        },
      ],
    });

    const first = replyOf(decide(store, request()));
    expect(first.reply.events).toEqual([
      { type: "tool_call", id: "call_1", name: "lookup", arguments: '{"q":1}' },
      { type: "tool_call", id: "call_2", name: "lookup", arguments: '{"q":2}' },
    ]);
    expect(first.reply.finish).toBe("tool_calls");

    const next = replyOf(decide(store, request())).reply.events;
    expect(next[0]).toMatchObject({ id: "call_3" });
  });
});

describe("reply variants", () => {
  it("walks the seeded order so every variant appears once before any repeat", () => {
    const { store } = setup({ random: { seed: 7 }, rules: [variantRule()] });

    const texts = pickTexts(store, 6);

    expect(new Set(texts.slice(0, 3))).toEqual(new Set(["one", "two", "three"]));
    expect(texts.slice(3)).toEqual(texts.slice(0, 3));
  });

  it("replays the same order for the same seed", () => {
    const first = pickTexts(setup({ random: { seed: 7 }, rules: [variantRule()] }).store, 4);
    const replay = pickTexts(setup({ random: { seed: 7 }, rules: [variantRule()] }).store, 4);

    expect(replay).toEqual(first);
  });

  it("can order variants differently for a different seed", () => {
    const seven = pickTexts(setup({ random: { seed: 7 }, rules: [variantRule()] }).store, 3);
    const fortyTwo = pickTexts(setup({ random: { seed: 42 }, rules: [variantRule()] }).store, 3);

    expect(fortyTwo).not.toEqual(seven);
  });

  it("keeps a rule's variant order when unrelated requests answer in between", () => {
    const config = {
      random: { seed: 7 },
      rules: [variantRule(), textRule("other", "other reply", { textContains: "unrelated" })],
    };
    const { store } = setup(config);
    const baseline = pickTexts(setup(config).store, 3);

    const interleaved: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      interleaved.push(replyText(decide(store, userText("pick one"))));
      expect(replyText(decide(store, userText("unrelated")))).toBe("other reply");
    }

    expect(interleaved).toEqual(baseline);
    expect(new Set(interleaved).size).toBe(3);
  });

  it("can carry an error variant among reply variants", () => {
    const { store } = setup({
      random: { seed: 7 },
      rules: [
        {
          id: "flaky",
          match: { textContains: "flaky" },
          variants: [{ reply: [{ type: "text", text: "fine" }] }, { error: { status: 429, message: "Slow down." } }],
        },
      ],
    });

    const outcomes = [decide(store, userText("flaky")), decide(store, userText("flaky"))];
    const successes = outcomes.filter((outcome) => outcome.kind === "reply");
    const failures = outcomes.filter((outcome) => outcome.kind === "error");

    expect(successes.map(replyText)).toEqual(["fine"]);
    expect(failures.map((outcome) => failureOf(outcome).failure)).toEqual([{ status: 429, message: "Slow down." }]);
  });

  it("applies a finish override from the chosen variant", () => {
    const { store } = setup({
      random: { seed: 7 },
      rules: [
        {
          id: "cut",
          match: { textContains: "cut" },
          variants: [
            { reply: [{ type: "text", text: "short" }], finish: "length" },
            { reply: [{ type: "text", text: "full" }] },
          ],
        },
      ],
    });

    const finishes = [decide(store, userText("cut")), decide(store, userText("cut"))].map(
      (outcome) => replyOf(outcome).reply.finish,
    );

    expect(new Set(finishes)).toEqual(new Set(["length", "stop"]));
  });

  it("restores budgets and variant positions on reset", () => {
    const store = new Store();
    const config = parseConfig({
      random: { seed: 7 },
      rules: [
        {
          ...variantRule(),
          times: 1,
        },
      ],
    });
    const state = resetAiState(store, config);
    const first = replyText(decide(store, userText("pick one")));
    expect(state.budgets.get("pick")).toBe(0);
    expect(state.variantHits.get("pick")).toBe(1);

    expect(replyOf(decide(store, userText("pick one"))).matched).toEqual({ default: "echo" });

    resetAiState(store, config);
    expect(replyText(decide(store, userText("pick one")))).toBe(first);
    expect(state.budgets.get("pick")).toBe(0);
    expect(state.variantHits.get("pick")).toBe(1);
  });
});
