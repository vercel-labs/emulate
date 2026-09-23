import { describe, it, expect } from "vitest";
import { defineEmulator } from "@emulators/core";
import { createEmulateHandler } from "../index.js";
import { customApiContract } from "../../../../../tests/contracts/custom-api.js";

customApiContract({
  describe,
  it,
  expect,
  defineEmulator,
  create(config) {
    const handler = createEmulateHandler(config);
    return {
      close: handler.close,
      request(path, init) {
        const segments = path.split("?")[0].split("/");
        return handler.GET(new Request(`http://localhost/local/${path}`, init), {
          params: Promise.resolve({ path: segments }),
        });
      },
    };
  },
});
