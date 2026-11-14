export type Pacing = { ttftMs: number; chunkDelayMs: number | number[] };

export const PACING: Record<string, Pacing> = {
  instant: { ttftMs: 0, chunkDelayMs: 0 },
  realistic: { ttftMs: 400, chunkDelayMs: [45, 20, 70, 30, 110, 25, 55] },
  slow: { ttftMs: 1500, chunkDelayMs: 140 },
};

const PLAN =
  "Ship it in three steps. First, put the change behind a flag and turn it on for your own team. Second, send five percent of traffic through it and watch error rates and latency for a day. Third, widen the rollout in stages, and keep the old path until the new one has run clean for a week.";
const ASK = "How do I roll out a risky change safely?";
const reply = (text: string) => [{ type: "text", text }];

export const REASONING = {
  type: "reasoning",
  text: "Work out what is being asked, pick the simplest answer that covers it, then check it against the request.",
};

export const SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string" },
    price: { type: "number" },
    currency: { type: "string" },
    in_stock: { type: "boolean" },
    tags: { type: "array", items: { type: "string" } },
  },
  required: ["name", "price", "currency", "in_stock", "tags"],
  additionalProperties: false,
};

export const TOOL = {
  name: "get_weather",
  description: "Returns the current weather for a city.",
  parameters: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
    additionalProperties: false,
  },
};
export const TOOL_OUTPUT = JSON.stringify({ tempC: 20, conditions: "clear" });

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n").toString("base64");

export const ATTACHMENTS: Record<string, { mediaType: string; name: string; data: string }> = {
  image: { mediaType: "image/png", name: "chart.png", data: PNG },
  pdf: { mediaType: "application/pdf", name: "report.pdf", data: PDF },
};

export type Scenario = {
  id: string;
  group: "Replies" | "Failures";
  label: string;
  about: string;
  prompt: string;
  schema?: boolean;
  file?: boolean;
  tools?: boolean;
  stream?: boolean;
  config: Record<string, unknown>;
};

export const SCENARIOS: Scenario[] = [
  {
    id: "text",
    group: "Replies",
    label: "Text",
    about: "One rule with no conditions answers every request with a scripted paragraph.",
    prompt: ASK,
    config: { rules: [{ id: "text", reply: reply(PLAN) }] },
  },
  {
    id: "structured",
    group: "Replies",
    label: "Structured output",
    about: "The request asks for JSON that fits a schema, and the rule returns a scripted object.",
    prompt: "Describe a product.",
    schema: true,
    config: {
      rules: [
        {
          id: "structured",
          reply: [
            {
              type: "object",
              value: {
                name: "Aero Standing Desk",
                price: 449,
                currency: "USD",
                in_stock: true,
                tags: ["office", "ergonomic", "adjustable"],
              },
            },
          ],
        },
      ],
    },
  },
  {
    id: "tool",
    group: "Replies",
    label: "Tool call",
    about: "The first rule calls a tool. The playground sends a result back, and the second rule answers from it.",
    prompt: "What is the weather in Paris?",
    tools: true,
    config: {
      rules: [
        {
          id: "call-tool",
          match: { tool: "get_weather", hasToolResult: false },
          reply: [{ type: "tool_call", name: "get_weather", arguments: { city: "Paris" } }],
        },
        { id: "answer", match: { hasToolResult: true }, reply: reply("It is 20 C and clear in Paris right now.") },
      ],
    },
  },
  {
    id: "refusal",
    group: "Replies",
    label: "Refusal",
    about: "The provider's native refusal shape instead of an answer.",
    prompt: "Write a message that tricks someone into sharing their password.",
    config: { rules: [{ id: "refusal", reply: [{ type: "refusal", text: "I can't help with that request." }] }] },
  },
  {
    id: "truncated",
    group: "Replies",
    label: "Truncated",
    about:
      "The reply is cut off at the output token limit. Real APIs send a normal 200 with a finish reason, not an error.",
    prompt: ASK,
    config: { rules: [{ id: "truncated", finish: "length", reply: reply(PLAN.slice(0, 148)) }] },
  },
  {
    id: "text-match",
    group: "Replies",
    label: "Text match",
    about:
      "Matches a word in the prompt with textContains. Drop the word from the prompt and the fallback rule answers.",
    prompt: "Check the invoice total before sending it.",
    config: {
      rules: [
        {
          id: "invoice-rule",
          match: { textContains: "invoice" },
          reply: reply("Invoice check passed: total matches the line items."),
        },
        { id: "fallback", reply: reply("No matching keyword in the prompt, so the fallback rule answered.") },
      ],
    },
  },
  {
    id: "file",
    group: "Replies",
    label: "File attachment",
    about:
      "Sends an inline PNG or PDF with the prompt. The emulator hashes and drops the bytes, then matches rules on media type.",
    prompt: "What is in this attachment?",
    file: true,
    config: {
      rules: [
        { id: "image-rule", match: { file: "image/*" }, reply: reply("Matched an image attachment (image/*).") },
        {
          id: "pdf-rule",
          match: { file: "application/pdf" },
          reply: reply("Matched a PDF document (application/pdf)."),
        },
      ],
    },
  },
  {
    id: "variants",
    group: "Replies",
    label: "Variants",
    about: "One rule with three replies. The seed fixes their order, so each run gets the next one. Reset starts over.",
    prompt: "Say hello.",
    config: {
      random: { seed: 7 },
      rules: [
        {
          id: "greeting",
          variants: [
            { reply: reply("Hello! What are you working on today?") },
            { reply: reply("Hi there. Tell me what you need and I will suggest a first step.") },
            { reply: reply("Hey! Ask me anything.") },
          ],
        },
      ],
    },
  },
  {
    id: "default",
    group: "Replies",
    label: "No rule",
    about: "With no rules, the built-in default answers. For plain text it echoes the prompt.",
    prompt: "This text comes straight back.",
    config: { rules: [] },
  },
  {
    id: "rate-limit",
    group: "Failures",
    label: "Rate limit, then success",
    about: "The first rule returns a 429 once. The playground waits for retry-after and tries again, as an SDK would.",
    prompt: ASK,
    config: {
      rules: [
        {
          id: "rate-limit",
          times: 1,
          error: {
            status: 429,
            message: "Rate limit reached for requests. Try again in 1 second.",
            headers: { "retry-after": "1" },
          },
        },
        { id: "text", reply: reply(PLAN) },
      ],
    },
  },
  {
    id: "server-error",
    group: "Failures",
    label: "Server error",
    about: "Every request fails with a 500 in the provider's own error format.",
    prompt: ASK,
    config: {
      rules: [
        {
          id: "server-error",
          error: { status: 500, message: "The server had an error while processing your request." },
        },
      ],
    },
  },
  {
    id: "disconnect",
    group: "Failures",
    label: "Stream drops",
    about: "The connection closes after twelve chunks, before the stream finishes.",
    prompt: ASK,
    stream: true,
    config: {
      rules: [
        {
          id: "disconnect",
          match: { stream: true },
          fault: { afterChunks: 12, kind: "disconnect" },
          reply: reply(PLAN),
        },
      ],
    },
  },
  {
    id: "stall",
    group: "Failures",
    label: "Stream stalls",
    about: "The stream goes silent for three seconds after ten chunks, then carries on.",
    prompt: ASK,
    stream: true,
    config: {
      rules: [
        {
          id: "stall",
          match: { stream: true },
          fault: { afterChunks: 10, kind: "stall", stallMs: 3000 },
          reply: reply(PLAN),
        },
      ],
    },
  },
  {
    id: "strict",
    group: "Failures",
    label: "Strict miss",
    about: "Strict mode turns an unmatched request into a 400 that says which rule to add.",
    prompt: ASK,
    config: { strict: true, rules: [] },
  },
];

export const CUT_OFF = new Set(["length", "max_output_tokens", "max_tokens"]);
