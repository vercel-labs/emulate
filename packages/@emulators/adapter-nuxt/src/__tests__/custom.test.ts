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
    const handler = createEmulateHandler(config, { routePrefix: "/local" });
    return {
      close: handler.close,
      request(path, init) {
        return handler({
          req: new Request(`http://localhost/local/${path}`, init),
          context: { params: { path: path.split("?")[0] } },
        });
      },
    };
  },
});
