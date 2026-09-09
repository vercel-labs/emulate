import type { AppEnv, Hono } from "@emulators/core";
import type { MailgunDomain, MailgunList } from "./entities.js";
import type { Fmt } from "./formatters.js";
import { notFound } from "./helpers.js";
import type { MailgunStore } from "./store.js";
import type { MailgunCtx } from "./webhooks.js";

export interface MailgunRouteContext {
  app: Hono<AppEnv>;
  ms: MailgunStore;
  ctx: MailgunCtx;
  fmt: Fmt;
  baseUrl: string;
}

export function findDomain(ms: MailgunStore, name: string): MailgunDomain {
  const domain = ms.domains.findOneBy("name", name.toLowerCase());
  if (!domain) throw notFound(`Domain not found: ${name}`);
  return domain;
}

export function findList(ms: MailgunStore, address: string): MailgunList {
  const list = ms.lists.findOneBy("address", decodeURIComponent(address).toLowerCase());
  if (!list) throw notFound("Mailing list not found");
  return list;
}

export const MESSAGE_HTML_PATH = "/_mailgun/messages";
