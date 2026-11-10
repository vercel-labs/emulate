import { latestUserText } from "./defaults.js";
import { AiConfigError } from "./errors.js";
import type {
  AIRequest,
  AiConfig,
  AiFormat,
  FilePart,
  FinishReason,
  HttpFailure,
  Json,
  Message,
  ReplyEvent,
  Rule,
  RuleMatch,
  RuleReplyEvent,
  RuleVariant,
  RuleSnapshot,
  StreamFault,
  Timing,
} from "./types.js";

/** Remaining firing budgets keyed by rule id; null means unlimited. */
export type RuleBudgets = Map<string, number | null>;

/** A rule together with the budget it has left, as listed by the rules endpoint and inspector. */
export type RuleView = Rule & { remaining: number | null };

/** The first matching rule after its budget was consumed, or the ids of matching rules that ran out. */
export type RuleMatchResult = { rule: Rule; snapshot: RuleSnapshot } | { exhausted: string[] };

const DEFAULT_TIMING: Timing = { ttftMs: 0, chunkDelayMs: 0 };
const DEFAULT_SEED = 1;
const MAX_TIMER_MS = 2_147_483_647;

const CONFIG_KEYS = new Set(["port", "baseUrl", "strict", "timing", "random", "models", "rules"]);
const RANDOM_KEYS = new Set(["seed"]);
const VARIANT_KEYS = new Set(["reply", "error", "finish", "timing", "fault"]);
const TIMING_KEYS = new Set(["ttftMs", "chunkDelayMs"]);
const MATCH_KEYS = new Set(["model", "format", "stream", "textContains", "tool", "hasToolResult", "file"]);
const RULE_KEYS = new Set(["id", "match", "times", "reply", "variants", "finish", "error", "fault", "timing"]);
const ERROR_KEYS = new Set(["status", "message", "type", "code", "param", "headers"]);
const FAULT_KEYS = new Set(["afterChunks", "kind", "stallMs"]);
const TEXT_EVENT_KEYS = new Set(["type", "text"]);
const OBJECT_EVENT_KEYS = new Set(["type", "value"]);
const TOOL_CALL_EVENT_KEYS = new Set(["type", "name", "arguments", "id"]);

const FORMATS: ReadonlySet<string> = new Set(["openai-chat", "openai-responses"]);
const FINISH_REASONS: ReadonlySet<string> = new Set(["stop", "tool_calls", "length", "refusal", "content_filter"]);
const FAULT_KINDS: ReadonlySet<string> = new Set(["disconnect", "stall"]);

/** Validate a seed `ai` block or a `PUT /_ai/rules` body into the canonical config, applying defaults. */
export function parseConfig(raw: unknown): AiConfig {
  if (raw === undefined || raw === null) {
    return { strict: false, timing: { ...DEFAULT_TIMING }, random: { seed: DEFAULT_SEED }, models: [], rules: [] };
  }

  let configRaw: Record<string, unknown>;
  let rulesRaw: unknown;

  if (Array.isArray(raw)) {
    configRaw = {};
    rulesRaw = raw;
  } else if (isRecord(raw)) {
    configRaw = raw;
    assertKnownKeys(configRaw, CONFIG_KEYS, "");
    rulesRaw = configRaw.rules;
  } else {
    throw new AiConfigError("expected an object or an array of rules", "config");
  }

  const strict = configRaw.strict === undefined ? false : expectBoolean(configRaw.strict, "strict");
  const timing = {
    ...DEFAULT_TIMING,
    ...parseTimingFields(configRaw.timing === undefined ? {} : configRaw.timing, "timing"),
  };
  const random = parseRandom(configRaw.random);
  const models = parseModels(configRaw.models);

  if (configRaw.port !== undefined) {
    const port = expectInteger(configRaw.port, "port", 1);
    if (port > 65535) throw new AiConfigError("expected a port between 1 and 65535", "port");
  }
  if (configRaw.baseUrl !== undefined) expectString(configRaw.baseUrl, "baseUrl", true);

  if (rulesRaw !== undefined && !Array.isArray(rulesRaw)) {
    throw new AiConfigError("expected an array of rules", "rules");
  }
  const rules = (rulesRaw ?? []).map((rule, index) => parseRule(rule, `rules[${index}]`));
  assertUniqueRuleIds(rules);

  return { strict, timing, random, models, rules };
}

/** Build the initial budgets from each rule's `times`; entries are null for unlimited rules. */
export function initialBudgets(config: AiConfig): RuleBudgets {
  const budgets: RuleBudgets = new Map();
  for (const rule of config.rules) {
    budgets.set(rule.id, rule.times === undefined ? null : rule.times);
  }
  return budgets;
}

/** Pick the first rule whose conditions hold and whose budget is not used up, consuming one use atomically. */
export function matchRule(config: AiConfig, budgets: RuleBudgets, request: AIRequest): RuleMatchResult {
  const exhausted: string[] = [];
  for (const rule of config.rules) {
    if (!matches(rule.match, request)) continue;
    const remaining = budgetOf(rule, budgets);
    if (remaining !== null && remaining <= 0) {
      exhausted.push(rule.id);
      continue;
    }
    const next = remaining === null ? null : remaining - 1;
    budgets.set(rule.id, next);
    return { rule, snapshot: { id: rule.id, remaining: next, rule: structuredClone(rule) } };
  }
  return { exhausted };
}

/** Turn a rule's authored reply into reply events, filling in tool call ids from `makeId`. */
export function ruleEvents(rule: Rule, makeId: () => string): ReplyEvent[] {
  if (!rule.reply) return [];
  return rule.reply.map((event): ReplyEvent => {
    switch (event.type) {
      case "reasoning":
        return { type: "reasoning", text: event.text };
      case "text":
        return { type: "text", text: event.text };
      case "object":
        return { type: "object", value: event.value };
      case "refusal":
        return { type: "refusal", text: event.text };
      case "tool_call":
        return {
          type: "tool_call",
          id: event.id ?? makeId(),
          name: event.name,
          arguments: JSON.stringify(event.arguments),
        };
      default:
        throw new Error("unknown reply event");
    }
  });
}

/** List the active rules with their remaining budgets for the rules endpoint and inspector. */
export function rulesView(config: AiConfig, budgets: RuleBudgets): RuleView[] {
  return config.rules.map((rule) => ({
    ...rule,
    remaining: rule.times === undefined ? null : (budgets.get(rule.id) ?? rule.times),
  }));
}

function matches(match: RuleMatch, request: AIRequest): boolean {
  if (match.format !== undefined && match.format !== request.format) return false;
  if (match.stream !== undefined && match.stream !== request.stream) return false;
  if (match.model !== undefined && !globMatch(match.model, request.model)) return false;
  if (match.textContains !== undefined && !latestUserText(request).includes(match.textContains)) return false;
  const toolPattern = match.tool;
  if (toolPattern !== undefined && !request.tools.some((tool) => globMatch(toolPattern, tool.name))) return false;
  if (match.hasToolResult !== undefined && hasToolResult(request.messages) !== match.hasToolResult) return false;
  if (match.file !== undefined && !matchesFiles(match.file, latestUserFiles(request.messages))) return false;
  return true;
}

function budgetOf(rule: Rule, budgets: RuleBudgets): number | null {
  if (rule.times === undefined) return null;
  const remaining = budgets.get(rule.id);
  return remaining === undefined ? rule.times : remaining;
}

function latestUserMessage(messages: Message[]): Message | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === "user") return messages[index];
  }
  return undefined;
}

function latestUserFiles(messages: Message[]): FilePart[] {
  const message = latestUserMessage(messages);
  if (!message) return [];
  return message.parts.filter((part): part is FilePart => part.type === "file");
}

function hasToolResult(messages: Message[]): boolean {
  let start = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === "assistant") {
      start = index + 1;
      break;
    }
  }
  for (let index = start; index < messages.length; index++) {
    if (messages[index].parts.some((part) => part.type === "tool_result")) return true;
  }
  return false;
}

function matchesFiles(spec: boolean | string, files: FilePart[]): boolean {
  if (typeof spec === "boolean") return spec === files.length > 0;
  return files.some((file) => globMatch(spec, file.mediaType));
}

function globMatch(pattern: string, value: string): boolean {
  if (!pattern.includes("*")) return pattern === value;
  let patternIndex = 0;
  let valueIndex = 0;
  let starIndex = -1;
  let retryIndex = 0;
  while (valueIndex < value.length) {
    if (patternIndex < pattern.length && pattern[patternIndex] !== "*" && pattern[patternIndex] === value[valueIndex]) {
      patternIndex++;
      valueIndex++;
    } else if (patternIndex < pattern.length && pattern[patternIndex] === "*") {
      starIndex = patternIndex++;
      retryIndex = valueIndex;
    } else if (starIndex !== -1) {
      patternIndex = starIndex + 1;
      valueIndex = ++retryIndex;
    } else {
      return false;
    }
  }
  while (patternIndex < pattern.length && pattern[patternIndex] === "*") patternIndex++;
  return patternIndex === pattern.length;
}

function parseModels(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new AiConfigError("expected an array of model ids", "models");
  return raw.map((model, index) => expectString(model, `models[${index}]`, true));
}

function parseTimingFields(raw: unknown, path: string): Partial<Timing> {
  const obj = expectRecord(raw, path);
  assertKnownKeys(obj, TIMING_KEYS, path);
  const timing: Partial<Timing> = {};
  if (obj.ttftMs !== undefined) timing.ttftMs = expectDelay(obj.ttftMs, `${path}.ttftMs`);
  if (obj.chunkDelayMs !== undefined) {
    const raw = obj.chunkDelayMs;
    if (Array.isArray(raw)) {
      if (raw.length === 0) throw new AiConfigError("expected a nonempty delay list", `${path}.chunkDelayMs`);
      timing.chunkDelayMs = raw.map((value, index) => expectDelay(value, `${path}.chunkDelayMs[${index}]`));
    } else {
      timing.chunkDelayMs = expectDelay(raw, `${path}.chunkDelayMs`);
    }
  }
  return timing;
}

function parseRandom(raw: unknown): { seed: number } {
  if (raw === undefined || raw === null) return { seed: DEFAULT_SEED };
  const obj = expectRecord(raw, "random");
  assertKnownKeys(obj, RANDOM_KEYS, "random");
  const seed = obj.seed === undefined ? DEFAULT_SEED : expectSafeInteger(obj.seed, "random.seed", 0);
  return { seed };
}

function parseVariants(raw: unknown, path: string, stream: boolean): RuleVariant[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new AiConfigError("expected a nonempty list of variants", path);
  }
  return raw.map((variant, index) => {
    const at = `${path}[${index}]`;
    const obj = expectRecord(variant, at);
    assertKnownKeys(obj, VARIANT_KEYS, at);
    const hasReply = obj.reply !== undefined;
    const hasError = obj.error !== undefined;
    if (hasReply === hasError) throw new AiConfigError("expected exactly one of reply or error", at);

    const parsed: RuleVariant = hasError
      ? { error: parseError(obj.error, `${at}.error`) }
      : { reply: parseReply(obj.reply, `${at}.reply`, "a variant needs at least one event") };

    if (obj.finish !== undefined) {
      if (hasError) throw new AiConfigError("finish does not apply to an error variant", `${at}.finish`);
      parsed.finish = parseFinish(obj.finish, `${at}.finish`);
    }
    if (obj.timing !== undefined) {
      if (hasError) throw new AiConfigError("timing does not apply to an error variant", `${at}.timing`);
      parsed.timing = parseTimingFields(obj.timing, `${at}.timing`);
    }
    if (obj.fault !== undefined) {
      if (hasError) throw new AiConfigError("fault does not apply to an error variant", `${at}.fault`);
      if (!stream) throw new AiConfigError("stream faults require match.stream: true", `${at}.fault`);
      parsed.fault = parseFault(obj.fault, `${at}.fault`);
    }
    return parsed;
  });
}

function parseRule(raw: unknown, path: string): Rule {
  const obj = expectRecord(raw, path);
  assertKnownKeys(obj, RULE_KEYS, path);

  const id = expectString(obj.id, `${path}.id`, true);
  const match = obj.match === undefined ? {} : parseMatch(obj.match, `${path}.match`);
  const rule: Rule = { id, match };

  if (obj.times !== undefined) rule.times = expectSafeInteger(obj.times, `${path}.times`, 0);

  const hasReply = obj.reply !== undefined;
  const hasVariants = obj.variants !== undefined;
  const hasError = obj.error !== undefined;
  if (hasReply && hasError) throw new AiConfigError("reply and error are mutually exclusive", `${path}.reply`);
  if (hasReply && hasVariants) throw new AiConfigError("reply and variants are mutually exclusive", `${path}.variants`);
  if (hasVariants && hasError) throw new AiConfigError("variants and error are mutually exclusive", `${path}.variants`);
  if (!hasReply && !hasVariants && !hasError) {
    throw new AiConfigError("one of reply, variants, or error is required", path);
  }

  if (hasReply) {
    rule.reply = parseReply(obj.reply, `${path}.reply`);
  } else if (hasVariants) {
    rule.variants = parseVariants(obj.variants, `${path}.variants`, match.stream === true);
  } else {
    rule.error = parseError(obj.error, `${path}.error`);
  }
  const scripted = hasReply || hasVariants;

  if (obj.finish !== undefined) {
    if (!scripted) throw new AiConfigError("finish does not apply to an error rule", `${path}.finish`);
    rule.finish = parseFinish(obj.finish, `${path}.finish`);
  }

  if (obj.timing !== undefined) {
    if (!scripted) throw new AiConfigError("timing does not apply to an error rule", `${path}.timing`);
    rule.timing = parseTimingFields(obj.timing, `${path}.timing`);
  }

  if (obj.fault !== undefined) {
    if (!scripted) throw new AiConfigError("fault requires a reply", `${path}.fault`);
    if (match.stream !== true) {
      throw new AiConfigError("stream faults require match.stream: true", `${path}.fault`);
    }
    rule.fault = parseFault(obj.fault, `${path}.fault`);
  }

  return rule;
}

function parseMatch(raw: unknown, path: string): RuleMatch {
  const obj = expectRecord(raw, path);
  assertKnownKeys(obj, MATCH_KEYS, path);
  const match: RuleMatch = {};

  if (obj.model !== undefined) match.model = expectString(obj.model, `${path}.model`, true);
  if (obj.format !== undefined) match.format = parseFormat(obj.format, `${path}.format`);
  if (obj.stream !== undefined) match.stream = expectBoolean(obj.stream, `${path}.stream`);
  if (obj.textContains !== undefined) match.textContains = expectString(obj.textContains, `${path}.textContains`);
  if (obj.tool !== undefined) match.tool = expectString(obj.tool, `${path}.tool`, true);
  if (obj.hasToolResult !== undefined) {
    match.hasToolResult = expectBoolean(obj.hasToolResult, `${path}.hasToolResult`);
  }
  if (obj.file !== undefined) match.file = parseFileMatch(obj.file, `${path}.file`);

  return match;
}

function parseFileMatch(value: unknown, path: string): boolean | string {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return expectString(value, path, true);
  throw new AiConfigError("expected a boolean or a media type", path);
}

function parseFormat(value: unknown, path: string): AiFormat {
  const format = expectString(value, path, true);
  if (!FORMATS.has(format)) {
    throw new AiConfigError('expected "openai-chat" or "openai-responses"', path);
  }
  return format as AiFormat;
}

function parseFinish(value: unknown, path: string): FinishReason {
  const finish = expectString(value, path, true);
  if (!FINISH_REASONS.has(finish)) {
    throw new AiConfigError(`expected one of ${[...FINISH_REASONS].join(", ")}`, path);
  }
  return finish as FinishReason;
}

function parseReply(raw: unknown, path: string, emptyMessage = "a reply needs at least one event"): RuleReplyEvent[] {
  if (!Array.isArray(raw)) throw new AiConfigError("expected an array of reply events", path);
  if (raw.length === 0) throw new AiConfigError(emptyMessage, path);
  return raw.map((event, index) => parseReplyEvent(event, `${path}[${index}]`));
}

function parseReplyEvent(raw: unknown, path: string): RuleReplyEvent {
  const obj = expectRecord(raw, path);
  const type = expectString(obj.type, `${path}.type`, true);

  switch (type) {
    case "reasoning":
      assertKnownKeys(obj, TEXT_EVENT_KEYS, path);
      return { type, text: expectString(obj.text, `${path}.text`) };
    case "text":
      assertKnownKeys(obj, TEXT_EVENT_KEYS, path);
      return { type, text: expectString(obj.text, `${path}.text`) };
    case "refusal":
      assertKnownKeys(obj, TEXT_EVENT_KEYS, path);
      return { type, text: expectString(obj.text, `${path}.text`) };
    case "object":
      assertKnownKeys(obj, OBJECT_EVENT_KEYS, path);
      if (obj.value === undefined) throw new AiConfigError("expected a JSON value", `${path}.value`);
      return { type, value: expectJson(obj.value, `${path}.value`) };
    case "tool_call": {
      assertKnownKeys(obj, TOOL_CALL_EVENT_KEYS, path);
      if (obj.arguments === undefined) throw new AiConfigError("expected tool arguments", `${path}.arguments`);
      const args = expectJson(obj.arguments, `${path}.arguments`);
      if (!isRecord(args)) {
        throw new AiConfigError(
          "expected a JSON object for tool arguments, not an encoded string; write the fields directly",
          `${path}.arguments`,
        );
      }
      return {
        type,
        name: expectString(obj.name, `${path}.name`, true),
        arguments: args,
        ...(obj.id === undefined ? {} : { id: expectString(obj.id, `${path}.id`, true) }),
      };
    }
    default:
      throw new AiConfigError(`unknown reply event type "${type}"`, `${path}.type`);
  }
}

function parseError(raw: unknown, path: string): HttpFailure {
  const obj = expectRecord(raw, path);
  assertKnownKeys(obj, ERROR_KEYS, path);

  const status = expectInteger(obj.status, `${path}.status`);
  if (status < 400 || status > 599) {
    throw new AiConfigError("expected an HTTP error status between 400 and 599", `${path}.status`);
  }

  const failure: HttpFailure = {
    status,
    message: expectString(obj.message, `${path}.message`),
  };
  if (obj.type !== undefined) failure.type = expectString(obj.type, `${path}.type`);
  if (obj.code !== undefined) failure.code = expectString(obj.code, `${path}.code`);
  if (obj.param !== undefined) failure.param = expectString(obj.param, `${path}.param`);
  if (obj.headers !== undefined) failure.headers = parseHeaders(obj.headers, `${path}.headers`);

  return failure;
}

function parseHeaders(raw: unknown, path: string): Record<string, string> {
  const obj = expectRecord(raw, path);
  const entries: [string, string][] = [];
  for (const [name, value] of Object.entries(obj)) {
    const headerPath = joinPath(path, name);
    const text = expectString(value, headerPath);
    try {
      new Headers([[name, text]]);
    } catch {
      throw new AiConfigError("expected a valid HTTP header name and value", headerPath);
    }
    entries.push([name, text]);
  }
  return Object.fromEntries(entries);
}

function parseFault(raw: unknown, path: string): StreamFault {
  const obj = expectRecord(raw, path);
  assertKnownKeys(obj, FAULT_KEYS, path);

  const afterChunks = expectSafeInteger(obj.afterChunks, `${path}.afterChunks`, 0);
  const kind = expectString(obj.kind, `${path}.kind`, true);
  if (!FAULT_KINDS.has(kind)) throw new AiConfigError('expected "disconnect" or "stall"', `${path}.kind`);

  if (kind === "stall") {
    if (obj.stallMs === undefined) throw new AiConfigError("stallMs is required for a stall", `${path}.stallMs`);
    return { afterChunks, kind, stallMs: expectDelay(obj.stallMs, `${path}.stallMs`, 1) };
  }

  if (obj.stallMs !== undefined) throw new AiConfigError("stallMs only applies to a stall", `${path}.stallMs`);
  return { afterChunks, kind: "disconnect" };
}

function assertUniqueRuleIds(rules: Rule[]): void {
  const seen = new Set<string>();
  for (let index = 0; index < rules.length; index++) {
    const id = rules[index].id;
    if (seen.has(id)) throw new AiConfigError(`duplicate rule id "${id}"`, `rules[${index}].id`);
    seen.add(id);
  }
}

function assertKnownKeys(obj: Record<string, unknown>, allowed: ReadonlySet<string>, path: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) throw new AiConfigError(`unknown key "${key}"`, joinPath(path, key));
  }
}

function joinPath(path: string, key: string): string {
  return path ? `${path}.${key}` : key;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new AiConfigError("expected an object", path);
  return value;
}

function expectString(value: unknown, path: string, nonEmpty = false): string {
  if (typeof value !== "string") throw new AiConfigError("expected a string", path);
  if (nonEmpty && value.length === 0) throw new AiConfigError("expected a non-empty string", path);
  return value;
}

function expectBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new AiConfigError("expected a boolean", path);
  return value;
}

function expectFiniteNumber(value: unknown, path: string, minimum?: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new AiConfigError("expected a finite number", path);
  }
  if (minimum !== undefined && value < minimum) {
    throw new AiConfigError(`expected a number greater than or equal to ${minimum}`, path);
  }
  return value;
}

function expectInteger(value: unknown, path: string, minimum?: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new AiConfigError("expected an integer", path);
  }
  if (minimum !== undefined && value < minimum) {
    throw new AiConfigError(`expected an integer greater than or equal to ${minimum}`, path);
  }
  return value;
}

function expectSafeInteger(value: unknown, path: string, minimum?: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new AiConfigError("expected a safe integer", path);
  }
  if (minimum !== undefined && value < minimum) {
    throw new AiConfigError(`expected an integer greater than or equal to ${minimum}`, path);
  }
  return value;
}

function expectDelay(value: unknown, path: string, minimum = 0): number {
  const delay = expectFiniteNumber(value, path, minimum);
  if (delay > MAX_TIMER_MS) {
    throw new AiConfigError(`expected a delay no greater than ${MAX_TIMER_MS} milliseconds`, path);
  }
  return delay;
}

function expectJson(value: unknown, path: string, depth = 0): Json {
  if (depth > 100) throw new AiConfigError("JSON nesting is too deep", path);
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new AiConfigError("expected a finite number", path);
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => expectJson(item, `${path}[${index}]`, depth + 1));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, expectJson(item, joinPath(path, key), depth + 1)]),
    );
  }
  throw new AiConfigError("expected a JSON value", path);
}
