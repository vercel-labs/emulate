import type {
  AppEnv,
  RouteContext,
  ServicePlugin,
  Store,
  TokenMap,
  WebhookDispatcher,
} from "@internal/core";
import type { Hono } from "hono";
import {
  createLabelRecord,
  createStoredMessage,
  ensureSystemLabels,
  findLabelById,
  findLabelByName,
  generateUid,
} from "./helpers.js";
import { labelRoutes } from "./routes/labels.js";
import { messageRoutes } from "./routes/messages.js";
import { oauthRoutes } from "./routes/oauth.js";
import { threadRoutes } from "./routes/threads.js";
import { getGoogleStore } from "./store.js";

export { getGoogleStore, type GoogleStore } from "./store.js";
export * from "./entities.js";

export interface GoogleSeedUser {
  email: string;
  name?: string;
  given_name?: string;
  family_name?: string;
  picture?: string;
  locale?: string;
  email_verified?: boolean;
}

export interface GoogleSeedLabel {
  id?: string;
  user_email?: string;
  name: string;
  type?: "system" | "user";
  message_list_visibility?: string;
  label_list_visibility?: string;
  color_background?: string;
  color_text?: string;
}

export interface GoogleSeedMessage {
  id?: string;
  thread_id?: string;
  user_email?: string;
  raw?: string;
  from?: string;
  to?: string;
  cc?: string;
  bcc?: string;
  reply_to?: string;
  subject?: string;
  snippet?: string;
  body_text?: string;
  body_html?: string;
  label_ids?: string[];
  date?: string;
  internal_date?: string;
  message_id?: string;
  references?: string;
  in_reply_to?: string;
}

export interface GoogleSeedConfig {
  port?: number;
  users?: GoogleSeedUser[];
  oauth_clients?: Array<{
    client_id: string;
    client_secret: string;
    name?: string;
    redirect_uris: string[];
  }>;
  labels?: GoogleSeedLabel[];
  messages?: GoogleSeedMessage[];
}

function seedDefaults(store: Store, _baseUrl: string): void {
  const gs = getGoogleStore(store);
  const defaultEmail = "testuser@gmail.com";

  if (!gs.users.findOneBy("email", defaultEmail)) {
    gs.users.insert({
      uid: generateUid("goog"),
      email: defaultEmail,
      name: "Test User",
      given_name: "Test",
      family_name: "User",
      picture: null,
      email_verified: true,
      locale: "en",
    });
  }

  ensureSystemLabels(gs, defaultEmail);
  seedMessages(store, [
    {
      id: "msg_welcome",
      thread_id: "thr_welcome",
      user_email: defaultEmail,
      from: "Welcome Team <welcome@example.com>",
      to: defaultEmail,
      subject: "Welcome to your local Gmail emulator",
      snippet: "Your OAuth flow is set up and Gmail message, thread, and label APIs are ready.",
      body_text:
        "Your OAuth flow is set up and Gmail message, thread, and label APIs are ready.\n\nUse this inbox to test Gmail automations locally.",
      label_ids: ["INBOX", "UNREAD", "CATEGORY_UPDATES"],
      date: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    },
    {
      id: "msg_build",
      thread_id: "thr_build",
      user_email: defaultEmail,
      from: "Build Bot <builds@example.com>",
      to: defaultEmail,
      subject: "Nightly build finished successfully",
      snippet: "The latest build completed successfully in 6 minutes.",
      body_text:
        "The latest build completed successfully in 6 minutes.\n\nArtifact upload finished and smoke checks passed.",
      label_ids: ["INBOX", "CATEGORY_UPDATES"],
      date: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    },
    {
      id: "msg_build_reply",
      thread_id: "thr_build",
      user_email: defaultEmail,
      from: defaultEmail,
      to: "Build Bot <builds@example.com>",
      subject: "Re: Nightly build finished successfully",
      snippet: "Thanks, I will review the artifact after lunch.",
      body_text: "Thanks, I will review the artifact after lunch.",
      label_ids: ["SENT"],
      date: new Date(Date.now() - 90 * 60 * 1000).toISOString(),
      in_reply_to: "<msg_build@emulate.google.local>",
      references: "<msg_build@emulate.google.local>",
    },
    {
      id: "msg_draft",
      thread_id: "thr_draft",
      user_email: defaultEmail,
      from: defaultEmail,
      to: "someone@example.com",
      subject: "Draft follow-up",
      snippet: "Checking in on the open question from yesterday.",
      body_text: "Checking in on the open question from yesterday.",
      label_ids: ["DRAFT"],
      date: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    },
  ], defaultEmail);
}

export function seedFromConfig(store: Store, _baseUrl: string, config: GoogleSeedConfig): void {
  const gs = getGoogleStore(store);

  if (config.users) {
    for (const user of config.users) {
      const existing = gs.users.findOneBy("email", user.email);
      if (!existing) {
        const nameParts = (user.name ?? "").split(/\s+/).filter(Boolean);
        gs.users.insert({
          uid: generateUid("goog"),
          email: user.email,
          name: user.name ?? user.email.split("@")[0],
          given_name: user.given_name ?? nameParts[0] ?? "",
          family_name: user.family_name ?? nameParts.slice(1).join(" "),
          picture: user.picture ?? null,
          email_verified: user.email_verified ?? true,
          locale: user.locale ?? "en",
        });
      }

      ensureSystemLabels(gs, user.email);
    }
  }

  if (config.oauth_clients) {
    for (const client of config.oauth_clients) {
      const existing = gs.oauthClients.findOneBy("client_id", client.client_id);
      if (existing) continue;

      gs.oauthClients.insert({
        client_id: client.client_id,
        client_secret: client.client_secret,
        name: client.name ?? "Code App (Google)",
        redirect_uris: client.redirect_uris,
      });
    }
  }

  const fallbackEmail = config.users?.[0]?.email ?? gs.users.all()[0]?.email ?? "testuser@gmail.com";
  ensureSystemLabels(gs, fallbackEmail);

  if (config.labels) {
    seedLabels(store, config.labels, fallbackEmail);
  }

  if (config.messages) {
    seedMessages(store, config.messages, fallbackEmail);
  }
}

function seedLabels(store: Store, labels: GoogleSeedLabel[], fallbackEmail: string): void {
  const gs = getGoogleStore(store);

  for (const label of labels) {
    const userEmail = label.user_email ?? fallbackEmail;
    ensureSystemLabels(gs, userEmail);

    const existing =
      (label.id ? findLabelById(gs, userEmail, label.id) : undefined) ??
      findLabelByName(gs, userEmail, label.name);

    if (existing) continue;

    createLabelRecord(gs, {
      gmail_id: label.id,
      user_email: userEmail,
      name: label.name,
      type: label.type ?? "user",
      message_list_visibility: label.message_list_visibility ?? "show",
      label_list_visibility: label.label_list_visibility ?? "labelShow",
      color_background: label.color_background ?? null,
      color_text: label.color_text ?? null,
    });
  }
}

function seedMessages(store: Store, messages: GoogleSeedMessage[], fallbackEmail: string): void {
  const gs = getGoogleStore(store);

  for (const message of messages) {
    const userEmail = message.user_email ?? fallbackEmail;
    ensureSystemLabels(gs, userEmail);

    if (message.id && gs.messages.findOneBy("gmail_id", message.id)) continue;

    createStoredMessage(gs, {
      gmail_id: message.id,
      thread_id: message.thread_id,
      user_email: userEmail,
      raw: message.raw ?? null,
      from: message.from,
      to: message.to,
      cc: message.cc ?? null,
      bcc: message.bcc ?? null,
      reply_to: message.reply_to ?? null,
      subject: message.subject,
      snippet: message.snippet,
      body_text: message.body_text ?? null,
      body_html: message.body_html ?? null,
      label_ids: message.label_ids ?? ["INBOX", "UNREAD"],
      date: message.date,
      internal_date: message.internal_date,
      message_id: message.message_id,
      references: message.references ?? null,
      in_reply_to: message.in_reply_to ?? null,
    }, {
      createMissingCustomLabels: true,
    });
  }
}

export const googlePlugin: ServicePlugin = {
  name: "google",
  register(
    app: Hono<AppEnv>,
    store: Store,
    webhooks: WebhookDispatcher,
    baseUrl: string,
    tokenMap?: TokenMap,
  ): void {
    const ctx: RouteContext = { app, store, webhooks, baseUrl, tokenMap };
    oauthRoutes(ctx);
    messageRoutes(ctx);
    threadRoutes(ctx);
    labelRoutes(ctx);
  },
  seed(store: Store, baseUrl: string): void {
    seedDefaults(store, baseUrl);
  },
};

export default googlePlugin;
