import { randomBytes } from "crypto";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

export interface License {
  key: string;
  product: string;
  amount: number;
  currency: string;
  sessionId: string;
  issuedAt: string;
}

// In a real app this would be a database. For the demo we persist to a JSON
// file under the OS temp dir. A file (not module memory) is required because
// Next.js dev runs route handlers and server components in separate worker
// processes — module-level state and `globalThis` are per-process, so the
// webhook handler would write to one in-memory array and the dashboard would
// read from another. The file is the cheapest cross-process store.
const STORE_DIR = join(tmpdir(), "acme-studio-demo");
const STORE_FILE = join(STORE_DIR, "licenses.json");

function readAll(): License[] {
  try {
    return JSON.parse(readFileSync(STORE_FILE, "utf8")) as License[];
  } catch {
    return [];
  }
}

function writeAll(licenses: License[]): void {
  mkdirSync(STORE_DIR, { recursive: true });
  writeFileSync(STORE_FILE, JSON.stringify(licenses, null, 2));
}

function generateKey(): string {
  const bytes = randomBytes(8).toString("hex").toUpperCase();
  return `LIFETIME-${bytes.slice(0, 4)}-${bytes.slice(4, 8)}-${bytes.slice(8, 12)}-${bytes.slice(12, 16)}`;
}

export function issueLicense(input: {
  product: string;
  amount: number;
  currency: string;
  sessionId: string;
}): License {
  const all = readAll();
  const existing = all.find((l) => l.sessionId === input.sessionId);
  if (existing) return existing;

  const license: License = {
    key: generateKey(),
    product: input.product,
    amount: input.amount,
    currency: input.currency,
    sessionId: input.sessionId,
    issuedAt: new Date().toISOString(),
  };
  all.push(license);
  writeAll(all);
  return license;
}

export function listLicenses(): License[] {
  return readAll().slice().reverse();
}

export function findLicenseBySessionId(sessionId: string): License | undefined {
  return readAll().find((l) => l.sessionId === sessionId);
}
