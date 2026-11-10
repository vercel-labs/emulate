import { Store } from "@emulators/core";
import { describe, expect, it } from "vitest";
import { seedFromConfig, type AiSeedConfig } from "../index.js";
import { getAiState } from "../state.js";

const baseUrl = "http://localhost:4000";

const seed: AiSeedConfig = {
  strict: true,
  timing: { ttftMs: 5, chunkDelayMs: [1, 2, 0] },
  random: { seed: 7 },
  models: ["gpt-seeded", "gpt-seeded-other"],
  rules: [
    {
      id: "greeting",
      match: { textContains: "hello" },
      reply: [{ type: "text", text: "Hello from the seed." }],
    },
    {
      id: "fallback",
      reply: [{ type: "text", text: "Fallback answer." }],
    },
  ],
};

describe("AI seed config type", () => {
  it("accepts every field the parser accepts and keeps its values", () => {
    const store = new Store();

    seedFromConfig(store, baseUrl, seed);

    const config = getAiState(store).config;
    expect(config.strict).toBe(true);
    expect(config.timing).toEqual({ ttftMs: 5, chunkDelayMs: [1, 2, 0] });
    expect(config.random).toEqual({ seed: 7 });
    expect(config.models).toEqual(["gpt-seeded", "gpt-seeded-other"]);
    expect(config.rules).toEqual([
      {
        id: "greeting",
        match: { textContains: "hello" },
        reply: [{ type: "text", text: "Hello from the seed." }],
      },
      {
        id: "fallback",
        match: {},
        reply: [{ type: "text", text: "Fallback answer." }],
      },
    ]);
  });
});
