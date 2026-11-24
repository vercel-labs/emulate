export interface Order {
  sessionId: string;
  completedAt: string;
}

/**
 * Orders the webhook recorded, by checkout session id. Next bundles the webhook route and the success page
 * separately, each with its own copy of this module, so the map lives on globalThis where both see the same one.
 */
const orders: Map<string, Order> = ((globalThis as { stripeOrders?: Map<string, Order> }).stripeOrders ??= new Map());

export function recordOrder(order: Order): void {
  orders.set(order.sessionId, order);
}

export function getOrder(sessionId: string): Order | undefined {
  return orders.get(sessionId);
}
