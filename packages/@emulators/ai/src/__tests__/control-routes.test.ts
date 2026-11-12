import { createServer } from "@emulators/core";
import { describe, expect, it } from "vitest";
import { aiPlugin, seedFromConfig, type AiSeedConfig } from "../index.js";
import type { Rule } from "../types.js";

const origin = "http://localhost:4000";

type App = ReturnType<typeof createServer>["app"];

interface ModelEntry {
  id: string;
  object: string;
  created: number;
  owned_by: string;
}

interface RuleEntry {
  id: string;
  remaining: number | null;
}

interface RulesBody {
  strict: boolean;
  timing: unknown;
  random: { seed: number };
  models: string[];
  rules: RuleEntry[];
}

interface CallEntry {
  seq: number;
  model: string;
  matched: { id: string } | { default: string } | null;
}

function createApp(seed: AiSeedConfig = {}): App {
  const server = createServer(aiPlugin, { baseUrl: origin });
  seedFromConfig(server.store, origin, seed);
  return server.app;
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function chat(app: App, model: string, content: string): Promise<Response> {
  return app.request(`${origin}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content }] }),
  });
}

function putRules(app: App, body: unknown): Promise<Response> {
  return app.request(`${origin}/_ai/rules`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function matchedRuleId(call: CallEntry): string | undefined {
  return call.matched !== null && "id" in call.matched ? call.matched.id : undefined;
}

function respond(app: App, model: string, input: string): Promise<Response> {
  return app.request(`${origin}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, input, store: true }),
  });
}

const greeting: Rule = {
  id: "greeting",
  match: { textContains: "hello" },
  reply: [{ type: "text", text: "Hello from the seed." }],
};

describe("AI models route", () => {
  it("lists seeded models and models seen on earlier requests", async () => {
    const app = createApp({ models: ["seeded-model"] });

    expect((await chat(app, "seen-in-chat", "hello")).status).toBe(200);
    expect((await respond(app, "seen-in-responses", "hello")).status).toBe(200);

    const response = await app.request(`${origin}/v1/models`);
    expect(response.status).toBe(200);

    const body = await json<{ object: string; data: ModelEntry[] }>(response);
    expect(body.object).toBe("list");
    expect(body.data.map((entry) => entry.id).sort()).toEqual(["seeded-model", "seen-in-chat", "seen-in-responses"]);
    expect(body.data).toContainEqual({ id: "seen-in-chat", object: "model", created: 0, owned_by: "emulate" });
  });

  it("lists the same models under another path prefix", async () => {
    const app = createApp({ models: ["seeded-model"] });
    expect((await chat(app, "seen-in-chat", "hello")).status).toBe(200);

    const direct = await json<{ data: ModelEntry[] }>(await app.request(`${origin}/v1/models`));
    const prefixed = await json<{ object: string; data: ModelEntry[] }>(await app.request(`${origin}/api/v1/models`));

    expect(prefixed.object).toBe("list");
    expect(prefixed.data.map((entry) => entry.id).sort()).toEqual(["seeded-model", "seen-in-chat"]);
    expect(prefixed.data).toEqual(direct.data);
  });
});

describe("AI call record control route", () => {
  it("empties the call record and leaves rules and stored responses alone", async () => {
    const app = createApp({ models: ["model-a"], rules: [greeting] });

    expect((await chat(app, "model-a", "hello")).status).toBe(200);
    const storedResponse = await respond(app, "model-a", "hello");
    expect(storedResponse.status).toBe(200);
    const stored = await json<{ id: string }>(storedResponse);

    const rulesBefore = await json<RulesBody>(await app.request(`${origin}/_ai/rules`));
    const callsBefore = await json<CallEntry[]>(await app.request(`${origin}/_ai/calls`));
    expect(callsBefore).toHaveLength(2);

    const deleted = await app.request(`${origin}/_ai/calls`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    expect(await json<{ deleted: number }>(deleted)).toEqual({ deleted: 2 });

    expect(await json<CallEntry[]>(await app.request(`${origin}/_ai/calls`))).toEqual([]);
    expect(await json<RulesBody>(await app.request(`${origin}/_ai/rules`))).toEqual(rulesBefore);
    expect((await app.request(`${origin}/v1/responses/${stored.id}`)).status).toBe(200);
  });
});

describe("AI inspector page", () => {
  it("shows a recorded call and the rule that answered it", async () => {
    const app = createApp({ rules: [greeting] });
    expect((await chat(app, "inspector-model", "hello")).status).toBe(200);

    const response = await app.request(`${origin}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");

    const html = await response.text();
    expect(html).toContain("AI Inspector");
    expect(html).toContain("inspector-model");
    expect(html).toContain("greeting");
  });

  it("shows the seeded rule and its remaining budget on the rules tab", async () => {
    const app = createApp({ rules: [{ ...greeting, times: 2 }] });

    const html = await (await app.request(`${origin}/?tab=rules`)).text();
    expect(html).toContain("greeting");
    expect(html).toContain("<td>2</td>");
  });
});

describe("AI rules control route", () => {
  it("restores a spent rule budget when the same rule is written again", async () => {
    const app = createApp();
    const once: Rule = {
      id: "once",
      times: 1,
      match: { textContains: "hello" },
      reply: [{ type: "text", text: "Answering once." }],
    };

    expect((await putRules(app, { rules: [once] })).status).toBe(200);
    expect((await chat(app, "model-a", "hello")).status).toBe(200);
    expect((await chat(app, "model-a", "hello")).status).toBe(200);
    expect((await json<CallEntry[]>(await app.request(`${origin}/_ai/calls`))).map(matchedRuleId)).toEqual([
      "once",
      undefined,
    ]);

    expect((await putRules(app, { rules: [once] })).status).toBe(200);
    const rules = await json<RulesBody>(await app.request(`${origin}/_ai/rules`));
    expect(rules.rules.map((rule) => rule.remaining)).toEqual([1]);

    expect((await chat(app, "model-a", "hello")).status).toBe(200);
    expect((await json<CallEntry[]>(await app.request(`${origin}/_ai/calls`))).map(matchedRuleId)).toEqual([
      "once",
      undefined,
      "once",
    ]);
  });

  it("keeps a non default seed when the rules view is written back and defaults it when only rules are written", async () => {
    const app = createApp({ random: { seed: 9 }, rules: [greeting] });

    const view = await json<RulesBody>(await app.request(`${origin}/_ai/rules`));
    expect(view.random).toEqual({ seed: 9 });

    const roundTrip = await putRules(app, view);
    expect(roundTrip.status).toBe(200);
    expect((await json<RulesBody>(roundTrip)).random).toEqual({ seed: 9 });

    const rulesOnly = await putRules(app, { rules: view.rules });
    expect(rulesOnly.status).toBe(200);
    expect((await json<RulesBody>(rulesOnly)).random).toEqual({ seed: 1 });
  });
});

describe("AI reset control route", () => {
  it("restores the seeded rules, models, strict, and seed", async () => {
    const app = createApp({
      strict: true,
      random: { seed: 9 },
      models: ["seeded-model"],
      rules: [greeting],
    });

    const replaced = await app.request(`${origin}/_ai/rules`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        rules: [{ id: "runtime-rule", match: {}, reply: [{ type: "text", text: "runtime" }] }],
      }),
    });
    expect(replaced.status).toBe(200);
    expect((await chat(app, "model-a", "hello")).status).toBe(200);

    const reset = await app.request(`${origin}/_ai/reset`, { method: "POST" });
    expect(reset.status).toBe(200);
    expect(await json<{ reset: boolean }>(reset)).toEqual({ reset: true });

    const rules = await json<RulesBody>(await app.request(`${origin}/_ai/rules`));
    expect(rules.strict).toBe(true);
    expect(rules.random).toEqual({ seed: 9 });
    expect(rules.models).toEqual(["seeded-model"]);
    expect(rules.rules.map((rule) => rule.id)).toEqual(["greeting"]);
    expect(await json<CallEntry[]>(await app.request(`${origin}/_ai/calls`))).toEqual([]);
  });
});
