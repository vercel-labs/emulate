import { randomBytes } from "node:crypto";
import type { ZendeskStore } from "./store.js";

const SEQUENCE_BASES: Record<string, number> = {
  tickets: 1,
  users: 10001,
  organizations: 20001,
  organization_memberships: 30001,
  groups: 40001,
  group_memberships: 50001,
  ticket_fields: 60001,
  user_fields: 70001,
  organization_fields: 80001,
  audits: 100001,
  events: 200001,
  macros: 300001,
  triggers: 400001,
  views: 500001,
  satisfaction_ratings: 600001,
  attachments: 700001,
  custom_statuses: 800001,
  brands: 900001,
  ticket_forms: 950001,
  identities: 960001,
  custom_field_options: 970001,
};

const SEQUENCE_PREFIX = "zendesk.sequence.";

export function nextId(zs: ZendeskStore, name: string): number {
  const key = `${SEQUENCE_PREFIX}${name}`;
  const current = zs.raw.getData<number>(key) ?? (SEQUENCE_BASES[name] ?? 1) - 1;
  const next = current + 1;
  zs.raw.setData(key, next);
  return next;
}

export function reserveId(zs: ZendeskStore, name: string, id: number): void {
  const key = `${SEQUENCE_PREFIX}${name}`;
  const current = zs.raw.getData<number>(key) ?? (SEQUENCE_BASES[name] ?? 1) - 1;
  if (id > current) zs.raw.setData(key, id);
}

const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function ulid(): string {
  let time = Date.now();
  let out = "";
  for (let i = 0; i < 10; i++) {
    out = ULID_ALPHABET[time % 32] + out;
    time = Math.floor(time / 32);
  }
  const bytes = randomBytes(16);
  for (let i = 0; i < 16; i++) out += ULID_ALPHABET[bytes[i] % 32];
  return out;
}

export function hexToken(bytes = 16): string {
  return randomBytes(bytes).toString("hex");
}
