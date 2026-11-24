import { resolve } from "path";
import type { NextConfig } from "next";
import { withEmulate } from "@emulators/adapter-next";
import { MAX_UPLOAD_MB } from "./src/lib/blob/limits";
import { origin } from "./src/lib/origin";

const nextConfig: NextConfig = {
  turbopack: {
    root: resolve(import.meta.dirname, "../.."),
  },
  env: {
    RESEND_BASE_URL: `${origin}/emulate/resend`,
    STRIPE_HOST: "localhost",
    STRIPE_PORT: new URL(origin).port,
    STRIPE_PROTOCOL: "http",
    TWILIO_BASE_URL: `${origin}/emulate/twilio`,
  },
  experimental: {
    serverActions: {
      bodySizeLimit: `${MAX_UPLOAD_MB + 1}mb`,
    },
  },
};

export default withEmulate(nextConfig);
