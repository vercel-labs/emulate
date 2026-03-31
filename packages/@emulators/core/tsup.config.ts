import { defineConfig } from "tsup";
import { cpSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  onSuccess: async () => {
    const src = resolve("src/fonts");
    const dest = resolve("dist/fonts");
    mkdirSync(dest, { recursive: true });
    cpSync(src, dest, { recursive: true });
  },
});
