---
name: ai
description: Mock OpenAI Responses, Chat Completions, and Anthropic Messages for deterministic tests without API keys or external network access. Use for SDK integration, tool loops, structured output, retries, and stream failures.
allowed-tools: Bash(npx emulate:*), Bash(curl:*)
---

# AI provider emulator

Rules and deterministic defaults control replies. For the full API reference, see [AI Responses](https://emulate.dev/docs/ai).

## Start

```bash
npx emulate start --service ai --port 4014
```

Port `4014` is the default when all services start together. Starting `ai` alone without `--port` uses `EMULATE_PORT`, `PORT`, or `4000`.

To start in code, use `createEmulator({ service: "ai", port: 4014, seed: { ai: { rules: [] } } })` from `emulate`.

## Clients

```typescript
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { createOpenAI } from "@ai-sdk/openai";

const client = new OpenAI({ apiKey: "test", baseURL: "http://localhost:4014/v1" });
const anthropic = new Anthropic({ apiKey: "test", baseURL: "http://localhost:4014" });
const openai = createOpenAI({ apiKey: "test", baseURL: "http://localhost:4014/v1" });

await client.responses.create({ model: "gpt-x", input: "Hi" });
await client.chat.completions.create({ model: "gpt-x", messages: [{ role: "user", content: "Hi" }] });
await anthropic.messages.create({ model: "claude-x", max_tokens: 16, messages: [{ role: "user", content: "Hi" }] });
```

- The Anthropic SDK appends `/v1/messages`; omit `/v1` from `baseURL`.
- In the AI SDK, `openai("gpt-x")` uses Responses and `openai.chat("gpt-x")` uses Chat Completions.
- `@ai-sdk/openai-compatible` uses Chat Completions. For `generateObject`, set `supportsStructuredOutputs: true` to send a schema, or script an object reply instead of the schema-free `{}` default.
- For Vercel AI Gateway, point your OpenAI-compatible client at `http://localhost:4014/v1` or set `OPENAI_BASE_URL`. The private `@ai-sdk/gateway` protocol is unsupported.
- Use a placeholder API key if your SDK requires one, such as `OPENAI_API_KEY=test`. Replies echo any model id, including `provider/model` slugs.

## Routes

The emulator matches routes by path suffix, so any prefix works (such as `/v1` or `/api/v1`).

| Method   | Path                   | Behavior                                        |
| -------- | ---------------------- | ----------------------------------------------- |
| `POST`   | `/v1/responses`        | OpenAI Responses                                |
| `POST`   | `/v1/chat/completions` | OpenAI Chat Completions                         |
| `POST`   | `/v1/messages`         | Anthropic Messages                              |
| `GET`    | `/v1/responses/:id`    | Retrieve a stored response                      |
| `DELETE` | `/v1/responses/:id`    | Delete a stored response                        |
| `GET`    | `/v1/models`           | List configured and previously requested models |

Generation routes support streaming and send a deterministic id: `x-request-id` for OpenAI and `request-id` for Anthropic.

### Anthropic Messages

- Send `model`, `messages`, and a positive integer `max_tokens`. Set `system` at the top level.
- `output_config.format` accepts a JSON Schema. The result is a `text` block containing JSON.
- Client tools may omit `input_schema`, including bash, text editor, computer use, and memory.
- Hosted tools return 400: `web_search_*`, `web_fetch_*`, `code_execution_*`, `tool_search_tool_*`, and `mcp_toolset`.
- Streams use Anthropic message and content block events. Tool inputs use `input_json_delta`.
- Unsupported Messages paths, or any unsupported data path with `anthropic-version`, return Anthropic's `not_found_error`.

## Defaults

When no rule matches:

| Request                    | Reply                                                   |
| -------------------------- | ------------------------------------------------------- |
| Plain text                 | Echoes the latest user text                             |
| Attachments only           | `Received N files (...)` with file names or media types |
| JSON mode without a schema | `{}`                                                    |
| Supported schema           | Deterministic, schema-valid object                      |
| Forced tool choice         | Tool call with arguments generated from its schema      |
| Tool result                | `Received the result of <tool or call id>.`             |

## Schema validation and generation

On Chat Completions (`response_format`) and Responses (`text.format`), model ids starting with `claude` (with or without a prefix like `anthropic/`) use Anthropic schema rules, and other models use OpenAI rules; errors keep the route's native envelope. On Messages, `output_config.format` and strict tools always use Anthropic schema rules regardless of model.

| Dialect                 | Required shape                                                                                            | Rejected keywords                                                                                   |
| ----------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| OpenAI (`strict: true`) | `additionalProperties: false` and every property in `required`                                            | `allOf`, `not`, `dependentRequired`, `dependentSchemas`, `if`, `then`, `else`                       |
| Anthropic               | `json_schema` with `strict: true` on OpenAI routes (`json_object` returns 400); `json_schema` on Messages | `oneOf`, numeric or string constraints, array constraints except `minItems` 0 or 1, external `$ref` |

- OpenAI skips non-strict validation. Strict response schemas return `param: "response_format"` (Chat) or `param: "text.format"` (Responses); invalid strict tools return `Invalid schema for function '<name>'` with code `invalid_function_parameters`.
- Default generation supports `type`, `properties`, `required`, `enum`, `const`, `items`, numeric and length bounds, `nullable`, common string formats, and bounded local `$ref`. It uses the first valid `anyOf` branch or first `oneOf` sample matching exactly one branch (returning 400 if none does); sibling keywords also apply.
- Unsupported keywords return 400 naming the schema path. For `pattern`, supply a supported `format` or script a reply; regex checks are time-limited, and samples that fail the pattern return 400.

## Rules

Save rules under `ai` in `emulate.config.yaml` (or pass `--seed <file>`), or replace them at runtime with `PUT /_ai/rules`. The first rule whose matchers all hold wins; omit `match` to match every call.

```yaml
ai:
  models: [gpt-x]
  timing: { ttftMs: 0, chunkDelayMs: 0 }
  random: { seed: 7 }
  rules:
    - id: hello
      match: { textContains: Hi }
      times: 1
      reply: [{ type: text, text: Hello from emulate. }]
```

If the project config uses a `services:` map, put this seed under `services.<name>.seed` without the `ai:` wrapper. A top-level `ai:` block starts a separate service.

- Set exactly one of `reply`, `variants`, or `error` per rule.
- `times` counts matches, including errors, faults, and retries. Exhausted rules are skipped; omit `times` for no limit.

### Matchers

| Key             | Matches                                                                    |
| --------------- | -------------------------------------------------------------------------- |
| `model`         | Model id with optional `*` wildcards                                       |
| `format`        | `openai-chat`, `openai-responses`, or `anthropic-messages`                 |
| `stream`        | Whether the request streams                                                |
| `textContains`  | Case-sensitive text in the latest user instruction, excluding tool results |
| `tool`          | Declared tool name with optional `*` wildcards                             |
| `hasToolResult` | Whether the current turn carries a tool result                             |
| `file`          | `true` for any attachment, including in tool results, or a media-type glob |

### Replies

`reply` is an ordered list of events:

| `type`      | Fields                             | Output                               |
| ----------- | ---------------------------------- | ------------------------------------ |
| `text`      | `text`                             | Assistant text                       |
| `object`    | `value`                            | JSON text                            |
| `tool_call` | `name`, `arguments`, optional `id` | Tool call; omit `id` to generate one |
| `reasoning` | `text`                             | See [Reasoning](#reasoning)          |
| `refusal`   | `text`                             | Native refusal shape                 |

Use a JSON object for `tool_call.arguments`, not a JSON string.

### Finish and request limits

`finish` overrides inferred and limit-triggered reasons. Without limits or an override, tool calls finish with `tool_calls`, refusals with no tool call are recorded as `refusal`, and other replies finish with `stop`.

| `finish`         | Chat `finish_reason` | Responses `status` | Messages `stop_reason` |
| ---------------- | -------------------- | ------------------ | ---------------------- |
| `stop`           | `stop`               | `completed`        | `end_turn`             |
| `tool_calls`     | `tool_calls`         | `completed`        | `tool_use`             |
| `length`         | `length`             | `incomplete`       | `max_tokens`           |
| `content_filter` | `content_filter`     | `incomplete`       | `refusal`              |
| `refusal`        | `stop`               | `completed`        | `refusal`              |

| Request limit  | Chat Completions                        | Responses           | Messages         |
| -------------- | --------------------------------------- | ------------------- | ---------------- |
| Stop sequences | `stop`                                  | Unsupported         | `stop_sequences` |
| Token cap      | `max_completion_tokens` or `max_tokens` | `max_output_tokens` | `max_tokens`     |

- Limits apply to scripted and default replies. Stop sequences cut text at the first match and omit the sequence.
- Chat reports a matched sequence as `finish_reason: "stop"`; Messages sets `stop_reason: "stop_sequence"` and returns the match in `stop_sequence`.
- Caps estimate one token per four characters. Text beyond the cap is truncated; tool calls that do not fit are dropped whole.
- Capped replies return `finish_reason: "length"` on Chat, `status: "incomplete"` with `incomplete_details.reason: "max_output_tokens"` on Responses, and `stop_reason: "max_tokens"` on Messages. The call record keeps `refusal` even when Chat sees `stop` or Responses sees `completed`.

### Errors and faults

- `error` returns a native HTTP error. Set `status` and `message`; add optional `type`, `code`, `param`, or `headers`.
- `fault` requires `match: { stream: true }`. `afterChunks` counts text or tool-argument deltas, not lifecycle events.
- Use `kind: disconnect` to cut the stream or `kind: stall` with `stallMs` to pause it.

### Timing

- Set `ttftMs` and `chunkDelayMs` in `ai.timing` or override them on a rule. Both default to zero.
- `ttftMs` delays the first byte of any reply. `chunkDelayMs` spaces stream frames; a list supplies delays in order and repeats its last value.
- Client disconnect or reset cancels pending delays. Structured output splits at JSON structural characters, never inside a string.

### Variants

- Use `variants` to cycle through `reply` or `error` entries. SDK retries consume the next entry.
- Variants can override rule-level `finish`, `timing`, and `fault`.
- `ai.random.seed` shuffles each rule's cycle. The same seed and match order give the same sequence, with each entry used once per cycle.
- Each rule counts its own matches. Startup, reset, and `PUT /_ai/rules` restart the sequence.

## Control endpoints

### Access

- Control routes and the inspector accept same-origin requests and requests without `Origin`.
- Data routes accept requests without `Origin`, same-origin requests, and loopback browser origins (`localhost`, `*.localhost`, `127.0.0.1`, `[::1]`). Foreign browser origins get 403.
- Host validation allows loopback names, IP addresses, and the base URL host to block DNS rebinding. For other hosts, pass `--base-url http://<host>:<port>` or set `publicUrl` in `createEmulateHandler`.

### Calls

```bash
curl -s http://localhost:4014/_ai/calls | jq
```

- Returns the last 500 calls as a JSON array, oldest first.
- Request fields include `seq`, `time`, `format`, `path`, `model`, `stream`, normalized `messages`, `tools`, `toolChoice`, `previousResponseId`, `references`, and `store`.
- Outcome fields include `matched`, the reply summary, `status`, `fault`, `delivery`, and `warnings`.
- `matched` is `{ id, remaining, rule }` for a rule, `{ default }` for a default, or `null` for a strict-mode miss. `rule` is the snapshot used to answer.
- `DELETE /_ai/calls` clears the call record and returns `{ "deleted": <count> }`.
- Prompts and tool arguments are recorded. API keys, auth headers, URL credentials, and file bytes are never recorded.

### Rules

```bash
curl -s http://localhost:4014/_ai/rules > rules.json
```

- `GET` returns `rules`, `strict`, `timing`, `random`, and `models`. Each rule reports `remaining`; `null` means unlimited.
- `PUT` replaces all five fields and returns the same shape as `GET`. Omitted fields reset to defaults, and all rules regain their full `times` budget.
- `PUT` ignores `remaining`, `port`, and `baseUrl`. An invalid body returns 400 with the failing path and keeps the active config.

Edit `rules.json`, then send the whole document:

```bash
curl -X PUT http://localhost:4014/_ai/rules \
  -H "Content-Type: application/json" --data @rules.json
```

### Reset and stored responses

- `POST /_ai/reset` or `reset()` restores seeded rules and budgets, clears calls and stored responses, and cancels active streams. The HTTP route returns `{ "reset": true }`.
- Responses stores the most recent 1000 replies and resolves `previous_response_id` and `item_reference` before matching. `store: false` skips storage but still records the call.
- Unknown references continue with empty context and appear as unresolved in the call record. A tool call without a matching `function_call_output` returns 400 unless its referenced history is missing.

## Recipes

Run these against the local emulator. The rule-install commands replace the full runtime config, so use a disposable instance.

### Two-step tool loop

Install rules for the initial tool call and its continuation:

```bash
curl -X PUT http://localhost:4014/_ai/rules \
  -H "Content-Type: application/json" \
  -d '{"rules":[
    {"id":"weather-call","match":{"textContains":"weather","tool":"get_weather","hasToolResult":false},
     "reply":[{"type":"tool_call","name":"get_weather","arguments":{"city":"Paris"}}]},
    {"id":"weather-result","match":{"hasToolResult":true},
     "reply":[{"type":"text","text":"The temperature in Paris is 20 C."}]}
  ]}'
```

```typescript
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, jsonSchema, stepCountIs, tool } from "ai";

const openai = createOpenAI({ baseURL: "http://localhost:4014/v1", apiKey: "test" });
const result = await generateText({
  model: openai("gpt-x"),
  prompt: "What is the weather in Paris?",
  tools: {
    get_weather: tool({
      inputSchema: jsonSchema<{ city: string }>({
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      }),
      execute: async ({ city }) => ({ city, temperatureC: 20 }),
    }),
  },
  stopWhen: stepCountIs(2),
});
console.log(result.text);
```

- In Responses mode, `@ai-sdk/openai` 3.x references assistant text and tool calls with `item_reference`. Version 4.x sends pure tool-call history inline and references assistant text.
- Use `openai.chat("gpt-x")` to send the tool history inline with Chat Completions.

### Retry once after a 429

Install a one-use error before the success rule. The OpenAI SDK retries 429s and honors `retry-after`.

```bash
curl -X PUT http://localhost:4014/_ai/rules \
  -H "Content-Type: application/json" \
  -d '{"rules":[
    {"id":"rate-limit-once","match":{"textContains":"retry"},"times":1,
     "error":{"status":429,"message":"Injected rate limit.","headers":{"retry-after":"1"}}},
    {"id":"success","match":{"textContains":"retry"},
     "reply":[{"type":"text","text":"Recovered after the retry."}]}
  ]}'
```

```typescript
import OpenAI from "openai";

const openai = new OpenAI({ baseURL: "http://localhost:4014/v1", apiKey: "test", maxRetries: 1 });
await openai.chat.completions.create({ model: "gpt-x", messages: [{ role: "user", content: "Please retry this." }] });
```

Check `GET /_ai/calls` for the 429 followed by a successful retry.

### Structured output

Run without a matching rule to generate a deterministic object from the schema:

```typescript
import { createOpenAI } from "@ai-sdk/openai";
import { generateObject } from "ai";
import { z } from "zod";

const openai = createOpenAI({ baseURL: "http://localhost:4014/v1", apiKey: "test" });
const { object } = await generateObject({
  model: openai("gpt-x"),
  schema: z.object({ name: z.string(), minutes: z.number() }),
  prompt: "Plan a short workout.",
});
console.log(object);
```

To return a specific object, add this rule under `ai.rules` before starting (or install it with `PUT /_ai/rules`):

```yaml
- id: workout
  match: { textContains: workout }
  reply: [{ type: object, value: { name: Squats, minutes: 15 } }]
```

### Reasoning

Responses returns a reasoning summary; Messages returns signed `thinking` before text or tool calls. Chat reports only `reasoning_tokens` in usage.

Add this rule under `ai.rules` before starting (or install it with `PUT /_ai/rules`), then send a prompt containing `explain`:

```yaml
- id: think-first
  match: { textContains: explain }
  reply:
    - { type: reasoning, text: The user wants a short explanation. }
    - { type: text, text: Here is the explanation. }
```

```bash
curl -s http://localhost:4014/v1/responses \
  -H "Content-Type: application/json" -d '{"model":"gpt-x","input":"Please explain."}'
```

### Streaming failures and stalls

Add this rule under `ai.rules` before starting (or install it with `PUT /_ai/rules`), then send a streaming request with a client timeout below `stallMs`. The record can show `fault: stall` and `delivery: client_aborted` on the same call.

```yaml
- id: slow
  match: { stream: true }
  reply: [{ type: text, text: Partial answer that stalls. }]
  timing: { ttftMs: 200, chunkDelayMs: 50 }
  fault: { afterChunks: 2, kind: stall, stallMs: 30000 }
```

```bash
curl -sSN --max-time 2 http://localhost:4014/v1/responses \
  -H "Content-Type: application/json" -d '{"model":"gpt-x","input":"Hi","stream":true}'
```

### Strict mode

Stop any instance on port `4014`, save this as `strict.yaml`, start the emulator, and send the Responses request above. The native 400 names the model and tools and prints a suggested rule as YAML and JSON.

```yaml
ai:
  strict: true
  rules: []
```

```bash
npx emulate start --service ai --port 4014 --seed strict.yaml
```

**Before `PUT`:** Read `GET /_ai/rules` and add the suggested rule to that complete config. Replace the placeholder reply text before sending, or it becomes the live reply.

## Limits

- Refusals: `@ai-sdk/openai` 3.x and 4.x fail to parse native Responses refusal parts in non-streaming calls and drop them in streams. Chat parsing omits `refusal`.
- Refusal testing: Use the official `openai` SDK for native refusals. For AI SDK tests, script the same content as `text`.
- Attachments: Input only; the emulator does not fetch remote files or use file contents to generate replies. Inline bytes are decoded only to record name, media type, size, and SHA-256; URL and file-id references have no size or hash.
  - Responses: `input_file` accepts inline data, a URL, or a file id. Use `input_image` for images.
  - Chat Completions: PDF `file` parts accept inline data or a file id, not a URL. Images use `image_url`.
  - Messages: Images and documents accept `http` or `https` URLs. Base64 sources require `image/jpeg`, `image/png`, `image/gif`, or `image/webp` for images and `application/pdf` for documents.
  - Validation: Malformed inline data returns a native 400. `@ai-sdk/openai` rejects types other than images or PDFs before sending unless `passThroughUnsupportedFiles` is set.
- Unsupported OpenAI features (400): Hosted tools, custom tools, allowed tool choice, background mode, Conversations API, multiple candidates (`n > 1`), audio input or output, and legacy `functions`.
- Unimplemented routes (404): Gemini, embeddings, image generation, file uploads, input item listing, token counting, and response cancellation. The native error names the supported paths.
- Ignored fields: Unknown optional request fields and OpenRouter `reasoning` fields have no effect. Replies do not support templating, and token usage is estimated.

## Verify

```bash
curl -s http://localhost:4014/_ai/calls | jq 'last | {format, model, matched, status, delivery}'
```

Open `http://localhost:4014/` for the read-only **Calls** and **Rules** tabs.

## Custom emulators alongside built-ins

- Scaffold with `npx emulate init --custom inventory`.
- Register it in `emulate.config.ts` with `defineConfig` from `emulate`, alongside built-ins such as `{ emulator: "ai" }`.
- Run `npx emulate start --watch` to reload imports and see custom state at the printed `/_emulate` URL. Successful reloads restore the seed.
- Existing flat seed configs still work; use `--config` to select an explicit file. See [Custom emulators](https://emulate.dev/docs/custom-emulators).
