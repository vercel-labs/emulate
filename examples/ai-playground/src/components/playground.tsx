"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ResponseCard, type Step } from "@/components/response-card";
import { PROTOCOLS, type Part, type RequestInput, type ToolCall } from "@/lib/protocols";
import {
  hasReplies,
  pacingName,
  parseJson,
  prettyJson,
  scriptsReasoning,
  withReasoning,
  type Config,
} from "@/lib/rules";
import { PACING, SCENARIOS, SCHEMA, TOOL_OUTPUT } from "@/lib/scenarios";

const API_NAMES = [
  { id: "chat", label: "Chat Completions" },
  { id: "responses", label: "Responses" },
  { id: "messages", label: "Messages" },
] as const;

type ApiId = (typeof API_NAMES)[number]["id"];

const describe = (part: Part) =>
  part.kind === "finish"
    ? `finish ${part.text}`
    : part.kind === "tool"
      ? part.name
        ? `tool call ${part.name} ${part.text}`.trim()
        : `arguments ${JSON.stringify(part.text)}`
      : part.signature && !part.text
        ? "signature"
        : `${part.kind} ${JSON.stringify(part.text)}`;

const snapshot = (step: Step): Step => ({
  ...step,
  parts: step.parts.map((part) => ({ ...part })),
  events: [...step.events],
  errorFacts: { ...step.errorFacts },
});

const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

export function Playground() {
  const [scenarioId, setScenarioId] = useState(SCENARIOS[0].id);
  const [api, setApi] = useState<ApiId>("chat");
  const [stream, setStream] = useState(true);
  const [prompt, setPrompt] = useState(SCENARIOS[0].prompt);
  const [schemaText, setSchemaText] = useState(prettyJson(SCHEMA));
  const [attachment, setAttachment] = useState("image");
  const [rulesText, setRulesText] = useState(prettyJson({ timing: PACING.realistic, ...SCENARIOS[0].config }));
  const [applied, setApplied] = useState<string | null>(null);
  const [rulesError, setRulesError] = useState<string | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [live, setLive] = useState<Step | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [message, setMessage] = useState("Connecting.");
  const [running, setRunning] = useState(false);
  const [connected, setConnected] = useState(false);

  const scenario = useMemo(() => SCENARIOS.find((item) => item.id === scenarioId) ?? SCENARIOS[0], [scenarioId]);
  const config = useMemo(() => parseJson(rulesText).value as Config | undefined, [rulesText]);
  const rulesState = useMemo(() => {
    const parsed = parseJson(rulesText);
    if (rulesError) return { kind: "bad" as const, text: rulesError };
    if (parsed.error) return { kind: "bad" as const, text: `Invalid JSON: ${parsed.error}` };
    if (applied === null) return { kind: "none" as const, text: "Not applied yet" };
    return rulesText === applied ? { kind: "ok" as const, text: "Applied" } : { kind: "none" as const, text: "Edited" };
  }, [rulesText, rulesError, applied]);

  const abortRef = useRef<AbortController | null>(null);
  const appliedRef = useRef<string | null>(null);
  const seqRef = useRef(0);
  const rulesSeqRef = useRef(0);

  const queueRef = useRef<Promise<boolean>>(Promise.resolve(true));

  const applyRules = useCallback((text: string, force = false) => {
    if (!force && text === appliedRef.current) return Promise.resolve(true);
    appliedRef.current = null;
    const seq = ++rulesSeqRef.current;
    setRulesError(null);
    const send = async () => {
      if (seq !== rulesSeqRef.current) return false;
      try {
        const response = await fetch("/api/ai/rules", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: text,
        });
        if (seq !== rulesSeqRef.current) return false;
        if (response.ok) {
          appliedRef.current = text;
          setApplied(text);
          return true;
        }
        const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
        setRulesError(body?.error?.message ?? `Rejected with status ${response.status}`);
      } catch {
        if (seq === rulesSeqRef.current) setRulesError("The emulator is not reachable.");
      }
      return false;
    };
    const result = queueRef.current.then(send);
    queueRef.current = result;
    return result;
  }, []);

  const selectScenario = useCallback(
    (id: string) => {
      const next = SCENARIOS.find((item) => item.id === id) ?? SCENARIOS[0];
      setScenarioId(id);
      setPrompt(next.prompt);
      if (next.stream) setStream(true);
      const current = parseJson(rulesText).value as Config | undefined;
      const nextConfig = withReasoning(
        { timing: current?.timing ?? PACING.realistic, ...next.config },
        scriptsReasoning(config ?? {}),
      );
      const text = prettyJson(nextConfig);
      setRulesText(text);
      void applyRules(text);
    },
    [rulesText, config, applyRules],
  );

  const editRules = useCallback(
    (edit: (config: Config) => Config) => {
      if (!config) return;
      const text = prettyJson(edit(config));
      setRulesText(text);
      void applyRules(text);
    },
    [config, applyRules],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/ai/calls");
        if (!response.ok) throw new Error();
        const calls = (await response.json()) as { seq: number }[];
        seqRef.current = calls.at(-1)?.seq ?? 0;
        if (cancelled) return;
        setConnected(true);
        const framed = window.top !== window.self;
        setMessage(framed ? "Open this page on its own to run scenarios." : "Pick a scenario and press Run.");
        if (!framed) await applyRules(rulesText);
      } catch {
        if (cancelled) return;
        setConnected(false);
        setMessage("The emulator is not reachable. Start the app with pnpm --filter ai-playground dev.");
      }
    })();
    return () => {
      cancelled = true;
    };
    // The first rules text is the only one applied on mount; later edits apply themselves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const lastCall = useCallback(async () => {
    try {
      const calls = (await (await fetch("/api/ai/calls")).json()) as {
        seq: number;
        matched: Step["matched"];
        fault: string;
      }[];
      const call = calls.at(-1);
      if (!call || call.seq === seqRef.current) return null;
      seqRef.current = call.seq;
      return call;
    } catch {
      return null;
    }
  }, []);

  const exchange = useCallback(
    async (input: RequestInput, title: string, onProgress: (step: Step) => void): Promise<Step> => {
      const protocol = PROTOCOLS[api];
      const body = protocol.body(input);
      const step: Step = {
        title,
        path: protocol.path,
        status: null,
        outcome: "ok",
        parts: [],
        finish: "",
        matched: null,
        fault: "none",
        retryAfter: null,
        errorFacts: {},
        message: "",
        streamed: false,
        first: 0,
        chunks: 0,
        longest: 0,
        total: 0,
        events: [],
        request: prettyJson(body),
        response: "",
      };
      const started = performance.now();
      const signal = abortRef.current?.signal;
      const structured = input.schema;
      let terminal = false;
      const tools = new Map<number, Part>();

      let last = started;
      const apply = (part: Part) => {
        if (part.kind === "finish") {
          step.finish = part.text;
          return;
        }
        const now = performance.now();
        if (!step.first) step.first = now;
        else step.longest = Math.max(step.longest, now - last);
        last = now;
        step.chunks += 1;
        if (part.kind === "tool") {
          const existing = tools.get(part.key ?? 0);
          const target = existing ?? { kind: "tool" as const, text: "", name: "", key: part.key };
          target.id = part.id ?? target.id;
          target.name = part.name ?? target.name;
          target.text += part.text;
          if (!existing) {
            tools.set(part.key ?? 0, target);
            step.parts.push(target);
          }
        } else {
          const last = step.parts.at(-1);
          if (last?.kind === part.kind) {
            last.text += part.text;
            last.signature = part.signature ?? last.signature;
          } else {
            step.parts.push({ ...part });
          }
        }
      };

      let painted = 0;
      const progress = (force = false) => {
        const now = performance.now();
        if (!force && now - painted < 40) return;
        painted = now;
        onProgress(snapshot(step));
      };

      try {
        const response = await fetch(protocol.path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal,
        });
        step.status = response.status;
        step.retryAfter = response.headers.get("retry-after");
        progress(true);
        if (response.headers.get("content-type")?.includes("text/event-stream") && response.body) {
          step.streamed = true;
          const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
          let buffer = "";
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            step.response += value;
            buffer += value;
            const blocks = buffer.split(/\r?\n\r?\n/);
            buffer = blocks.pop() ?? "";
            for (const block of blocks) {
              const data = block
                .split(/\r?\n/)
                .filter((line) => line.startsWith("data:"))
                .map((line) => line.slice(5).trimStart())
                .join("\n");
              if (!data) continue;
              const json = data === "[DONE]" ? null : (JSON.parse(data) as Record<string, never>);
              const carried = json ? protocol.read(json) : [{ kind: "finish" as const, text: "[DONE]" }];
              const type = json?.type as string | undefined;
              if (!json || type === "response.completed" || type === "response.incomplete" || type === "message_stop") {
                terminal = true;
              }
              step.events.push({
                at: Math.round(performance.now() - started),
                name: json?.type ?? data,
                carried: carried.map(describe).join(", "),
                data,
              });
              for (const part of carried) apply(part);
              progress();
            }
          }
          step.outcome = terminal ? "ok" : "dropped";
        } else {
          const text = await response.text();
          step.response = prettyJson(parseJson(text).value ?? text);
          const json = parseJson(text).value as Record<string, never> | undefined;
          if (response.ok && json) {
            const carried = protocol.parse(json);
            step.events.push({
              at: Math.round(performance.now() - started),
              name: "response",
              carried: carried.map(describe).join(", "),
              data: step.response,
            });
            for (const part of carried) apply(part);
            progress(true);
          } else {
            const error = (json as { error?: { message?: string; type?: string; code?: string } } | undefined)?.error;
            step.message = error?.message ?? text;
            step.errorFacts = {
              "Error type": error?.type,
              "Error code": error?.code,
              "Retry after": step.retryAfter ? `${step.retryAfter} s` : undefined,
              "Request ID": response.headers.get("x-request-id") ?? undefined,
            };
            step.outcome = "error";
          }
        }
      } catch {
        step.outcome = signal?.aborted ? "stopped" : "dropped";
      }

      step.total = performance.now() - started;
      const call = await lastCall();
      step.matched = call?.matched ?? null;
      step.fault = call?.fault ?? "none";

      if (structured) {
        const text = step.parts.find((part) => part.kind === "text")?.text ?? "";
        const parsed = parseJson(text);
        if (parsed.error) step.structured = { valid: false, note: "The reply is not valid JSON." };
        else {
          const value = parsed.value as Record<string, unknown>;
          const required = (structured.required as string[] | undefined) ?? [];
          const missing = required.filter((name) => !value || typeof value !== "object" || !(name in value));
          step.structured =
            missing.length > 0
              ? { valid: false, note: `Missing required fields: ${missing.join(", ")}.` }
              : { valid: true, note: "Valid JSON with every required field." };
        }
      }

      const thinks = scriptsReasoning((config ?? {}) as Config);
      step.reasoningMissing = thinks && api !== "responses" && !step.parts.some((part) => part.kind === "reasoning");
      progress(true);
      return step;
    },
    [api, config, lastCall],
  );

  const run = useCallback(async () => {
    if (running) return;
    const schema = scenario.schema ? parseJson(schemaText) : {};
    if (schema.error) {
      setSteps([]);
      setMessage(`The JSON Schema is not valid JSON: ${schema.error}`);
      return;
    }
    setMessage("");
    setSteps([]);
    if (!(await applyRules(rulesText))) {
      setMessage("The rules were not applied. See the message above the rules.");
      return;
    }
    abortRef.current = new AbortController();
    setRunning(true);
    const produced: Step[] = [];
    const trail: string[] = [];
    let plan: { title: string; calls: ToolCall[] | null; thoughts: Part[]; retried: boolean } = {
      title: "Request",
      calls: null,
      thoughts: [],
      retried: false,
    };
    try {
      for (;;) {
        setLive(null);
        const step = await exchange(
          {
            prompt,
            stream,
            schema: schema.value as Record<string, unknown> | undefined,
            scenario,
            attachment: scenario.file ? attachment : undefined,
            calls: plan.calls,
            thoughts: plan.thoughts,
          },
          plan.title,
          setLive,
        );
        produced.push(step);
        setLive(null);
        setSteps([...produced]);

        setNotes([...trail]);

        const wait = Number(step.retryAfter);
        if (step.status === 429 && step.retryAfter && Number.isFinite(wait) && !plan.retried) {
          trail.push(`The playground waits ${wait} s, as retry-after asks, then sends the same request again.`);
          await pause(wait * 1000, abortRef.current.signal);
          plan = { ...plan, title: "Retry", retried: true };
          continue;
        }

        const calls = step.parts.filter((part) => part.kind === "tool" && part.id) as ToolCall[];
        if (step.outcome === "ok" && scenario.tools && calls.length > 0 && !plan.calls) {
          trail.push(`The playground answers the tool call with ${TOOL_OUTPUT} and sends the conversation back.`);
          plan = {
            ...plan,
            title: "Request with the tool result",
            calls,
            thoughts: step.parts.filter((part) => part.kind === "reasoning"),
          };
          continue;
        }

        break;
      }
      setNotes([...trail]);
    } finally {
      setLive(null);
      setRunning(false);
      abortRef.current = null;
    }
  }, [applyRules, attachment, exchange, prompt, rulesText, running, scenario, schemaText, stream]);

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-14 shrink-0 items-center justify-between border-b px-6">
        <div className="font-semibold">
          emulate <span className="ml-2 font-normal text-muted-foreground">AI playground</span>
        </div>
        <div className="flex items-center gap-5 text-sm text-muted-foreground">
          <span className="flex items-center gap-2">
            <span className={`size-2 rounded-full ${connected ? "bg-emerald-500" : "bg-muted-foreground/40"}`} />
            {connected ? "Connected" : "Not connected"}
          </span>
          <a className="hover:text-foreground" href="/emulate/ai" target="_blank" rel="noreferrer">
            Inspector
          </a>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[13.5rem_minmax(0,1fr)_minmax(0,1fr)]">
        <nav className="border-b p-3 lg:overflow-auto lg:border-r lg:border-b-0" aria-label="Scenarios">
          {(["Replies", "Failures"] as const).map((group) => (
            <div key={group}>
              <h2 className="mt-3 mb-1 px-2 text-xs font-medium text-muted-foreground first:mt-0">{group}</h2>
              {SCENARIOS.filter((item) => item.group === group).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => selectScenario(item.id)}
                  aria-pressed={item.id === scenarioId}
                  className={`block w-full rounded-md px-2 py-1.5 text-left ${
                    item.id === scenarioId ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>
          ))}
        </nav>

        <section className="flex flex-col gap-5 border-b p-6 lg:overflow-auto lg:border-r lg:border-b-0">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="font-semibold">{scenario.label}</h1>
              <p className="mt-1 text-sm text-muted-foreground">{scenario.about}</p>
            </div>
            <button
              type="button"
              onClick={() => (running ? abortRef.current?.abort() : void run())}
              className="shrink-0 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 active:scale-[0.98]"
            >
              {running ? "Stop" : "Run ⌘↵"}
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-4 text-sm">
            <div className="flex rounded-md border p-0.5" role="radiogroup" aria-label="API">
              {API_NAMES.map((item) => (
                <label key={item.id} className="cursor-pointer">
                  <input
                    type="radio"
                    name="api"
                    value={item.id}
                    checked={api === item.id}
                    onChange={() => setApi(item.id)}
                    className="peer sr-only"
                  />
                  <span className="block rounded px-2.5 py-0.5 text-muted-foreground peer-checked:bg-muted peer-checked:text-foreground">
                    {item.label}
                  </span>
                </label>
              ))}
            </div>
            <label className="flex items-center gap-2 text-muted-foreground">
              <input
                type="checkbox"
                checked={stream}
                disabled={scenario.stream}
                onChange={(event) => setStream(event.target.checked)}
                className="accent-foreground"
              />
              Stream
            </label>
          </div>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm text-muted-foreground">Prompt</span>
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              rows={2}
              className="w-full resize-y rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </label>

          {scenario.schema && (
            <label className="flex flex-col gap-1.5">
              <span className="text-sm text-muted-foreground">JSON Schema</span>
              <textarea
                value={schemaText}
                onChange={(event) => setSchemaText(event.target.value)}
                spellCheck={false}
                rows={8}
                className="w-full resize-y rounded-md border bg-background px-3 py-2 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </label>
          )}

          {scenario.file && (
            <label className="flex items-center gap-3 text-sm text-muted-foreground">
              Attachment
              <select
                value={attachment}
                onChange={(event) => setAttachment(event.target.value)}
                className="rounded-md border bg-background px-2 py-1 text-xs"
              >
                <option value="image">Image (chart.png, inline PNG)</option>
                <option value="pdf">PDF (report.pdf, inline PDF)</option>
              </select>
            </label>
          )}

          <div className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-sm text-muted-foreground">Rules</span>
              <select
                value={config ? pacingName(config) : "custom"}
                onChange={(event) => editRules((current) => ({ ...current, timing: PACING[event.target.value] }))}
                aria-label="Pacing"
                className="rounded-md border bg-background px-1.5 py-0.5 text-xs"
              >
                <option value="instant">Instant pacing</option>
                <option value="realistic">Realistic pacing</option>
                <option value="slow">Slow pacing</option>
                <option value="custom" disabled>
                  Custom pacing
                </option>
              </select>
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={config ? scriptsReasoning(config) : false}
                  disabled={!config || !hasReplies(config)}
                  onChange={(event) => editRules((current) => withReasoning(current, event.target.checked))}
                  className="accent-foreground"
                />
                Reasoning
              </label>
              <span
                className={`ml-auto text-xs ${rulesState.kind === "bad" ? "text-destructive" : "text-muted-foreground"}`}
              >
                {rulesState.text}
              </span>
              <button
                type="button"
                onClick={() => void applyRules(rulesText, true)}
                className="rounded-md border px-2 py-0.5 text-xs hover:bg-muted"
              >
                Reset
              </button>
            </div>
            <textarea
              value={rulesText}
              onChange={(event) => {
                setRulesText(event.target.value);
                setRulesError(null);
              }}
              spellCheck={false}
              rows={14}
              className="w-full resize-y rounded-md border bg-background px-3 py-2 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <p className="text-xs text-muted-foreground">
              Every change is sent to <code className="font-mono">PUT /_ai/rules</code> at once, except text typed here,
              which waits for the next run. The first matching rule answers. Reset restores budgets and the variant
              order.
            </p>
          </div>
        </section>

        <section className="flex flex-col gap-3 p-6 lg:overflow-auto" aria-label="Response">
          {steps.length === 0 && !live && message && <p className="text-sm text-muted-foreground">{message}</p>}
          {[...steps, ...(live ? [live] : [])].map((step, index) => (
            <div key={index} className="flex flex-col gap-3">
              {index > 0 && notes[index - 1] && (
                <p className="px-1 text-sm text-muted-foreground">{notes[index - 1]}</p>
              )}
              <ResponseCard step={step} />
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}
