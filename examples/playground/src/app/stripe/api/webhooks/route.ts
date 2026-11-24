import { NextResponse } from "next/server";
import { recordOrder } from "@/lib/stripe/orders";

export async function POST(request: Request) {
  const body = await request.json();
  if (body.type === "checkout.session.completed") {
    recordOrder({ sessionId: body.data.object.id, completedAt: new Date().toISOString() });
  }
  return NextResponse.json({ received: true });
}
