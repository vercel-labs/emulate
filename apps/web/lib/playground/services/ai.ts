import type { ConsoleService, ConsoleVariable } from "./types";

const JSON_HEADERS = { "Content-Type": "application/json" };
const MESSAGES_HEADERS = { ...JSON_HEADERS, "anthropic-version": "2023-06-01" };
const WEATHER_PARAMETERS = {
  type: "object",
  properties: { city: { type: "string" } },
  required: ["city"],
};

function json(body: unknown): string {
  return JSON.stringify(body, null, 2);
}

const variables: ConsoleVariable[] = [
  {
    name: "response_id",
    label: "Response id",
    hint: "Filled in when you run Create a response. A stored response can be continued, read, and deleted.",
  },
];

/** AI requests for the request console: the three wire formats the emulator answers, plus its control routes. */
export const ai: ConsoleService = {
  name: "ai",
  label: "AI",
  description: "OpenAI Chat Completions and Responses and Anthropic Messages, answered by rules instead of a model.",
  variables,
  groups: [
    {
      title: "Chat Completions",
      presets: [
        {
          label: "Echo a message",
          description: "No rule matches this text, so the default reply repeats the latest user message.",
          method: "POST",
          path: "/v1/chat/completions",
          headers: JSON_HEADERS,
          body: json({ model: "gpt-4o", messages: [{ role: "user", content: "Say this back to me" }] }),
        },
        {
          label: "Match a rule",
          description: "The seeded greeting rule answers any message that contains hello.",
          method: "POST",
          path: "/v1/chat/completions",
          headers: JSON_HEADERS,
          body: json({ model: "gpt-4o", messages: [{ role: "user", content: "hello there" }] }),
        },
        {
          label: "Stream a reply",
          description: "Returns the reply as server-sent events, ending with [DONE].",
          method: "POST",
          path: "/v1/chat/completions",
          headers: JSON_HEADERS,
          body: json({ model: "gpt-4o", stream: true, messages: [{ role: "user", content: "hello there" }] }),
        },
        {
          label: "Ask for structured output",
          description: "No rule is needed: the default reply is generated to fit the JSON Schema.",
          method: "POST",
          path: "/v1/chat/completions",
          headers: JSON_HEADERS,
          body: json({
            model: "gpt-4o",
            messages: [{ role: "user", content: "Describe a city" }],
            response_format: {
              type: "json_schema",
              json_schema: {
                name: "city",
                schema: {
                  type: "object",
                  properties: { name: { type: "string" }, population: { type: "integer" } },
                  required: ["name", "population"],
                  additionalProperties: false,
                },
              },
            },
          }),
        },
        {
          label: "Call a tool",
          description: "The seeded weather rule answers a request that declares get_weather with a tool call.",
          method: "POST",
          path: "/v1/chat/completions",
          headers: JSON_HEADERS,
          body: json({
            model: "gpt-4o",
            messages: [{ role: "user", content: "What is the weather in Paris?" }],
            tools: [{ type: "function", function: { name: "get_weather", parameters: WEATHER_PARAMETERS } }],
          }),
        },
      ],
    },
    {
      title: "Responses",
      presets: [
        {
          label: "Create a response",
          description: "Stores the response and keeps its id, so the next requests can use it.",
          method: "POST",
          path: "/v1/responses",
          headers: JSON_HEADERS,
          body: json({ model: "gpt-4o", input: "hello there" }),
          captures: { response_id: "id" },
        },
        {
          label: "Continue the conversation",
          description: "Sends a new turn on top of the stored response. Run Create a response first.",
          method: "POST",
          path: "/v1/responses",
          headers: JSON_HEADERS,
          body: json({ model: "gpt-4o", input: "Say this back to me", previous_response_id: "{{response_id}}" }),
        },
        {
          label: "Get a stored response",
          description: "Reads the stored response back. Run Create a response first.",
          method: "GET",
          path: "/v1/responses/{{response_id}}",
        },
        {
          label: "Delete a stored response",
          description: "Removes the stored response. Run Create a response first.",
          method: "DELETE",
          path: "/v1/responses/{{response_id}}",
        },
      ],
    },
    {
      title: "Messages",
      presets: [
        {
          label: "Send a message",
          description: "The Anthropic wire format: max_tokens is required and the reply is a list of content blocks.",
          method: "POST",
          path: "/v1/messages",
          headers: MESSAGES_HEADERS,
          body: json({
            model: "claude-sonnet-4-5",
            max_tokens: 256,
            messages: [{ role: "user", content: "hello there" }],
          }),
        },
        {
          label: "Stop at a stop sequence",
          description: "The reply is cut at the first stop sequence and reports stop_reason stop_sequence.",
          method: "POST",
          path: "/v1/messages",
          headers: MESSAGES_HEADERS,
          body: json({
            model: "claude-sonnet-4-5",
            max_tokens: 256,
            stop_sequences: ["back"],
            messages: [{ role: "user", content: "Say this back to me" }],
          }),
        },
        {
          label: "Stream a message",
          description: "Returns the reply as Anthropic's server-sent events, from message_start to message_stop.",
          method: "POST",
          path: "/v1/messages",
          headers: MESSAGES_HEADERS,
          body: json({
            model: "claude-sonnet-4-5",
            max_tokens: 256,
            stream: true,
            messages: [{ role: "user", content: "hello there" }],
          }),
        },
      ],
    },
    {
      title: "Models and control",
      presets: [
        {
          label: "List models",
          description: "Lists the seeded models and every model an earlier request named. No input needed.",
          method: "GET",
          path: "/v1/models",
        },
        {
          label: "List rules",
          description: "Returns the active rules with their remaining budgets, in the shape PUT accepts.",
          method: "GET",
          path: "/_ai/rules",
        },
        {
          label: "List recorded calls",
          description: "Returns every generation request so far, oldest first, with the rule that answered it.",
          method: "GET",
          path: "/_ai/calls",
        },
        {
          label: "Restore the seed",
          description: "Restores the seeded rules, budgets, ids, call record, and stored responses.",
          method: "POST",
          path: "/_ai/reset",
        },
      ],
    },
  ],
};
