import { createHmac } from "crypto";

export type WebhookSignatureScheme = "github" | "stripe";

export interface WebhookSubscription {
  id: number;
  url: string;
  events: string[];
  active: boolean;
  secret?: string;
  signatureScheme?: WebhookSignatureScheme;
  owner: string;
  repo?: string;
}

export interface WebhookDelivery {
  id: number;
  hook_id: number;
  event: string;
  action?: string;
  payload: unknown;
  status_code: number | null;
  delivered_at: string;
  duration: number | null;
  success: boolean;
}

const MAX_DELIVERIES = 1000;

export class WebhookDispatcher {
  private subscriptions: WebhookSubscription[] = [];
  private deliveries: WebhookDelivery[] = [];
  private subscriptionIdCounter = 1;
  private deliveryIdCounter = 1;

  register(sub: Omit<WebhookSubscription, "id"> & { id?: number }): WebhookSubscription {
    const { id: explicitId, ...rest } = sub;
    const id = explicitId !== undefined ? explicitId : this.subscriptionIdCounter++;
    if (id >= this.subscriptionIdCounter) {
      this.subscriptionIdCounter = id + 1;
    }
    const subscription: WebhookSubscription = { ...rest, id };
    this.subscriptions.push(subscription);
    return subscription;
  }

  unregister(id: number): boolean {
    const idx = this.subscriptions.findIndex((s) => s.id === id);
    if (idx === -1) return false;
    this.subscriptions.splice(idx, 1);
    return true;
  }

  getSubscription(id: number): WebhookSubscription | undefined {
    return this.subscriptions.find((s) => s.id === id);
  }

  getSubscriptions(owner?: string, repo?: string): WebhookSubscription[] {
    return this.subscriptions.filter((s) => {
      if (owner && s.owner !== owner) return false;
      if (repo !== undefined && s.repo !== repo) return false;
      return true;
    });
  }

  updateSubscription(
    id: number,
    data: Partial<Pick<WebhookSubscription, "url" | "events" | "active" | "secret">>,
  ): WebhookSubscription | undefined {
    const sub = this.subscriptions.find((s) => s.id === id);
    if (!sub) return undefined;
    Object.assign(sub, data);
    return sub;
  }

  async dispatch(
    event: string,
    action: string | undefined,
    payload: unknown,
    owner: string,
    repo?: string,
  ): Promise<void> {
    const matchingSubs = this.subscriptions.filter((s) => {
      if (!s.active) return false;
      if (s.owner !== owner) return false;
      if (repo !== undefined) {
        if (s.repo !== repo) return false;
      } else if (s.repo !== undefined) {
        return false;
      }
      return event === "ping" || s.events.includes("*") || s.events.includes(event);
    });

    for (const sub of matchingSubs) {
      const delivery: WebhookDelivery = {
        id: this.deliveryIdCounter++,
        hook_id: sub.id,
        event,
        action,
        payload,
        status_code: null,
        delivered_at: new Date().toISOString(),
        duration: null,
        success: false,
      };

      const body = JSON.stringify(payload);

      const headers = buildWebhookHeaders(sub, event, delivery.id, body);

      try {
        const start = Date.now();
        const response = await fetch(sub.url, {
          method: "POST",
          headers,
          body,
          signal: AbortSignal.timeout(10000),
        });
        delivery.duration = Date.now() - start;
        delivery.status_code = response.status;
        delivery.success = response.ok;
      } catch {
        delivery.duration = 0;
        delivery.success = false;
      }

      this.deliveries.push(delivery);
      if (this.deliveries.length > MAX_DELIVERIES) {
        this.deliveries.splice(0, this.deliveries.length - MAX_DELIVERIES);
      }
    }
  }

  getDeliveries(hookId?: number): WebhookDelivery[] {
    if (hookId !== undefined) {
      return this.deliveries.filter((d) => d.hook_id === hookId);
    }
    return [...this.deliveries];
  }

  clear(): void {
    this.subscriptions.length = 0;
    this.deliveries.length = 0;
    this.subscriptionIdCounter = 1;
    this.deliveryIdCounter = 1;
  }
}

function buildWebhookHeaders(
  sub: WebhookSubscription,
  event: string,
  deliveryId: number,
  body: string,
): Record<string, string> {
  if (sub.signatureScheme === "stripe") {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (sub.secret) {
      const timestamp = Math.floor(Date.now() / 1000);
      const payload = `${timestamp}.${body}`;
      const signature = createHmac("sha256", sub.secret).update(payload).digest("hex");
      headers["Stripe-Signature"] = `t=${timestamp},v1=${signature}`;
    }
    return headers;
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-GitHub-Event": event,
    "X-GitHub-Delivery": String(deliveryId),
  };
  if (sub.secret) {
    const hmac = createHmac("sha256", sub.secret).update(body).digest("hex");
    headers["X-Hub-Signature-256"] = `sha256=${hmac}`;
  }
  return headers;
}
