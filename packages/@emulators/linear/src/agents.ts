import type {
  LinearAgentActivityContent,
  LinearAgentActivitySignal,
  LinearAgentActivityType,
  LinearAgentAuthSignalMetadata,
  LinearAgentExternalUrl,
  LinearAgentPlanStep,
  LinearAgentPlanStepStatus,
  LinearAgentSelectOption,
  LinearAgentSelectSignalMetadata,
  LinearAgentSessionStatus,
  LinearAgentActivitySignalMetadata,
} from "./entities.js";

export interface SessionLinks {
  external_link: string | null;
  external_urls: LinearAgentExternalUrl[];
}

export interface ParsedAgentActivityCreate {
  agentSessionId: string;
  content: LinearAgentActivityContent;
  ephemeral: boolean;
  signal: LinearAgentActivitySignal | null;
  signalMetadata: LinearAgentActivitySignalMetadata | null;
}

export interface ParsedAgentPromptActivityCreate {
  agentSessionId: string;
  content: Extract<LinearAgentActivityContent, { type: "prompt" }>;
  signal: "stop" | null;
  signalMetadata: null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value === "string" && value.trim()) return value;
  throw new Error(`${field} is required`);
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function stringInput(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function arrayInput(value: unknown, fallback: string[] = []): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : fallback;
}

export function normalizeActivityType(value: string): LinearAgentActivityType {
  if (
    value === "thought" ||
    value === "elicitation" ||
    value === "action" ||
    value === "response" ||
    value === "error" ||
    value === "prompt"
  ) {
    return value;
  }
  throw new Error(`Unsupported agent activity type: ${value}`);
}

export function normalizeActivitySignal(value: string | undefined): LinearAgentActivitySignal | null {
  if (!value) return null;
  if (value === "auth" || value === "continue" || value === "select" || value === "stop") return value;
  throw new Error(`Unsupported agent activity signal: ${value}`);
}

export function normalizePlanStepStatus(value: string): LinearAgentPlanStepStatus {
  if (value === "pending" || value === "inProgress" || value === "completed" || value === "canceled") {
    return value;
  }
  throw new Error(`Unsupported plan step status: ${value}`);
}

export function parsePlanInput(value: unknown): LinearAgentPlanStep[] | null {
  if (value == null) return null;
  if (!Array.isArray(value)) {
    throw new Error("plan must be an array of { content, status } steps");
  }
  if (value.length === 0) return [];
  return value.map((step, index) => {
    if (!isRecord(step)) throw new Error(`plan[${index}] must be an object`);
    return {
      content: requiredString(step.content, `plan[${index}].content`),
      status: normalizePlanStepStatus(requiredString(step.status, `plan[${index}].status`)),
    };
  });
}

export function parseExternalUrlList(value: unknown, field: string): LinearAgentExternalUrl[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  const urls = value.map((item, index) => {
    if (!isRecord(item)) throw new Error(`${field}[${index}] must be an object`);
    return {
      label: requiredString(item.label, `${field}[${index}].label`),
      url: requiredString(item.url, `${field}[${index}].url`),
    };
  });
  const seen = new Set<string>();
  for (const item of urls) {
    if (seen.has(item.url)) throw new Error(`${field} URLs must be unique`);
    seen.add(item.url);
  }
  return urls;
}

export function parseSessionLinksInput(input: Record<string, unknown>): SessionLinks {
  const externalLink = nullableString(input.externalLink);
  const externalUrls = "externalUrls" in input ? parseExternalUrlList(input.externalUrls, "externalUrls") : [];
  if (externalLink && !externalUrls.some((link) => link.url === externalLink)) {
    externalUrls.unshift({ label: "Open", url: externalLink });
  }
  return {
    external_link: externalLink ?? externalUrls[0]?.url ?? null,
    external_urls: externalUrls,
  };
}

export function applyExternalUrlUpdates(current: SessionLinks, input: Record<string, unknown>): SessionLinks {
  let externalUrls = [...current.external_urls];
  let externalLink = current.external_link;

  if ("externalUrls" in input) {
    externalUrls = parseExternalUrlList(input.externalUrls, "externalUrls");
  } else {
    if ("addedExternalUrls" in input) {
      const added = parseExternalUrlList(input.addedExternalUrls, "addedExternalUrls");
      for (const link of added) {
        const idx = externalUrls.findIndex((existing) => existing.url === link.url);
        if (idx >= 0) externalUrls[idx] = link;
        else externalUrls.push(link);
      }
    }
    if ("removedExternalUrls" in input) {
      const removed = arrayInput(input.removedExternalUrls);
      externalUrls = externalUrls.filter((link) => !removed.includes(link.url));
    }
  }

  if ("externalLink" in input) {
    externalLink = nullableString(input.externalLink);
    if (externalLink && !externalUrls.some((link) => link.url === externalLink)) {
      externalUrls = [{ label: "Open", url: externalLink }, ...externalUrls];
    }
  } else if (!externalLink) {
    externalLink = externalUrls[0]?.url ?? null;
  }

  if (externalLink && !externalUrls.some((link) => link.url === externalLink)) {
    externalLink = externalUrls[0]?.url ?? null;
  }

  return { external_link: externalLink, external_urls: externalUrls };
}

function parseSelectOptions(value: unknown, field: string): LinearAgentSelectOption[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value.map((option, index) => {
    if (!isRecord(option)) throw new Error(`${field}[${index}] must be an object`);
    const parsed: LinearAgentSelectOption = {
      value: requiredString(option.value, `${field}[${index}].value`),
    };
    if (typeof option.label === "string") parsed.label = option.label;
    return parsed;
  });
}

/**
 * Parse and validate nested activity content into a discriminated union.
 * Invalid type-specific fields throw.
 */
export function parseActivityContentInput(input: Record<string, unknown>): LinearAgentActivityContent {
  if (isRecord(input.content)) {
    return buildActivityContent(input.content, "content");
  }
  throw new Error("agentActivityCreate requires content { type, ... }");
}

function buildActivityContent(raw: Record<string, unknown>, prefix: string): LinearAgentActivityContent {
  const type = normalizeActivityType(requiredString(raw.type, `${prefix}.type`));

  switch (type) {
    case "thought":
    case "elicitation":
    case "response":
      return { type, body: requiredString(raw.body, `${prefix}.body`) };
    case "error": {
      const content: Extract<LinearAgentActivityContent, { type: "error" }> = {
        type,
        body: requiredString(raw.body, `${prefix}.body`),
      };
      if (typeof raw.reasonCode === "string" && raw.reasonCode.trim()) {
        content.reasonCode = raw.reasonCode;
      }
      return content;
    }
    case "prompt": {
      const content: Extract<LinearAgentActivityContent, { type: "prompt" }> = {
        type,
        body: activityBody(raw, prefix),
      };
      if (typeof raw.title === "string" && raw.title.trim()) {
        content.title = raw.title;
      }
      return content;
    }
    case "action": {
      const content: Extract<LinearAgentActivityContent, { type: "action" }> = {
        type,
        action: requiredString(raw.action, `${prefix}.action`),
        parameter: requiredString(raw.parameter, `${prefix}.parameter`),
      };
      if (typeof raw.result === "string") {
        content.result = raw.result;
      }
      return content;
    }
  }
}

/**
 * Parse signal metadata and enforce shape based on signal type.
 * Returns null when no signal is set.
 */
export function parseSignalAndMetadata(
  signalRaw: string | undefined,
  metadataRaw: unknown,
): {
  signal: LinearAgentActivitySignal | null;
  signalMetadata: LinearAgentActivitySignalMetadata | null;
} {
  const signal = normalizeActivitySignal(signalRaw);
  if (!signal) {
    if (metadataRaw != null) {
      throw new Error("signalMetadata requires signal");
    }
    return { signal: null, signalMetadata: null };
  }

  if (signal === "stop" || signal === "continue") {
    if (metadataRaw != null && isRecord(metadataRaw) && Object.keys(metadataRaw).length > 0) {
      throw new Error(`${signal} signal does not accept signalMetadata fields`);
    }
    return { signal, signalMetadata: null };
  }

  if (signal === "auth") {
    if (!isRecord(metadataRaw)) throw new Error("auth signal requires signalMetadata with url");
    const metadata: LinearAgentAuthSignalMetadata = {
      url: requiredString(metadataRaw.url, "signalMetadata.url"),
    };
    if (typeof metadataRaw.userId === "string" && metadataRaw.userId.trim()) {
      metadata.userId = metadataRaw.userId;
    }
    if (typeof metadataRaw.providerName === "string" && metadataRaw.providerName.trim()) {
      metadata.providerName = metadataRaw.providerName;
    }
    return { signal, signalMetadata: metadata };
  }

  // select
  if (!isRecord(metadataRaw)) throw new Error("select signal requires signalMetadata with options");
  const metadata: LinearAgentSelectSignalMetadata = {
    options: parseSelectOptions(metadataRaw.options, "signalMetadata.options"),
  };
  if (metadata.options.length === 0) {
    throw new Error("select signal requires at least one option");
  }
  return { signal, signalMetadata: metadata };
}

export function validateSignalForActivityType(
  type: LinearAgentActivityType,
  signal: LinearAgentActivitySignal | null,
): void {
  if (!signal) return;
  if (signal === "stop" && type !== "prompt") {
    throw new Error("stop signal is only valid on prompt activities");
  }
  if ((signal === "auth" || signal === "select") && type !== "elicitation") {
    throw new Error(`${signal} signal is only valid on elicitation activities`);
  }
  // continue is accepted on any type; production uses it as a soft modifier.
  void type;
}

export function parseAgentActivityCreateInput(input: Record<string, unknown>): ParsedAgentActivityCreate {
  const agentSessionId = stringInput(input.agentSessionId);
  if (!agentSessionId) {
    throw new Error("agentSessionId is required");
  }

  const content = parseActivityContentInput(input);
  if (content.type === "prompt") {
    throw new Error("Agents cannot create prompt activities");
  }
  // Validate signal/type pairing before requiring metadata so callers get the clearer error first.
  const signal = normalizeActivitySignal(stringInput(input.signal));
  validateSignalForActivityType(content.type, signal);
  const { signalMetadata } = parseSignalAndMetadata(stringInput(input.signal), input.signalMetadata);

  const ephemeral = typeof input.ephemeral === "boolean" ? input.ephemeral : false;
  if (ephemeral && content.type !== "thought" && content.type !== "action") {
    throw new Error("Only thought or action activities can be marked ephemeral");
  }

  return {
    agentSessionId,
    content,
    ephemeral,
    signal,
    signalMetadata,
  };
}

export function parseAgentPromptActivityCreateInput(input: Record<string, unknown>): ParsedAgentPromptActivityCreate {
  const agentSessionId = stringInput(input.agentSessionId);
  if (!agentSessionId) throw new Error("agentSessionId is required");
  if (!isRecord(input.content)) throw new Error("content is required");
  const content = buildActivityContent(input.content, "content");
  if (content.type !== "prompt") throw new Error("content.type must be prompt");
  const signal = normalizeActivitySignal(stringInput(input.signal));
  if (signal !== null && signal !== "stop") {
    throw new Error("Only the stop signal is valid on prompt activities");
  }
  parseSignalAndMetadata(signal ?? undefined, input.signalMetadata);
  return {
    agentSessionId,
    content,
    signal,
    signalMetadata: null,
  };
}

export function statusFromActivity(
  type: LinearAgentActivityType,
  _signal: LinearAgentActivitySignal | null,
): LinearAgentSessionStatus {
  switch (type) {
    case "thought":
    case "action":
    case "prompt":
      return "active";
    case "elicitation":
      return "awaitingInput";
    case "response":
      return "complete";
    case "error":
      return "error";
  }
}

/** Production-shaped content JSON: only fields for the activity type. */
export function activityContentAsJSON(content: LinearAgentActivityContent): Record<string, unknown> {
  switch (content.type) {
    case "thought":
    case "elicitation":
    case "response":
      return { type: content.type, body: content.body };
    case "error":
      return content.reasonCode
        ? { type: content.type, body: content.body, reasonCode: content.reasonCode }
        : { type: content.type, body: content.body };
    case "prompt":
      return content.title
        ? { type: content.type, body: content.body, title: content.title }
        : { type: content.type, body: content.body };
    case "action":
      return content.result !== undefined
        ? {
            type: content.type,
            action: content.action,
            parameter: content.parameter,
            result: content.result,
          }
        : { type: content.type, action: content.action, parameter: content.parameter };
  }
}

export function activityContentAsGraphQL(content: LinearAgentActivityContent): Record<string, unknown> {
  const typeNames: Record<LinearAgentActivityType, string> = {
    action: "AgentActivityActionContent",
    elicitation: "AgentActivityElicitationContent",
    error: "AgentActivityErrorContent",
    prompt: "AgentActivityPromptContent",
    response: "AgentActivityResponseContent",
    thought: "AgentActivityThoughtContent",
  };
  const json = activityContentAsJSON(content);
  if (content.type === "action") {
    return {
      __typename: typeNames[content.type],
      ...json,
      resultData: content.result === undefined ? null : proseMirrorDocument(content.result),
    };
  }
  return {
    __typename: typeNames[content.type],
    ...json,
    bodyData: proseMirrorDocument(content.body),
  };
}

function activityBody(raw: Record<string, unknown>, prefix: string): string {
  if (typeof raw.body === "string" && raw.body.trim()) return raw.body;
  const body = proseMirrorText(raw.bodyData).trim();
  if (body) return body;
  throw new Error(`${prefix}.body or ${prefix}.bodyData is required`);
}

function proseMirrorText(value: unknown): string {
  if (Array.isArray(value)) return value.map(proseMirrorText).join("");
  if (!isRecord(value)) return "";
  const ownText = typeof value.text === "string" ? value.text : "";
  return ownText + proseMirrorText(value.content);
}

function proseMirrorDocument(text: string): Record<string, unknown> {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: text ? [{ type: "text", text }] : [],
      },
    ],
  };
}
