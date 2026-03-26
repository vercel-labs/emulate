import { defineConfig } from "tsup";
import { cpSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const copyFonts = async () => {
  const src = resolve(__dirname, "../@internal/core/src/fonts");
  const dest = resolve(__dirname, "dist/fonts");
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, { recursive: true });
};

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm"],
    dts: false,
    clean: true,
    sourcemap: true,
    noExternal: [/^@emulators\//, /^@internal\//],
    banner: {
      js: "#!/usr/bin/env node",
    },
    onSuccess: copyFonts,
  },
  {
    entry: ["src/api.ts"],
    format: ["esm"],
    dts: true,
    clean: false,
    sourcemap: true,
    noExternal: [/^@emulators\//, /^@internal\//],
    onSuccess: copyFonts,
  },
]);
