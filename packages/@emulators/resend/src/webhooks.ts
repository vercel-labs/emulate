import { createHash, createHmac, randomBytes } from "crypto";
import type { WebhookDispatcher, WebhookHeaderContext } from "@emulators/core";
import type { ResendWebhook } from "./entities.js";

const SECRET_PREFIX = "whsec_";
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

// Event types the emulator emits. Seeded webhooks that list no events subscribe to all of them.
export const RESEND_WEBHOOK_EVENTS = [
  "email.sent",
  "email.delivered",
  "domain.created",
  "domain.deleted",
  "contact.created",
  "contact.deleted",
];

// Hosts that webhooks created or updated through the API may deliver to when resend.webhook_hosts is not set.
// Seeded webhooks come from the operator's own config and are not checked.
export const DEFAULT_WEBHOOK_HOSTS = ["localhost", "127.0.0.1", "::1"];

export function normalizeWebhookHost(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
}

export type WebhookEndpointRejection = { status: 403 | 422; message: string };

// The emulator sends deliveries from its own host, so an API client may only point a webhook at a host the operator
// allowed. Without that check, anyone who can reach the emulator could make it post to services only its host can reach.
export function webhookEndpointRejection(
  endpoint: string,
  allowedHosts: string[] = DEFAULT_WEBHOOK_HOSTS,
): WebhookEndpointRejection | undefined {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return { status: 422, message: "endpoint must be an http or https URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { status: 422, message: "endpoint must be an http or https URL" };
  }
  const host = normalizeWebhookHost(url.hostname);
  if (allowedHosts.some((allowed) => normalizeWebhookHost(allowed) === host)) return undefined;
  return {
    status: 403,
    message: `${host} is not in resend.webhook_hosts: ${allowedHosts.join(", ") || "(empty)"}.`,
  };
}

export function generateSigningSecret(): string {
  return SECRET_PREFIX + randomBytes(24).toString("base64");
}

// Seeded webhooks without a signing_secret get one derived from the endpoint, so it survives resets and restarts.
export function seededSigningSecret(endpoint: string): string {
  const digest = createHash("sha256").update(`emulate resend webhook ${endpoint}`).digest();
  return SECRET_PREFIX + digest.subarray(0, 24).toString("base64");
}

function svixMessageId(): string {
  const bytes = randomBytes(27);
  let id = "msg_";
  for (const byte of bytes) id += BASE62[byte % BASE62.length];
  return id;
}

// Svix signs `${svix-id}.${svix-timestamp}.${body}` with HMAC-SHA256, keyed with the base64-decoded secret after the whsec_ prefix.
export function svixSignature(secret: string, id: string, timestamp: string, body: string): string {
  const key = Buffer.from(secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : secret, "base64");
  return "v1," + createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64");
}

export function svixWebhookHeaders({ body, subscription }: WebhookHeaderContext): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (!subscription.secret) return headers;

  const id = svixMessageId();
  const timestamp = String(Math.floor(Date.now() / 1000));
  headers["svix-id"] = id;
  headers["svix-timestamp"] = timestamp;
  headers["svix-signature"] = svixSignature(subscription.secret, id, timestamp, body);
  return headers;
}

export function subscribeWebhook(webhooks: WebhookDispatcher, webhook: ResendWebhook): void {
  const subscription = {
    url: webhook.endpoint,
    events: webhook.events,
    active: webhook.status === "enabled",
    secret: webhook.signing_secret,
  };
  if (webhooks.getSubscription(webhook.id)) {
    webhooks.updateSubscription(webhook.id, subscription);
  } else {
    webhooks.register({ id: webhook.id, owner: "resend", ...subscription });
  }
}
