import { defineConfig } from "tsup";
import { cpSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const copyFonts = async () => {
  const src = resolve(__dirname, "../core/src/fonts");
  const dest = resolve(__dirname, "dist/fonts");
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, { recursive: true });
};

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  noExternal: [/^@emulators\/core/],
  onSuccess: copyFonts,
});
