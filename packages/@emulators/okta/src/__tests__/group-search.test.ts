import { Hono } from "@emulators/core";
import { beforeEach, describe, expect, it } from "vitest";
import { Store, WebhookDispatcher, authMiddleware, type TokenMap } from "@emulators/core";
import { oktaPlugin, seedFromConfig } from "../index.js";
import { filterGroups, parseGroupSearch, InvalidSearchError } from "../search.js";
import type { OktaGroup } from "../entities.js";

const base = "http://localhost:4000";

function createTestApp() {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map();
  tokenMap.set("ssws-token", { login: "admin@okta.local", id: 1, scopes: ["okta.*"] });

  const app = new Hono();
  app.use("*", authMiddleware(tokenMap));
  oktaPlugin.register(app as any, store, webhooks, base, tokenMap);
  oktaPlugin.seed?.(store, base);
  seedFromConfig(store, base, {
    groups: [
      { okta_id: "00g_aws", name: "app_aws-e2e", description: "AWS access" },
      { okta_id: "00g_aws_auto", name: "app_aws-e2e-auto", description: "AWS auto grant" },
      { okta_id: "00g_twingate", name: "app_twingate-e2e" },
      { okta_id: "00g_builtin", name: "Built in", type: "BUILT_IN" },
    ],
  });
  return { app, store };
}

const headers = { Authorization: "SSWS ssws-token" };

async function names(app: Hono, query: string): Promise<{ status: number; names: string[] }> {
  const res = await app.request(`${base}/api/v1/groups?${query}`, { headers });
  if (res.status !== 200) return { status: res.status, names: [] };
  const body = (await res.json()) as Array<{ profile: { name: string } }>;
  return { status: 200, names: body.map((group) => group.profile.name).sort() };
}

describe("GET /api/v1/groups search and filter", () => {
  let app: Hono;

  beforeEach(() => {
    app = createTestApp().app;
  });

  it("matches an exact profile.name", async () => {
    const q = new URLSearchParams({ search: 'profile.name eq "app_aws-e2e"' });
    expect(await names(app, q.toString())).toEqual({ status: 200, names: ["app_aws-e2e"] });
  });

  it("combines clauses with and", async () => {
    const q = new URLSearchParams({ search: 'profile.name sw "app_aws" and type eq "OKTA_GROUP"' });
    expect(await names(app, q.toString())).toEqual({ status: 200, names: ["app_aws-e2e", "app_aws-e2e-auto"] });
  });

  it("honours filter the same way", async () => {
    const q = new URLSearchParams({ filter: 'type eq "BUILT_IN"' });
    const result = await names(app, q.toString());
    expect(result.status).toBe(200);
    // The default seed's Everyone group is BUILT_IN too; the OKTA_GROUP ones must be gone.
    expect(result.names).toContain("Built in");
    expect(result.names).not.toContain("app_aws-e2e");
  });

  it("returns an empty page rather than everything when nothing matches", async () => {
    const q = new URLSearchParams({ search: 'profile.name eq "no-such-group"' });
    expect(await names(app, q.toString())).toEqual({ status: 200, names: [] });
  });

  it("still narrows with q alongside search", async () => {
    const q = new URLSearchParams({ q: "auto", search: 'profile.name sw "app_"' });
    expect(await names(app, q.toString())).toEqual({ status: 200, names: ["app_aws-e2e-auto"] });
  });

  it("rejects an expression it cannot evaluate", async () => {
    const q = new URLSearchParams({ search: 'profile.name gt "a"' });
    const res = await app.request(`${base}/api/v1/groups?${q}`, { headers });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errorCode: string };
    expect(body.errorCode).toBe("E0000031");
  });
});

describe("parseGroupSearch", () => {
  const group = (name: string, description: string | null = null): OktaGroup =>
    ({
      id: 1,
      created_at: "2024-01-01T00:00:00.000Z",
      updated_at: "2024-01-02T00:00:00.000Z",
      okta_id: "00g1",
      type: "OKTA_GROUP",
      name,
      description,
    }) as OktaGroup;

  it("unescapes quoted values and compares case-insensitively", () => {
    expect(filterGroups([group('Say "hi"')], 'profile.name eq "say \\"HI\\""')).toHaveLength(1);
  });

  it("supports pr, ne, sw and co", () => {
    const groups = [group("alpha", "first"), group("beta")];
    expect(filterGroups(groups, "profile.description pr").map((g) => g.name)).toEqual(["alpha"]);
    expect(filterGroups(groups, 'profile.name ne "alpha"').map((g) => g.name)).toEqual(["beta"]);
    expect(filterGroups(groups, 'profile.name sw "al"').map((g) => g.name)).toEqual(["alpha"]);
    expect(filterGroups(groups, 'profile.name co "et"').map((g) => g.name)).toEqual(["beta"]);
  });

  it("throws on unknown attributes, operators and missing values", () => {
    expect(() => parseGroupSearch('profile.email eq "x"')).toThrow(InvalidSearchError);
    expect(() => parseGroupSearch('profile.name like "x"')).toThrow(InvalidSearchError);
    expect(() => parseGroupSearch("profile.name eq")).toThrow(InvalidSearchError);
    expect(() => parseGroupSearch('profile.name eq "a" or type eq "b"')).toThrow(InvalidSearchError);
  });
});
