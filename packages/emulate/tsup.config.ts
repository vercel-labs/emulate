import { defineConfig } from "tsup";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const copyFonts = async () => {
  const src = resolve(__dirname, "../@internal/core/src/fonts");
  const dest = resolve(__dirname, "dist/fonts");
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, { recursive: true });
};

const addShebang = async () => {
  const entry = resolve(__dirname, "dist/index.js");
  const content = readFileSync(entry, "utf-8");
  writeFileSync(entry, `#!/usr/bin/env node\n${content}`);
};

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm"],
    dts: false,
    clean: true,
    splitting: true,
    sourcemap: true,
    noExternal: [/^@emulators\//, /^@internal\//],
    async onSuccess() {
      await copyFonts();
      await addShebang();
    },
  },
  {
    entry: ["src/api.ts"],
    format: ["esm"],
    dts: true,
    clean: false,
    splitting: true,
    sourcemap: true,
    noExternal: [/^@emulators\//, /^@internal\//],
    onSuccess: copyFonts,
  },
]);
