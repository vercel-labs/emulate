import type { RouteContext } from "@emulators/core";
import { parseSlackBody, slackError, slackOk } from "../helpers.js";
import { isSlackTokenRevoked, slackRequestToken } from "../tokens.js";

const RETRY_REASONS = new Set([
  "http_timeout",
  "too_many_redirects",
  "connection_failed",
  "ssl_error",
  "http_error",
  "unknown_error",
]);

export function eventRetryRoutes({ app, store, webhooks }: RouteContext): void {
  app.post("/_slack/simulate/event-retry", async (c) => {
    const token = slackRequestToken(c);
    if (token && isSlackTokenRevoked(store, token)) return slackError(c, "token_revoked");
    if (!c.get("authUser")) return slackError(c, "not_authed");

    const body = await parseSlackBody(c);
    const reason = body.reason ?? "http_timeout";
    if (
      typeof body.event_id !== "string" ||
      !body.event_id.trim() ||
      typeof reason !== "string" ||
      !RETRY_REASONS.has(reason)
    ) {
      return slackError(c, "invalid_arguments");
    }

    const subscriptions = new Set(webhooks.getSubscriptions("slack").map((sub) => sub.id));
    const original = webhooks
      .getDeliveries()
      .filter((delivery) => {
        if (!subscriptions.has(delivery.hook_id)) return false;
        const payload = delivery.payload as { type?: string; event_id?: string } | null;
        return payload?.type === "event_callback" && payload.event_id === body.event_id;
      })
      .sort((a, b) => b.id - a.id)[0];
    if (!original) return slackError(c, "event_not_found");

    const retryNum = (original.redelivery_count ?? 0) + 1;
    const delivery = await webhooks.redeliver(original.id, {
      headers: { "X-Slack-Retry-Num": String(retryNum), "X-Slack-Retry-Reason": reason },
    });
    if (!delivery) return slackError(c, "subscription_inactive");

    return slackOk(c, {
      event_id: body.event_id,
      retry_num: retryNum,
      delivery_id: delivery.id,
      success: delivery.success,
      status_code: delivery.status_code,
    });
  });
}
