export interface Order {
  sessionId: string;
  customerId: string | null;
  customerEmail: string | null;
  paymentStatus: string;
  paymentIntentId: string | null;
  chargeId: string | null;
  completedAt: string;
}

const orders = new Map<string, Order>();

export function recordOrder(order: Order): void {
  orders.set(order.sessionId, order);
}

export function updateOrder(sessionId: string, data: Partial<Order>): void {
  const existing = orders.get(sessionId);
  if (existing) {
    Object.assign(existing, data);
  }
}

export function getOrder(sessionId: string): Order | undefined {
  return orders.get(sessionId);
}

export function findOrderByCustomer(customerId: string): Order | undefined {
  for (const order of orders.values()) {
    if (order.customerId === customerId) return order;
  }
  return undefined;
}
