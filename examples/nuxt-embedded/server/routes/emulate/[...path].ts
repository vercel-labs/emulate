import { createEmulateHandler } from "@emulators/adapter-nuxt";
import * as github from "@emulators/github";
import * as google from "@emulators/google";

// Serves the embedded emulators on the same origin as the app:
//   /emulate/github/**   -> GitHub emulator
//   /emulate/google/**   -> Google emulator
export default defineEventHandler(
  createEmulateHandler({
    services: {
      github: {
        emulator: github,
        seed: {
          users: [
            { login: "publisher", name: "Publishing Lead", email: "publisher@example.com" },
            { login: "designer", name: "Creative Director", email: "designer@example.com" },
            { login: "editor", name: "Content Editor", email: "editor@example.com" },
          ],
        },
      },
      google: {
        emulator: google,
        seed: {
          users: [
            { email: "publisher@example.com", name: "Publishing Lead" },
            { email: "designer@example.com", name: "Creative Director" },
            { email: "editor@example.com", name: "Content Editor" },
          ],
        },
      },
    },
  }),
);
