import { Hono, Store, WebhookDispatcher, type AppEnv } from "@emulators/core";
import { beforeEach, describe, expect, it } from "vitest";
import {
  cybersoarPlugin,
  DEFAULT_API_KEY,
  DEFAULT_CUSTOMER,
  DEFAULT_MSP,
  getCsStore,
  seedFromConfig,
  type CybersoarSeedConfig,
} from "../index.js";

const baseUrl = "http://localhost:4323";

function createApp(seed?: CybersoarSeedConfig, withDefaults = true) {
  const store = new Store();
  const app = new Hono<AppEnv>();
  cybersoarPlugin.register(app, store, new WebhookDispatcher(), baseUrl);
  if (withDefaults) cybersoarPlugin.seed?.(store, baseUrl);
  if (seed) seedFromConfig(store, baseUrl, seed);
  return { app, store };
}

async function call(
  app: Hono<AppEnv>,
  method: string,
  path: string,
  body?: unknown,
  auth: string | null = `ApiKey ${DEFAULT_API_KEY}`,
) {
  const headers: Record<string, string> = {};
  if (auth) headers.Authorization = auth;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await app.request(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed };
}

const query = (params: Record<string, string>) => `?${new URLSearchParams(params).toString()}`;

describe("CyberSOAR plugin", () => {
  let ctx: ReturnType<typeof createApp>;

  beforeEach(() => {
    ctx = createApp();
  });

  it("requires an ApiKey header", async () => {
    const missing = await call(ctx.app, "GET", "/incidents/alerts", undefined, null);
    expect(missing.status).toBe(401);
    expect(missing.body).toEqual({ statusCode: 401, message: "Unauthorized", error: "Unauthorized" });
    expect((await call(ctx.app, "GET", "/incidents/alerts", undefined, "ApiKey nope")).status).toBe(401);
    expect((await call(ctx.app, "GET", "/incidents/alerts", undefined, `Bearer ${DEFAULT_API_KEY}`)).status).toBe(200);
    expect((await call(ctx.app, "GET", "/health", undefined, null)).body.status).toBe("ok");
  });

  it("pages closed alerts for a customer namespace the way the report factory does", async () => {
    const from = new Date(Date.now() - 400 * 86400000);
    const to = new Date(Date.now() + 86400000);
    const params = {
      name: `"${DEFAULT_MSP}:${DEFAULT_CUSTOMER}"`,
      status: "CLOSED",
      "ingestAt.gt": from.toISOString(),
      "ingestAt.lt": to.toISOString(),
      pageSize: "25",
    };
    const first = await call(ctx.app, "GET", `/incidents/alerts${query(params)}`);
    expect(first.status).toBe(200);
    expect(first.body.data).toHaveLength(25);
    expect(first.body.meta.nextPage).toBe(1);
    expect(first.body.meta.count).toBeGreaterThan(25);
    expect(
      first.body.data.every((alert: any) => alert.status === "CLOSED" && alert.customer === DEFAULT_CUSTOMER),
    ).toBe(true);
    expect(first.body.data[0]).toMatchObject({
      id: expect.any(String),
      caseId: expect.any(String),
      criticity: expect.any(Number),
      ruleName: expect.any(String),
      ruleId: expect.any(String),
      ruleRuntime: expect.any(String),
      elasticId: expect.any(String),
      sourceRef: expect.any(String),
      tags: expect.any(Array),
    });
    expect(Date.parse(first.body.data[0].ingestAt)).toBeGreaterThanOrEqual(Date.parse(first.body.data[1].ingestAt));
    const all: any[] = [...first.body.data];
    let next = first.body.meta.nextPage;
    while (next !== undefined) {
      const page = await call(ctx.app, "GET", `/incidents/alerts${query({ ...params, pageIndex: String(next) })}`);
      all.push(...page.body.data);
      next = page.body.meta.nextPage;
    }
    expect(all).toHaveLength(first.body.meta.count);
    expect(new Set(all.map((alert) => alert.id)).size).toBe(all.length);
    const bySlug = await call(
      ctx.app,
      "GET",
      `/incidents/alerts${query({ ...params, name: '"nimbus-msp:acme-corp"', pageSize: "100" })}`,
    );
    expect(bySlug.body.meta.count).toBe(first.body.meta.count);
    expect(bySlug.body.data.map((alert: any) => alert.id).sort()).toEqual(all.map((alert) => alert.id).sort());
    const none = await call(ctx.app, "GET", `/incidents/alerts${query({ name: '"Nobody:Nowhere"' })}`);
    expect(none.body).toEqual({ data: [], meta: { count: 0, pageIndex: 0, pageSize: 20 } });
  });

  it("filters by service, verdict, ingest window, and tags", async () => {
    const tp = await call(
      ctx.app,
      "GET",
      `/incidents/alerts${query({ name: `"${DEFAULT_MSP}:${DEFAULT_CUSTOMER}"`, verdict: "TP", pageSize: "100" })}`,
    );
    expect(tp.body.data.length).toBeGreaterThan(0);
    expect(tp.body.data.every((alert: any) => alert.verdict === "TP")).toBe(true);
    const firewall = await call(ctx.app, "GET", `/incidents/alerts${query({ service: "FIREWALL", pageSize: "100" })}`);
    expect(firewall.body.data.every((alert: any) => alert.service === "FIREWALL")).toBe(true);
    const window = await call(
      ctx.app,
      "GET",
      `/incidents/alerts${query({ "ingestAt.gt": new Date(Date.now() - 4 * 86400000).toISOString(), "ingestAt.lt": new Date(Date.now() - 2 * 86400000).toISOString(), pageSize: "100" })}`,
    );
    expect(window.body.data.some((alert: any) => alert.id === "a0000000-0000-4000-8000-00000000f101")).toBe(true);
    expect(window.body.data.some((alert: any) => alert.id === "a0000000-0000-4000-8000-00000000f102")).toBe(false);
    const mailed = await call(ctx.app, "GET", `/incidents/alerts${query({ tags: "MAIL_SENT", pageSize: "100" })}`);
    expect(mailed.body.data.every((alert: any) => alert.tags.includes("MAIL_SENT"))).toBe(true);
    const waiting = await call(
      ctx.app,
      "GET",
      `/incidents/alerts${query({ status: "WAITING_ANALYST", pageSize: "100" })}`,
    );
    expect(waiting.body.data.every((alert: any) => alert.verdict === "NEW")).toBe(true);
    expect((await call(ctx.app, "GET", `/incidents/alerts${query({ service: "NOPE" })}`)).status).toBe(400);
    expect((await call(ctx.app, "GET", `/incidents/alerts${query({ "ingestAt.gt": "yesterday" })}`)).status).toBe(400);
    expect((await call(ctx.app, "GET", `/incidents/alerts${query({ pageSize: "0" })}`)).status).toBe(400);
    const stats = await call(ctx.app, "GET", `/incidents/alerts/stats${query({ name: '"nimbus-msp:acme-corp"' })}`);
    expect(stats.body.data.total).toBeGreaterThan(0);
    expect(stats.body.data.byService.MS365).toBeGreaterThan(0);
  });

  it("creates, reads, updates, closes, and deletes alerts", async () => {
    const created = await call(ctx.app, "POST", "/incidents/alerts", {
      customer: "Newco",
      msp: DEFAULT_MSP,
      service: "ACTIVE_DIRECTORY",
      ruleName: "Account added to Domain Admins",
      criticity: 4,
    });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({
      customer: "Newco",
      service: "ACTIVE_DIRECTORY",
      status: "WAITING_ANALYST",
      verdict: "NEW",
      criticity: 4,
      tags: [],
    });
    const id = created.body.data.id;
    expect((await call(ctx.app, "GET", `/incidents/alerts/${id}`)).body.data.id).toBe(id);
    expect(
      (await call(ctx.app, "GET", `/incidents/alerts${query({ name: `"${DEFAULT_MSP}:Newco"` })}`)).body.meta.count,
    ).toBe(1);
    expect(
      (await call(ctx.app, "GET", `/incidents/alerts${query({ name: '"nimbus-msp:newco"' })}`)).body.meta.count,
    ).toBe(1);
    const invalid = await call(ctx.app, "POST", "/incidents/alerts", { service: "X" });
    expect(invalid.status).toBe(400);
    expect(invalid.body.message).toEqual(
      expect.arrayContaining(["customer should not be empty", "ruleName should not be empty"]),
    );
    const closed = await call(ctx.app, "POST", "/_cybersoar/simulate/close", { id, verdict: "TP", notify: true }, null);
    expect(closed.body.data[0]).toMatchObject({ status: "CLOSED", verdict: "TP", tags: ["MAIL_SENT"] });
    expect(closed.body.data[0].closedAt).toBeTruthy();
    const patched = await call(ctx.app, "PATCH", `/incidents/alerts/${id}`, { verdict: "FP", tags: [] });
    expect(patched.body.data).toMatchObject({ verdict: "FP", tags: [] });
    const cases = await call(ctx.app, "GET", `/incidents/cases${query({ name: '"nimbus-msp:newco"' })}`);
    expect(cases.body.data[0]).toMatchObject({ customer: "Newco", alertCount: 1, status: "CLOSED", verdict: "FP" });
    expect((await call(ctx.app, "GET", `/incidents/cases/${created.body.data.caseId}`)).body.data.alerts).toHaveLength(
      1,
    );
    expect((await call(ctx.app, "DELETE", `/incidents/alerts/${id}`)).status).toBe(204);
    expect((await call(ctx.app, "GET", `/incidents/alerts/${id}`)).status).toBe(404);
  });

  it("simulates bulk alerts and exposes customers, events, and the inspector", async () => {
    const simulated = await call(
      ctx.app,
      "POST",
      "/_cybersoar/simulate/alert",
      {
        customer: DEFAULT_CUSTOMER,
        msp: DEFAULT_MSP,
        service: "MS365",
        ruleName: "Impossible travel sign-in",
        count: 5,
        status: "CLOSED",
        verdict: "TP",
        tags: ["MAIL_SENT"],
      },
      null,
    );
    expect(simulated.status).toBe(201);
    expect(simulated.body.meta.count).toBe(5);
    expect(new Set(simulated.body.data.map((alert: any) => alert.caseId)).size).toBe(5);
    const customers = await call(ctx.app, "GET", "/customers");
    expect(customers.body.data.find((customer: any) => customer.name === DEFAULT_CUSTOMER).namespaces).toEqual([
      `${DEFAULT_MSP}:${DEFAULT_CUSTOMER}`,
      "nimbus-msp:acme-corp",
    ]);
    const events = await call(ctx.app, "GET", "/_cybersoar/events?type=alert.created", undefined, null);
    expect(events.body.events.length).toBeGreaterThan(5);
    for (const tab of ["alerts", "cases", "customers", "events", "auth"]) {
      const page = await ctx.app.request(`${baseUrl}/?tab=${tab}`);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("CyberSOAR");
    }
  });

  it("seeds custom customers and alerts without defaults", async () => {
    const custom = createApp(
      {
        api_keys: [{ api_key: "secret" }],
        customers: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            name: "Custom Co",
            msp: "Other MSP",
            generate_alerts: 10,
            generate_days: 30,
          },
        ],
        alerts: [
          {
            id: "22222222-2222-4222-8222-222222222222",
            customer: "Custom Co",
            msp: "Other MSP",
            service: "FIREWALL",
            ruleName: "Blocked command and control beacon",
            status: "CLOSED",
            verdict: "TP",
            criticity: 4,
          },
        ],
      },
      false,
    );
    expect(getCsStore(custom.store).alerts.count()).toBe(11);
    const list = await call(
      custom.app,
      "GET",
      `/incidents/alerts${query({ name: '"other-msp:custom-co"', pageSize: "100" })}`,
      undefined,
      "ApiKey secret",
    );
    expect(list.body.meta.count).toBe(11);
    expect(list.body.data.some((alert: any) => alert.id === "22222222-2222-4222-8222-222222222222")).toBe(true);
    expect(list.body.data.every((alert: any) => Date.parse(alert.ingestAt) > Date.now() - 31 * 86400000)).toBe(true);
    expect((await call(custom.app, "GET", "/incidents/alerts")).status).toBe(401);
  });
});
