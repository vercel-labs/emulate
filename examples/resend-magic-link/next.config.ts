import { resolve } from "path";
import type { NextConfig } from "next";
import { withEmulate } from "@emulators/adapter-next";

const port = process.env.PORT ?? "3000";

const nextConfig: NextConfig = {
  turbopack: {
    root: resolve(import.meta.dirname, "../.."),
  },
  env: {
    RESEND_BASE_URL: `http://localhost:${port}/emulate/resend`,
  },
};

export default withEmulate(nextConfig);
