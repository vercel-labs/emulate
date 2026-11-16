import type { EmulateHandlerConfig } from "@emulators/adapter-next";
import * as apple from "@emulators/apple";
import * as clerk from "@emulators/clerk";
import * as github from "@emulators/github";
import * as google from "@emulators/google";
import * as microsoft from "@emulators/microsoft";
import * as okta from "@emulators/okta";
import * as resend from "@emulators/resend";
import * as stripe from "@emulators/stripe";
import * as twilio from "@emulators/twilio";
import * as vercel from "@emulators/vercel";
import { origin } from "@/lib/origin";

/** Every emulator the playground serves under /emulate/<name>, with the seed data its flows use. */
export const services: EmulateHandlerConfig["services"] = {
  apple: {
    emulator: apple,
    seed: {
      oauth_clients: [
        {
          client_id: "emu_apple_client_id",
          team_id: "EMULATE01",
          name: "emulate playground",
          redirect_uris: [`${origin}/oauth/api/auth/callback/apple`],
        },
      ],
    },
  },
  clerk: {
    emulator: clerk,
    seed: {
      oauth_applications: [
        {
          client_id: "emu_clerk_client_id",
          client_secret: "emu_clerk_client_secret",
          name: "emulate playground",
          redirect_uris: [`${origin}/oauth/api/auth/callback/clerk`],
        },
      ],
    },
  },
  github: {
    emulator: github,
    seed: {
      oauth_apps: [
        {
          client_id: "emu_github_client_id",
          client_secret: "emu_github_client_secret",
          name: "emulate playground",
          redirect_uris: [`${origin}/oauth/api/auth/callback/github`],
        },
      ],
      users: [
        { login: "admin", name: "Admin User", email: "admin@example.com" },
        { login: "designer", name: "Creative Director", email: "designer@example.com" },
        { login: "editor", name: "Content Editor", email: "editor@example.com" },
      ],
    },
  },
  google: {
    emulator: google,
    seed: {
      oauth_clients: [
        {
          client_id: "emu_google_client_id",
          client_secret: "emu_google_client_secret",
          name: "emulate playground",
          redirect_uris: [`${origin}/oauth/api/auth/callback/google`],
        },
      ],
      users: [
        { email: "admin@example.com", name: "Admin User" },
        { email: "designer@example.com", name: "Creative Director" },
        { email: "editor@example.com", name: "Content Editor" },
      ],
    },
  },
  microsoft: {
    emulator: microsoft,
    seed: {
      oauth_clients: [
        {
          client_id: "emu_microsoft_client_id",
          client_secret: "emu_microsoft_client_secret",
          name: "emulate playground",
          redirect_uris: [`${origin}/oauth/api/auth/callback/microsoft`],
        },
      ],
    },
  },
  okta: {
    emulator: okta,
    seed: {
      oauth_clients: [
        {
          client_id: "emu_okta_client_id",
          client_secret: "emu_okta_client_secret",
          name: "emulate playground",
          redirect_uris: [`${origin}/oauth/api/auth/callback/okta`],
        },
      ],
    },
  },
  resend: {
    emulator: resend,
    seed: {
      domains: [{ name: "example.com" }],
    },
  },
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
      webhooks: [{ url: `${origin}/stripe/api/webhooks`, events: ["*"] }],
    },
  },
  twilio: {
    emulator: twilio,
  },
  vercel: {
    emulator: vercel,
    seed: {
      integrations: [
        {
          client_id: "emu_vercel_client_id",
          client_secret: "emu_vercel_client_secret",
          name: "emulate playground",
          redirect_uris: [`${origin}/oauth/api/auth/callback/vercel`],
        },
      ],
    },
  },
};
