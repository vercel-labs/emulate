# AI Playground with emulate

An interactive playground for the `@emulators/ai` emulator covering OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages. Pick a scenario, edit rules live, and inspect the streamed events, raw request, and raw response.

## Getting started

From the repository root:

```bash
pnpm install
pnpm --filter ai-playground dev
```

Open [http://localhost:3000](http://localhost:3000). The emulator is embedded in the app, and its read-only inspector is at [http://localhost:3000/emulate/ai](http://localhost:3000/emulate/ai).

## How it works

`src/app/emulate/[...path]/route.ts` mounts the AI emulator with `createEmulateHandler` from `@emulators/adapter-next`, seeded with realistic timing and one greeting rule.

Two same-origin routes forward the playground's requests to that mount, so the page can edit rules and read response headers such as `retry-after` without any cross-origin setup:

- `/v1/*` forwards to `/emulate/ai/v1/*`, the three provider endpoints.
- `/api/ai/*` forwards to `/emulate/ai/_ai/*`, the rules, calls, and reset routes. Next.js treats folders starting with `_` as private, so the control routes cannot live at `/_ai` directly.

`next.config.ts` wraps the config with `withEmulate`, which keeps the emulator fonts in the serverless output trace.

## Scenarios

- **Replies**: Text, Structured output, Tool call, Refusal, Truncated, Text match (`textContains`), File attachment (inline PNG and PDF), Variants (seeded order), and No rule (built-in defaults).
- **Failures**: Rate limit then success (`retry-after` retry flow), Server error (500), Stream drops, Stream stalls, and Strict miss (400 with a rule template).
- **Controls**: API switcher, Stream toggle, Pacing presets, Reasoning toggle, live JSON rules editor, and Reset.

Every change is sent to `PUT /_ai/rules` at once, except text typed in the rules editor, which waits for the next run.
