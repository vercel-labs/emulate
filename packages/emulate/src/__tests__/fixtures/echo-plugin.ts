import type { ServicePlugin, Store } from "@emulators/core";

export const plugin: ServicePlugin = {
  name: "echo",
  register(app) {
    app.get("/ping", (c) => c.json({ ok: true, service: "echo" }));
  },
};

export function seedFromConfig(store: Store, _baseUrl: string, config: unknown): void {
  store.setData("echo:config", config);
}

export const label = "Echo test plugin";
export const endpoints = "ping";
export const initConfig = {
  echo: {
    message: "hello",
  },
};
