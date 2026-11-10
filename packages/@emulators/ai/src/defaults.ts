import { AiRequestError } from "./errors.js";
import type { AIRequest, HttpFailure, Json, JsonSchema, Reply, ReplyEvent, Usage } from "./types.js";

const keywords = new Set([
  "$schema",
  "$id",
  "$defs",
  "definitions",
  "$ref",
  "title",
  "description",
  "default",
  "examples",
  "type",
  "properties",
  "required",
  "additionalProperties",
  "enum",
  "const",
  "items",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "nullable",
  "anyOf",
  "oneOf",
  "format",
  "pattern",
]);
const types = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);

const formatSamples: Record<string, string> = {
  email: "user@example.com",
  uuid: "00000000-0000-4000-8000-000000000000",
  uri: "https://example.com/",
  hostname: "example.com",
  ipv4: "192.0.2.1",
  ipv6: "2001:db8::1",
  date: "2026-01-01",
  time: "00:00:00Z",
  "date-time": "2026-01-01T00:00:00Z",
  duration: "PT1S",
};

function fail(path: string, reason: string): never {
  throw new AiRequestError(`Cannot generate a default for ${path}: ${reason}. Add an explicit reply rule.`, path);
}

function record(value: unknown): value is Record<string, Json> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function equal(left: Json, right: Json): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => equal(item, right[index]))
    );
  }
  if (record(left) && record(right)) {
    const keys = Object.keys(left);
    return (
      keys.length === Object.keys(right).length &&
      keys.every((key) => Object.hasOwn(right, key) && equal(left[key], right[key]))
    );
  }
  return false;
}

function adjacentNumber(value: number, direction: 1 | -1): number {
  if (value === 0) return direction * Number.MIN_VALUE;
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  view.setBigUint64(0, view.getBigUint64(0) + (value > 0 === direction > 0 ? 1n : -1n));
  return view.getFloat64(0);
}

/** Return text parts from the latest user turn, excluding tool results. */
export function latestUserText(request: AIRequest): string {
  const message = [...request.messages].reverse().find((message) => message.role === "user");
  return (
    message?.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("") ?? ""
  );
}

/** Generate a deterministic value for the supported schema subset, or throw a path-specific client error. */
export function sampleSchema(schema: JsonSchema, seed: string | number, path = "schema"): Json {
  function asSchema(value: Json | undefined, at: string): JsonSchema {
    if (typeof value !== "boolean" && !record(value)) fail(at, "expected a schema");
    return value;
  }

  let remaining = 4096;
  let characters = 262144;
  const seedLimit = 64;
  const seedText = Array.from(String(seed) || "sample").slice(0, seedLimit);

  function spend(at: string): void {
    if (--remaining < 0) fail(at, "generation exceeds the bounded schema size or recursion depth");
  }

  function resolve(ref: Json, at: string): JsonSchema {
    if (typeof ref !== "string" || (ref !== "#" && !ref.startsWith("#/"))) {
      fail(at, "only local references are supported");
    }
    let target: Json = schema;
    for (const segment of ref === "#" ? [] : ref.slice(2).split("/")) {
      const key = segment.replace(/~1/g, "/").replace(/~0/g, "~");
      spend(at);
      if (Array.isArray(target)) {
        if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= target.length) {
          fail(at, `unresolved reference ${ref}`);
        }
        target = target[Number(key)];
      } else if (record(target) && Object.hasOwn(target, key)) {
        target = target[key];
      } else {
        fail(at, `unresolved reference ${ref}`);
      }
    }
    return asSchema(target, at);
  }

  function validate(node: JsonSchema, at: string, depth = 0): void {
    if (depth > 32) fail(at, "schema nesting exceeds 32 levels");
    if (typeof node === "boolean") return;
    for (const key of Object.keys(node)) {
      if (!keywords.has(key)) fail(`${at}.${key}`, "unsupported schema keyword");
    }
    if (node.$ref !== undefined) resolve(node.$ref, `${at}.$ref`);
    if (node.type !== undefined) {
      const list = Array.isArray(node.type) ? node.type : [node.type];
      if (!list.length || list.some((type) => typeof type !== "string" || !types.has(type))) {
        fail(`${at}.type`, "unsupported type");
      }
    }
    for (const key of ["properties", "$defs", "definitions"]) {
      if (node[key] === undefined) continue;
      if (!record(node[key])) fail(`${at}.${key}`, "expected an object");
      for (const [name, child] of Object.entries(node[key])) {
        validate(asSchema(child, `${at}.${key}.${name}`), `${at}.${key}.${name}`, depth + 1);
      }
    }
    if (
      node.required !== undefined &&
      (!Array.isArray(node.required) || node.required.some((key) => typeof key !== "string"))
    ) {
      fail(`${at}.required`, "expected property names");
    }
    if (node.enum !== undefined) {
      if (!Array.isArray(node.enum) || !node.enum.length) fail(`${at}.enum`, "expected a nonempty array");
      node.enum.forEach((item, index) => checkValue(item, `${at}.enum[${index}]`));
    }
    if (Object.hasOwn(node, "const")) checkValue(node.const, `${at}.const`);
    if (node.nullable !== undefined && typeof node.nullable !== "boolean") fail(`${at}.nullable`, "expected a boolean");
    if (node.items !== undefined) validate(asSchema(node.items, `${at}.items`), `${at}.items`, depth + 1);
    if (node.additionalProperties !== undefined) {
      validate(
        asSchema(node.additionalProperties, `${at}.additionalProperties`),
        `${at}.additionalProperties`,
        depth + 1,
      );
    }
    if (node.anyOf !== undefined) {
      if (!Array.isArray(node.anyOf) || !node.anyOf.length) fail(`${at}.anyOf`, "expected a nonempty array");
      node.anyOf.forEach((branch, index) =>
        validate(asSchema(branch, `${at}.anyOf[${index}]`), `${at}.anyOf[${index}]`, depth + 1),
      );
    }
    if (node.oneOf !== undefined) {
      if (!Array.isArray(node.oneOf) || !node.oneOf.length) fail(`${at}.oneOf`, "expected a nonempty array");
      node.oneOf.forEach((branch, index) =>
        validate(asSchema(branch, `${at}.oneOf[${index}]`), `${at}.oneOf[${index}]`, depth + 1),
      );
    }
    for (const key of [
      "minimum",
      "maximum",
      "exclusiveMinimum",
      "exclusiveMaximum",
      "multipleOf",
      "minLength",
      "maxLength",
      "minItems",
      "maxItems",
    ]) {
      const bound = node[key];
      if (bound === undefined) continue;
      if (typeof bound !== "number" || !Number.isFinite(bound)) fail(`${at}.${key}`, "expected a finite number");
      if ((key.endsWith("Length") || key.endsWith("Items")) && (!Number.isSafeInteger(bound) || bound < 0)) {
        fail(`${at}.${key}`, "expected a nonnegative integer");
      }
      if (key === "multipleOf" && bound <= 0) fail(`${at}.${key}`, "expected a positive number");
    }
  }

  /** Rejects a const or enum value nested past the depth bound, before it is cloned or compared. */
  function checkValue(value: Json, at: string, depth = 0): void {
    if (depth > 32) fail(at, "value nesting exceeds 32 levels");
    if (Array.isArray(value)) {
      for (const item of value) checkValue(item, at, depth + 1);
    } else if (record(value)) {
      for (const item of Object.values(value)) checkValue(item, at, depth + 1);
    }
  }

  function matches(value: Json, node: JsonSchema, depth = 0): boolean {
    spend(path);
    if (depth > 32) return false;
    if (typeof node === "boolean") return node;
    if (node.nullable === true && value === null) return true;
    if (node.$ref !== undefined && !matches(value, resolve(node.$ref, path), depth + 1)) return false;
    if (
      node.anyOf !== undefined &&
      !(node.anyOf as Json[]).some((branch) => matches(value, branch as JsonSchema, depth + 1))
    )
      return false;
    if (Array.isArray(node.oneOf)) {
      let matched = 0;
      for (const branch of node.oneOf as Json[]) {
        if (matches(value, branch as JsonSchema, depth + 1)) matched += 1;
        if (matched > 1) return false;
      }
      if (matched !== 1) return false;
    }
    if (Object.hasOwn(node, "const") && !equal(value, node.const)) return false;
    if (Array.isArray(node.enum) && !node.enum.some((item) => equal(item, value))) return false;
    const valueType = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    if (node.type !== undefined) {
      const list = Array.isArray(node.type) ? node.type : [node.type];
      if (
        !list.some(
          (type) => type === valueType || (type === "integer" && typeof value === "number" && Number.isInteger(value)),
        )
      )
        return false;
    }
    if (typeof value === "number") {
      if (typeof node.minimum === "number" && value < node.minimum) return false;
      if (typeof node.maximum === "number" && value > node.maximum) return false;
      if (typeof node.exclusiveMinimum === "number" && value <= node.exclusiveMinimum) return false;
      if (typeof node.exclusiveMaximum === "number" && value >= node.exclusiveMaximum) return false;
      if (
        typeof node.multipleOf === "number" &&
        Math.abs(value / node.multipleOf - Math.round(value / node.multipleOf)) > 1e-8
      )
        return false;
    }
    if (typeof value === "string" || Array.isArray(value)) {
      const length = typeof value === "string" ? Array.from(value).length : value.length;
      const min = node[typeof value === "string" ? "minLength" : "minItems"];
      const max = node[typeof value === "string" ? "maxLength" : "maxItems"];
      if (typeof min === "number" && length < min) return false;
      if (typeof max === "number" && length > max) return false;
      if (
        Array.isArray(value) &&
        node.items !== undefined &&
        !value.every((item) => matches(item, node.items as JsonSchema, depth + 1))
      )
        return false;
    }
    if (record(value)) {
      if (Array.isArray(node.required) && node.required.some((key) => !Object.hasOwn(value, key as string)))
        return false;
      const properties = record(node.properties) ? node.properties : {};
      for (const [key, item] of Object.entries(value)) {
        const child = Object.hasOwn(properties, key) ? properties[key] : node.additionalProperties;
        if (child !== undefined && !matches(item, child as JsonSchema, depth + 1)) return false;
      }
    }
    return true;
  }

  function siblings(node: Record<string, Json>, keyword: string): Record<string, Json> {
    return Object.fromEntries(Object.entries(node).filter(([key]) => key !== keyword));
  }

  /** Adds the sibling keywords a branch does not set itself, so the sample honors both where they do not conflict. */
  function mergeSchema(branch: JsonSchema, rest: Record<string, Json>): JsonSchema {
    if (typeof branch === "boolean") return branch === false ? false : rest;
    const merged: Record<string, Json> = { ...rest, ...branch };
    if (record(rest.properties) && record(branch.properties)) {
      merged.properties = { ...rest.properties, ...branch.properties };
    }
    if (Array.isArray(rest.required) && Array.isArray(branch.required)) {
      merged.required = [...new Set([...rest.required, ...branch.required])];
    }
    return merged;
  }

  /** Sample branches in order and return the first value that satisfies the node, skipping branches it cannot sample. */
  function sampleAlternative(node: Record<string, Json>, keyword: "anyOf" | "oneOf", at: string, depth: number): Json {
    const rest = siblings(node, keyword);
    const branches = node[keyword] as Json[];
    let sampled = false;
    let firstError: AiRequestError | undefined;
    for (const [index, branch] of branches.entries()) {
      const before = characters;
      try {
        const value = sample(mergeSchema(branch as JsonSchema, rest), `${at}.${keyword}[${index}]`, depth + 1);
        sampled = true;
        if (matches(value, node)) return value;
      } catch (error) {
        if (!(error instanceof AiRequestError)) throw error;
        firstError ??= error;
        characters = before;
      }
    }
    if (!sampled && firstError) throw firstError;
    if (keyword === "oneOf") fail(at, "no oneOf branch produces a value that matches exactly one branch");
    fail(at, "no anyOf branch produces a value that satisfies the schema");
  }

  function sample(node: JsonSchema, at: string, depth = 0): Json {
    if (depth > 32) fail(at, "generation exceeds the bounded schema size or recursion depth");
    spend(at);
    if (node === false) fail(at, "schema permits no value");
    if (node === true) return null;
    if (Object.hasOwn(node, "const")) {
      if (!matches(node.const, node)) fail(at, "const does not satisfy the schema");
      characters -= JSON.stringify(node.const).length;
      if (characters < 0) fail(at, "sample exceeds the bounded output size");
      return structuredClone(node.const);
    }
    if (Array.isArray(node.enum)) {
      const candidate = node.enum.find((value) => matches(value, node));
      if (candidate === undefined) fail(at, "no enum value satisfies the schema");
      characters -= JSON.stringify(candidate).length;
      if (characters < 0) fail(at, "sample exceeds the bounded output size");
      return structuredClone(candidate);
    }
    if ((node.nullable === true || depth > 8) && matches(null, node)) return null;
    let value: Json;
    if (node.$ref !== undefined) {
      const resolved = resolve(node.$ref, `${at}.$ref`);
      value = sample(mergeSchema(resolved, siblings(node, "$ref")), `${at}.$ref`, depth + 1);
    } else if (Array.isArray(node.anyOf)) {
      value = sampleAlternative(node, "anyOf", at, depth);
    } else if (Array.isArray(node.oneOf)) {
      value = sampleAlternative(node, "oneOf", at, depth);
    } else {
      const type = Array.isArray(node.type)
        ? node.type[0]
        : (node.type ?? (node.properties || node.required ? "object" : node.items ? "array" : "null"));
      switch (type) {
        case "object": {
          const properties = record(node.properties) ? node.properties : {};
          const required = new Set((node.required ?? []) as string[]);
          const entries: [string, Json][] = [];
          for (const key of required) {
            const child = Object.hasOwn(properties, key) ? properties[key] : (node.additionalProperties ?? true);
            entries.push([key, sample(child as JsonSchema, `${at}.properties.${key}`, depth + 1)]);
          }
          value = Object.fromEntries(entries);
          break;
        }
        case "array": {
          const count = typeof node.minItems === "number" ? node.minItems : 0;
          if (count > remaining) fail(`${at}.minItems`, "array exceeds the bounded output size");
          value = Array.from({ length: count }, (_, index) =>
            sample((node.items ?? true) as JsonSchema, `${at}.items[${index}]`, depth + 1),
          );
          break;
        }
        case "string": {
          const known = typeof node.format === "string" ? formatSamples[node.format] : undefined;
          if (known !== undefined) {
            characters -= known.length;
            if (characters < 0) fail(at, "sample exceeds the bounded output size");
            value = known;
            break;
          }
          if (node.pattern !== undefined) {
            fail(at, "the sampler cannot generate a string for a pattern");
          }
          const min = typeof node.minLength === "number" ? node.minLength : 0;
          const max = typeof node.maxLength === "number" ? node.maxLength : 65536;
          const length = Math.max(min, Math.min(seedText.length, max));
          characters -= length;
          if (length > 65536 || characters < 0) fail(at, "string exceeds the bounded output size");
          value = Array.from({ length }, (_, index) => seedText[index % seedText.length]).join("");
          break;
        }
        case "integer":
        case "number": {
          let step = typeof node.multipleOf === "number" ? node.multipleOf : type === "integer" ? 1 : undefined;
          if (type === "integer" && step !== undefined && !Number.isInteger(step)) {
            const [coefficient, exponent = "0"] = step.toString().split("e");
            const decimals = coefficient.split(".")[1]?.length ?? 0;
            const scale = 10 ** Math.max(0, decimals - Number(exponent));
            let numerator = Math.round(step * scale);
            let denominator = scale;
            while (denominator) [numerator, denominator] = [denominator, numerator % denominator];
            step = Math.round(step * scale) / numerator;
          }
          const low = Math.max(
            typeof node.minimum === "number" ? node.minimum : -Infinity,
            typeof node.exclusiveMinimum === "number" ? node.exclusiveMinimum : -Infinity,
          );
          const high = Math.min(
            typeof node.maximum === "number" ? node.maximum : Infinity,
            typeof node.exclusiveMaximum === "number" ? node.exclusiveMaximum : Infinity,
          );
          let number = Number.isFinite(low) ? low : Math.min(0, high);
          if (step !== undefined) {
            const [coefficient, exponent = "0"] = step.toString().split("e");
            const decimals = coefficient.split(".")[1]?.length ?? 0;
            const digits = Number(coefficient.replace(".", ""));
            const multiply = (count: number) => {
              const [product, shift = "0"] = (count * digits).toString().split("e");
              return Number(`${product}e${Number(shift) + Number(exponent) - decimals}`);
            };
            let count = Math.round(number / step);
            if (Number.isFinite(low) && multiply(count) < low) count++;
            if (!Number.isFinite(low) && multiply(count) > high) count--;
            if (multiply(count) === node.exclusiveMinimum) count++;
            if (multiply(count) === node.exclusiveMaximum && !Number.isFinite(low)) count--;
            number = multiply(count);
          } else {
            if (number === node.exclusiveMinimum) number = adjacentNumber(number, 1);
            if (number === node.exclusiveMaximum) number = adjacentNumber(number, -1);
          }
          if (!Number.isFinite(number)) fail(at, "numeric bounds permit no finite sample");
          value = number;
          break;
        }
        case "boolean":
          value = false;
          break;
        case "null":
          value = null;
          break;
        default:
          fail(`${at}.type`, "unsupported type");
      }
    }
    if (!matches(value, node)) fail(at, "constraints do not permit the generated sample");
    return value;
  }

  validate(schema, path);
  const value = sample(schema, path);
  if (JSON.stringify(value).length > 262144) fail(path, "sample exceeds the bounded output size");
  return value;
}

/** Estimate one token per four characters; output includes its reasoning share. */
export function estimateUsage(request: AIRequest, events: ReplyEvent[]): Usage {
  const input = JSON.stringify({ messages: request.messages, tools: request.tools, output: request.output }).length;
  let output = 0;
  let reasoning = 0;
  for (const event of events) {
    const text =
      event.type === "object"
        ? JSON.stringify(event.value)
        : event.type === "tool_call"
          ? event.name + event.arguments
          : event.text;
    const tokens = Math.ceil(text.length / 4);
    output += tokens;
    if (event.type === "reasoning") reasoning += tokens;
  }
  return { input: Math.ceil(input / 4), output, reasoning };
}

/** Apply permissive defaults, choosing forced tools before structured output and text. */
export function defaultReply(request: AIRequest, makeId: (prefix: string) => string): Reply {
  const text = latestUserText(request);
  let event: ReplyEvent;
  if (request.toolChoice === "required" || typeof request.toolChoice === "object") {
    const choice = request.toolChoice;
    const tool =
      typeof choice === "object" ? request.tools.find((tool) => tool.name === choice.name) : request.tools[0];
    if (!tool) throw new AiRequestError("Forced tool choice requires a declared tool.", "tool_choice");
    const args = sampleSchema(tool.parameters ?? { type: "object" }, text, `tools.${tool.name}.parameters`);
    event = { type: "tool_call", id: makeId("call"), name: tool.name, arguments: JSON.stringify(args) };
  } else if (request.output) {
    event = {
      type: "object",
      value: request.output.kind === "json_object" ? {} : sampleSchema(request.output.schema, text),
    };
  } else {
    const latest = request.messages.at(-1);
    const result = latest?.parts.at(-1);
    const files =
      [...request.messages]
        .reverse()
        .find((message) => message.role === "user")
        ?.parts.filter((part) => part.type === "file") ?? [];
    const acknowledgement =
      result?.type === "tool_result" ? `Received the result of ${result.name ?? result.id}.` : undefined;
    event = {
      type: "text",
      text:
        acknowledgement ??
        (text ||
          (files.length
            ? `Received ${files.length} files (${files.map((file) => file.name ?? file.mediaType).join(", ")}).`
            : "")),
    };
  }
  const events = [event];
  return { events, finish: event.type === "tool_call" ? "tool_calls" : "stop", usage: estimateUsage(request, events) };
}

/** Describe a strict miss with a seed rule and a rules-endpoint replacement body. */
export function strictMissFailure(request: AIRequest, exhaustedRuleIds: string[]): HttpFailure {
  const match = { model: request.model, format: request.format };
  const rule = { id: "matching-reply", match, reply: [{ type: "text", text: "Replace with your expected reply." }] };
  const yaml = [
    "ai:",
    "  rules:",
    `    - id: ${rule.id}`,
    "      match:",
    `        model: ${JSON.stringify(request.model)}`,
    `        format: ${request.format}`,
    "      reply:",
    "        - type: text",
    `          text: ${JSON.stringify(rule.reply[0].text)}`,
  ].join("\n");
  return {
    status: 400,
    type: "invalid_request_error",
    message: [
      `No AI rule matched model ${JSON.stringify(request.model)} with tools ${JSON.stringify(request.tools.map((tool) => tool.name))}.`,
      ...(exhaustedRuleIds.length
        ? [`Exhausted matching rules: ${exhaustedRuleIds.map((id) => JSON.stringify(id)).join(", ")}.`]
        : []),
      `Add a matching rule to your seed configuration:\n${yaml}`,
      `Or PUT /_ai/rules with this JSON body (include any existing rules you want to keep):\n${JSON.stringify({ rules: [rule] }, null, 2)}`,
    ].join("\n\n"),
  };
}
