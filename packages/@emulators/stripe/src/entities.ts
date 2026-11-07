import type { Entity } from "@emulators/core";

export interface StripeCustomer extends Entity {
  stripe_id: string;
  email: string | null;
  name: string | null;
  description: string | null;
  metadata: Record<string, string>;
}

export interface StripeProduct extends Entity {
  stripe_id: string;
  name: string;
  description: string | null;
  active: boolean;
  metadata: Record<string, string>;
}

export interface StripePrice extends Entity {
  stripe_id: string;
  product_id: string;
  currency: string;
  unit_amount: number | null;
  type: "one_time" | "recurring";
  active: boolean;
  metadata: Record<string, string>;
}

export type PaymentIntentStatus =
  | "requires_payment_method"
  | "requires_confirmation"
  | "requires_action"
  | "processing"
  | "succeeded"
  | "canceled";

export interface StripePaymentIntent extends Entity {
  stripe_id: string;
  amount: number;
  currency: string;
  status: PaymentIntentStatus;
  customer_id: string | null;
  description: string | null;
  payment_method: string | null;
  metadata: Record<string, string>;
}

export interface StripeCharge extends Entity {
  stripe_id: string;
  amount: number;
  currency: string;
  status: "succeeded" | "pending" | "failed";
  customer_id: string | null;
  payment_intent_id: string | null;
  description: string | null;
  metadata: Record<string, string>;
  payment_method?: string;
  failure_code?: string;
  failure_message?: string;
}

export interface StripeCheckoutSession extends Entity {
  stripe_id: string;
  mode: "payment" | "setup" | "subscription";
  status: "open" | "complete" | "expired";
  payment_status: "paid" | "unpaid" | "no_payment_required";
  customer_id: string | null;
  success_url: string | null;
  cancel_url: string | null;
  line_items: Array<{ price: string; quantity: number }>;
  metadata: Record<string, string>;
}

export interface StripeEventRequest {
  id: string | null;
  idempotency_key: string | null;
}

export interface StripeEvent extends Entity {
  stripe_id: string;
  type: string;
  api_version: string;
  /** Unix seconds. Kept separately from created_at so simulated time can set it later. */
  created: number;
  data: { object: Record<string, unknown>; previous_attributes?: Record<string, unknown> };
  pending_webhooks: number;
  request: StripeEventRequest;
}

export interface StripeWebhookEndpoint extends Entity {
  stripe_id: string;
  url: string;
  enabled_events: string[];
  status: "enabled" | "disabled";
  /** Rendered as null when unset. Events always use the emulator's version. */
  api_version?: string;
  description?: string;
  metadata: Record<string, string>;
  /** Seed endpoints may have no secret, in which case deliveries are unsigned. */
  secret?: string;
  created: number;
}

/** A delivery the chaos settings decided not to send. Sent deliveries live in the core dispatcher. */
export interface StripeWebhookAttempt extends Entity {
  event_id: string;
  type: string;
  status: "dropped";
  url: string;
  created: number;
}
