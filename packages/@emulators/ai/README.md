# @emulators/ai

Deterministic OpenAI Responses, Chat Completions, and Anthropic Messages emulation for local development and CI. Scripted rules and deterministic defaults control replies, so the same config and request sequence repeat across runs.

Streams, structured output, tool calls, reasoning, refusals, stored responses, failures, and stream faults are available on demand.

Part of [emulate](https://github.com/vercel-labs/emulate): local drop-in replacement services for CI and no-network sandboxes.

## Install

```bash
npm install @emulators/ai
npx emulate start --service ai --port 4014
```

Without `--port`, a single selected service uses `EMULATE_PORT`, `PORT`, or `4000`. In an all-services run, `ai` listens on port `4014`.

## Client setup

Point OpenAI clients at `http://localhost:4014/v1` and the Anthropic SDK at `http://localhost:4014`. Any path prefix works (`/v1`, `/api/v1`), because the wire format comes from the end of the request path.

The emulator never validates, stores, or logs API keys, though most SDKs require a placeholder string. Generation responses carry a deterministic request id: `x-request-id` on OpenAI routes and `request-id` on Messages.

```typescript
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { createOpenAI } from "@ai-sdk/openai";

const client = new OpenAI({ baseURL: "http://localhost:4014/v1", apiKey: "test" });
const anthropic = new Anthropic({ baseURL: "http://localhost:4014", apiKey: "test" });
const openai = createOpenAI({ baseURL: "http://localhost:4014/v1", apiKey: "test" });
```

- The Anthropic SDK adds `/v1` itself, so omit it from its base URL.
- `openai("gpt-x")` posts to `/v1/responses`; `openai.chat("gpt-x")` posts to `/v1/chat/completions`.
- `@ai-sdk/openai-compatible` works in Chat mode with the same base URL. For `generateObject` with `createOpenAICompatible`, set `supportsStructuredOutputs: true` or script an `object` reply rule. Otherwise the default `{}` reply fails the schema check.
- Vercel AI Gateway's OpenAI-compatible `/v1` shape works too. Any model id is accepted and echoed back. The private `@ai-sdk/gateway` protocol is not supported.

## Endpoints

### Data

| Method | Path                   | Behavior                                           |
| ------ | ---------------------- | -------------------------------------------------- |
| POST   | `/v1/chat/completions` | Chat Completions, unary or streamed                |
| POST   | `/v1/responses`        | Responses, unary or streamed                       |
| POST   | `/v1/messages`         | Anthropic Messages, unary or streamed              |
| GET    | `/v1/responses/{id}`   | Retrieve a stored response                         |
| DELETE | `/v1/responses/{id}`   | Delete a stored response                           |
| GET    | `/v1/models`           | List configured and previously requested model ids |

Messages client tools accept an optional `input_schema`. Server tools return a 400. Unsupported data paths return a native 404 naming the supported paths.

### Control

| Method | Path         | Behavior                                                                                           |
| ------ | ------------ | -------------------------------------------------------------------------------------------------- |
| GET    | `/_ai/calls` | Recorded calls as a bare JSON array, oldest first                                                  |
| DELETE | `/_ai/calls` | Clear calls and return `{ "deleted": <count> }`                                                    |
| GET    | `/_ai/rules` | Active rules and remaining budgets, returned in the shape below                                    |
| PUT    | `/_ai/rules` | Replace active rules without restarting; accepts and returns the shape below                       |
| POST   | `/_ai/reset` | Restore seeded rules and budgets, clear calls and stored responses, and return `{ "reset": true }` |
| GET    | `/`          | Read-only inspector with Calls and Rules tabs                                                      |

The rules shape is `{ "rules": [...], "strict": <bool>, "timing": {...}, "random": { "seed": <number> }, "models": [...] }`. Each rule's `remaining` budget is shown; `null` means unlimited.

### Access

- Control routes and the inspector accept requests without an `Origin` header (curl, tests) and same-origin requests; other origins get 403.
- Data routes accept requests without an `Origin` header, same-origin requests, and loopback browser origins (`localhost`, `*.localhost`, `127.0.0.1`, `[::1]`); foreign browser origins get 403.
- Host validation allows only loopback names, IP addresses, and the base URL host. Pass `--base-url http://<host>:<port>` for other hosts, or set `publicUrl` in `createEmulateHandler`.
- Startup warns when the service listens beyond loopback.

## Seed configuration

Save under `ai` in `emulate.config.yaml` (or pass `--seed <file>`):

```yaml
ai:
  strict: false
  timing: { ttftMs: 0, chunkDelayMs: 0 }
  random: { seed: 7 }
  models: [gpt-x]
  rules:
    - id: weather-call
      match: { textContains: weather, tool: get_weather, hasToolResult: false }
      times: 1
      reply:
        - type: tool_call
          name: get_weather
          arguments: { city: Paris }
    - id: weather-result
      match: { hasToolResult: true }
      reply:
        - type: text
          text: The temperature in Paris is 20 C.
    - id: rate-limit-once
      match: { textContains: retry }
      times: 1
      error:
        status: 429
        message: Injected rate limit. Retry this request.
        headers: { retry-after: "1" }
```

Rules are evaluated in order, and the first match wins. Every supplied matcher must hold. `times` caps how many times a rule can fire. An unknown configuration key fails at startup, with its path.

`PUT /_ai/rules` accepts `rules`, plus optional `strict`, `timing`, `random`, and `models`. It ignores `port` and `baseUrl`. A body with only `rules` resets the other fields to their defaults. Every replacement restores each rule's full `times` budget.

## Rules

### Matchers

| Matcher         | Meaning                                                                                                   |
| --------------- | --------------------------------------------------------------------------------------------------------- |
| `model`         | Model id, with `*` wildcards                                                                              |
| `format`        | `openai-chat`, `openai-responses`, or `anthropic-messages`                                                |
| `stream`        | Boolean                                                                                                   |
| `textContains`  | Case-sensitive text in the latest user instruction, excluding tool results                                |
| `tool`          | A declared tool name, with `*` wildcards                                                                  |
| `hasToolResult` | Whether the current continuation carries a tool result                                                    |
| `file`          | `true` for any attachment, including one in a tool result, or a media-type glob such as `application/pdf` |

### Reply events

| Event       | Shape                                           |
| ----------- | ----------------------------------------------- |
| `text`      | `{ type: text, text }`                          |
| `object`    | `{ type: object, value }`, sent as JSON text    |
| `tool_call` | `{ type: tool_call, name, arguments }`          |
| `reasoning` | `{ type: reasoning, text }`                     |
| `refusal`   | `{ type: refusal, text }`, native refusal shape |

`arguments` must be a JSON object. A string is rejected at startup and on `PUT /_ai/rules`. `reasoning` becomes a reasoning summary on Responses and a signed `thinking` block on Messages. Chat Completions has no field for reasoning and reports only reasoning tokens.

### Variants, finish, and faults

- A rule sets one of `reply`, `variants`, or `error`. With `variants`, `ai.random.seed` shuffles entries per rule so every variant runs once per cycle; an SDK retry takes the next entry.
- A variant holds `reply` or `error`, and can override rule-level `finish`, `timing`, and `fault`.
- `finish` accepts `stop`, `tool_calls`, `length`, `refusal`, or `content_filter`. Without `finish`, a reply with a tool call ends with `tool_calls`, a refusal with no tool call is recorded as `refusal`, and anything else ends with `stop`.
- A refusal (or `finish: refusal`) is recorded as `refusal`, while clients see `stop` on Chat Completions, `completed` on Responses, and `refusal` on Messages.
- `length` and `content_filter` reach the client as `finish_reason` on Chat Completions, `status: "incomplete"` on Responses, and `max_tokens` or `refusal` on Messages.
- `fault` disconnects or stalls a stream after a counted number of content chunks and requires `match.stream: true`.

### Timing

`timing.ttftMs` is the wait before the first byte of any reply, streamed or not. `timing.chunkDelayMs` is the gap between the frames of a stream.

### Request limits

These apply to scripted and default replies alike. A rule's own `finish` wins when set. Token caps count output at one token per four characters.

| Limit         | Behavior                                                                                                                           |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Chat stop     | `stop` cuts text at the first match, omits the sequence, and ends the reply with `stop`.                                           |
| Messages stop | `stop_sequences` cuts and omits the match, reporting `stop_reason: "stop_sequence"` and the match in `stop_sequence`.              |
| Chat cap      | `max_completion_tokens` or `max_tokens` cuts an over-cap reply and ends it with `length`.                                          |
| Responses cap | `max_output_tokens` cuts an over-cap reply, reporting `status: "incomplete"` and `incomplete_details.reason: "max_output_tokens"`. |
| Messages cap  | `max_tokens` cuts an over-cap reply and reports `stop_reason: "max_tokens"`.                                                       |

A tool call that does not fit the token cap is dropped whole, never sent partially.

## Defaults

With no matching rule, the service:

- echoes the latest user text
- returns a deterministic, schema-valid object when a schema was requested, or `{}` for JSON mode without a schema
- returns a generated call when the request forces a tool
- acknowledges a tool result or an attachment-only request
- accepts and echoes any model id

Set `strict: true` to turn every unmatched request into a native 400. The 400 names the model and tools, and includes the missing rule as YAML and JSON.

## State and privacy

- Responses are stored by default (up to the most recent 1000) so multi-turn sessions and item references resolve. Set `store: false` to skip storage.
- Unknown `previous_response_id` and item references continue with empty context. A function call with no matching `function_call_output` returns OpenAI's 400 (`No tool output found for function call <id>.`) unless its referenced history is missing.
- The last 500 generation calls are recorded with format, model, `matched`, normalized prompt, tool arguments, and outcome. `matched` is `{ id, remaining, rule }`, `{ default }`, or `null`.
- Keys, auth headers, URL credentials, and file bytes are never recorded. Attachment metadata keeps name, media type, size, and SHA-256 only.

## Limits

- Unsupported OpenAI features return a native 400 naming the feature: hosted tools, custom tools, allowed tool choice, background mode, Conversations API, multiple candidates (`n > 1`), audio input or output, and legacy `functions`.
- Hosted Messages tool types return a 400: `web_search_*`, `web_fetch_*`, `code_execution_*`, `tool_search_tool_*`, and `mcp_toolset`.
- Unimplemented routes return a native 404 naming the supported paths: Gemini, embeddings, image generation, file uploads, input item listing, token counting, and response cancellation. Errors on `/v1/messages`, unsupported paths under `/v1/messages`, and unsupported data paths with an `anthropic-version` header use Anthropic's error envelope.
- OpenRouter `reasoning` fields and unknown optional fields have no effect. Reply text uses no templating, and usage numbers are deterministic estimates.

## Links

- [Full documentation](https://emulate.dev/docs/ai)
- [Agent skill](../../../skills/ai/SKILL.md)
- [GitHub](https://github.com/vercel-labs/emulate)
