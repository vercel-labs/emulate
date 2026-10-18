import type { PolarOrganization, PolarProduct, PolarCheckout, PolarSubscription } from "../entities.js";

export function formatOrganization(o: PolarOrganization) {
  return {
    id: o.polar_id,
    name: o.name,
    slug: o.slug,
  };
}

export function formatProduct(p: PolarProduct) {
  return {
    id: p.polar_id,
    name: p.name,
    description: p.description,
    price: p.price,
    organization_id: p.organization_id,
  };
}

export function formatCheckout(c: PolarCheckout) {
  return {
    id: c.polar_id,
    client_secret: "mock_client_secret_" + c.polar_id,
    url: c.url,
    status: c.status,
    product_id: c.product_id,
    organization_id: c.organization_id,
    customer_email: c.customer_email,
  };
}

export function formatSubscription(s: PolarSubscription) {
  return {
    id: s.polar_id,
    status: s.status,
    user_id: s.user_id,
    product_id: s.product_id,
    organization_id: s.organization_id,
  };
}
