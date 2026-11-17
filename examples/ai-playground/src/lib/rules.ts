import { PACING, REASONING, type Pacing } from "./scenarios";

export type Config = Record<string, unknown> & {
  timing?: Pacing;
  rules?: ConfigRule[];
};

type ConfigRule = Record<string, unknown> & {
  id?: string;
  reply?: { type?: string; text?: string }[];
  variants?: { reply?: { type?: string; text?: string }[]; [key: string]: unknown }[];
};

export function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(
    /\[\n\s+([^[\]{}]*?)\n\s+\]/g,
    (_, items: string) => `[${items.replace(/,\n\s+/g, ", ")}]`,
  );
}

export function parseJson(text: string): { value?: unknown; error?: string } {
  try {
    return { value: JSON.parse(text) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export function pacingName(config: Config): string {
  const timing = JSON.stringify(config.timing);
  return Object.keys(PACING).find((name) => JSON.stringify(PACING[name]) === timing) ?? "custom";
}

function repliesOf(config: Config): NonNullable<ConfigRule["reply"]>[] {
  return (config.rules ?? [])
    .flatMap((rule) => [rule, ...(rule.variants ?? [])])
    .map((item) => item?.reply)
    .filter((reply): reply is NonNullable<ConfigRule["reply"]> => Array.isArray(reply));
}

export function scriptsReasoning(config: Config): boolean {
  return repliesOf(config).some((events) => events.some((event) => event?.type === "reasoning"));
}

export function hasReplies(config: Config): boolean {
  return repliesOf(config).length > 0;
}

export function withReasoning(config: Config, on: boolean): Config {
  const next = structuredClone(config);
  for (const events of repliesOf(next)) {
    const rest = events.filter((event) => event?.type !== "reasoning");
    events.splice(0, events.length, ...(on ? [REASONING, ...rest] : rest));
  }
  return next;
}

export function answeredBy(matched: { id?: string; remaining?: number | null; default?: string } | null): string {
  if (!matched) return "no rule matched";
  if (matched.default) return `built-in default (${matched.default})`;
  return `rule ${matched.id}${matched.remaining == null ? "" : `, ${matched.remaining} uses left`}`;
}
