import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createServer, serve } from "@emulators/core";
import { githubPlugin, seedFromConfig, type GitHubSeedConfig } from "../index.js";

const run = promisify(execFile);

export const GH_HOST = "github.localhost";
export const GH_TOKEN = "gh-cli-token";

export interface GhEmulator {
  baseUrl: string;
  port: number;
  gh: (...args: string[]) => Promise<{ stdout: string; stderr: string }>;
  rest: (method: string, path: string, body?: unknown) => Promise<any>;
  close: () => Promise<void>;
}

export async function ghAvailable(): Promise<boolean> {
  try {
    await run("gh", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Serves the GitHub emulator on a free port and runs the real gh binary against it.
 * gh talks plain HTTP only to the host github.localhost (http://api.github.localhost/...),
 * so HTTP_PROXY routes those requests to the emulator without TLS.
 */
export async function startGhEmulator(seed: GitHubSeedConfig): Promise<GhEmulator> {
  const baseUrl = `http://${GH_HOST}`;
  const { app, store } = createServer(githubPlugin, {
    baseUrl,
    tokens: { [GH_TOKEN]: { login: seed.users![0].login, id: 1, scopes: ["repo", "user", "read:org"] } },
  });
  githubPlugin.seed?.(store, baseUrl);
  seedFromConfig(store, baseUrl, seed);

  const server: Server = serve({ fetch: app.fetch, port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  const configDir = mkdtempSync(join(tmpdir(), "emulate-gh-"));
  const proxy = `http://127.0.0.1:${port}`;
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: configDir,
    GH_CONFIG_DIR: configDir,
    GH_HOST,
    GH_TOKEN,
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
    GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
    GH_TELEMETRY: "false",
    GH_SPINNER_DISABLED: "1",
    NO_COLOR: "1",
    HTTP_PROXY: proxy,
    http_proxy: proxy,
    NO_PROXY: "",
    no_proxy: "",
  };

  return {
    baseUrl,
    port,
    gh: (...args) => run("gh", args, { env, cwd: configDir }),
    rest: async (method, path, body) => {
      const res = await app.request(`${baseUrl}${path}`, {
        method,
        headers: { Authorization: `token ${GH_TOKEN}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
      return json;
    },
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(configDir, { recursive: true, force: true });
    },
  };
}
