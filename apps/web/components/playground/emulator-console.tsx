"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { getEmulator, resetEmulator } from "@/lib/playground/runtime";
import type { ConsolePreset, ConsoleVariable, PresetGroup } from "@/lib/playground/services";

type Method = ConsolePreset["method"];

interface Form {
  method: Method;
  path: string;
  headers: string;
  body: string;
}

type Outcome =
  | {
      kind: "response";
      status: number;
      statusText: string;
      elapsed: number;
      body: string;
      location: string | null;
      kept: string[];
    }
  | { kind: "error"; message: string; elapsed: number }
  | { kind: "missing"; labels: string[] };

type Phase = "idle" | "loading" | "sending";

const methods: Method[] = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];

const placeholder = /\{\{([a-z0-9_]+)\}\}/g;

const fieldClass =
  "w-full rounded-md border border-neutral-200 bg-white px-2.5 py-1.5 font-mono text-sm text-neutral-900 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-500 disabled:opacity-50 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-100";

const primaryButtonClass =
  "inline-flex h-9 items-center rounded-md bg-neutral-900 px-4 text-sm font-medium text-white hover:bg-neutral-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-500 disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200";

const secondaryButtonClass =
  "inline-flex h-8 items-center rounded-md border border-neutral-200 px-3 text-sm text-neutral-700 hover:border-neutral-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-500 dark:border-neutral-800 dark:text-neutral-300 dark:hover:border-neutral-700";

const labelClass = "text-sm font-medium text-neutral-900 dark:text-neutral-100";

const hintClass = "text-xs text-neutral-500 dark:text-neutral-400";

function now(): number {
  return performance.now();
}

function initialValuesFor(variables: ConsoleVariable[]): Record<string, string> {
  return variables.some((variable) => variable.name === "token") ? { token: "playground-token" } : {};
}

function toForm(preset: ConsolePreset | undefined): Form {
  return {
    method: preset?.method ?? "GET",
    path: preset?.path ?? "",
    headers: Object.entries(preset?.headers ?? {})
      .map(([name, value]) => `${name}: ${value}`)
      .join("\n"),
    body: preset?.body ?? "",
  };
}

function placeholdersIn(text: string): string[] {
  return Array.from(text.matchAll(placeholder), (match) => match[1]);
}

function fill(text: string, values: Record<string, string>): string {
  return text.replace(placeholder, (_, name: string) => values[name] ?? "");
}

const redirectCapture = "@location.";

/** Reads the values a preset keeps from a response: dot paths into the JSON body, or query parameters of a redirect. */
function capture(
  response: { body: string; location: string | null },
  captures: Record<string, string> = {},
): Record<string, string> {
  let json: unknown;
  try {
    json = JSON.parse(response.body);
  } catch {
    json = undefined;
  }
  const redirect = response.location ? new URL(response.location, "https://emulate.local") : null;
  const kept: Record<string, string> = {};
  for (const [name, path] of Object.entries(captures)) {
    const value = path.startsWith(redirectCapture)
      ? redirect?.searchParams.get(path.slice(redirectCapture.length))
      : path
          .split(".")
          .reduce<unknown>((node, key) => (node as Record<string, unknown> | null | undefined)?.[key], json);
    if (typeof value === "string" || typeof value === "number") kept[name] = String(value);
  }
  return kept;
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

/** Request console for one in-tab emulator. `{{name}}` placeholders are filled from the Values fields when sending. */
export function EmulatorConsole({
  name,
  groups,
  variables,
}: {
  name: string;
  groups: PresetGroup[];
  variables: ConsoleVariable[];
}) {
  const operations = groups
    .flatMap((group, groupIndex) => group.presets.map((preset) => ({ groupIndex, groupTitle: group.title, preset })))
    .map((operation, index) => ({ ...operation, index }));
  const initial = initialValuesFor(variables);

  const [selected, setSelected] = useState(0);
  const [filter, setFilter] = useState("");
  const [form, setForm] = useState<Form>(() => toForm(operations[0]?.preset));
  const [values, setValues] = useState<Record<string, string>>(initial);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [notice, setNotice] = useState("");
  const latestRequest = useRef(0);
  const result = useRef<HTMLElement>(null);

  useEffect(() => {
    if (outcome) result.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [outcome]);

  const current = operations[selected];
  const bodyDisabled = form.method === "GET" || form.method === "HEAD";
  const used = [...new Set([form.path, form.headers, bodyDisabled ? "" : form.body].flatMap(placeholdersIn))];
  const missing = used.filter((variable) => !values[variable]?.trim());
  const query = filter.trim().toLowerCase();
  const matching = operations.filter(({ groupTitle, preset }) =>
    [preset.label, preset.path, groupTitle].some((text) => text.toLowerCase().includes(query)),
  );
  const visibleGroups = groups
    .map((group, groupIndex) => ({
      title: group.title,
      items: matching.filter((operation) => operation.groupIndex === groupIndex),
    }))
    .filter((group) => group.items.length > 0);

  function labelOf(variable: string): string {
    return variables.find((item) => item.name === variable)?.label ?? variable;
  }

  function choose(index: number) {
    latestRequest.current += 1;
    setSelected(index);
    setForm(toForm(operations[index].preset));
    setOutcome(null);
    setPhase("idle");
    setNotice("");
  }

  function reset() {
    latestRequest.current += 1;
    resetEmulator(name);
    setValues(initial);
    setOutcome(null);
    setPhase("idle");
    setNotice("Emulator reset to its seed data.");
  }

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (missing.length > 0) {
      setOutcome({ kind: "missing", labels: missing.map(labelOf) });
      return;
    }
    const request = ++latestRequest.current;
    setNotice("");
    setOutcome(null);
    setPhase("loading");
    const started = now();
    try {
      const emulator = await getEmulator(name);
      if (request !== latestRequest.current) return;
      setPhase("sending");
      const response = await emulator.send({
        method: form.method,
        path: fill(form.path, values),
        headers: parseHeaders(fill(form.headers, values)),
        body: bodyDisabled ? undefined : fill(form.body, values),
      });
      if (request !== latestRequest.current) return;
      const captured = response.status < 400 ? capture(response, current.preset.captures) : {};
      if (Object.keys(captured).length > 0) setValues((previous) => ({ ...previous, ...captured }));
      setOutcome({
        kind: "response",
        status: response.status,
        statusText: response.statusText,
        elapsed: Math.round(now() - started),
        body: prettify(response.body),
        location: response.location,
        kept: Object.keys(captured).map(labelOf),
      });
    } catch (error) {
      if (request !== latestRequest.current) return;
      setOutcome({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
        elapsed: Math.round(now() - started),
      });
    } finally {
      if (request === latestRequest.current) setPhase("idle");
    }
  }

  if (!current)
    return <p className="text-sm text-neutral-500 dark:text-neutral-400">This service has no operations yet.</p>;

  const sendLabel = phase === "loading" ? "Loading the emulator..." : phase === "sending" ? "Sending..." : "Send";

  return (
    <div className="grid gap-8 md:grid-cols-[18rem_minmax(0,1fr)] md:items-start">
      <aside className="flex flex-col gap-3 md:sticky md:top-24">
        <label htmlFor="playground-filter" className={labelClass}>
          Filter operations
        </label>
        <input
          id="playground-filter"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          spellCheck={false}
          className={fieldClass}
        />
        <div>
          <button type="button" data-reset onClick={reset} className={secondaryButtonClass}>
            Reset emulator
          </button>
        </div>
        <p aria-live="polite" className={hintClass}>
          {notice}
        </p>
        <div className="flex max-h-80 flex-col gap-4 overflow-y-auto md:max-h-[calc(100vh-14rem)]">
          {visibleGroups.map((group) => (
            <div key={group.title} className="flex flex-col gap-1">
              <h3 className="px-2 text-xs font-medium tracking-wide text-neutral-500 uppercase dark:text-neutral-400">
                {group.title}
              </h3>
              {group.items.map((operation) => (
                <button
                  key={operation.index}
                  type="button"
                  data-operation={operation.preset.label}
                  aria-current={operation.index === selected ? "true" : undefined}
                  onClick={() => choose(operation.index)}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-neutral-700 outline-none hover:bg-neutral-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-500 aria-[current=true]:bg-neutral-100 aria-[current=true]:font-medium aria-[current=true]:text-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-900 dark:aria-[current=true]:bg-neutral-900 dark:aria-[current=true]:text-neutral-50"
                >
                  <span className="w-14 shrink-0 font-mono text-xs text-neutral-500 dark:text-neutral-400">
                    {operation.preset.method}
                  </span>
                  <span className="truncate">{operation.preset.label}</span>
                </button>
              ))}
            </div>
          ))}
          {visibleGroups.length === 0 && (
            <p className="px-2 text-sm text-neutral-500 dark:text-neutral-400">No operations match this filter.</p>
          )}
        </div>
      </aside>

      <div className="flex min-w-0 flex-col gap-6">
        <div className="flex flex-col gap-1">
          <h2 className="text-base font-medium text-neutral-900 dark:text-neutral-100">{current.preset.label}</h2>
          {current.preset.description && (
            <p className="text-sm text-neutral-600 dark:text-neutral-400">{current.preset.description}</p>
          )}
        </div>

        {used.length > 0 && (
          <fieldset className="flex flex-col gap-4">
            <legend className="mb-3 text-sm font-medium text-neutral-900 dark:text-neutral-100">Values</legend>
            {used.map((variable) => {
              const hint = variables.find((item) => item.name === variable)?.hint;
              return (
                <div key={variable} className="flex flex-col gap-1.5">
                  <label htmlFor={`playground-var-${variable}`} className={labelClass}>
                    {labelOf(variable)}
                  </label>
                  <input
                    id={`playground-var-${variable}`}
                    data-variable={variable}
                    value={values[variable] ?? ""}
                    onChange={(event) => setValues((previous) => ({ ...previous, [variable]: event.target.value }))}
                    aria-describedby={hint ? `playground-var-${variable}-hint` : undefined}
                    spellCheck={false}
                    className={fieldClass}
                  />
                  {hint && (
                    <p id={`playground-var-${variable}-hint`} className={hintClass}>
                      {hint}
                    </p>
                  )}
                </div>
              );
            })}
          </fieldset>
        )}

        <form onSubmit={send} className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-[8rem_1fr]">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="playground-method" className={labelClass}>
                Method
              </label>
              <select
                id="playground-method"
                value={form.method}
                onChange={(event) => setForm((previous) => ({ ...previous, method: event.target.value as Method }))}
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
              <label htmlFor="playground-path" className={labelClass}>
                Path
              </label>
              <input
                id="playground-path"
                value={form.path}
                onChange={(event) => setForm((previous) => ({ ...previous, path: event.target.value }))}
                spellCheck={false}
                className={fieldClass}
              />
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="playground-headers" className={labelClass}>
              Headers
            </label>
            <p className={hintClass}>One Name: value pair per line.</p>
            <textarea
              id="playground-headers"
              rows={3}
              value={form.headers}
              onChange={(event) => setForm((previous) => ({ ...previous, headers: event.target.value }))}
              spellCheck={false}
              className={fieldClass}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="playground-body" className={labelClass}>
              Body
            </label>
            <textarea
              id="playground-body"
              rows={10}
              value={form.body}
              disabled={bodyDisabled}
              onChange={(event) => setForm((previous) => ({ ...previous, body: event.target.value }))}
              spellCheck={false}
              className={fieldClass}
            />
          </div>
          <div>
            <button type="submit" data-send disabled={phase !== "idle"} className={primaryButtonClass}>
              {sendLabel}
            </button>
          </div>
        </form>

        <section
          ref={result}
          aria-live="polite"
          data-outcome={outcome?.kind}
          className="flex scroll-mb-6 flex-col gap-3"
        >
          {outcome?.kind === "response" && (
            <>
              <p className="text-sm text-neutral-900 dark:text-neutral-100">
                <span data-status className="font-medium">
                  {`${outcome.status} ${outcome.statusText}`.trim()}
                </span>
                <span className="text-neutral-500 dark:text-neutral-400"> in {outcome.elapsed} ms</span>
              </p>
              {outcome.location && (
                <p data-location className="font-mono text-xs break-all text-neutral-600 dark:text-neutral-400">
                  Location: {outcome.location}
                </p>
              )}
              {outcome.kept.length > 0 && (
                <p className={hintClass}>Kept {outcome.kept.join(", ")} from this response for later requests.</p>
              )}
              <pre
                data-body
                className="max-h-96 overflow-auto rounded-lg bg-neutral-100 p-4 font-mono text-xs break-all whitespace-pre-wrap text-neutral-800 dark:bg-neutral-900 dark:text-neutral-200"
              >
                {outcome.body}
              </pre>
            </>
          )}
          {outcome?.kind === "error" && (
            <p className="text-sm text-red-600 dark:text-red-400">
              Request failed after {outcome.elapsed} ms: {outcome.message}
            </p>
          )}
          {outcome?.kind === "missing" && (
            <p className="text-sm text-red-600 dark:text-red-400">
              Fill in {outcome.labels.join(", ")} before sending.
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
