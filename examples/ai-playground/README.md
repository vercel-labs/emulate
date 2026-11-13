# AI Playground with emulate

An interactive playground for the `@emulators/ai` emulator covering OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages. Pick a scenario, edit rules live, and inspect the streamed events, raw request, and raw response.

## Getting started

Requires Node 24 or later. From the repository root:

```bash
pnpm install
pnpm --filter ai-playground dev
```

Open [http://localhost:8000](http://localhost:8000). The emulator runs on [http://localhost:4123](http://localhost:4123), where you can also open the read-only inspector.

Run the server tests with:

```bash
pnpm --filter ai-playground test
```

## Scenarios

- **Replies**: Text, Structured output, Tool call, Refusal, Truncated, Text match (`textContains`), File attachment (inline PNG and PDF), Variants (seeded order), and No rule (built-in defaults).
- **Failures**: Rate limit then success (`retry-after` retry flow), Server error (500), Stream drops, Stream stalls, and Strict miss (400 with rule template).
- **Controls**: API switcher (Chat Completions, Responses, Messages), Stream toggle, Pacing presets (`ttftMs` and `chunkDelayMs`), Reasoning toggle, live JSON rules editor, and Reset.

## How it works

`server.ts` starts an in-process AI emulator via `createEmulator({ service: "ai" })` and serves `index.html` on the same origin as a scoped proxy for `/v1/*`, `/_ai/*`, and `/_emulate/fonts/*`. Same-origin hosting lets the browser edit rules via `PUT /_ai/rules` and read response headers such as `retry-after`, while refusing cross-origin requests and unknown hosts.
