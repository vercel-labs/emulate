import { describe, expect, it } from "vitest";
import { AiConfigError, AiRequestError } from "../errors.js";
import { initialBudgets, matchRule, parseConfig } from "../rules.js";
import type { AIRequest, AiConfig } from "../types.js";

function configError(run: () => unknown): AiConfigError {
  try {
    run();
  } catch (error) {
    if (error instanceof AiConfigError) return error;
    throw error;
  }
  throw new Error("expected an AiConfigError");
}

function reply(text = "ok") {
  return [{ type: "text", text }];
}

function config(rules: unknown[]): AiConfig {
  return parseConfig({ rules });
}

function request(overrides: Partial<AIRequest> = {}): AIRequest {
  return {
    format: "openai-chat",
    model: "gpt-4o",
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

describe("rule parsing errors", () => {
  it("rejects an unknown match key", () => {
    const error = configError(() => config([{ id: "a", match: { colour: "red" }, reply: reply() }]));
    expect(error.message).toBe('rules[0].match.colour: unknown key "colour"');
  });

  it("rejects a negative times value", () => {
    const error = configError(() => config([{ id: "a", times: -1, match: {}, reply: reply() }]));
    expect(error.message).toBe("rules[0].times: expected an integer greater than or equal to 0");
  });

  it("rejects reply and variants together", () => {
    const error = configError(() =>
      config([
        {
          id: "a",
          match: {},
          reply: reply(),
          variants: [{ reply: reply("variant") }],
        },
      ]),
    );
    expect(error.message).toBe("rules[0].variants: reply and variants are mutually exclusive");
  });

  it("rejects a rule reply with no events", () => {
    const error = configError(() => config([{ id: "a", match: {}, reply: [] }]));
    expect(error.message).toBe("rules[0].reply: a reply needs at least one event");
    expect(error.path).toBe("rules[0].reply");
  });

  it("keeps the variant wording for an empty variant reply", () => {
    const error = configError(() => config([{ id: "a", match: {}, variants: [{ reply: [] }] }]));
    expect(error.message).toBe("rules[0].variants[0].reply: a variant needs at least one event");
    expect(error.path).toBe("rules[0].variants[0].reply");
  });

  it("accepts a rule reply with one event", () => {
    const parsed = config([{ id: "a", match: {}, reply: reply() }]);
    expect(parsed.rules[0].reply).toEqual([{ type: "text", text: "ok" }]);
  });
});

describe("rule matching", () => {
  it("matches a model glob", () => {
    const parsed = config([{ id: "glob", match: { model: "gpt-*" }, reply: reply() }]);
    const budgets = initialBudgets(parsed);

    const hit = matchRule(parsed, budgets, request({ model: "gpt-4o-mini" }));
    expect("rule" in hit && hit.rule.id).toBe("glob");

    expect(matchRule(parsed, budgets, request({ model: "claude-opus-5-5" }))).toEqual({ exhausted: [] });
  });

  it("matches text in the latest user turn", () => {
    const parsed = config([{ id: "refund", match: { textContains: "refund" }, reply: reply() }]);
    const budgets = initialBudgets(parsed);

    const hit = matchRule(parsed, budgets, request());
    expect(hit).toEqual({ exhausted: [] });

    const messages: AIRequest["messages"] = [{ role: "user", parts: [{ type: "text", text: "where is my refund?" }] }];
    const matched = matchRule(parsed, budgets, request({ messages }));
    expect("rule" in matched && matched.rule.id).toBe("refund");
  });

  it("matches a tool name glob", () => {
    const parsed = config([{ id: "search", match: { tool: "search*" }, reply: reply() }]);
    const budgets = initialBudgets(parsed);

    const hit = matchRule(parsed, budgets, request({ tools: [{ name: "search_web" }] }));
    expect("rule" in hit && hit.rule.id).toBe("search");

    expect(matchRule(parsed, budgets, request({ tools: [{ name: "lookup" }] }))).toEqual({ exhausted: [] });
  });

  it("picks the first matching rule", () => {
    const parsed = config([
      { id: "first", match: { textContains: "hello" }, reply: reply("first") },
      { id: "second", match: { model: "*" }, reply: reply("second") },
    ]);

    const hit = matchRule(parsed, initialBudgets(parsed), request());
    expect("rule" in hit && hit.rule.id).toBe("first");
  });

  it("reports rules whose budget is used up", () => {
    const parsed = config([{ id: "once", times: 1, match: {}, reply: reply() }]);
    const budgets = initialBudgets(parsed);

    const first = matchRule(parsed, budgets, request());
    expect("rule" in first && first.snapshot.remaining).toBe(0);

    expect(matchRule(parsed, budgets, request())).toEqual({ exhausted: ["once"] });
  });

  it("rejects a forced tool choice that names no declared tool", () => {
    const parsed = config([{ id: "any", times: 1, match: {}, reply: reply() }]);
    const budgets = initialBudgets(parsed);

    let error: unknown;
    try {
      matchRule(parsed, budgets, request({ toolChoice: { name: "missing" } }));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AiRequestError);
    expect((error as AiRequestError).param).toBe("tool_choice");
    expect(budgets.get("any")).toBe(1);
  });
});

describe("rule matching on files", () => {
  function fileMatch(spec: boolean | string, messages: AIRequest["messages"]): boolean {
    const parsed = config([{ id: "file", match: { file: spec }, reply: reply() }]);
    return "rule" in matchRule(parsed, initialBudgets(parsed), request({ messages }));
  }

  it("matches a file returned inside a tool result", () => {
    const messages: AIRequest["messages"] = [
      { role: "user", parts: [{ type: "text", text: "describe the chart" }] },
      { role: "assistant", parts: [{ type: "tool_call", id: "call_1", name: "render_chart", arguments: "{}" }] },
      {
        role: "tool",
        parts: [
          { type: "file", mediaType: "image/png", name: "chart.png", source: "inline" },
          { type: "tool_result", id: "call_1", output: "rendered" },
        ],
      },
    ];

    expect(fileMatch("image/*", messages)).toBe(true);
    expect(fileMatch(true, messages)).toBe(true);
    expect(fileMatch(false, messages)).toBe(false);
  });

  it("matches a file on the latest user message next to a tool result", () => {
    const messages: AIRequest["messages"] = [
      {
        role: "user",
        parts: [
          { type: "file", mediaType: "application/pdf", name: "report.pdf", source: "inline" },
          { type: "text", text: "summarize" },
        ],
      },
      { role: "assistant", parts: [{ type: "tool_call", id: "call_1", name: "read", arguments: "{}" }] },
      { role: "tool", parts: [{ type: "tool_result", id: "call_1", output: "ok" }] },
    ];

    expect(fileMatch("application/pdf", messages)).toBe(true);
  });

  it("ignores files from turns before the last assistant message", () => {
    const messages: AIRequest["messages"] = [
      { role: "user", parts: [{ type: "text", text: "look at this" }] },
      { role: "assistant", parts: [{ type: "tool_call", id: "call_1", name: "render", arguments: "{}" }] },
      {
        role: "tool",
        parts: [
          { type: "file", mediaType: "image/png", name: "chart.png", source: "inline" },
          { type: "tool_result", id: "call_1", output: "rendered" },
        ],
      },
      { role: "assistant", parts: [{ type: "text", text: "here it is" }] },
      { role: "user", parts: [{ type: "text", text: "thanks" }] },
    ];

    expect(fileMatch(true, messages)).toBe(false);
  });
});
