import { resolve } from "path";
import type { NextConfig } from "next";
import { withEmulate } from "@emulators/adapter-next";

const port = process.env.PORT ?? "3000";

const nextConfig: NextConfig = {
  turbopack: {
    root: resolve(import.meta.dirname, "../.."),
  },
  env: {
    // Point the official Twilio SDK at the embedded emulator. The custom request
    // client in src/lib/twilio.ts rewrites Twilio product hosts to this base URL.
    TWILIO_BASE_URL: `http://localhost:${port}/emulate/twilio`,
  },
};

export default withEmulate(nextConfig);
