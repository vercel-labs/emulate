import { createEmulateProxy } from "@emulators/adapter-next";

export const { GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS } = createEmulateProxy({
  targets: {
    resend: process.env.EMULATE_RESEND_URL ?? "http://127.0.0.1:4000",
  },
});
