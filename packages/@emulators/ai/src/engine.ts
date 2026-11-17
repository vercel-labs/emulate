import type { Store } from "@emulators/core";
import { defaultEvents, estimateUsage, eventText, eventTokens, strictMissFailure } from "./defaults.js";
import { matchRule, ruleEvents } from "./rules.js";
import { getAiState, nextId, type AiState } from "./state.js";
import type { AIRequest, FinishReason, Outcome, Reply, ReplyEvent, Rule } from "./types.js";

/** How the request's own limits ended a reply: untouched, cut at a stop sequence, or cut at the token cap. */
type Ending = { kind: "complete" } | { kind: "stop_sequence"; sequence: string } | { kind: "max_tokens" };

function earliestStop(text: string, sequences: string[]): { at: number; sequence: string } | undefined {
  let found: { at: number; sequence: string } | undefined;
  for (const sequence of sequences) {
    const at = text.indexOf(sequence);
    if (at !== -1 && (found === undefined || at < found.at)) found = { at, sequence };
  }
  return found;
}

function applyStop(events: ReplyEvent[], stop: string[] | undefined): { events: ReplyEvent[]; ending: Ending } {
  const sequences = (stop ?? []).filter((sequence) => sequence !== "");
  for (const [index, event] of events.entries()) {
    if (event.type !== "text") continue;
    const hit = earliestStop(event.text, sequences);
    if (hit === undefined) continue;
    const kept = event.text.slice(0, hit.at);
    const head: ReplyEvent[] = kept === "" ? [] : [{ ...event, text: kept }];
    return {
      events: [...events.slice(0, index), ...head],
      ending: { kind: "stop_sequence", sequence: hit.sequence },
    };
  }
  return { events, ending: { kind: "complete" } };
}

function withoutLoneHighSurrogate(text: string): string {
  const last = text.charCodeAt(text.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? text.slice(0, -1) : text;
}

function applyCap(
  events: ReplyEvent[],
  maxOutputTokens: number | undefined,
): { events: ReplyEvent[]; capped: boolean } {
  if (maxOutputTokens === undefined) return { events, capped: false };
  const kept: ReplyEvent[] = [];
  let left = maxOutputTokens;
  for (const event of events) {
    const cost = eventTokens(event);
    if (cost <= left) {
      kept.push(event);
      left -= cost;
      continue;
    }
    if (event.type !== "tool_call") {
      const prefix = withoutLoneHighSurrogate(eventText(event).slice(0, left * 4));
      if (prefix !== "") {
        kept.push(event.type === "object" ? { type: "text", text: prefix } : { ...event, text: prefix });
      }
    }
    return { events: kept, capped: true };
  }
  return { events: kept, capped: false };
}

/** Applies the request's stop sequences, then its token cap, to the events a rule or default produced. */
function applyLimits(request: AIRequest, events: ReplyEvent[]): { events: ReplyEvent[]; ending: Ending } {
  const stopped = applyStop(events, request.stop);
  const capped = applyCap(stopped.events, request.maxOutputTokens);
  if (capped.capped) return { events: capped.events, ending: { kind: "max_tokens" } };
  return { events: capped.events, ending: stopped.ending };
}

/** The one place a finish reason is decided: a rule's explicit override, then the token cap, then the events themselves. */
function finishOf(events: ReplyEvent[], ending: Ending, override?: FinishReason): FinishReason {
  if (override !== undefined) return override;
  if (ending.kind === "max_tokens") return "length";
  if (events.some((event) => event.type === "tool_call")) return "tool_calls";
  if (events.some((event) => event.type === "refusal")) return "refusal";
  return "stop";
}

/** Builds the reply for a set of events after the request's limits; a rule may override the finish reason. */
function replyOf(request: AIRequest, events: ReplyEvent[], finish?: FinishReason): Reply {
  const limited = applyLimits(request, events);
  const reply: Reply = {
    events: limited.events,
    finish: finishOf(limited.events, limited.ending, finish),
    usage: estimateUsage(request, limited.events),
  };
  return limited.ending.kind === "stop_sequence" ? { ...reply, stopSequence: limited.ending.sequence } : reply;
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
    const ruleIds = state.config.rules.map((rule) => rule.id);
    return { kind: "error", matched: null, failure: strictMissFailure(request, match.exhausted, ruleIds) };
  }

  const { kind, events } = defaultEvents(request, makeId);
  return {
    kind: "reply",
    matched: { default: kind },
    timing: { ...state.config.timing },
    reply: replyOf(request, events),
  };
}
