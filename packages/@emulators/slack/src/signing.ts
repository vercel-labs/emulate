import { createHmac } from "node:crypto";
import type { Store } from "@emulators/core";

export function slackRequestHeaders(
  store: Store,
  body: string,
  contentType = "application/json",
): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": contentType };
  const secret = store.getData<string>("slack.signing_secret");
  if (secret) {
    const timestamp = Math.floor(Date.now() / 1000);
    headers["X-Slack-Request-Timestamp"] = String(timestamp);
    headers["X-Slack-Signature"] = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  }
  return headers;
}
