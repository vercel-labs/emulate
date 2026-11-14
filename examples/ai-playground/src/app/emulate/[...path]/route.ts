import { createEmulateHandler } from "@emulators/adapter-next";
import * as ai from "@emulators/ai";

export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = createEmulateHandler({
  services: {
    ai: {
      emulator: ai,
      seed: {
        timing: { ttftMs: 400, chunkDelayMs: [45, 20, 70, 30, 110, 25, 55] },
        rules: [
          {
            id: "greeting",
            match: { textContains: "hello" },
            reply: [{ type: "text", text: "Hello from the emulate AI playground." }],
          },
        ],
      },
    },
  },
});
