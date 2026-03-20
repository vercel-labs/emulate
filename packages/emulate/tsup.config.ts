import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm"],
    dts: false,
    clean: true,
    sourcemap: true,
    noExternal: [/^@internal\//],
    banner: {
      js: "#!/usr/bin/env node",
    },
  },
  {
    entry: ["src/api.ts"],
    format: ["esm"],
    dts: true,
    clean: false,
    sourcemap: true,
    noExternal: [/^@internal\//],
  },
]);
