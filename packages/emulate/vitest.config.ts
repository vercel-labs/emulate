import { defineConfig } from "vitest/config";

export default defineConfig({
  define: {
    PKG_VERSION: JSON.stringify("0.0.0-test"),
  },
  test: {
    globals: true,
  },
});
