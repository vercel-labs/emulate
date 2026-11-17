"use client";

import { CUT_OFF } from "@/lib/scenarios";
import type { Part } from "@/lib/protocols";
import { answeredBy } from "@/lib/rules";

export type Step = {
  title: string;
  path: string;
  status: number | null;
  outcome: "ok" | "error" | "dropped" | "stopped";
  parts: Part[];
  finish: string;
  matched: { id?: string; remaining?: number | null; default?: string } | null;
  fault: string;
  retryAfter: string | null;
  errorFacts: Record<string, string | undefined>;
  message: string;
  structured?: { valid: boolean; note: string };
  reasoningMissing?: boolean;
  streamed: boolean;
  first: number;
  chunks: number;
  longest: number;
  total: number;
  events: { at: number; name: string; carried: string; data: string }[];
  request: string;
  response: string;
};

const seconds = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`);

function Fact({ name, value, warn }: { name: string; value: string; warn?: boolean }) {
  return (
    <>
      <dt className="text-muted-foreground">{name}</dt>
      <dd className={warn ? "text-amber-600 dark:text-amber-400" : undefined}>{value}</dd>
    </>
  );
}

export function ResponseCard({ step }: { step: Step }) {
  const facts: React.ReactNode[] = [];
  for (const [name, value] of Object.entries(step.errorFacts)) {
    if (value) facts.push(<Fact key={name} name={name} value={value} />);
  }
  if (step.matched !== undefined) {
    facts.push(<Fact key="answered" name="Answered by" value={answeredBy(step.matched)} />);
  }
  if (step.fault && step.fault !== "none")
    facts.push(<Fact key="fault" name="Injected fault" value={step.fault} warn />);
  if (step.finish) {
    facts.push(<Fact key="finish" name="Finish reason" value={step.finish} warn={CUT_OFF.has(step.finish)} />);
  }
  if (step.streamed && step.first) {
    facts.push(
      <Fact
        key="stream"
        name="Stream"
        value={`first token ${seconds(step.first)}, ${step.chunks} chunks, longest gap ${seconds(step.longest)}`}
        warn={step.longest >= 1000}
      />,
    );
  }

  const statusKind =
    step.status === null
      ? "text-muted-foreground"
      : step.status < 400
        ? "text-emerald-600 dark:text-emerald-400"
        : "text-destructive";

  return (
    <article className="rounded-lg border">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2.5">
        <span className="font-medium">{step.title}</span>
        <code className="font-mono text-xs text-muted-foreground">POST {step.path}</code>
        <span className={`ml-auto font-mono text-xs ${statusKind}`}>
          {[step.status ?? (step.outcome ? "no response" : ""), step.total ? seconds(step.total) : ""]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </header>

      {(step.parts.length > 0 || step.message || step.structured || step.reasoningMissing) && (
        <div className="space-y-2.5 border-t px-4 py-3">
          {step.parts.map((part, index) => (
            <p
              key={index}
              className={
                part.kind === "reasoning"
                  ? "text-sm text-muted-foreground"
                  : part.kind === "tool" || step.structured
                    ? "whitespace-pre-wrap font-mono text-xs"
                    : "whitespace-pre-wrap"
              }
            >
              {part.kind === "reasoning" && (
                <span className="mb-0.5 block text-xs text-muted-foreground">Reasoning</span>
              )}
              {part.kind === "tool" && <span className="mb-0.5 block text-xs text-muted-foreground">Tool call</span>}
              {part.kind === "refusal" && <span className="mb-0.5 block text-xs text-muted-foreground">Refusal</span>}
              {part.kind === "tool" ? `${part.name ?? ""} ${part.text}`.trim() : part.text}
            </p>
          ))}
          {step.message && <pre className="whitespace-pre-wrap font-mono text-xs">{step.message}</pre>}
          {step.structured && (
            <p
              className={`text-sm ${step.structured.valid ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"}`}
            >
              {step.structured.note}
            </p>
          )}
          {step.outcome === "dropped" && (
            <p className="text-sm text-destructive">The connection closed before the reply finished.</p>
          )}
          {step.outcome === "stopped" && <p className="text-sm text-muted-foreground">Stopped.</p>}
          {CUT_OFF.has(step.finish) && (
            <p className="text-sm text-amber-600 dark:text-amber-400">
              Cut off at the output token limit. The API still answers 200, so the finish reason is the only sign.
            </p>
          )}
          {step.reasoningMissing && (
            <p className="text-sm text-muted-foreground">
              The rule scripts reasoning, but this API sent none. Chat Completions has no field for it and reports only
              reasoning tokens.
            </p>
          )}
        </div>
      )}

      {facts.length > 0 && (
        <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-0.5 border-t px-4 py-2.5 text-xs">
          {facts}
        </dl>
      )}

      <details className="border-t" open={step.streamed && step.events.length > 0}>
        <summary className="cursor-pointer px-4 py-2 text-xs text-muted-foreground">
          Events <span className="ml-1.5">{step.events.length}</span>
        </summary>
        <div className="max-h-80 overflow-auto px-4 pb-3 font-mono text-xs">
          {step.events.map((event, index) => (
            <details key={index}>
              <summary className="grid cursor-pointer grid-cols-[3.5rem_auto_minmax(0,1fr)] gap-3 rounded px-1 py-px hover:bg-muted">
                <span className="text-right text-muted-foreground">+{event.at}</span>
                <span className="text-muted-foreground">{event.name}</span>
                <span className="truncate">{event.carried}</span>
              </summary>
              <pre className="my-1 whitespace-pre-wrap rounded bg-muted px-2.5 py-2">{event.data}</pre>
            </details>
          ))}
        </div>
      </details>

      <details className="border-t">
        <summary className="cursor-pointer px-4 py-2 text-xs text-muted-foreground">Request body</summary>
        <pre className="whitespace-pre-wrap px-4 pb-3 font-mono text-xs">{step.request}</pre>
      </details>

      <details className="border-t">
        <summary className="cursor-pointer px-4 py-2 text-xs text-muted-foreground">Response body</summary>
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap px-4 pb-3 font-mono text-xs">{step.response}</pre>
      </details>
    </article>
  );
}
