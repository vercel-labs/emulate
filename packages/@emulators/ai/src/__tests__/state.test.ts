import { Store } from "@emulators/core";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../rules.js";
import {
  CALL_RECORD_LIMIT,
  beginRequest,
  clearCalls,
  getAiState,
  getSeedConfig,
  isCurrentGeneration,
  nextId,
  recordCall,
  resetAiState,
  setSeedConfig,
  settleCall,
} from "../state.js";
import type { CallRecord, StoredResponse } from "../types.js";

function call(seq: number): CallRecord {
  return {
    seq,
    time: "2026-01-01T00:00:00.000Z",
    format: "openai-chat",
    path: "/v1/chat/completions",
    model: "gpt-x",
    stream: false,
    messages: [],
    tools: [],
    toolChoice: "auto",
    references: [],
    store: false,
    matched: null,
    status: 200,
    fault: "none",
    delivery: "pending",
    warnings: [],
  };
}

function storedResponse(): StoredResponse {
  return {
    id: "resp_1",
    createdAt: 1,
    model: "gpt-x",
    inputItems: [],
    outputItems: [],
    response: {},
  };
}

function stampOf(state: ReturnType<typeof getAiState>): { generation: number; callsGeneration: number } {
  return { generation: state.generation, callsGeneration: state.callsGeneration };
}

describe("getAiState", () => {
  it("returns one state per store with the documented defaults", () => {
    const store = new Store();
    const state = getAiState(store);

    expect(getAiState(store)).toBe(state);
    expect(getAiState(new Store())).not.toBe(state);
    expect(state.config).toEqual({
      strict: false,
      timing: { ttftMs: 0, chunkDelayMs: 0 },
      random: { seed: 1 },
      models: [],
      rules: [],
    });
    expect(state.budgets.size).toBe(0);
    expect(state.variantHits.size).toBe(0);
    expect(state.callSeq).toBe(0);
    expect(state.calls).toEqual([]);
    expect(state.responses.size).toBe(0);
    expect(state.seenModels.size).toBe(0);
    expect(state.nextId).toBe(1);
  });
});

describe("seed configuration", () => {
  it("round trips the seed config and defaults when none was set", () => {
    const store = new Store();
    const config = parseConfig({
      strict: true,
      timing: { ttftMs: 5, chunkDelayMs: [1, 2] },
      random: { seed: 9 },
      models: ["m-1"],
      rules: [{ id: "hello", match: { textContains: "hello" }, reply: [{ type: "text", text: "hi" }] }],
    });

    setSeedConfig(store, config);

    expect(getSeedConfig(store)).toEqual(config);
    expect(getSeedConfig(new Store())).toEqual(parseConfig({}));
  });
});

describe("resetAiState", () => {
  it("restores config, budgets, variant positions, ids, calls, and stored responses", () => {
    const store = new Store();
    const config = parseConfig({
      random: { seed: 7 },
      rules: [{ id: "once", times: 1, match: {}, reply: [{ type: "text", text: "ok" }] }],
    });
    const state = resetAiState(store, config);
    state.budgets.set("once", 0);
    state.variantHits.set("once", 4);
    state.callSeq = 7;
    state.nextId = 42;
    state.calls = [call(1)];
    state.responses.set("resp_1", storedResponse());
    state.seenModels.add("gpt-x");

    const reset = resetAiState(store, config);

    expect(reset).toBe(state);
    expect(reset.config).toEqual(config);
    expect(reset.budgets.get("once")).toBe(1);
    expect(reset.variantHits.size).toBe(0);
    expect(reset.callSeq).toBe(0);
    expect(reset.nextId).toBe(1);
    expect(reset.calls).toEqual([]);
    expect(reset.responses.size).toBe(0);
    expect(reset.seenModels.size).toBe(0);
  });

  it("aborts streams started under the previous generation", () => {
    const store = new Store();
    const state = resetAiState(store, parseConfig({}));
    const scope = beginRequest(state);
    expect(isCurrentGeneration(state, scope)).toBe(true);

    resetAiState(store, parseConfig({}));

    expect(scope.signal.aborted).toBe(true);
    expect(isCurrentGeneration(state, scope)).toBe(false);
  });
});

describe("beginRequest", () => {
  it("follows the client signal", () => {
    const state = resetAiState(new Store(), parseConfig({}));
    const client = new AbortController();
    const scope = beginRequest(state, client.signal);

    expect(scope.signal.aborted).toBe(false);
    client.abort();
    expect(scope.signal.aborted).toBe(true);

    scope.dispose();
  });

  it("stops listening once disposed", () => {
    const state = resetAiState(new Store(), parseConfig({}));
    const client = new AbortController();
    const scope = beginRequest(state, client.signal);

    scope.dispose();
    scope.dispose();
    client.abort();

    expect(scope.signal.aborted).toBe(false);
  });
});

describe("nextId", () => {
  it("increments per state", () => {
    const state = resetAiState(new Store(), parseConfig({}));

    expect(nextId(state)).toBe(1);
    expect(nextId(state)).toBe(2);
  });
});

describe("call record", () => {
  it("caps the record and drops the oldest calls", () => {
    const store = new Store();
    const state = resetAiState(store, parseConfig({}));
    const stamp = stampOf(state);

    for (let seq = 1; seq <= CALL_RECORD_LIMIT + 5; seq += 1) {
      expect(recordCall(state, call(seq), stamp)).toBe(true);
    }

    expect(state.calls).toHaveLength(CALL_RECORD_LIMIT);
    expect(state.calls[0].seq).toBe(6);
    expect(state.calls.at(-1)?.seq).toBe(CALL_RECORD_LIMIT + 5);
  });

  it("rejects calls stamped before a reset", () => {
    const store = new Store();
    const state = resetAiState(store, parseConfig({}));
    const stamp = stampOf(state);

    resetAiState(store, parseConfig({}));

    expect(recordCall(state, call(1), stamp)).toBe(false);
    expect(state.calls).toEqual([]);
  });

  it("settles current calls and ignores late completions", () => {
    const store = new Store();
    const state = resetAiState(store, parseConfig({}));
    const stamp = stampOf(state);
    const current = call(1);
    recordCall(state, current, stamp);
    settleCall(state, current, stamp, "completed");
    expect(current.delivery).toBe("completed");

    resetAiState(store, parseConfig({}));
    settleCall(state, current, stamp, "error");

    expect(current.delivery).toBe("completed");
  });

  it("empties the record and rejects completions from before the clear", () => {
    const store = new Store();
    const state = resetAiState(store, parseConfig({}));
    const stamp = stampOf(state);
    recordCall(state, call(1), stamp);

    clearCalls(state);

    expect(state.calls).toEqual([]);
    expect(recordCall(state, call(2), stamp)).toBe(false);
    expect(state.calls).toEqual([]);
  });
});
