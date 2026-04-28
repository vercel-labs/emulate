import { issueLicense } from "@/lib/licenses";
import { recordWebhook } from "@/lib/webhook-log";

interface CheckoutSessionEvent {
  type: string;
  data?: {
    object?: {
      id?: string;
      object?: string;
      payment_status?: string;
    };
  };
}

export async function POST(req: Request) {
  // In production:
  //   const event = stripe.webhooks.constructEvent(
  //     await req.text(),
  //     req.headers.get("stripe-signature")!,
  //     process.env.STRIPE_WEBHOOK_SECRET!,
  //   );
  // The local emulator delivers JSON directly, so we parse the body as-is.
  const event = (await req.json()) as CheckoutSessionEvent;

  recordWebhook({
    event: event.type,
    sessionId: event.data?.object?.id,
  });

  if (event.type === "checkout.session.completed") {
    const session = event.data?.object;
    if (session?.id && session.payment_status === "paid") {
      issueLicense({
        product: "Lifetime License",
        amount: 2900,
        currency: "usd",
        sessionId: session.id,
      });
    }
  }

  return new Response(null, { status: 204 });
}
