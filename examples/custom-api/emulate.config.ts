import { defineConfig } from "emulate";
import inventory from "./emulators/inventory.ts";
// @emulate:imports

export default defineConfig({
  services: {
    inventory: { emulator: inventory },
    // @emulate:services
  },
});
