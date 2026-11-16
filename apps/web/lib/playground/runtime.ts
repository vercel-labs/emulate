import "@/lib/emulator-browser/buffer";
import type { ServicePlugin, Store, WebhookDispatcher } from "@emulators/core";
import { fallbackUsers, seeds } from "./seeds";

interface EmulatorModule {
  default: ServicePlugin;
  seedFromConfig?(store: Store, baseUrl: string, config: never, webhooks?: WebhookDispatcher): void;
}

export interface EmulatorRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string;
}

export interface EmulatorResponse {
  status: number;
  statusText: string;
  body: string;
  location: string | null;
}

export interface Emulator {
  send(request: EmulatorRequest): Promise<EmulatorResponse>;
  /** Sends any request to the emulator and returns the raw response, for callers that need headers or bytes. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
}

const loaders: Record<string, () => Promise<EmulatorModule>> = {
  apple: () => import("@emulators/apple"),
  aws: () => import("@emulators/aws"),
  clerk: () => import("@emulators/clerk"),
  github: () => import("@emulators/github"),
  google: () => import("@emulators/google"),
  linear: () => import("@emulators/linear"),
  microsoft: () => import("@emulators/microsoft"),
  mongoatlas: () => import("@emulators/mongoatlas"),
  okta: () => import("@emulators/okta"),
  resend: () => import("@emulators/resend"),
  slack: () => import("@emulators/slack"),
  stripe: () => import("@emulators/stripe"),
  twilio: () => import("@emulators/twilio"),
  vercel: () => import("@emulators/vercel"),
};

const running = new Map<string, Promise<Emulator>>();

/** Loads one emulator into this browser tab and seeds it. Requests are answered in memory and never reach a server. */
async function create(name: string): Promise<Emulator> {
  const [{ createServer }, emulator] = await Promise.all([import("@emulators/core"), loaders[name]()]);
  const baseUrl = `https://${name}.emulate.local`;
  const server = createServer(emulator.default, { baseUrl, fallbackUser: fallbackUsers[name] });
  emulator.default.seed?.(server.store, baseUrl);
  const seed = seeds[name];
  if (seed) emulator.seedFromConfig?.(server.store, baseUrl, seed as never, server.webhooks);

  return {
    fetch: (path, init) => Promise.resolve(server.app.fetch(new Request(baseUrl + path, init))),
    async send({ method, path, headers, body }) {
      const response = await server.app.fetch(new Request(baseUrl + path, { method, headers, body }));
      return {
        status: response.status,
        statusText: response.statusText,
        body: await response.text(),
        location: response.headers.get("location"),
      };
    },
  };
}

/** Returns the emulator for a service, creating it in this tab on first use. */
export function getEmulator(name: string): Promise<Emulator> {
  let emulator = running.get(name);
  if (!emulator) {
    emulator = create(name);
    running.set(name, emulator);
  }
  return emulator;
}

/** Drops a service's emulator so its next request starts from fresh seed data. */
export function resetEmulator(name: string): void {
  running.delete(name);
}
