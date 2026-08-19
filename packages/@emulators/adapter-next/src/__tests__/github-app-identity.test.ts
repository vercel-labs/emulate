import * as github from "@emulators/github";
import { githubAppIdentityContract, type TestPersistence } from "../../../../../tests/contracts/github-app-identity.js";
import { createEmulateHandler, type EmulateHandlerConfig } from "../index.js";
function config(persistence?: TestPersistence, privateKey?: string): EmulateHandlerConfig {
  return {
    services: {
      github: {
        emulator: github,
        seed: { apps: [{ app_id: 123, slug: "embedded", name: "Embedded", private_key: privateKey }] },
      },
    },
    persistence,
  };
}
githubAppIdentityContract<EmulateHandlerConfig, ReturnType<typeof createEmulateHandler>>({
  createEmulateHandler,
  config,
  async createExplicitPrivateKey() {
    const prepared = await github.materializeGitHubSeedConfig({ apps: [{ app_id: 123, slug: "key", name: "Key" }] });
    return prepared.config.apps![0]!.private_key!;
  },
  requestApp(handler, authorization, method = "GET") {
    return handler[method](
      new Request("http://localhost/emulate/github/app", {
        method,
        headers: authorization ? { Authorization: authorization } : undefined,
      }),
      { params: Promise.resolve({ path: ["github", "app"] }) },
    );
  },
});
