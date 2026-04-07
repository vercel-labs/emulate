import { createEmulateHandler } from "@emulators/adapter-next";
import * as github from "@emulators/github";
import * as google from "@emulators/google";

export const { GET, POST, PUT, PATCH, DELETE } = createEmulateHandler({
  services: {
    github: {
      emulator: github,
      seed: {
        users: [
          { login: "admin", name: "Admin User", email: "admin@example.com" },
          { login: "designer", name: "Creative Director", email: "designer@example.com" },
          { login: "editor", name: "Content Editor", email: "editor@example.com" },
        ],
      },
    },
    google: {
      emulator: google,
      seed: {
        users: [
          { email: "admin@example.com", name: "Admin User" },
          { email: "designer@example.com", name: "Creative Director" },
          { email: "editor@example.com", name: "Content Editor" },
        ],
      },
    },
  },
});
