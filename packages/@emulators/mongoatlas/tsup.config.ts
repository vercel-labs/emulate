import { defineConfig } from "tsup";
import { emitTypes } from "../../../scripts/emit-types.mjs";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: false,
  onSuccess: async () => emitTypes(__dirname),
  sourcemap: true,
});
