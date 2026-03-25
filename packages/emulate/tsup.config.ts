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
    platform: "node",
    dts: false,
    clean: true,
    sourcemap: true,
    noExternal: [/^@internal\//],
    banner: {
      js: `#!/usr/bin/env node
import { createRequire as __cr } from 'node:module';
const require = __cr(import.meta.url);`,
    },
    onSuccess: copyFonts,
  },
  {
    entry: ["src/api.ts"],
    format: ["esm"],
    platform: "node",
    dts: true,
    clean: false,
    sourcemap: true,
    noExternal: [/^@internal\//],
    banner: {
      js: `import { createRequire as __cr } from 'node:module';
const require = __cr(import.meta.url);`,
    },
    onSuccess: copyFonts,
  },
]);
