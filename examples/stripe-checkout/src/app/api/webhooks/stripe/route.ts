import { NextResponse } from "next/server";
import { recordOrder, updateOrder, findOrderByCustomer } from "@/lib/orders";

export async function POST(request: Request) {
  const body = await request.json();
  const event = body.type as string;
  const obj = body.data?.object;

  switch (event) {
    case "customer.created": {
      const order = findOrderByCustomer(obj.id);
      if (order) {
        updateOrder(order.sessionId, { customerEmail: obj.email ?? null });
      }
      break;
    }

    case "checkout.session.completed": {
      recordOrder({
        sessionId: obj.id,
        customerId: obj.customer ?? null,
        customerEmail: null,
        paymentStatus: obj.payment_status,
        paymentIntentId: null,
        chargeId: null,
        completedAt: new Date().toISOString(),
      });
      break;
    }

    case "payment_intent.succeeded": {
      const customerId = obj.customer as string | null;
      if (customerId) {
        const order = findOrderByCustomer(customerId);
        if (order) {
          updateOrder(order.sessionId, { paymentIntentId: obj.id });
        }
      }
      break;
    }

    case "charge.succeeded": {
      break;
    }
  }

  return NextResponse.json({ received: true });
}
