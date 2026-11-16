"use client";

import { useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import type { ConsolePreset, ConsoleVariable, PresetGroup } from "@/lib/services";

type Method = ConsolePreset["method"];

interface Form {
  method: Method;
  path: string;
  headers: string;
  body: string;
}

type Outcome =
  | { kind: "response"; status: number; statusText: string; elapsed: number; body: string; kept: string[] }
  | { kind: "error"; message: string; elapsed: number }
  | { kind: "missing"; labels: string[] };

const methods: Method[] = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];

const placeholder = /\{\{([a-z0-9_]+)\}\}/g;

const fieldClass =
  "w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 font-mono text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50";

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

/** Reads the values a preset keeps from a JSON response, each by a dot path such as `id` or `results.0.id`. */
function capture(text: string, captures: Record<string, string> = {}): Record<string, string> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return {};
  }
  const kept: Record<string, string> = {};
  for (const [name, path] of Object.entries(captures)) {
    const value = path
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

/** Request console for one emulator: a filterable list of operations on the left, the editable request and its response on the right. `{{name}}` placeholders are filled from the Values fields when sending. */
export function ApiConsole({
  name,
  groups,
  variables,
  initialValues,
}: {
  name: string;
  groups: PresetGroup[];
  variables: ConsoleVariable[];
  initialValues: Record<string, string>;
}) {
  const operations = groups
    .flatMap((group, groupIndex) => group.presets.map((preset) => ({ groupIndex, groupTitle: group.title, preset })))
    .map((operation, index) => ({ ...operation, index }));

  const [selected, setSelected] = useState(0);
  const [filter, setFilter] = useState("");
  const [form, setForm] = useState<Form>(() => toForm(operations[0]?.preset));
  const [values, setValues] = useState<Record<string, string>>(initialValues);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [pending, setPending] = useState(false);
  const latestRequest = useRef(0);

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
    setPending(false);
  }

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (missing.length > 0) {
      setOutcome({ kind: "missing", labels: missing.map(labelOf) });
      return;
    }
    const request = ++latestRequest.current;
    setPending(true);
    setOutcome(null);
    const started = performance.now();
    try {
      const response = await fetch(`/emulate/${name}${fill(form.path, values).replace(/\/$/, "")}`, {
        method: form.method,
        headers: parseHeaders(fill(form.headers, values)),
        body: bodyDisabled ? undefined : fill(form.body, values),
      });
      const text = await response.text();
      if (request !== latestRequest.current) return;
      const captured = response.ok ? capture(text, current.preset.captures) : {};
      if (Object.keys(captured).length > 0) setValues((previous) => ({ ...previous, ...captured }));
      setOutcome({
        kind: "response",
        status: response.status,
        statusText: response.statusText,
        elapsed: Math.round(performance.now() - started),
        body: prettify(text),
        kept: Object.keys(captured).map(labelOf),
      });
    } catch (error) {
      if (request !== latestRequest.current) return;
      setOutcome({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
        elapsed: Math.round(performance.now() - started),
      });
    } finally {
      if (request === latestRequest.current) setPending(false);
    }
  }

  if (!current) return <p className="text-sm text-muted-foreground">This service has no operations yet.</p>;

  return (
    <div className="grid gap-6 md:grid-cols-[18rem_minmax(0,1fr)] md:items-start">
      <aside className="flex flex-col gap-3 md:sticky md:top-6">
        <label htmlFor="console-filter" className="text-sm font-medium">
          Filter operations
        </label>
        <input
          id="console-filter"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          spellCheck={false}
          className={fieldClass}
        />
        <div className="flex max-h-80 flex-col gap-4 overflow-y-auto md:max-h-[calc(100vh-11rem)]">
          {visibleGroups.map((group) => (
            <div key={group.title} className="flex flex-col gap-1">
              <h3 className="px-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">{group.title}</h3>
              {group.items.map((operation) => (
                <button
                  key={operation.index}
                  type="button"
                  aria-current={operation.index === selected ? "true" : undefined}
                  onClick={() => choose(operation.index)}
                  className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 aria-[current=true]:bg-muted aria-[current=true]:font-medium"
                >
                  <span className="w-14 shrink-0 font-mono text-xs text-muted-foreground">
                    {operation.preset.method}
                  </span>
                  <span className="truncate">{operation.preset.label}</span>
                </button>
              ))}
            </div>
          ))}
          {visibleGroups.length === 0 && (
            <p className="px-2 text-sm text-muted-foreground">No operations match this filter.</p>
          )}
        </div>
      </aside>
      <div className="flex min-w-0 flex-col gap-6">
        <div className="flex flex-col gap-1">
          <h2 className="text-base font-medium">{current.preset.label}</h2>
          {current.preset.description && <p className="text-sm text-muted-foreground">{current.preset.description}</p>}
        </div>
        {used.length > 0 && (
          <fieldset className="flex flex-col gap-4">
            <legend className="mb-3 text-sm font-medium">Values</legend>
            {used.map((variable) => {
              const hint = variables.find((item) => item.name === variable)?.hint;
              return (
                <div key={variable} className="flex flex-col gap-1.5">
                  <label htmlFor={`console-var-${variable}`} className="text-sm font-medium">
                    {labelOf(variable)}
                  </label>
                  <input
                    id={`console-var-${variable}`}
                    value={values[variable] ?? ""}
                    onChange={(event) => setValues((previous) => ({ ...previous, [variable]: event.target.value }))}
                    aria-describedby={hint ? `console-var-${variable}-hint` : undefined}
                    spellCheck={false}
                    className={fieldClass}
                  />
                  {hint && (
                    <p id={`console-var-${variable}-hint`} className="text-xs text-muted-foreground">
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
              <label htmlFor="console-method" className="text-sm font-medium">
                Method
              </label>
              <select
                id="console-method"
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
              <label htmlFor="console-path" className="text-sm font-medium">
                Path
              </label>
              <input
                id="console-path"
                value={form.path}
                onChange={(event) => setForm((previous) => ({ ...previous, path: event.target.value }))}
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
              onChange={(event) => setForm((previous) => ({ ...previous, headers: event.target.value }))}
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
              rows={10}
              value={form.body}
              disabled={bodyDisabled}
              onChange={(event) => setForm((previous) => ({ ...previous, body: event.target.value }))}
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
              {outcome.kept.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  Kept {outcome.kept.join(", ")} from this response for later requests.
                </p>
              )}
              <pre className="max-h-96 overflow-auto rounded-xl bg-muted p-4 font-mono text-xs break-all whitespace-pre-wrap">
                {outcome.body}
              </pre>
            </>
          )}
          {outcome?.kind === "error" && (
            <p className="text-sm text-destructive">
              Request failed after {outcome.elapsed} ms: {outcome.message}
            </p>
          )}
          {outcome?.kind === "missing" && (
            <p className="text-sm text-destructive">Fill in {outcome.labels.join(", ")} before sending.</p>
          )}
        </section>
      </div>
    </div>
  );
}
