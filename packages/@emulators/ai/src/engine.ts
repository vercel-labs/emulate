import type { Store } from "@emulators/core";
import { defaultEvents, estimateUsage, strictMissFailure } from "./defaults.js";
import { matchRule, ruleEvents } from "./rules.js";
import { getAiState, nextId, type AiState } from "./state.js";
import type { AIRequest, FinishReason, Outcome, Reply, ReplyEvent, Rule } from "./types.js";

function finishOf(events: ReplyEvent[]): FinishReason {
  if (events.some((event) => event.type === "tool_call")) return "tool_calls";
  if (events.some((event) => event.type === "refusal")) return "refusal";
  return "stop";
}

/** Builds the reply for a set of events; a rule may override the finish reason its events imply. */
function replyOf(request: AIRequest, events: ReplyEvent[], finish?: FinishReason): Reply {
  return { events, finish: finish ?? finishOf(events), usage: estimateUsage(request, events) };
}

function hashText(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193) >>> 0;
  }
  return hash;
}

/**
 * Builds the rule body for one hit, folding its seeded variant over the rule-level defaults.
 * Each rule counts its own hits, so interleaved calls still rotate through the shuffled order.
 */
function applyVariant(rule: Rule, state: AiState): Rule {
  const variants = rule.variants;
  if (!variants || variants.length === 0) return rule;
  const hits = state.variantHits;
  const hit = hits.get(rule.id) ?? 0;
  hits.set(rule.id, hit + 1);
  const variant = variants[variantIndex(state.config.random.seed, rule.id, hit, variants.length)];
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

function variantIndex(seed: number, ruleId: string, hit: number, length: number): number {
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
  return order[hit % length];
}

function idFactory(state: AiState): (prefix: string) => string {
  return (prefix) => `${prefix}_${nextId(state)}`;
}

/**
 * Decides one request: the first matching rule under budget, else a default or the strict-mode failure.
 * Throws the client error for a tool choice that forces a tool the request never declared.
 */
export function decide(store: Store, request: AIRequest): Outcome {
  const state = getAiState(store);
  const makeId = idFactory(state);
  const match = matchRule(state.config, state.budgets, request);

  if ("rule" in match) {
    const { snapshot } = match;
    const rule = applyVariant(match.rule, state);
    if (rule.error) return { kind: "error", matched: snapshot, failure: rule.error };

    return {
      kind: "reply",
      matched: snapshot,
      timing: { ...state.config.timing, ...rule.timing },
      ...(rule.fault ? { fault: rule.fault } : {}),
      reply: replyOf(
        request,
        ruleEvents(rule, () => makeId("call")),
        rule.finish,
      ),
    };
  }

  if (state.config.strict) {
    return { kind: "error", matched: null, failure: strictMissFailure(request, match.exhausted) };
  }

  const { kind, events } = defaultEvents(request, makeId);
  return {
    kind: "reply",
    matched: { default: kind },
    timing: { ...state.config.timing },
    reply: replyOf(request, events),
  };
}
