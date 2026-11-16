"use client";

import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import type { ConsolePreset } from "@/lib/services";

type Method = ConsolePreset["method"];

interface Form {
  method: Method;
  path: string;
  headers: string;
  body: string;
}

type Outcome =
  | { kind: "response"; status: number; statusText: string; elapsed: number; body: string }
  | { kind: "error"; message: string; elapsed: number };

const methods: Method[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

const fieldClass =
  "w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 font-mono text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50";

/** Turns a preset into editable form values, with headers written one `Name: value` per line. */
function toForm(preset: ConsolePreset): Form {
  return {
    method: preset.method,
    path: preset.path,
    headers: Object.entries(preset.headers ?? {})
      .map(([name, value]) => `${name}: ${value}`)
      .join("\n"),
    body: preset.body ?? "",
  };
}

function parseHeaders(text: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const colon = line.indexOf(":");
    if (colon > 0) headers[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return headers;
}

function prettify(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** Sends a request to one emulator from the browser and shows the status, timing, and body of the response. */
export function ApiConsole({ name, presets }: { name: string; presets: ConsolePreset[] }) {
  const [form, setForm] = useState<Form>(() => toForm(presets[0]));
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [pending, setPending] = useState(false);
  const bodyDisabled = form.method === "GET";

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setOutcome(null);
    const started = performance.now();
    try {
      const response = await fetch(`/emulate/${name}${form.path.replace(/\/$/, "")}`, {
        method: form.method,
        headers: parseHeaders(form.headers),
        body: bodyDisabled ? undefined : form.body,
      });
      const text = await response.text();
      setOutcome({
        kind: "response",
        status: response.status,
        statusText: response.statusText,
        elapsed: Math.round(performance.now() - started),
        body: prettify(text),
      });
    } catch (error) {
      setOutcome({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
        elapsed: Math.round(performance.now() - started),
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h2 className="text-base font-medium">Presets</h2>
        <div className="flex flex-wrap gap-2">
          {presets.map((preset) => (
            <Button
              key={preset.label}
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setForm(toForm(preset));
                setOutcome(null);
              }}
            >
              {preset.label}
            </Button>
          ))}
        </div>
      </div>
      <form onSubmit={send} className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-[8rem_1fr]">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="console-method" className="text-sm font-medium">
              Method
            </label>
            <select
              id="console-method"
              value={form.method}
              onChange={(event) => setForm((current) => ({ ...current, method: event.target.value as Method }))}
              className={fieldClass}
            >
              {methods.map((method) => (
                <option key={method} value={method}>
                  {method}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="console-path" className="text-sm font-medium">
              Path
            </label>
            <input
              id="console-path"
              value={form.path}
              onChange={(event) => setForm((current) => ({ ...current, path: event.target.value }))}
              spellCheck={false}
              className={fieldClass}
            />
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="console-headers" className="text-sm font-medium">
            Headers
          </label>
          <textarea
            id="console-headers"
            rows={3}
            value={form.headers}
            onChange={(event) => setForm((current) => ({ ...current, headers: event.target.value }))}
            spellCheck={false}
            className={fieldClass}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="console-body" className="text-sm font-medium">
            Body
          </label>
          <textarea
            id="console-body"
            rows={6}
            value={form.body}
            disabled={bodyDisabled}
            onChange={(event) => setForm((current) => ({ ...current, body: event.target.value }))}
            spellCheck={false}
            className={fieldClass}
          />
        </div>
        <div>
          <Button type="submit" disabled={pending}>
            {pending ? "Sending..." : "Send"}
          </Button>
        </div>
      </form>
      <section aria-live="polite" className="flex flex-col gap-3">
        {outcome?.kind === "response" && (
          <>
            <p className="text-sm">
              <span className="font-medium">
                {outcome.status} {outcome.statusText}
              </span>
              <span className="text-muted-foreground"> in {outcome.elapsed} ms</span>
            </p>
            <pre className="max-h-96 overflow-auto rounded-xl bg-muted p-4 font-mono text-xs whitespace-pre-wrap break-all">
              {outcome.body}
            </pre>
          </>
        )}
        {outcome?.kind === "error" && (
          <p className="text-sm text-destructive">
            Request failed after {outcome.elapsed} ms: {outcome.message}
          </p>
        )}
      </section>
    </div>
  );
}
