import { createEmulateHandler } from "@emulators/adapter-next";
import * as twilio from "@emulators/twilio";

export const { GET, POST, PUT, PATCH, DELETE } = createEmulateHandler({
  services: {
    twilio: {
      emulator: twilio,
    },
  },
});
