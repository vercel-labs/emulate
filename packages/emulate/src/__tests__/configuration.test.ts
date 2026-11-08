import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { describe, expect, it, vi } from "vitest";
import { initCommand } from "../commands/init.js";
import { DEFAULT_TOKENS, SERVICE_NAMES, SERVICE_REGISTRY } from "../registry.js";
import { Hono, Store, WebhookDispatcher, createApiErrorHandler, createErrorHandler } from "@emulators/core";
import { seedFromConfig, stripePlugin, type StripeSeedConfig } from "@emulators/stripe";

const repoRoot = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
const examplePath = resolve(repoRoot, "emulate.config.example.yaml");
const validTopLevelKeys = new Set(["tokens", ...SERVICE_NAMES]);

describe("configuration examples", () => {
  it("contains the current service sections without placeholder PEM material", () => {
    const source = readFileSync(examplePath, "utf8");
    const config = parse(source) as Record<string, unknown>;

    expect(Object.keys(config).every((key) => validTopLevelKeys.has(key))).toBe(true);
    expect(SERVICE_NAMES.every((name) => name in config)).toBe(true);
    expect(source).not.toContain("BEGIN RSA PRIVATE KEY");
    expect(source).not.toContain("your PEM key");
    expect(source).not.toContain("...your");
  });

  it("gives Stripe a starter price that a subscription can use, in the example and in init", async () => {
    const example = (parse(readFileSync(examplePath, "utf8")) as { stripe: StripeSeedConfig }).stripe;
    for (const stripe of [SERVICE_REGISTRY.stripe.initConfig.stripe as StripeSeedConfig, example]) {
      expect(stripe.prices?.every((price) => price.product_name === undefined)).toBe(true);

      const store = new Store();
      const webhooks = new WebhookDispatcher();
      const app = new Hono();
      app.onError(createApiErrorHandler());
      app.use("*", createErrorHandler());
      stripePlugin.register(app as never, store, webhooks, "http://localhost:4000");
      seedFromConfig(store, "http://localhost:4000", stripe, webhooks);
      const call = async (method: string, path: string, body?: Record<string, unknown>) => {
        const res = await app.request(`http://localhost:4000${path}`, {
          method,
          headers: { "Content-Type": "application/json" },
          ...(body && { body: JSON.stringify(body) }),
        });
        return { status: res.status, body: (await res.json()) as Record<string, any> };
      };

      const prices = await call("GET", "/v1/prices?type=recurring");
      expect(prices.body.data).toHaveLength(1);
      expect(prices.body.data[0]).toMatchObject({ unit_amount: 2000, recurring: { interval: "month" } });
      const customer = await call("POST", "/v1/customers", {
        payment_method: "pm_card_visa",
        invoice_settings: { default_payment_method: "pm_card_visa" },
      });
      const subscription = await call("POST", "/v1/subscriptions", {
        customer: customer.body.id,
        items: [{ price: prices.body.data[0].id }],
      });
      expect(subscription.status, JSON.stringify(subscription.body)).toBe(200);
      expect(subscription.body.status).toBe("active");
    }
  });

  it("generates a starter section for every registry service", () => {
    const previousDirectory = process.cwd();
    const directory = mkdtempSync(join(tmpdir(), "emulate-init-"));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      process.chdir(directory);
      initCommand({ service: "all" });

      const config = parse(readFileSync(join(directory, "emulate.config.yaml"), "utf8")) as Record<string, unknown>;

      expect(config.tokens).toEqual(DEFAULT_TOKENS.tokens);
      for (const name of SERVICE_NAMES) {
        expect(config[name]).toEqual(SERVICE_REGISTRY[name].initConfig[name]);
      }
    } finally {
      log.mockRestore();
      process.chdir(previousDirectory);
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
