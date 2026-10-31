import * as github from "@emulators/github";
import { githubAppIdentityContract, type TestPersistence } from "../../../../../tests/contracts/github-app-identity.js";
import { createEmulateHandler, type EmulateHandlerConfig } from "../index.js";
function config(persistence?: TestPersistence, privateKey?: string): EmulateHandlerConfig {
  return {
    services: {
      github: {
        emulator: github,
        seed: {
          users: [{ login: "octocat" }],
          orgs: [{ login: "acme" }],
          repos: [
            { owner: "acme", name: "private-repo", private: true },
            { owner: "acme", name: "other-repo", private: true },
          ],
          apps: [
            {
              app_id: 123,
              slug: "embedded",
              name: "Embedded",
              private_key: privateKey,
              permissions: { contents: "write", issues: "write", pull_requests: "write" },
              installations: [
                {
                  installation_id: 124,
                  account: "acme",
                  repository_selection: "selected",
                  repositories: ["acme/private-repo"],
                },
              ],
            },
          ],
        },
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
  request(handler, path, authorization, method = "GET", body) {
    const headers = authorization
      ? { Authorization: authorization, ...(body ? { "Content-Type": "application/json" } : {}) }
      : body
        ? { "Content-Type": "application/json" }
        : undefined;
    return handler[method](
      new Request(`http://localhost/emulate/github/${path}`, {
        method,
        headers,
        body,
      }),
      { params: Promise.resolve({ path: ["github", ...path.split("/")] }) },
    );
  },
});
