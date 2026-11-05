import type { Store } from "@emulators/core";
import { defaultReply, estimateUsage, latestUserText, strictMissFailure } from "./defaults.js";
import { AiRequestError } from "./errors.js";
import { matchRule, ruleEvents } from "./rules.js";
import { getAiState, nextId, type AiState } from "./state.js";
import type { AIRequest, FinishReason, Outcome, ReplyEvent, Rule } from "./types.js";

function defaultKind(request: AIRequest): string {
  if (request.toolChoice === "required" || typeof request.toolChoice === "object") return "forced_tool";
  if (request.output) return request.output.kind;
  if (request.messages.at(-1)?.parts.at(-1)?.type === "tool_result") return "tool_result";
  if (latestUserText(request).length > 0) return "echo";
  const latestUser = [...request.messages].reverse().find((message) => message.role === "user");
  if (latestUser?.parts.some((part) => part.type === "file")) return "attachments";
  return "echo";
}

function finishOf(events: ReplyEvent[]): FinishReason {
  if (events.some((event) => event.type === "tool_call")) return "tool_calls";
  if (events.some((event) => event.type === "refusal")) return "refusal";
  return "stop";
}

function hashText(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193) >>> 0;
  }
  return hash;
}

/**
 * Picks a variant from a seed-shuffled cycle, so every variant appears once per cycle of calls
 * and the same seed and call ordinal always land on the same variant.
 */
/** Builds the rule body for this call, folding the seeded variant over the rule-level defaults. */
function applyVariant(rule: Rule, state: AiState): Rule {
  const variants = rule.variants;
  if (!variants || variants.length === 0) return rule;
  const variant = variants[variantIndex(state.config.random.seed, rule.id, state.callSeq, variants.length)];
  if (!variant) return rule;

  const finish = variant.finish ?? rule.finish;
  const fault = variant.fault ?? rule.fault;
  const timing = rule.timing || variant.timing ? { ...rule.timing, ...variant.timing } : undefined;
  return {
    id: rule.id,
    match: rule.match,
    ...(rule.times === undefined ? {} : { times: rule.times }),
    ...(variant.reply === undefined ? {} : { reply: variant.reply }),
    ...(variant.error === undefined ? {} : { error: variant.error }),
    ...(finish === undefined ? {} : { finish }),
    ...(timing === undefined ? {} : { timing }),
    ...(fault === undefined ? {} : { fault }),
  };
}

function variantIndex(seed: number, ruleId: string, call: number, length: number): number {
  if (length <= 1) return 0;
  let state = (seed ^ hashText(ruleId)) >>> 0;
  const order = Array.from({ length }, (_, index) => index);
  for (let index = length - 1; index > 0; index -= 1) {
    state = (Math.imul(state ^ (state >>> 15), 0x2c1b3c6d) + 0x297a2d39) >>> 0;
    const swap = state % (index + 1);
    const value = order[index];
    order[index] = order[swap];
    order[swap] = value;
  }
  return order[call % length];
}

function idFactory(state: AiState): (prefix: string) => string {
  return (prefix) => `${prefix}_${nextId(state)}`;
}

function validateForcedTool(request: AIRequest): void {
  if (request.toolChoice !== "required" && typeof request.toolChoice !== "object") return;
  const choice = request.toolChoice;
  const tool = typeof choice === "object" ? request.tools.find((item) => item.name === choice.name) : request.tools[0];
  if (!tool) throw new AiRequestError("Forced tool choice requires a declared tool.", "tool_choice");
}

/** Decides one request: the first matching rule under budget, else a default or the strict-mode failure. */
export function decide(store: Store, request: AIRequest): Outcome {
  validateForcedTool(request);
  const state = getAiState(store);
  const makeId = idFactory(state);
  const match = matchRule(state.config, state.budgets, request);

  if ("rule" in match) {
    const { snapshot } = match;
    const rule = applyVariant(match.rule, state);
    if (rule.error) return { kind: "error", matched: snapshot, failure: rule.error };

    const events = ruleEvents(rule, () => makeId("call"));
    return {
      kind: "reply",
      matched: snapshot,
      timing: { ...state.config.timing, ...rule.timing },
      ...(rule.fault ? { fault: rule.fault } : {}),
      reply: {
        events,
        finish: rule.finish ?? finishOf(events),
        usage: estimateUsage(request, events),
      },
    };
  }

  if (state.config.strict) {
    return { kind: "error", matched: null, failure: strictMissFailure(request, match.exhausted) };
  }

  return {
    kind: "reply",
    matched: { default: defaultKind(request) },
    timing: { ...state.config.timing },
    reply: defaultReply(request, makeId),
  };
}
