import { defineConfig } from "tsup";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const pkg = JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf-8"));

const copyFonts = async () => {
  const src = resolve(__dirname, "../@emulators/core/src/fonts");
  const dest = resolve(__dirname, "dist/fonts");
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, { recursive: true });
};

const addShebang = async () => {
  const entry = resolve(__dirname, "dist/index.js");
  const content = readFileSync(entry, "utf-8");
  writeFileSync(entry, `#!/usr/bin/env node\n${content}`);
};

const shared = {
  define: {
    "PKG_VERSION": JSON.stringify(pkg.version),
  },
};

export default defineConfig([
  {
    ...shared,
    entry: ["src/index.ts"],
    format: ["esm"],
    dts: false,
    clean: true,
    splitting: true,
    sourcemap: true,
    noExternal: [/^@emulators\//],
    async onSuccess() {
      await copyFonts();
      await addShebang();
    },
  },
  {
    ...shared,
    entry: ["src/api.ts"],
    format: ["esm"],
    dts: true,
    clean: false,
    splitting: true,
    sourcemap: true,
    noExternal: [/^@emulators\//],
    onSuccess: copyFonts,
  },
]);
