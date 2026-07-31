import type { Entity } from "@emulators/core";

export interface CreemProduct extends Entity {
  creem_id: string;
  name: string;
  description: string | null;
  amount: number;
  currency: string;
  return_url: string | null;
}

export interface CreemCheckout extends Entity {
  creem_id: string;
  product_id: string;
  status: "open" | "completed";
  mode: "test";
  metadata: Record<string, string>;
  customer_id: string | null;
  customer_email: string | null;
  order_id: string | null;
  subscription_id: string | null;
}

export interface CreemSubscription extends Entity {
  creem_id: string;
  checkout_id: string;
  customer_id: string;
  customer_email: string;
  status: "active" | "canceled";
  current_period_end_date: string;
}
