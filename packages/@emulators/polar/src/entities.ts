import type { Entity } from "@emulators/core";

export interface PolarOrganization extends Entity {
  polar_id: string;
  name: string;
  slug: string;
  avatar_url: string | null;
}

export interface PolarProduct extends Entity {
  polar_id: string;
  name: string;
  description: string | null;
  organization_id: string;
  is_recurring: boolean;
  is_archived: boolean;
}

export interface PolarPrice extends Entity {
  polar_id: string;
  product_id: string;
  amount_type: "fixed";
  price_currency: string;
  price_amount: number;
  recurring_interval: "month" | "year" | null;
}

export interface PolarCheckout extends Entity {
  polar_id: string;
  status: "open" | "confirmed" | "expired";
  payment_processor: "stripe";
  client_secret: string;
  url: string;
  success_url: string;
  embed_origin: string | null;
  organization_id: string;
  product_id: string;
  price_id: string;
  customer_id: string | null;
  customer_name: string | null;
  customer_email: string | null;
  metadata: Record<string, string | number | boolean>;
}

export interface PolarSubscription extends Entity {
  polar_id: string;
  status: "active" | "canceled" | "incomplete" | "incomplete_expired" | "past_due" | "unpaid";
  current_period_start: string;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  canceled_at: string | null;
  started_at: string | null;
  user_id: string;
  organization_id: string;
  product_id: string;
  price_id: string;
  checkout_id: string | null;
  metadata: Record<string, string | number | boolean>;
}
