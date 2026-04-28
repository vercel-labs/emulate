import { resolve } from "path";
import type { NextConfig } from "next";
import { withEmulate } from "@emulators/adapter-next";

const nextConfig: NextConfig = {
  turbopack: {
    root: resolve(import.meta.dirname, "../.."),
  },
  // The Stripe Node SDK can be configured with host/port/protocol but it has no
  // notion of a path prefix. The embedded emulator lives at /emulate/stripe/*,
  // so rewrite /v1/* to land on the emulator's mount path. The SDK then talks
  // to localhost:3000/v1/... unmodified.
  async rewrites() {
    return [{ source: "/v1/:path*", destination: "/emulate/stripe/v1/:path*" }];
  },
};

export default withEmulate(nextConfig);
