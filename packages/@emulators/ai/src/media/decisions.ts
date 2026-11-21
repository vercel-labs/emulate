import {
  decodeResponsesAttachment,
  imageAttachment,
  inlineFilePart,
  mediaAttachment,
  redactedReference,
} from "../attachments.js";
import type { CodecContext, Decoded } from "../codec.js";
import { gatewayErrorBody, gatewayFile, gatewayMetadata, gatewayModel } from "../codecs/gateway.js";
import { chatCodec } from "../codecs/openai-chat.js";
import { AiRequestError } from "../errors.js";
import type { AiFormat, FilePart, HttpFailure, InputPart, Json, RuleReplyEvent } from "../types.js";
import { fail, isRecord, mediaRequest, textTokens } from "./fields.js";
import { hash32 } from "./pixels.js";
import type { MediaBody, MediaResult, MediaRoute } from "./route.js";
import { googleError } from "./videos.js";

type Family = "openai" | "gemini" | "typesafe" | "openrouter" | "perplexity" | "gateway";
type Kind = "boolean" | "choice" | "score" | "box" | "locate";

/** One question in a provider-neutral shape; `key` is the map key, or an OpenAI question's name or position. */
interface Question {
  key: string;
  name: string | null;
  kind: Kind;
  options: Array<string | boolean>;
  levels: string[];
  seed: string;
}

type Answer =
  | { kind: "boolean"; p: number }
  | { kind: "choice"; probs: number[] }
  | { kind: "score"; probs: number[] }
  | { kind: "box"; box: { top: number; bottom: number; left: number; right: number } }
  | { kind: "locate"; spans: Array<{ start: number; end: number; text: string; score: number }> }
  | { kind: "refusal" };

interface DecisionExtras {
  family: Family;
  model: string;
  questions: Question[];
  text: string;
  inputTokens: number;
}

const FORMATS: Record<Family, AiFormat> = {
  openai: "openai-decisions",
  gemini: "gemini-decisions",
  typesafe: "typesafe-systemone",
  openrouter: "openrouter-decisions",
  perplexity: "perplexity-decisions",
  gateway: "gateway",
};

const OPENAI_TYPES: Record<string, Kind> = { predicate: "boolean", choice: "choice", score: "score" };
const MAP_TYPES: Record<Family, Record<string, Kind>> = {
  openai: OPENAI_TYPES,
  gemini: { noul: "boolean", choice: "choice", score: "score" },
  typesafe: { noul: "boolean", choice: "choice", score: "score", box: "box" },
  openrouter: { noul: "boolean", choice: "choice", score: "score", box: "box" },
  perplexity: { noul: "boolean", choice: "choice", score: "score", locate: "locate" },
  gateway: { boolean: "boolean", choice: "choice", score: "score" },
};
const GEMINI_KEY = /^[A-Za-z0-9_-]{1,64}$/;
const PERPLEXITY_KEYS = new Set(["model", "state", "questions", "mode", "max_staleness"]);

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

const AUDIO_FORMATS: Record<string, string> = { wav: "audio/wav", mp3: "audio/mpeg" };
const MAX_INLINE_BYTES = 100_000_000;
const GEMINI_MEDIA: Record<string, string> = {
  image: "image/*",
  audio: "audio/*",
  video: "video/*",
  document: "application/*",
};

/** Reads one attachment part in any decision input or state shape, or returns undefined for anything else. */
function attachmentOf(value: Record<string, unknown>, path: string): FilePart | undefined {
  const responses = decodeResponsesAttachment(value, path);
  if (responses) return responses;
  if (value.type === "image_url") {
    const url = isRecord(value.image_url) ? value.image_url.url : value.image_url;
    return imageAttachment(url, `${path}.image_url`);
  }
  if (value.type === "video_url") {
    const url = isRecord(value.video_url) ? value.video_url.url : value.video_url;
    return mediaAttachment(url, "video/*", `${path}.video_url`);
  }
  if (value.type === "input_audio" && isRecord(value.input_audio)) {
    const format = String(value.input_audio.format ?? "");
    const mediaType = AUDIO_FORMATS[format] ?? `audio/${format || "*"}`;
    return inlineFilePart(
      String(value.input_audio.data ?? ""),
      mediaType,
      `${path}.input_audio.data`,
      MAX_INLINE_BYTES,
    );
  }
  const geminiType = typeof value.type === "string" && Object.hasOwn(GEMINI_MEDIA, value.type) ? value.type : undefined;
  if (geminiType && (typeof value.data === "string" || typeof value.uri === "string")) {
    const mediaType = typeof value.mime_type === "string" ? value.mime_type : GEMINI_MEDIA[geminiType];
    return typeof value.uri === "string"
      ? { type: "file", mediaType, source: "url", ref: redactedReference(value.uri, `${path}.uri`) }
      : inlineFilePart(String(value.data), mediaType, `${path}.data`, MAX_INLINE_BYTES);
  }
  return undefined;
}

/**
 * Walks a request's input or state, collecting its text for rule matching and its attachments as file parts. Any other
 * object is kept as JSON text, with attachments found anywhere inside it recorded as file parts instead of text.
 */
function flatten(value: unknown, parts: InputPart[], path: string): void {
  if (typeof value === "string") {
    parts.push({ type: "text", text: value });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => flatten(item, parts, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) {
    if (value !== null && value !== undefined) parts.push({ type: "text", text: JSON.stringify(value) });
    return;
  }
  const attachment = attachmentOf(value, path);
  if (attachment) {
    parts.push(attachment);
    return;
  }
  if (value.type === "input_text" || value.type === "text" || value.type === "output_text") {
    flatten(value.text, parts, `${path}.text`);
    return;
  }
  if (value.type === "input_json") {
    parts.push({ type: "text", text: JSON.stringify(value.data) });
    return;
  }
  if (typeof value.role === "string" && value.content !== undefined) {
    flatten(value.content, parts, `${path}.content`);
    return;
  }
  if (value.type === "function_call_output" || value.type === "custom_tool_call_output") {
    flatten(value.output, parts, `${path}.output`);
    return;
  }
  const text = JSON.stringify(value, (key, nested: unknown) => {
    const file = key !== "" && isRecord(nested) ? attachmentOf(nested, `${path}.${key}`) : undefined;
    if (!file) return nested;
    parts.push(file);
    return undefined;
  });
  parts.push({ type: "text", text });
}

function textOf(parts: InputPart[]): string {
  return parts.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

function instructionsText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  return JSON.stringify(value);
}

function decodeOpenAI(body: Record<string, unknown>): { questions: Question[]; input: unknown } {
  if (typeof body.model !== "string" || body.model === "")
    fail("Missing required parameter: 'model'.", "model", "missing_required_parameter");
  if (body.input === undefined || body.input === null || body.input === "") {
    fail("Missing required parameter: 'input'.", "input", "missing_required_parameter");
  }
  const raw = body.questions;
  if (!Array.isArray(raw)) fail("Missing required parameter: 'questions'.", "questions", "missing_required_parameter");
  if (raw.length < 1 || raw.length > 400)
    fail("'questions' must contain 1 to 400 questions.", "questions", "invalid_value");
  const names = new Set<string>();
  const questions = raw.map((item, index): Question => {
    const param = `questions[${index}]`;
    if (!isRecord(item)) fail(`Invalid type for '${param}': expected an object.`, param, "invalid_type");
    const kind = OPENAI_TYPES[String(item.type)];
    if (!kind)
      fail(
        `Invalid value for '${param}.type': expected 'predicate', 'choice', or 'score'.`,
        `${param}.type`,
        "invalid_value",
      );
    if (item.instructions === undefined || item.instructions === "") {
      fail(
        `Missing required parameter: '${param}.instructions'.`,
        `${param}.instructions`,
        "missing_required_parameter",
      );
    }
    const name = typeof item.name === "string" ? item.name : null;
    if (name !== null) {
      if (names.has(name)) fail(`Duplicate question name '${name}'.`, `${param}.name`, "invalid_value");
      names.add(name);
    }
    const question: Question = {
      key: name ?? String(index),
      name,
      kind,
      options: [],
      levels: [],
      seed: instructionsText(item.instructions),
    };
    if (kind === "choice") {
      const choices = item.choices;
      if (!Array.isArray(choices) || choices.length < 2 || choices.length > 255) {
        fail(`'${param}.choices' must list 2 to 255 choices.`, `${param}.choices`, "invalid_value");
      }
      const values = choices.map((choice, at) => {
        const value = isRecord(choice) ? choice.value : undefined;
        if (typeof value !== "string" && typeof value !== "boolean") {
          fail(
            `'${param}.choices[${at}].value' must be a string or boolean.`,
            `${param}.choices[${at}].value`,
            "invalid_type",
          );
        }
        return value;
      });
      if (new Set(values.map((value) => `${typeof value}:${String(value)}`)).size !== values.length) {
        fail(`'${param}.choices' values must be unique.`, `${param}.choices`, "invalid_value");
      }
      question.options = values;
    }
    if (kind === "score") {
      const levels = item.levels;
      if (!Array.isArray(levels) || levels.length < 2 || levels.length > 10) {
        fail(`'${param}.levels' must list 2 to 10 levels.`, `${param}.levels`, "invalid_value");
      }
      question.levels = levels.map((level, at) => {
        if (!isRecord(level) || typeof level.label !== "string")
          fail(
            `'${param}.levels[${at}].label' is required.`,
            `${param}.levels[${at}].label`,
            "missing_required_parameter",
          );
        return level.label;
      });
    }
    return question;
  });
  return { questions, input: body.input };
}

/** Reads a map of questions, the shape TypeSafe, OpenRouter, Perplexity, and Gemini share, applying each family's limits. */
function decodeMap(family: Family, body: Record<string, unknown>): { questions: Question[]; input: unknown } {
  const field = family === "gemini" ? "input" : "state";
  if (typeof body.model !== "string" || body.model === "") fail("model: Field required.", "model");
  if (body[field] === undefined || body[field] === null) fail(`${field}: Field required.`, field);
  if (family === "perplexity") {
    const extra = Object.keys(body).find((key) => !PERPLEXITY_KEYS.has(key));
    if (extra !== undefined) fail(`Unrecognized request argument supplied: ${extra}.`, extra);
  }
  if (!isRecord(body.questions) || Object.keys(body.questions).length === 0)
    fail("questions: expected at least one question.", "questions");
  const entries = Object.entries(body.questions);
  if (family === "gemini" && entries.length > 1000) fail("questions: at most 1000 questions are allowed.", "questions");
  const questions = entries.map(([key, item]): Question => {
    const at = `questions.${key}`;
    if (family === "gemini" && !GEMINI_KEY.test(key))
      fail(`${at}: question keys must match [A-Za-z0-9_-] and be at most 64 characters.`, at);
    if (!isRecord(item)) fail(`${at}: expected an object.`, at);
    const kind = MAP_TYPES[family][String(item.type)];
    if (!kind) fail(`${at}.type: expected one of ${Object.keys(MAP_TYPES[family]).join(", ")}.`, `${at}.type`);
    if (family === "gemini" && (typeof item.instructions !== "string" || item.instructions === ""))
      fail(`${at}.instructions: Field required.`, `${at}.instructions`);
    if (kind === "locate" && (typeof item.instructions !== "string" || item.instructions === "")) {
      fail(`${at}.instructions: Field required.`, `${at}.instructions`);
    }
    if (kind === "box" && family === "openrouter" && (item.instructions ?? "") === "") {
      fail(`${at}.instructions: Field required.`, `${at}.instructions`);
    }
    if (kind === "locate" && typeof body.state !== "string")
      fail(`${at}: locate questions require a string state.`, at);
    const question: Question = {
      key,
      name: key,
      kind,
      options: [],
      levels: [],
      seed: `${key}|${instructionsText(item.instructions)}`,
    };
    if (kind === "boolean" && family === "perplexity" && item.instructions === undefined && !isRecord(item.criteria)) {
      fail(`${at}: a noul question needs instructions or criteria.`, at);
    }
    if (kind === "choice") {
      if (!isRecord(item.criteria)) fail(`${at}.criteria: Field required.`, `${at}.criteria`);
      const keys = Object.keys(item.criteria);
      const min = family === "gemini" ? 2 : 1;
      if (keys.length < min || keys.length > 255)
        fail(`${at}.criteria: expected ${min} to 255 options.`, `${at}.criteria`);
      question.options = family === "gemini" ? [...keys].sort() : keys;
    }
    if (kind === "score") {
      if (!Array.isArray(item.criteria)) fail(`${at}.criteria: Field required.`, `${at}.criteria`);
      const max = family === "gemini" ? 255 : 10;
      const min = family === "gemini" ? 2 : 1;
      if (item.criteria.length < min || item.criteria.length > max)
        fail(`${at}.criteria: expected ${min} to ${max} levels.`, `${at}.criteria`);
      question.levels = item.criteria.map((level) => (typeof level === "string" ? level : JSON.stringify(level)));
    }
    return question;
  });
  return { questions, input: body[field] };
}

/** The attachments inside question instructions, recorded with the input's so `file` rules see them. */
function instructionFiles(questions: unknown): FilePart[] {
  const entries = Array.isArray(questions)
    ? questions.map((question, index): [string, unknown] => [`[${index}]`, question])
    : isRecord(questions)
      ? Object.entries(questions).map(([key, question]): [string, unknown] => [`.${key}`, question])
      : [];
  return entries.flatMap(([at, question]) => {
    if (!isRecord(question) || question.instructions === undefined) return [];
    const nested: InputPart[] = [];
    flatten(question.instructions, nested, `questions${at}.instructions`);
    return nested.filter((part): part is FilePart => part.type === "file");
  });
}

function decodeDecision(family: Family, body: MediaBody): Decoded {
  let value: unknown = body.kind === "json" ? body.value : undefined;
  if (body.kind === "form") {
    const request = body.fields.get("request")?.[0];
    if (request === undefined) fail("request: Field required.", "request");
    try {
      value = JSON.parse(request);
    } catch {
      fail("request: expected a JSON object.", "request");
    }
  }
  if (!isRecord(value)) fail("Expected a JSON object body.", undefined, "invalid_json");
  const { questions, input } = family === "openai" ? decodeOpenAI(value) : decodeMap(family, value);
  const parts: InputPart[] = [];
  flatten(input, parts, family === "gemini" || family === "openai" ? "input" : "state");
  parts.push(...instructionFiles(value.questions));
  const model = String(value.model);
  const text = textOf(parts);
  const extras: DecisionExtras = {
    family,
    model,
    questions,
    text,
    inputTokens: textTokens(JSON.stringify(input)) + questions.length * 8,
  };
  return {
    request: mediaRequest(FORMATS[family], "decision", model, parts, false),
    extras: extras as unknown as Record<string, unknown>,
  };
}

/** Spreads deterministic weights over `count` outcomes, sharpened so one clearly leads, rounded to two decimals summing to 1. */
function spread(seed: string, labels: string[]): number[] {
  const weights = labels.map((label) => (1 + (hash32(`${seed}|${label}`) % 100)) ** 3);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const exact = weights.map((weight) => (weight * 100) / total);
  const cents = exact.map(Math.floor);
  const byRemainder = exact.map((_, index) => index).sort((a, b) => exact[b] - cents[b] - (exact[a] - cents[a]));
  const missing = 100 - cents.reduce((sum, cent) => sum + cent, 0);
  byRemainder.slice(0, missing).forEach((index) => (cents[index] += 1));
  return cents.map((cent) => cent / 100);
}

/** Answers from a seed of fixed-size digests, so the work per option does not grow with the input or instructions. */
function defaultAnswer(question: Question, inputHash: number, firstWord: RegExpExecArray | null): Answer {
  const seed = `${hash32(question.seed)}|${inputHash}`;
  switch (question.kind) {
    case "boolean":
      return { kind: "boolean", p: (1 + (hash32(seed) % 99)) / 100 };
    case "choice":
      return { kind: "choice", probs: spread(seed, question.options.map(String)) };
    case "score":
      return { kind: "score", probs: spread(seed, question.levels) };
    case "box":
      return { kind: "box", box: { top: 0.25, bottom: 0.75, left: 0.25, right: 0.75 } };
    case "locate": {
      const word = firstWord;
      return {
        kind: "locate",
        spans: word ? [{ start: word.index, end: word.index + word[0].length, text: word[0], score: 0.9 }] : [],
      };
    }
  }
}

function isProbability(value: unknown): value is number {
  return typeof value === "number" && value >= 0 && value <= 1;
}

function badAnswer(question: Question, expected: string): never {
  throw new AiRequestError(
    `The decision rule's answer for question '${question.key}' must be ${expected}.`,
    `answers.${question.key}`,
    "invalid_rule_answer",
    500,
  );
}

/** Turns a rule's answer into probabilities: a probability, a choice, a score, explicit probabilities, a box, or null for a refusal. */
function scriptedAnswer(question: Question, value: Json): Answer {
  if (value === null) return { kind: "refusal" };
  switch (question.kind) {
    case "boolean":
      if (!isProbability(value)) badAnswer(question, "a probability from 0 to 1");
      return { kind: "boolean", p: value };
    case "choice": {
      if (isRecord(value)) {
        const labels = question.options.map(String);
        const entries = Object.entries(value);
        if (entries.some(([label, p]) => !labels.includes(label) || !isProbability(p)))
          badAnswer(question, `probabilities from 0 to 1 keyed by ${labels.join(", ")}`);
        return { kind: "choice", probs: labels.map((label) => (value[label] as number | undefined) ?? 0) };
      }
      const exactIndex = question.options.findIndex((option) => option === value);
      const index =
        exactIndex === -1 ? question.options.findIndex((option) => String(option) === String(value)) : exactIndex;
      if (index === -1) badAnswer(question, `one of ${question.options.map(String).join(", ")}`);
      return { kind: "choice", probs: question.options.map((_, at) => (at === index ? 1 : 0)) };
    }
    case "score": {
      if (Array.isArray(value)) {
        if (value.length !== question.levels.length || !value.every(isProbability))
          badAnswer(question, `${question.levels.length} probabilities from 0 to 1`);
        return { kind: "score", probs: value as number[] };
      }
      if (typeof value !== "number" || value < 0 || value > question.levels.length - 1)
        badAnswer(question, `a score from 0 to ${question.levels.length - 1}`);
      const low = Math.floor(value);
      const high = Math.min(low + 1, question.levels.length - 1);
      return {
        kind: "score",
        probs: question.levels.map((_, at) =>
          round2((at === low ? 1 - (value - low) : 0) + (at === high && high !== low ? value - low : 0)),
        ),
      };
    }
    case "box": {
      const sides = ["top", "bottom", "left", "right"] as const;
      if (!isRecord(value) || !sides.every((side) => isProbability(value[side])))
        badAnswer(question, "a box with top, bottom, left, and right from 0 to 1");
      const box = value as Record<(typeof sides)[number], number>;
      return { kind: "box", box: { top: box.top, bottom: box.bottom, left: box.left, right: box.right } };
    }
    case "locate": {
      const isSpan = (span: Json) =>
        isRecord(span) &&
        Number.isInteger(span.start) &&
        Number.isInteger(span.end) &&
        typeof span.text === "string" &&
        isProbability(span.score);
      if (!Array.isArray(value) || !value.every(isSpan))
        badAnswer(question, "a list of spans with integer start and end, text, and a score from 0 to 1");
      return { kind: "locate", spans: value as Array<{ start: number; end: number; text: string; score: number }> };
    }
  }
}

function answersFor(events: RuleReplyEvent[] | undefined, extras: DecisionExtras): Answer[] {
  const scripted = events?.find((event) => event.type === "decision");
  const answers = scripted?.type === "decision" ? scripted.answers : {};
  const inputHash = hash32(extras.text);
  const firstWord = /\S+/.exec(extras.text);
  return extras.questions.map((question) =>
    Object.hasOwn(answers, question.key)
      ? scriptedAnswer(question, answers[question.key])
      : defaultAnswer(question, inputHash, firstWord),
  );
}

function argmax(probs: number[]): number {
  return probs.indexOf(Math.max(...probs));
}

/** TypeSafe and Perplexity choice confidence: how far the top probability sits above a uniform guess. */
function choiceConfidence(probs: number[]): number {
  const n = probs.length;
  return n <= 1 ? 1 : round2(Math.max(0, (n * Math.max(...probs) - 1) / (n - 1)));
}

/** TypeSafe and Perplexity score confidence: one minus the probability-weighted distance from the top level, relative to a uniform spread. */
function scoreConfidence(probs: number[]): number {
  const top = argmax(probs);
  const spreadSum = probs.reduce((sum, p, index) => sum + p * Math.abs(index - top), 0);
  const baseline = probs.reduce((sum, _, index) => sum + Math.abs(index - top), 0) / probs.length;
  return baseline === 0 ? 1 : round2(Math.max(0, 1 - spreadSum / baseline));
}

function expected(probs: number[]): number {
  return round2(probs.reduce((sum, p, index) => sum + p * index, 0));
}

function gatewayAnswer(question: Question, answer: Answer): Json {
  switch (answer.kind) {
    case "boolean":
      return { type: "boolean", probability: answer.p };
    case "choice":
      return {
        type: "choice",
        choice: String(question.options[argmax(answer.probs)]),
        probabilities: Object.fromEntries(
          question.options.map((option, index) => [String(option), answer.probs[index]]),
        ),
      };
    case "score":
      return {
        type: "score",
        score: expected(answer.probs),
        probabilities: Object.fromEntries(answer.probs.map((p, index) => [String(index), p])),
      };
    default:
      return { type: "refusal" };
  }
}

function mapAnswer(family: Family, question: Question, answer: Answer): Json {
  if (family === "gateway") return gatewayAnswer(question, answer);
  const gemini = family === "gemini";
  switch (answer.kind) {
    case "refusal":
      if (family !== "openrouter") {
        throw new AiRequestError(
          `This provider has no refusal answer for question '${question.key}'.`,
          `answers.${question.key}`,
          "invalid_rule_answer",
          500,
        );
      }
      return { type: "refusal" };
    case "boolean": {
      const p = gemini ? Math.min(0.99, Math.max(0.01, answer.p)) : answer.p;
      return { type: "noul", noul: p, ...(gemini ? { confidence: round2(Math.max(p, 1 - p)) } : {}) };
    }
    case "choice":
      return {
        type: "choice",
        choice: String(question.options[argmax(answer.probs)]),
        confidence: gemini ? Math.max(...answer.probs) : choiceConfidence(answer.probs),
        probabilities: Object.fromEntries(
          question.options.map((option, index) => [String(option), answer.probs[index]]),
        ),
      };
    case "score":
      return {
        type: "score",
        score: expected(answer.probs),
        confidence: gemini ? Math.max(...answer.probs) : scoreConfidence(answer.probs),
        legend: Object.fromEntries(question.levels.map((level, index) => [String(index), level])),
        probabilities: Object.fromEntries(answer.probs.map((p, index) => [String(index), p])),
      };
    case "box":
      return { type: "box", box: answer.box };
    case "locate":
      return { type: "locate", spans: answer.spans };
  }
}

function openaiAnswer(question: Question, answer: Answer): Json {
  switch (answer.kind) {
    case "refusal":
      return { type: "refusal", name: question.name };
    case "boolean":
      return { type: "predicate", name: question.name, probability: answer.p };
    case "choice":
      return {
        type: "choice",
        name: question.name,
        choice: question.options[argmax(answer.probs)],
        confidence: Math.max(...answer.probs),
        probabilities: question.options.map((value, index) => ({ value, probability: answer.probs[index] })),
      };
    case "score":
      return {
        type: "score",
        name: question.name,
        score: expected(answer.probs),
        confidence: Math.max(...answer.probs),
        probabilities: question.levels.map((label, index) => ({
          value: index,
          label,
          probability: answer.probs[index],
        })),
      };
    default:
      return { type: "refusal", name: question.name };
  }
}

function renderDecision(events: RuleReplyEvent[] | undefined, decoded: Decoded, ctx: CodecContext): MediaResult {
  const extras = decoded.extras as unknown as DecisionExtras;
  const answers = answersFor(events, extras);
  const input = extras.inputTokens;
  const summary = `${answers.length} ${answers.length === 1 ? "answer" : "answers"}`;
  if (extras.family === "openai") {
    return {
      kind: "json",
      summary,
      value: {
        model: extras.model,
        answers: extras.questions.map((question, index) => openaiAnswer(question, answers[index])),
        usage: {
          input_tokens: input,
          input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
          output_tokens: 0,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: input,
        },
      },
    };
  }
  const mapped = Object.fromEntries(
    extras.questions.map((question, index) => [question.key, mapAnswer(extras.family, question, answers[index])]),
  );
  if (extras.family === "gateway") {
    return {
      kind: "json",
      summary,
      value: {
        answers: mapped,
        model: extras.model,
        usage: { inputTokens: input, outputTokens: 0 },
        warnings: [],
        providerMetadata: gatewayMetadata(extras.model, ctx.makeId("gen")),
      },
    };
  }
  if (extras.family === "gemini") {
    return {
      kind: "json",
      summary,
      value: {
        answers: mapped,
        usage: {
          total_input_tokens: input,
          input_tokens_by_modality: [{ modality: "text", tokens: input }],
          total_output_tokens: 0,
          total_tokens: input,
        },
      },
    };
  }
  const output = extras.questions.length * 3;
  return {
    kind: "json",
    summary,
    value: {
      model: extras.model,
      answers: mapped,
      usage: { input_tokens: input, output_tokens: output, ...(extras.family === "openrouter" ? { cost: 0 } : {}) },
      ...(extras.family === "openrouter"
        ? { id: `gen-dec-1730000000-${ctx.makeId("dec").slice(4).padStart(20, "0")}`, provider: "TypeSafe" }
        : {}),
    },
  };
}

function typesafeError(failure: HttpFailure): unknown {
  if (failure.status === 422 || failure.status === 400) {
    return {
      detail: [
        {
          loc: ["body", ...(failure.param ?? "").split(".").filter(Boolean)],
          msg: failure.message,
          type: failure.code ?? "value_error",
        },
      ],
    };
  }
  return { detail: failure.message };
}

function openrouterError(failure: HttpFailure): unknown {
  return { error: { code: failure.status, message: failure.message } };
}

const ERROR_BODIES: Record<Family, (failure: HttpFailure, requestId: string) => unknown> = {
  openai: (failure, requestId) => chatCodec.errorBody(failure, requestId),
  perplexity: (failure, requestId) => chatCodec.errorBody(failure, requestId),
  gemini: googleError,
  typesafe: typesafeError,
  openrouter: openrouterError,
  gateway: gatewayErrorBody,
};

function bodyValue(body: MediaBody): Record<string, unknown> | undefined {
  return body.kind === "json" && isRecord(body.value) ? body.value : undefined;
}

function decisionRoute(
  family: Family,
  matches: (path: string) => boolean,
  accepts?: (body: Record<string, unknown>) => boolean,
): MediaRoute {
  return {
    format: FORMATS[family],
    task: "decision",
    sample: { type: "decision", answers: {} },
    matches: (method, path) => method === "POST" && matches(path),
    ...(accepts ? { accepts: (body: MediaBody) => accepts(bodyValue(body) ?? {}) } : {}),
    decode: (body, ctx) => {
      try {
        return decodeDecision(family, body, ctx);
      } catch (error) {
        if (family === "typesafe" && error instanceof AiRequestError && error.status === 400) {
          throw new AiRequestError(error.message, error.param, error.code, 422);
        }
        throw error;
      }
    },
    render: renderDecision,
    errorBody: ERROR_BODIES[family],
  };
}

const isGoogleVersion = (path: string) => /^\/v1(?:beta|alpha)\//.test(path);
const isDecisions = (path: string) => path === "/decisions" || path.endsWith("/decisions");

/** Decision routes. `/decisions` is shared by OpenAI, Gemini, and Perplexity, so the body picks the wire format. */
export const decisionRoutes: MediaRoute[] = [
  decisionRoute("gateway", (path) => path.endsWith("/decision-model")),
  decisionRoute("openrouter", (path) => path.endsWith("/alpha/decisions")),
  decisionRoute("typesafe", (path) => path.endsWith("/systemone")),
  decisionRoute(
    "openai",
    (path) => isDecisions(path) && !isGoogleVersion(path),
    (body) => Array.isArray(body.questions),
  ),
  decisionRoute(
    "perplexity",
    (path) => isDecisions(path) && !isGoogleVersion(path),
    (body) => body.state !== undefined,
  ),
  decisionRoute(
    "gemini",
    (path) => isDecisions(path),
    (body) => isRecord(body.questions) && body.state === undefined,
  ),
];
