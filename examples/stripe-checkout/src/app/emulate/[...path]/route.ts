import { createEmulateHandler } from "@emulators/adapter-next";
import * as stripe from "@emulators/stripe";

export const { GET, POST, PUT, PATCH, DELETE } = createEmulateHandler({
  services: {
    stripe: {
      emulator: stripe,
      seed: {
        products: [
          { id: "prod_hoodie", name: "Emulate Hoodie", description: "Stay warm while shipping" },
          { id: "prod_stickers", name: "Emulate Sticker Pack", description: "Decorate your laptop" },
          { id: "prod_mug", name: "Emulate Mug", description: "Fuel your coding sessions" },
          { id: "prod_tshirt", name: "Emulate T-Shirt", description: "A comfortable tee for local development" },
        ],
        prices: [
          { id: "price_hoodie", product_name: "Emulate Hoodie", currency: "usd", unit_amount: 5000 },
          { id: "price_stickers", product_name: "Emulate Sticker Pack", currency: "usd", unit_amount: 800 },
          { id: "price_mug", product_name: "Emulate Mug", currency: "usd", unit_amount: 1500 },
          { id: "price_tshirt", product_name: "Emulate T-Shirt", currency: "usd", unit_amount: 2500 },
        ],
        webhooks: [
          {
            url: `http://localhost:${process.env.PORT ?? "3000"}/api/webhooks/stripe`,
            events: ["*"],
          },
        ],
      },
    },
  },
});
