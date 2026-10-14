import express from 'express';
import { Webhook } from 'svix';
import { Request, Response } from 'express';
import Stripe from 'stripe'; // Import Stripe library

// Extend the Request type to include rawBody
declare global {
    namespace Express {
        interface Request {
            rawBody?: string;
        }
    }
}

const app = express();

// Middleware to get raw body for signature verification.
// This is crucial for webhooks as the raw body is used in signature verification.
// If your application already has middleware that captures the raw body (e.g., body-parser.raw()),
// you might need to adjust or remove this specific `app.use` call to avoid conflicts.
app.use(express.json({
    verify: (req: Request, res: Response, buf: Buffer) => {
        req.rawBody = buf.toString();
    },
}));

// Environment variables for webhook secrets
// Ensure these are set in your environment (e.g., .env file)
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const POLAR_WEBHOOK_SECRET = process.env.POLAR_WEBHOOK_SECRET;
// While the full Stripe object might not be needed for webhooks alone,
// it's common practice to initialize it if other Stripe API calls are made.
// For webhook verification, only the secret is strictly needed.
// const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string); // Placeholder if other Stripe API calls were present.

app.post('/api/webhooks', async (req: Request, res: Response) => {
    // Ensure rawBody is available for signature verification
    if (!req.rawBody) {
        // This indicates a misconfiguration in the express.json middleware or its absence.
        return res.status(500).send('Webhook endpoint misconfigured: raw body not available.');
    }

    // Attempt to identify webhook provider based on headers
    const svixId = req.headers['svix-id'] as string | undefined;
    const svixTimestamp = req.headers['svix-timestamp'] as string | undefined;
    const webhookSignature = req.headers['webhook-signature'] as string | undefined; // As per core lesson 3 (Svix standard header)

    const stripeSignature = req.headers['stripe-signature'] as string | undefined;

    if (svixId && svixTimestamp && webhookSignature) {
        // This is likely a Polar.sh webhook (uses Svix)
        if (!POLAR_WEBHOOK_SECRET) {
            return res.status(500).send('Server Error: Polar webhook secret not configured.');
        }

        try {
            const wh = new Webhook(POLAR_WEBHOOK_SECRET, {
                webhookSignatureHeader: 'webhook-signature', // CRITICAL: As per core lesson 3
                webhookIdHeader: 'svix-id',
                webhookTimestampHeader: 'svix-timestamp',
            });

            // The 'verify' method will throw an error if the signature is invalid
            // or if the timestamp is too old/new.
            const payload = wh.verify(req.rawBody, {
                'webhook-signature': webhookSignature,
                'svix-id': svixId,
                'svix-timestamp': svixTimestamp,
            });

            // Webhook successfully verified. Process the payload.
            // In a production application, you would typically dispatch this event
            // to a dedicated service or handler based on the event 'type' or other fields.
            // Example payload structure for Polar.sh events:
            // if (typeof payload === 'object' && payload !== null && 'type' in payload) {
            //     switch ((payload as { type: string }).type) { // Safely cast to access 'type'
            //         case 'issue.pledged':
            //             // Handle new pledge event
            //             break;
            //         case 'order.created':
            //             // Handle order creation event
            //             break;
            //         case 'subscription.created':
            //             // Handle new subscription
            //             break;
            //         // Add more cases for other Polar.sh event types as needed
            //     }
            // }

            return res.status(200).json({ received: true, provider: 'polar.sh', event: payload });

        } catch (error: any) {
            // Log the error internally for debugging, but return a generic 400 to the client
            // to avoid leaking sensitive information.
            // In a real application, consider using a proper logging library here.
            // console.error(`Polar.sh Webhook Verification Error: ${error.message}`);
            return res.status(400).send(`Polar.sh Webhook Error: ${error.message}`);
        }

    } else if (stripeSignature) {
        // This is likely a Stripe webhook
        if (!STRIPE_WEBHOOK_SECRET) {
            return res.status(500).send('Server Error: Stripe webhook secret not configured.');
        }

        try {
            // Use the Stripe Node.js library to construct and verify the event
            const event = Stripe.webhooks.constructEvent(
                req.rawBody,
                stripeSignature,
                STRIPE_WEBHOOK_SECRET
            );

            // Webhook successfully verified. Process the event.
            // switch (event.type) {
            //     case 'customer.subscription.created':
            //         // Handle subscription creation
            //         break;
            //     case 'checkout.session.completed':
            //         // Handle checkout completion
            //         break;
            //     // Add more cases for other Stripe event types
            // }

            return res.status(200).json({ received: true, provider: 'stripe', event: event });

        } catch (error: any) {
            // Log the error internally for debugging, but return a generic 400 to the client.
            // console.error(`Stripe Webhook Verification Error: ${error.message}`);
            return res.status(400).send(`Stripe Webhook Error: ${error.message}`);
        }

    } else {
        // Neither Polar.sh nor Stripe recognized
        return res.status(400).send('Unknown webhook provider or missing signature headers.');
    }
});

export default app;