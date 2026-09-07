import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "@emulators/core";
import {
  Store,
  WebhookDispatcher,
  authMiddleware,
  createApiErrorHandler,
  createErrorHandler,
  type TokenMap,
} from "@emulators/core";
import { sepayPlugin, seedFromConfig, DEFAULT_API_KEY, DEFAULT_WEBHOOK_API_KEY } from "../index.js";
import { getSepayStore } from "../store.js";
import { buildVietQrString, crc16 } from "../vietqr.js";

const base = "http://localhost:14000";

interface WebhookRequest {
  authorization: string | undefined;
  body: Record<string, unknown>;
}

function startWebhookTarget(): Promise<{ server: Server; url: string; requests: WebhookRequest[] }> {
  const requests: WebhookRequest[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      requests.push({
        authorization: req.headers.authorization,
        body: JSON.parse(raw || "{}"),
      });
      res.writeHead(200);
      res.end("OK");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}/webhooks/sepay`, requests });
    });
  });
}

function createTestApp(seedConfig?: Parameters<typeof seedFromConfig>[2]) {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map();
  tokenMap.set(DEFAULT_API_KEY, { login: "sepay_admin", id: 1, scopes: [] });

  const app = new Hono();
  app.onError(createApiErrorHandler());
  app.use("*", createErrorHandler());
  app.use("*", authMiddleware(tokenMap));
  sepayPlugin.register(app as never, store, webhooks, base, tokenMap);
  sepayPlugin.seed?.(store, base);
  if (seedConfig) seedFromConfig(store, base, seedConfig);

  return { app, store };
}

function auth(token = DEFAULT_API_KEY): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

describe("SePay plugin", () => {
  let app: Hono;
  let store: Store;

  beforeEach(() => {
    const ctx = createTestApp();
    app = ctx.app;
    store = ctx.store;
  });

  describe("auth", () => {
    it("rejects missing bearer token", async () => {
      const res = await app.request(`${base}/userapi/transactions/list`);
      expect(res.status).toBe(401);
      const body = (await res.json()) as { status: number; error: string };
      expect(body.error).toBe("Unauthorized");
    });

    it("rejects invalid api key", async () => {
      const res = await app.request(`${base}/userapi/transactions/list`, { headers: auth("wrong_key") });
      expect(res.status).toBe(401);
    });
  });

  describe("transactions", () => {
    it("lists seeded transactions and filters by account_number", async () => {
      seedFromConfig(store, base, {
        transactions: [
          {
            id: 100001,
            transactionDate: "2026-01-15 09:30:00",
            transferType: "in",
            amount: 250000,
            code: "ORD1001",
            content: "ORD1001 thanh toan don hang",
            referenceNumber: "FT26011509300001",
          },
        ],
      });

      const res = await app.request(`${base}/userapi/transactions/list`, { headers: auth() });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { transactions: Array<Record<string, unknown>> };
      expect(body.transactions.length).toBeGreaterThanOrEqual(1);

      const filtered = await app.request(`${base}/userapi/transactions/list?account_number=0071000888888`, {
        headers: auth(),
      });
      const filteredBody = (await filtered.json()) as { transactions: Array<{ account_number: string }> };
      expect(filteredBody.transactions.length).toBeGreaterThan(0);
      expect(filteredBody.transactions.every((tx) => tx.account_number === "0071000888888")).toBe(true);

      const none = await app.request(`${base}/userapi/transactions/list?account_number=999`, { headers: auth() });
      const noneBody = (await none.json()) as { transactions: unknown[] };
      expect(noneBody.transactions).toHaveLength(0);
    });

    it("filters by reference_number and supports limit/offset", async () => {
      seedFromConfig(store, base, {
        transactions: [
          { id: 1, transferType: "in", amount: 1000, content: "one", referenceNumber: "REF_A" },
          { id: 2, transferType: "in", amount: 2000, content: "two", referenceNumber: "REF_B" },
          { id: 3, transferType: "in", amount: 3000, content: "three", referenceNumber: "REF_C" },
        ],
      });

      const byRef = await app.request(`${base}/userapi/transactions/list?reference_number=REF_B`, { headers: auth() });
      const byRefBody = (await byRef.json()) as { transactions: Array<{ id: string; amount_in: string }> };
      expect(byRefBody.transactions).toHaveLength(1);
      expect(byRefBody.transactions[0].id).toBe("2");
      expect(byRefBody.transactions[0].amount_in).toBe("2000.00");

      const paged = await app.request(`${base}/userapi/transactions/list?limit=1&offset=1`, { headers: auth() });
      const pagedBody = (await paged.json()) as { transactions: Array<{ id: string }> };
      expect(pagedBody.transactions).toHaveLength(1);
      expect(pagedBody.transactions[0].id).toBe("2");
    });

    it("gets a transaction by id and returns 404 for unknown ids", async () => {
      seedFromConfig(store, base, {
        transactions: [{ id: 48673, transferType: "in", amount: 19689000, content: "chuyen tien" }],
      });

      const res = await app.request(`${base}/userapi/transactions/details/48673`, { headers: auth() });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { transaction: { id: string; amount_in: string } };
      expect(body.transaction.id).toBe("48673");
      expect(body.transaction.amount_in).toBe("19689000.00");

      const alias = await app.request(`${base}/userapi/transactions/48673`, { headers: auth() });
      expect(alias.status).toBe(200);

      const missing = await app.request(`${base}/userapi/transactions/details/99999`, { headers: auth() });
      expect(missing.status).toBe(404);
    });
  });

  describe("simulate", () => {
    let target: Awaited<ReturnType<typeof startWebhookTarget>>;

    beforeEach(async () => {
      target = await startWebhookTarget();
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => target.server.close(() => resolve()));
    });

    it("creates a transaction and fires signed webhook deliveries to all targets", async () => {
      seedFromConfig(store, base, {
        webhook_targets: [{ url: target.url, api_key: "whk_secret_1" }, { url: `${target.url}/second` }],
      });

      const res = await app.request(`${base}/userapi/simulate/transaction`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({
          gateway: "Vietcombank",
          accountNumber: "0071000888888",
          amountIn: 250000,
          code: "ORD2002",
          content: "ORD2002 thanh toan don hang",
          referenceNumber: "FT260115TEST0001",
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { transaction: { id: string; amount_in: string; transfer_type: string } };
      expect(body.transaction.transfer_type).toBe("in");
      expect(body.transaction.amount_in).toBe("250000.00");

      expect(target.requests).toHaveLength(2);
      expect(target.requests[0].authorization).toBe("Bearer whk_secret_1");
      // target without explicit api_key falls back to the default webhook key
      expect(target.requests[1].authorization).toBe(`Bearer ${DEFAULT_WEBHOOK_API_KEY}`);
      const payload = target.requests[0].body;
      expect(payload.gateway).toBe("Vietcombank");
      expect(payload.amountIn).toBe(250000);
      expect(payload.code).toBe("ORD2002");
      expect(payload.referenceNumber).toBe("FT260115TEST0001");

      const ss = getSepayStore(store);
      const deliveries = ss.webhookDeliveries.all();
      expect(deliveries).toHaveLength(2);
      expect(deliveries.every((d) => d.success && d.status_code === 200)).toBe(true);
      expect(deliveries.every((d) => d.target_url.startsWith(target.url))).toBe(true);

      const list = await app.request(`${base}/userapi/transactions/list?reference_number=FT260115TEST0001`, {
        headers: auth(),
      });
      const listBody = (await list.json()) as { transactions: unknown[] };
      expect(listBody.transactions).toHaveLength(1);
    });
  });

  describe("reset semantics", () => {
    it("restores seeded state after reset", async () => {
      seedFromConfig(store, base, {
        api_keys: [{ token: "seeded_key", label: "CI Key" }],
        webhook_targets: [{ url: "http://127.0.0.1:9/webhooks/sepay", api_key: "whk_unreachable" }],
        transactions: [
          { id: 555001, transferType: "in", amount: 99000, content: "seeded order", referenceNumber: "SEED_REF" },
        ],
      });

      await app.request(`${base}/userapi/simulate/transaction`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ amountIn: 12345, content: "mutation" }),
      });

      const beforeReset = getSepayStore(store);
      expect(beforeReset.transactions.count()).toBeGreaterThan(1);
      expect(beforeReset.webhookDeliveries.count()).toBeGreaterThan(0);

      store.reset();
      sepayPlugin.seed?.(store, base);
      seedFromConfig(store, base, {
        api_keys: [{ token: "seeded_key", label: "CI Key" }],
        transactions: [
          { id: 555001, transferType: "in", amount: 99000, content: "seeded order", referenceNumber: "SEED_REF" },
        ],
      });

      const ss = getSepayStore(store);
      expect(ss.webhookDeliveries.count()).toBe(0);
      expect(ss.apiKeys.findOneBy("token", "seeded_key")).toBeDefined();
      expect(ss.apiKeys.findOneBy("token", DEFAULT_API_KEY)).toBeDefined();
      const seeded = ss.transactions.findOneBy("reference_number", "SEED_REF");
      expect(seeded).toBeDefined();
      expect(seeded!.amount_in).toBe("99000.00");
      expect(ss.transactions.findOneBy("transaction_content", "mutation")).toBeUndefined();

      const res = await app.request(`${base}/userapi/transactions/details/555001`, { headers: auth() });
      expect(res.status).toBe(200);
    });
  });

  describe("qr", () => {
    it("returns a PNG image with correct content type", async () => {
      const res = await app.request(`${base}/img?acc=0071000888888&bank=970436&amount=250000&des=ORD1001`);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("image/png");
      const bytes = new Uint8Array(await res.arrayBuffer());
      expect(bytes[0]).toBe(0x89);
      expect(bytes[1]).toBe(0x50);
      expect(bytes[2]).toBe(0x4e);
      expect(bytes[3]).toBe(0x47);
      const view = new DataView(bytes.buffer);
      const width = view.getUint32(16);
      const height = view.getUint32(20);
      expect(width).toBe(height);
      expect(width % 8).toBe(0);
      expect(width).toBeGreaterThan(100);
    });

    it("rejects missing params", async () => {
      const res = await app.request(`${base}/img?acc=onlyacc`);
      expect(res.status).toBe(400);
    });

    it("builds a VietQR EMVCo payload with valid CRC16", () => {
      expect(crc16("123456789")).toBe("29B1"); // CRC-16/CCITT-FALSE check value
      const payload = buildVietQrString({ acc: "0071000888888", bank: "970436", amount: "250000", des: "ORD1001" });
      expect(payload.startsWith("00020101021238")).toBe(true);
      expect(payload).toContain("5303704");
      expect(payload).toContain("5406250000");
      expect(payload).toContain("5802VN");
      expect(payload).toContain("QRIBFTTA");
      expect(/6304[0-9A-F]{4}$/.test(payload)).toBe(true);
    });
  });
});
