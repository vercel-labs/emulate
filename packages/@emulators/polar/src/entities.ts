import type { Entity } from "@emulators/core";

export interface PolarOrganization extends Entity {
  polar_id: string;
  name: string;
  slug: string;
}

export interface PolarProduct extends Entity {
  polar_id: string;
  name: string;
  description?: string;
  price: number;
  organization_id: string;
}

export interface PolarCheckout extends Entity {
  polar_id: string;
  url: string;
  status: "open" | "confirmed" | "failed";
  product_id: string;
  organization_id: string;
  customer_email?: string;
}

export interface PolarSubscription extends Entity {
  polar_id: string;
  status: "active" | "canceled";
  user_id: string;
  product_id: string;
  organization_id: string;
}
