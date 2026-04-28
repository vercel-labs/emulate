import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

export interface WebhookLogEntry {
  id: number;
  event: string;
  receivedAt: string;
  sessionId?: string;
}

// File-backed for the same reason as licenses: Next.js dev runs route
// handlers and server components in separate worker processes, so in-memory
// state isn't shared. The file is the cheapest cross-process store.
const STORE_DIR = join(tmpdir(), "acme-studio-demo");
const STORE_FILE = join(STORE_DIR, "webhook-log.json");

interface State {
  entries: WebhookLogEntry[];
  counter: number;
}

function readState(): State {
  try {
    return JSON.parse(readFileSync(STORE_FILE, "utf8")) as State;
  } catch {
    return { entries: [], counter: 1 };
  }
}

function writeState(state: State): void {
  mkdirSync(STORE_DIR, { recursive: true });
  writeFileSync(STORE_FILE, JSON.stringify(state, null, 2));
}

export function recordWebhook(input: { event: string; sessionId?: string }): WebhookLogEntry {
  const state = readState();
  const entry: WebhookLogEntry = {
    id: state.counter++,
    event: input.event,
    receivedAt: new Date().toISOString(),
    sessionId: input.sessionId,
  };
  state.entries.push(entry);
  if (state.entries.length > 50) state.entries.splice(0, state.entries.length - 50);
  writeState(state);
  return entry;
}

export function listWebhooks(sinceId = 0): WebhookLogEntry[] {
  return readState().entries.filter((e) => e.id > sinceId);
}
