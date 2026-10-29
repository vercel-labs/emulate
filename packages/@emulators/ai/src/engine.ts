import type { Store } from "@emulators/core";
import { defaultReply, estimateUsage, latestUserText, strictMissFailure } from "./defaults.js";
import { AiRequestError } from "./errors.js";
import { matchRule, ruleEvents } from "./rules.js";
import { getAiState, nextId, type AiState } from "./state.js";
import type { AIRequest, FinishReason, Outcome, ReplyEvent } from "./types.js";

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
    const { rule, snapshot } = match;
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
