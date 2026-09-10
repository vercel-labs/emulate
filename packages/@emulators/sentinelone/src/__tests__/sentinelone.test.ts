import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_ACCOUNT_ID,
  DEFAULT_ACCOUNT_NAME,
  DEFAULT_ADMIN_EMAIL,
  DEFAULT_ANALYST_EMAIL,
  DEFAULT_LINUX_AGENT_ID,
  DEFAULT_MAC_AGENT_ID,
  DEFAULT_ROLE_IDS,
  DEFAULT_SERVER_AGENT_ID,
  DEFAULT_SITE_ID,
  DEFAULT_SITE_NAME,
  DEFAULT_SITE_TOKEN,
  DEFAULT_TRIAL_SITE_ID,
  DEFAULT_WORKSTATION_AGENT_ID,
  getS1Store,
} from "../index.js";
import { api, createS1TestApp, query, s1TestBaseUrl, type S1TestApp } from "./helpers.js";

const simulate = (ctx: S1TestApp, path: string, body: unknown) =>
  ctx.app.request(`${s1TestBaseUrl}/_sentinelone/simulate/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("SentinelOne plugin", () => {
  let ctx: S1TestApp;

  beforeEach(() => {
    ctx = createS1TestApp();
  });

  describe("authentication and envelope", () => {
    it("requires an ApiToken header", async () => {
      const missing = await api(ctx.app, "GET", "/sites", undefined, null);
      expect(missing.status).toBe(401);
      expect(missing.body.errors[0]).toMatchObject({ code: 4010010, title: "Unauthorized" });
      expect((await api(ctx.app, "GET", "/sites", undefined, "wrong")).status).toBe(401);
      const bearer = await ctx.app.request(`${s1TestBaseUrl}/web/api/v2.1/system/info`, {
        headers: { Authorization: "Bearer test_emulate_sentinelone_api_token" },
      });
      expect(bearer.status).toBe(200);
      const v20 = await ctx.app.request(`${s1TestBaseUrl}/web/api/v2.0/system/info`, {
        headers: { Authorization: "ApiToken test_emulate_sentinelone_api_token" },
      });
      expect(v20.status).toBe(200);
    });

    it("paginates with cursor, skip, limit, countOnly, skipCount, and sorting", async () => {
      const first = await api(
        ctx.app,
        "GET",
        `/agents?${query({ limit: 2, sortBy: "computerName", sortOrder: "asc" })}`,
      );
      expect(first.status).toBe(200);
      expect(first.body.data).toHaveLength(2);
      expect(first.body.pagination.totalItems).toBe(6);
      expect(first.body.pagination.nextCursor).toBeTruthy();
      const second = await api(
        ctx.app,
        "GET",
        `/agents?${query({ limit: 2, sortBy: "computerName", sortOrder: "asc", cursor: first.body.pagination.nextCursor })}`,
      );
      expect(second.body.data[0].computerName > first.body.data[1].computerName).toBe(true);
      const third = await api(
        ctx.app,
        "GET",
        `/agents?${query({ limit: 2, cursor: second.body.pagination.nextCursor })}`,
      );
      expect(third.body.pagination.nextCursor).toBeNull();
      const count = await api(ctx.app, "GET", `/agents?${query({ countOnly: true })}`);
      expect(count.body).toEqual({ data: [], pagination: { nextCursor: null, totalItems: 6 } });
      const skipped = await api(ctx.app, "GET", `/agents?${query({ skip: 5, skipCount: true })}`);
      expect(skipped.body.data).toHaveLength(1);
      expect(skipped.body.pagination.totalItems).toBeNull();
      expect((await api(ctx.app, "GET", `/agents?${query({ limit: 5000 })}`)).status).toBe(400);
      expect((await api(ctx.app, "GET", `/agents?${query({ sortBy: "nope" })}`)).status).toBe(400);
    });
  });

  describe("agents (CyberHub flow)", () => {
    it("lists agents by siteIds with the fields the reports and license counts read", async () => {
      const response = await api(ctx.app, "GET", `/agents?${query({ siteIds: DEFAULT_SITE_ID, limit: 1000 })}`);
      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(5);
      const server = response.body.data.find((agent: any) => agent.id === DEFAULT_SERVER_AGENT_ID);
      expect(server).toMatchObject({
        computerName: "ACME-SRV-FILES",
        osType: "windows",
        osName: "Windows Server 2022 Standard",
        osRevision: "20348",
        machineType: "server",
        siteId: DEFAULT_SITE_ID,
        siteName: DEFAULT_SITE_NAME,
        accountId: DEFAULT_ACCOUNT_ID,
        accountName: DEFAULT_ACCOUNT_NAME,
        consoleMigrationStatus: "N/A",
        activeThreats: 1,
        infected: true,
      });
      expect(typeof server.lastActiveDate).toBe("string");
      expect(typeof server.uuid).toBe("string");
      const linux = response.body.data.find((agent: any) => agent.id === DEFAULT_LINUX_AGENT_ID);
      expect(linux.osRevision).toContain("Ubuntu 22.04.4");
      const trial = await api(ctx.app, "GET", `/agents?${query({ siteIds: DEFAULT_TRIAL_SITE_ID })}`);
      expect(trial.body.data.map((agent: any) => agent.computerName)).toEqual(["GLOBEX-WS-01"]);
      const both = await api(
        ctx.app,
        "GET",
        `/agents?${query({ siteIds: `${DEFAULT_SITE_ID},${DEFAULT_TRIAL_SITE_ID}`, countOnly: true })}`,
      );
      expect(both.body.pagination.totalItems).toBe(6);
      const pending = await api(
        ctx.app,
        "GET",
        `/agents?${query({ siteIds: DEFAULT_SITE_ID, consoleMigrationStatuses: "Pending" })}`,
      );
      expect(pending.body.data.map((agent: any) => agent.computerName)).toEqual(["ACME-OLD-KIOSK"]);
      const windows = await api(ctx.app, "GET", `/agents?${query({ osTypes: "windows", machineTypes: "server" })}`);
      expect(windows.body.data).toHaveLength(1);
      expect((await api(ctx.app, "GET", `/agents?${query({ query: "acme-ws" })}`)).body.data).toHaveLength(1);
      expect((await api(ctx.app, "GET", `/agents?${query({ isActive: false })}`)).body.data).toHaveLength(1);
    });

    it("assigns agents to dynamic groups from filters and exposes passphrases", async () => {
      const groups = await api(ctx.app, "GET", `/groups?${query({ siteIds: DEFAULT_SITE_ID })}`);
      expect(groups.body.data.map((group: any) => group.name).sort()).toEqual([
        "Default Group",
        "Linux-Servers",
        "Linux-Workstations",
        "MacOS-Workstations",
        "Windows-Servers",
        "Windows-Workstations",
      ]);
      const windowsServers = groups.body.data.find((group: any) => group.name === "Windows-Servers");
      expect(windowsServers).toMatchObject({ type: "dynamic", totalAgents: 1, filterName: "Windows-Servers" });
      const server = await api(ctx.app, "GET", `/agents/${DEFAULT_SERVER_AGENT_ID}`);
      expect(server.body.data.groupName).toBe("Windows-Servers");
      expect((await api(ctx.app, "GET", `/agents/${DEFAULT_MAC_AGENT_ID}`)).body.data.groupName).toBe(
        "MacOS-Workstations",
      );
      const passphrases = await api(
        ctx.app,
        "GET",
        `/agents/passphrases?${query({ ids: DEFAULT_WORKSTATION_AGENT_ID })}`,
      );
      expect(passphrases.body.data[0]).toMatchObject({ id: DEFAULT_WORKSTATION_AGENT_ID, computerName: "ACME-WS-001" });
      expect(passphrases.body.data[0].passphrase.split(" ")).toHaveLength(6);
    });

    it("decommissions agents and runs response actions", async () => {
      const decommissioned = await api(ctx.app, "POST", "/agents/actions/decommission", {
        filter: { ids: [DEFAULT_WORKSTATION_AGENT_ID], siteIds: [DEFAULT_SITE_ID], migrationStatus: "N/A" },
      });
      expect(decommissioned.body).toEqual({ data: { affected: 1 } });
      const remaining = await api(ctx.app, "GET", `/agents?${query({ siteIds: DEFAULT_SITE_ID })}`);
      expect(remaining.body.data.map((agent: any) => agent.id)).not.toContain(DEFAULT_WORKSTATION_AGENT_ID);
      expect(
        (await api(ctx.app, "GET", `/agents?${query({ siteIds: DEFAULT_SITE_ID, isDecommissioned: true })}`)).body.data,
      ).toHaveLength(1);
      expect((await api(ctx.app, "GET", `/sites/${DEFAULT_SITE_ID}`)).body.data.activeLicenses).toBe(4);
      expect((await api(ctx.app, "POST", "/agents/actions/decommission", { filter: {} })).status).toBe(400);
      const scan = await api(ctx.app, "POST", "/agents/actions/initiate-scan", {
        filter: { ids: [DEFAULT_SERVER_AGENT_ID] },
      });
      expect(scan.body.data.affected).toBe(1);
      expect((await api(ctx.app, "GET", `/agents/${DEFAULT_SERVER_AGENT_ID}`)).body.data.scanStatus).toBe("started");
      const disconnect = await api(ctx.app, "POST", "/agents/actions/disconnect", {
        filter: { ids: [DEFAULT_SERVER_AGENT_ID] },
      });
      expect(disconnect.body.data.affected).toBe(1);
      expect((await api(ctx.app, "GET", `/agents/${DEFAULT_SERVER_AGENT_ID}`)).body.data.networkStatus).toBe(
        "disconnected",
      );
      const moved = await api(ctx.app, "POST", "/agents/actions/move-to-site", {
        filter: { ids: [DEFAULT_MAC_AGENT_ID] },
        data: { targetSiteId: DEFAULT_TRIAL_SITE_ID },
      });
      expect(moved.body.data.affected).toBe(1);
      expect((await api(ctx.app, "GET", `/agents/${DEFAULT_MAC_AGENT_ID}`)).body.data).toMatchObject({
        siteId: DEFAULT_TRIAL_SITE_ID,
        groupName: "MacOS-Workstations",
      });
    });

    it("registers agents through the simulator and honours license limits", async () => {
      const registered = await simulate(ctx, "agent", {
        registrationToken: DEFAULT_SITE_TOKEN,
        computerName: "ACME-WS-002",
        osType: "windows",
        machineType: "desktop",
      });
      expect(registered.status).toBe(201);
      const body = (await registered.json()) as any;
      expect(body.data).toMatchObject({ siteId: DEFAULT_SITE_ID, groupName: "Windows-Workstations", isActive: true });
      const checkin = await simulate(ctx, "agent-checkin", { computerName: "ACME-WS-002", agentVersion: "24.2.2.118" });
      expect(checkin.status).toBe(200);
      expect(((await checkin.json()) as any).data.agentVersion).toBe("24.2.2.118");
      const limited = createS1TestApp({
        accounts: [
          {
            name: "Tiny",
            sites: [
              { name: "TINY SITE", unlimitedLicenses: false, totalLicenses: 1, agents: [{ computerName: "tiny-1" }] },
            ],
          },
        ],
      });
      const site = getS1Store(limited.store)
        .sites.all()
        .find((candidate) => candidate.name === "TINY SITE")!;
      const overflow = await simulate(limited, "agent", { siteId: site.s1_id, computerName: "tiny-2" });
      expect(overflow.status).toBe(400);
      expect(((await overflow.json()) as any).errors[0].detail).toContain("no license left");
    });
  });

  describe("accounts and sites (activation flow)", () => {
    it("creates an MSSP account and rejects duplicate names with code 4000030", async () => {
      const created = await api(ctx.app, "POST", "/accounts", {
        data: {
          name: "EDR-NIMBUS",
          accountType: "Trial",
          usageType: "mssp",
          billingMode: "consumption",
          inherits: false,
          unlimitedExpiration: true,
          licenses: {
            bundles: [{ name: "complete", surfaces: [{ name: "Total Agents", count: -1 }] }],
            modules: [{ name: "rogues" }],
            settings: [{ groupName: "malicious_data_retention", setting: "365 Days" }],
          },
          policy: { mitigationMode: "protect", mitigationModeSuspicious: "detect", engines: { penetration: "on" } },
        },
      });
      expect(created.status).toBe(200);
      expect(created.body.data).toMatchObject({
        name: "EDR-NIMBUS",
        accountType: "Trial",
        usageType: "mssp",
        billingMode: "consumption",
        unlimitedExpiration: true,
        state: "active",
      });
      expect(created.body.data.licenses.bundles[0].name).toBe("complete");
      const duplicate = await api(ctx.app, "POST", "/accounts", {
        data: {
          name: "edr-nimbus",
          accountType: "Trial",
          usageType: "mssp",
          billingMode: "consumption",
          unlimitedExpiration: true,
          inherits: true,
          licenses: { bundles: [], modules: [], settings: [] },
        },
      });
      expect(duplicate.status).toBe(400);
      expect(duplicate.body.errors[0].code).toBe(4000030);
      const fetched = await api(ctx.app, "GET", `/accounts/${created.body.data.id}`);
      expect(fetched.body.data.name).toBe("EDR-NIMBUS");
      const updated = await api(ctx.app, "PUT", `/accounts/${created.body.data.id}`, {
        data: {
          accountType: "Paid",
          name: "EDR-NIMBUS",
          usageType: "mssp",
          billingMode: "consumption",
          unlimitedExpiration: true,
          inherits: false,
          licenses: {
            bundles: [
              { name: "complete", surfaces: [{ name: "Total Agents", count: -1 }] },
              { name: "control", surfaces: [{ name: "Total Agents", count: -1 }] },
            ],
            modules: [],
            settings: [],
          },
        },
      });
      expect(updated.body.data.accountType).toBe("Paid");
      expect(updated.body.data.licenses.bundles.map((bundle: any) => bundle.name)).toEqual(["complete", "control"]);
      const policy = await api(ctx.app, "GET", `/accounts/${created.body.data.id}/policy`);
      expect(policy.body.data).toMatchObject({
        mitigationMode: "protect",
        inheritedFrom: "account",
        engines: { penetration: "on", exploits: "on" },
      });
      expect((await api(ctx.app, "GET", `/accounts?${query({ name: "EDR-NIMBUS" })}`)).body.data).toHaveLength(1);
      expect((await api(ctx.app, "GET", "/accounts/1")).status).toBe(404);
    });

    it("creates sites with default groups, updates names and external ids, and deletes them", async () => {
      const created = await api(ctx.app, "POST", "/sites", {
        data: {
          name: "  NIMBUS CLIENT #REF42 ",
          siteType: "Trial",
          accountId: DEFAULT_ACCOUNT_ID,
          externalId: "33333333-3333-4333-8333-333333333333",
          inherits: true,
          unlimitedExpiration: false,
          unlimitedLicenses: true,
          expiration: "2027-01-01T00:00:00.000Z",
          licenses: {
            bundles: [{ name: "complete", surfaces: [{ name: "Total Agents", count: -1 }] }],
            modules: [{ name: "rogues" }],
          },
        },
      });
      expect(created.status).toBe(200);
      expect(created.body.data).toMatchObject({
        name: "NIMBUS CLIENT #REF42",
        siteType: "Trial",
        accountId: DEFAULT_ACCOUNT_ID,
        accountName: DEFAULT_ACCOUNT_NAME,
        externalId: "33333333-3333-4333-8333-333333333333",
        state: "active",
        sku: "complete",
        suite: "Complete",
        activeLicenses: 0,
        healthStatus: true,
      });
      expect(created.body.data.registrationToken).toHaveLength(64);
      const groups = await api(ctx.app, "GET", `/groups?${query({ siteIds: created.body.data.id })}`);
      expect(groups.body.data.map((group: any) => group.name)).toEqual(["Default Group"]);
      const duplicate = await api(ctx.app, "POST", "/sites", {
        data: {
          name: "nimbus client #ref42",
          siteType: "Trial",
          accountId: DEFAULT_ACCOUNT_ID,
          unlimitedExpiration: true,
        },
      });
      expect(duplicate.status).toBe(400);
      expect(duplicate.body.errors[0].code).toBe(4000030);
      expect((await api(ctx.app, "POST", "/sites", { data: { name: "No type" } })).status).toBe(400);
      const renamed = await api(ctx.app, "PUT", `/sites/${created.body.data.id}`, {
        data: { siteType: "Trial", name: "NIMBUS CLIENT #REF99" },
      });
      expect(renamed.body.data.name).toBe("NIMBUS CLIENT #REF99");
      const externalId = await api(ctx.app, "PUT", `/sites/${created.body.data.id}`, {
        data: {
          name: "NIMBUS CLIENT #REF99",
          siteType: "Paid",
          externalId: "44444444-4444-4444-8444-444444444444",
          expiration: "2028-01-01T00:00:00.000Z",
        },
      });
      expect(externalId.body.data).toMatchObject({
        siteType: "Paid",
        externalId: "44444444-4444-4444-8444-444444444444",
        expiration: "2028-01-01T00:00:00.000Z",
      });
      const listed = await api(ctx.app, "GET", `/sites?${query({ accountId: DEFAULT_ACCOUNT_ID })}`);
      expect(listed.body.data.sites).toHaveLength(3);
      expect(listed.body.data.allSites).toEqual({ activeLicenses: 6, totalLicenses: 25 });
      expect(listed.body.pagination.totalItems).toBe(3);
      expect(
        (await api(ctx.app, "GET", `/sites?${query({ name: "NIMBUS CLIENT #REF99" })}`)).body.data.sites,
      ).toHaveLength(1);
      expect((await api(ctx.app, "DELETE", `/sites/${created.body.data.id}`)).body).toEqual({
        data: { success: true },
      });
      expect((await api(ctx.app, "GET", `/sites/${created.body.data.id}`)).body.data.state).toBe("deleted");
      expect(
        (await api(ctx.app, "GET", `/sites?${query({ accountId: DEFAULT_ACCOUNT_ID })}`)).body.data.sites,
      ).toHaveLength(2);
      expect(
        (await api(ctx.app, "GET", `/sites?${query({ accountId: DEFAULT_ACCOUNT_ID, states: "deleted" })}`)).body.data
          .sites,
      ).toHaveLength(1);
    });

    it("applies the default site configuration: policy overrides plus filters and dynamic groups", async () => {
      const site = (
        await api(ctx.app, "POST", "/sites", {
          data: { name: "FRESH SITE", siteType: "Paid", accountId: DEFAULT_ACCOUNT_ID, unlimitedExpiration: true },
        })
      ).body.data;
      const accountPolicy = (await api(ctx.app, "GET", `/accounts/${DEFAULT_ACCOUNT_ID}/policy`)).body.data;
      expect(accountPolicy.inheritedFrom).toBe("global");
      const {
        ioc: _ioc,
        iocAttributes: _attributes,
        autoFileUpload: _upload,
        inheritedFrom: _from,
        ...policies
      } = accountPolicy;
      const updated = await api(ctx.app, "PUT", `/sites/${site.id}/policy`, {
        data: {
          ...policies,
          agentNotification: true,
          snapshotsOn: false,
          mitigationModeSuspicious: "detect",
          mitigationMode: "detect",
          autoMitigationAction: "mitigation.none",
          agentUi: { ...policies.agentUi, showSuspicious: true, showDeviceTab: true },
          allowRemoteShell: true,
          engines: { ...policies.engines, penetration: "on" },
        },
      });
      expect(updated.status).toBe(200);
      expect(updated.body.data).toMatchObject({
        mitigationMode: "detect",
        snapshotsOn: false,
        autoMitigationAction: "mitigation.none",
        allowRemoteShell: true,
        inheritedFrom: "site",
      });
      expect(updated.body.data.engines.penetration).toBe("on");
      expect((await api(ctx.app, "PUT", `/sites/${site.id}/policy`, { data: {} })).status).toBe(400);
      for (const group of [
        { name: "Windows-Workstations", machineTypes: ["desktop", "laptop"], osTypes: ["windows"] },
        { name: "Linux-Servers", machineTypes: ["server"], osTypes: ["linux"] },
      ]) {
        const filter = await api(ctx.app, "POST", "/filters", {
          data: { name: group.name, filterFields: { machineTypes: group.machineTypes, osTypes: group.osTypes } },
          filter: { siteIds: site.id },
        });
        expect(filter.status).toBe(200);
        expect(filter.body.data).toMatchObject({ name: group.name, scopeLevel: "site", scopeId: site.id });
        const created = await api(ctx.app, "POST", "/groups", {
          data: { inherits: true, name: group.name, siteId: site.id, filterId: filter.body.data.id },
        });
        expect(created.body.data).toMatchObject({ name: group.name, type: "dynamic", filterId: filter.body.data.id });
      }
      const filters = await api(ctx.app, "GET", `/filters?${query({ siteIds: site.id })}`);
      expect(filters.body.data).toHaveLength(2);
      expect(
        (await api(ctx.app, "POST", "/groups", { data: { inherits: true, name: "Linux-Servers", siteId: site.id } }))
          .status,
      ).toBe(400);
      const groups = await api(ctx.app, "GET", `/groups?${query({ siteIds: site.id })}`);
      expect(groups.body.data).toHaveLength(3);
      const registered = await simulate(ctx, "agent", {
        siteId: site.id,
        computerName: "fresh-linux",
        osType: "linux",
        machineType: "server",
      });
      expect(((await registered.json()) as any).data.groupName).toBe("Linux-Servers");
      const groupPolicy = await api(ctx.app, "GET", `/groups/${groups.body.data[1].id}/policy`);
      expect(groupPolicy.body.data.inheritedFrom).toBe("site");
      const dynamic = groups.body.data.find((group: any) => group.type === "dynamic");
      expect((await api(ctx.app, "DELETE", `/filters/${dynamic.filterId}`)).status).toBe(400);
      expect((await api(ctx.app, "DELETE", `/groups/${dynamic.id}`)).status).toBe(200);
      expect((await api(ctx.app, "PUT", `/groups/${groups.body.data[0].id}/revert-policy`)).status).toBe(200);
    });
  });

  describe("users and roles", () => {
    it("finds users by email and creates users with site scope roles", async () => {
      const found = await api(ctx.app, "GET", `/users?${query({ email: DEFAULT_ANALYST_EMAIL })}`);
      expect(found.body.data).toHaveLength(1);
      expect(found.body.data[0]).toMatchObject({
        email: DEFAULT_ANALYST_EMAIL,
        fullName: "Ana Analyst",
        scope: "site",
      });
      expect(found.body.data[0].scopeRoles[0]).toMatchObject({
        id: DEFAULT_SITE_ID,
        roleId: DEFAULT_ROLE_IDS.socN1,
        roleName: "SOC N1",
        name: DEFAULT_SITE_NAME,
        accountName: DEFAULT_ACCOUNT_NAME,
      });
      expect((await api(ctx.app, "GET", `/users?${query({ email: "nobody@example.com" })}`)).body.data).toEqual([]);
      const created = await api(ctx.app, "POST", "/users", {
        data: {
          email: "Bob.Builder@Acme.Example",
          fullName: "Bob BUILDER",
          scope: "site",
          scopeRoles: [{ id: DEFAULT_SITE_ID, roleId: DEFAULT_ROLE_IDS.customerTech }],
        },
      });
      expect(created.status).toBe(200);
      expect(created.body.data).toMatchObject({
        email: "bob.builder@acme.example",
        fullName: "Bob BUILDER",
        scope: "site",
        twoFaEnabled: true,
        emailVerified: false,
      });
      expect(
        (
          await api(ctx.app, "POST", "/users", {
            data: {
              email: "bob.builder@acme.example",
              fullName: "Dup",
              scope: "site",
              scopeRoles: [{ id: DEFAULT_SITE_ID, roleId: DEFAULT_ROLE_IDS.customerTech }],
            },
          })
        ).body.errors[0].code,
      ).toBe(4000030);
      expect(
        (
          await api(ctx.app, "POST", "/users", {
            data: {
              email: "x@example.com",
              fullName: "X",
              scope: "site",
              scopeRoles: [{ id: DEFAULT_SITE_ID, roleId: "999" }],
            },
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await api(ctx.app, "POST", "/users", {
            data: { email: "x@example.com", fullName: "X", scope: "site", scopeRoles: [] },
          })
        ).status,
      ).toBe(400);
      const promoted = await api(ctx.app, "PUT", `/users/${created.body.data.id}`, {
        data: { scope: "account", scopeRoles: [{ id: DEFAULT_ACCOUNT_ID, roleId: DEFAULT_ROLE_IDS.mspAdmin }] },
      });
      expect(promoted.body.data).toMatchObject({ scope: "account" });
      expect(promoted.body.data.scopeRoles).toEqual([
        expect.objectContaining({ id: DEFAULT_ACCOUNT_ID, roleId: DEFAULT_ROLE_IDS.mspAdmin, roleName: "MSP Admin" }),
      ]);
      const bySite = await api(ctx.app, "GET", `/users?${query({ siteIds: DEFAULT_SITE_ID })}`);
      expect(bySite.body.data.map((user: any) => user.email).sort()).toEqual([
        "analyst@example.com",
        "customer.admin@acme.example",
      ]);
      const byAccount = await api(ctx.app, "GET", `/users?${query({ accountIds: DEFAULT_ACCOUNT_ID })}`);
      expect(byAccount.body.data.length).toBeGreaterThanOrEqual(3);
      expect((await api(ctx.app, "GET", `/users/${created.body.data.id}`)).body.data.email).toBe(
        "bob.builder@acme.example",
      );
      expect((await api(ctx.app, "DELETE", `/users/${created.body.data.id}`)).body).toEqual({
        data: { success: true },
      });
      expect((await api(ctx.app, "GET", `/users/${created.body.data.id}`)).status).toBe(404);
    });

    it("runs user actions and mints API tokens", async () => {
      const analyst = (await api(ctx.app, "GET", `/users?${query({ email: DEFAULT_ANALYST_EMAIL })}`)).body.data[0];
      expect(
        (await api(ctx.app, "POST", "/users/onboarding/send-verification-email", { filter: { ids: [analyst.id] } }))
          .body,
      ).toEqual({ data: { affected: 1 } });
      expect(
        (await api(ctx.app, "POST", "/users/login/send-reset-password-email", { filter: { ids: [analyst.id] } })).body
          .data.affected,
      ).toBe(1);
      expect(
        (await api(ctx.app, "POST", "/users/enroll-2fa", { data: { ids: [analyst.id] } })).body.data.affected,
      ).toBe(1);
      expect((await api(ctx.app, "POST", "/users/reset-2fa", { data: { ids: [analyst.id] } })).body.data.affected).toBe(
        1,
      );
      expect((await api(ctx.app, "POST", "/users/reset-2fa", { data: { ids: ["1"] } })).status).toBe(404);
      const events = (await (
        await ctx.app.request(`${s1TestBaseUrl}/_sentinelone/events?type=user.onboarding_email`)
      ).json()) as any;
      expect(events.events[0].detail.email).toBe(DEFAULT_ANALYST_EMAIL);
      const minted = await api(ctx.app, "POST", "/users/generate-api-token", {});
      expect(minted.status).toBe(200);
      expect(typeof minted.body.data.token).toBe("string");
      expect(minted.body.data.expiresAt).toBeTruthy();
      const viaNewToken = await api(ctx.app, "GET", "/user", undefined, minted.body.data.token);
      expect(viaNewToken.body.data.email).toBe(DEFAULT_ADMIN_EMAIL);
      const roles = await api(ctx.app, "GET", `/rbac/roles?${query({ siteIds: DEFAULT_SITE_ID, limit: 100 })}`);
      expect(roles.body.data.map((role: any) => role.name)).toContain("SOC N1");
      expect(roles.body.data.find((role: any) => role.name === "SOC N1").usersInRoles).toBe(1);
      const custom = await api(ctx.app, "POST", "/rbac/role", {
        data: { name: "Read-only auditor", description: "Audit", scope: "site" },
      });
      expect(custom.status).toBe(200);
      expect((await api(ctx.app, "DELETE", `/rbac/role/${DEFAULT_ROLE_IDS.admin}`)).status).toBe(400);
      expect((await api(ctx.app, "DELETE", `/rbac/role/${custom.body.data.id}`)).status).toBe(200);
    });
  });

  describe("threats and vulnerabilities", () => {
    it("lists threats, counts them, and runs mitigation and incident actions", async () => {
      const all = await api(ctx.app, "GET", `/threats?${query({ siteIds: DEFAULT_SITE_ID })}`);
      expect(all.body.data).toHaveLength(2);
      const open = await api(
        ctx.app,
        "GET",
        `/threats?${query({ siteIds: DEFAULT_SITE_ID, resolved: false, countOnly: true })}`,
      );
      expect(open.body.pagination.totalItems).toBe(1);
      const mimikatz = all.body.data.find((threat: any) => threat.threatInfo.threatName === "mimikatz.exe");
      expect(mimikatz).toMatchObject({
        threatInfo: {
          classification: "Hacktool",
          mitigationStatus: "not_mitigated",
          incidentStatus: "unresolved",
          confidenceLevel: "malicious",
        },
        agentRealtimeInfo: { agentComputerName: "ACME-SRV-FILES", siteId: DEFAULT_SITE_ID },
        agentDetectionInfo: { accountId: DEFAULT_ACCOUNT_ID },
      });
      const mitigated = await api(ctx.app, "POST", "/threats/mitigate/quarantine", { filter: { ids: [mimikatz.id] } });
      expect(mitigated.body).toEqual({ data: { affected: 1 } });
      expect((await api(ctx.app, "GET", `/threats/${mimikatz.id}`)).body.data.threatInfo.mitigationStatus).toBe(
        "mitigated",
      );
      expect((await api(ctx.app, "GET", `/agents/${DEFAULT_SERVER_AGENT_ID}`)).body.data.activeThreats).toBe(0);
      const resolved = await api(ctx.app, "POST", "/threats/incident", {
        filter: { ids: [mimikatz.id] },
        data: { incidentStatus: "resolved" },
      });
      expect(resolved.body.data.affected).toBe(1);
      expect(
        (
          await api(ctx.app, "POST", "/threats/analyst-verdict", {
            filter: { ids: [mimikatz.id] },
            data: { analystVerdict: "true_positive" },
          })
        ).body.data.affected,
      ).toBe(1);
      expect(
        (await api(ctx.app, "POST", "/threats/notes", { filter: { ids: [mimikatz.id] }, data: { text: "Contained" } }))
          .body.data.affected,
      ).toBe(1);
      expect((await api(ctx.app, "GET", `/threats/${mimikatz.id}`)).body.data.notes).toEqual(["Contained"]);
      expect((await api(ctx.app, "POST", "/threats/mitigate/explode", { filter: { ids: [mimikatz.id] } })).status).toBe(
        400,
      );
      const simulated = await simulate(ctx, "threat", {
        computerName: "ACME-WS-001",
        threatName: "dropper.exe",
        confidenceLevel: "suspicious",
        mitigationStatus: "not_mitigated",
      });
      expect(simulated.status).toBe(201);
      expect((await api(ctx.app, "GET", `/agents/${DEFAULT_WORKSTATION_AGENT_ID}`)).body.data).toMatchObject({
        activeThreats: 1,
        infected: true,
      });
      expect((await api(ctx.app, "GET", `/threats/${mimikatz.id}/timeline`)).body.data.length).toBeGreaterThanOrEqual(
        2,
      );
    });

    it("counts application risks per severity and lists CVEs the way the vulnerabilities cron does", async () => {
      const counts: Record<string, number> = {};
      for (const severity of ["CRITICAL", "HIGH", "MEDIUM", "LOW"]) {
        const response = await api(
          ctx.app,
          "GET",
          `/application-management/risks/applications?${query({ siteIds: DEFAULT_SITE_ID, countOnly: true, highestSeverities: severity })}`,
        );
        counts[severity] = response.body.pagination.totalItems;
      }
      expect(counts).toEqual({ CRITICAL: 1, HIGH: 3, MEDIUM: 0, LOW: 0 });
      const applications = await api(
        ctx.app,
        "GET",
        `/application-management/risks/applications?${query({ siteIds: DEFAULT_SITE_ID })}`,
      );
      expect(
        applications.body.data.find((application: any) => application.application === "Google Chrome"),
      ).toMatchObject({
        highestSeverity: "HIGH",
        cveCount: 1,
        endpointName: "ACME-WS-001",
        applicationVendor: "Google",
      });
      const cves = await api(
        ctx.app,
        "GET",
        `/application-management/risks?analystVerdict=Added%20CVE,Default&${query({ siteIds: DEFAULT_SITE_ID, limit: 1000, skipCount: true, sortBy: "detectionDate", sortOrder: "asc" })}`,
      );
      expect(cves.status).toBe(200);
      expect(cves.body.pagination.totalItems).toBeNull();
      expect(cves.body.data).toHaveLength(5);
      expect(cves.body.data.find((cve: any) => cve.cveId === "CVE-2024-38063")).toMatchObject({
        baseScore: 9.8,
        severity: "CRITICAL",
        endpointId: DEFAULT_SERVER_AGENT_ID,
        endpointName: "ACME-SRV-FILES",
        application: "Windows Server 2022",
        applicationVendor: "Microsoft",
        applicationVersion: "10.0.20348",
        ransomware: false,
        exploitedInTheWild: true,
      });
      const critical = await api(
        ctx.app,
        "GET",
        `/application-management/risks?${query({ siteIds: DEFAULT_SITE_ID, severities: "CRITICAL", countOnly: true })}`,
      );
      expect(critical.body.pagination.totalItems).toBe(1);
      const total = await api(ctx.app, "GET", `/application-management/risks?${query({ countOnly: true })}`);
      expect(total.body.pagination.totalItems).toBe(5);
      const verdict = await api(ctx.app, "POST", "/application-management/risks/analyst-verdict", {
        filter: { ids: [cves.body.data[0].id] },
        data: { analystVerdict: "False positive" },
      });
      expect(verdict.body.data.affected).toBe(1);
      expect(
        (
          await api(
            ctx.app,
            "GET",
            `/application-management/risks?analystVerdict=Added%20CVE,Default&${query({ siteIds: DEFAULT_SITE_ID, countOnly: true })}`,
          )
        ).body.pagination.totalItems,
      ).toBe(4);
      const added = await simulate(ctx, "vulnerability", {
        computerName: "acme-ubuntu-01",
        cveId: "CVE-2024-6387",
        application: "OpenSSH",
        applicationVendor: "OpenBSD",
        applicationVersion: "8.9p1",
        baseScore: 8.1,
      });
      expect(added.status).toBe(201);
      expect(((await added.json()) as any).data).toMatchObject({
        cveId: "CVE-2024-6387",
        severity: "HIGH",
        endpointName: "acme-ubuntu-01",
      });
      expect(
        (
          await api(
            ctx.app,
            "GET",
            `/application-management/inventory/endpoints?${query({ siteIds: DEFAULT_SITE_ID })}`,
          )
        ).body.data.find((row: any) => row.endpointName === "acme-ubuntu-01").vulnerableApplicationsCount,
      ).toBe(2);
    });
  });

  describe("exclusions, restrictions, and device control", () => {
    it("manages legacy and unified exclusions per scope", async () => {
      const legacy = await api(ctx.app, "POST", "/exclusions", {
        data: {
          osType: "windows",
          type: "path",
          value: "C:\\Program Files\\Backup\\",
          mode: "suppress",
          description: "Backup agent",
          pathExclusionType: "subfolders",
        },
        filter: { siteIds: DEFAULT_SITE_ID },
      });
      expect(legacy.status).toBe(200);
      expect(legacy.body.data).toMatchObject({
        type: "path",
        osType: "windows",
        mode: "suppress",
        scope: { siteIds: [DEFAULT_SITE_ID], accountIds: [DEFAULT_ACCOUNT_ID], tenant: false },
        scopeName: DEFAULT_SITE_NAME,
      });
      expect(
        (
          await api(ctx.app, "POST", "/exclusions", {
            data: { osType: "windows", type: "path", value: "c:\\program files\\backup\\" },
            filter: { siteIds: DEFAULT_SITE_ID },
          })
        ).body.errors[0].code,
      ).toBe(4000030);
      expect(
        (
          await api(ctx.app, "POST", "/exclusions", {
            data: { osType: "windows", type: "white_hash", value: "nope" },
            filter: { siteIds: DEFAULT_SITE_ID },
          })
        ).status,
      ).toBe(400);
      const unified = await api(ctx.app, "POST", "/unified-exclusions", {
        data: {
          actions: [],
          osType: "linux",
          type: "path",
          value: "/opt/backup/",
          exclusionName: "Backup dir",
          threatType: "EDR",
          interactionLevel: "suppress",
          reason: "Known good",
          modeType: "suppression",
          source: "user",
          tagIds: [],
        },
        filter: { scopeLevel: "account", scopeLevelId: DEFAULT_ACCOUNT_ID },
      });
      expect(unified.status).toBe(200);
      expect(unified.body.data).toMatchObject({
        exclusionName: "Backup dir",
        threatType: "EDR",
        interactionLevel: "suppress",
        modeType: "suppression",
        scope: { accountIds: [DEFAULT_ACCOUNT_ID], siteIds: [] },
      });
      expect(
        (
          await api(ctx.app, "POST", "/unified-exclusions", {
            data: {
              actions: [],
              osType: "linux",
              type: "path",
              value: "/x/",
              threatType: "EDR",
              interactionLevel: "suppress",
              modeType: "suppression",
              source: "user",
              tagIds: [],
            },
            filter: { scopeLevel: "account", scopeLevelId: DEFAULT_ACCOUNT_ID },
          })
        ).status,
      ).toBe(400);
      const siteScoped = await api(ctx.app, "GET", `/unified-exclusions?${query({ siteIds: DEFAULT_SITE_ID })}`);
      expect(siteScoped.body.data.map((exclusion: any) => exclusion.value)).toEqual(["C:\\Program Files\\Backup\\"]);
      const accountScoped = await api(
        ctx.app,
        "GET",
        `/unified-exclusions?${query({ accountIds: DEFAULT_ACCOUNT_ID })}`,
      );
      expect(accountScoped.body.data.map((exclusion: any) => exclusion.value)).toEqual([
        "C:\\Program Files\\Backup\\",
        "/opt/backup/",
      ]);
      expect((await api(ctx.app, "GET", `/exclusions?${query({ osTypes: "linux" })}`)).body.data).toHaveLength(1);
      const deleted = await api(ctx.app, "DELETE", "/unified-exclusions", {
        data: { data: { exclusions: [{ id: unified.body.data.id, type: "path" }] } },
      });
      expect(deleted.body).toEqual({ data: { affected: 1 } });
      expect((await api(ctx.app, "GET", "/unified-exclusions")).body.data).toHaveLength(1);
    });

    it("manages the blocklist and device control rules", async () => {
      const hash = "3395856ce81f2b7382dee72602f798b642f14140";
      const blocked = await api(ctx.app, "POST", "/restrictions", {
        data: {
          type: "black_hash",
          value: hash.toUpperCase(),
          osType: "windows",
          description: "EICAR",
          source: "user",
        },
        filter: { siteIds: DEFAULT_SITE_ID },
      });
      expect(blocked.status).toBe(200);
      expect(blocked.body.data).toMatchObject({ value: hash, type: "black_hash", scopeName: DEFAULT_SITE_NAME });
      expect(
        (
          await api(ctx.app, "POST", "/restrictions", {
            data: { type: "black_hash", value: "short", osType: "windows", description: "x", source: "user" },
            filter: { siteIds: DEFAULT_SITE_ID },
          })
        ).status,
      ).toBe(400);
      expect(
        (await api(ctx.app, "GET", `/restrictions?${query({ siteIds: DEFAULT_SITE_ID, value__contains: "3395" })}`))
          .body.data,
      ).toHaveLength(1);
      expect(
        (await api(ctx.app, "DELETE", "/restrictions", { filter: { ids: [blocked.body.data.id] } })).body.data.affected,
      ).toBe(1);
      const rule = await api(ctx.app, "POST", "/device-control", {
        data: {
          interface: "USB",
          ruleName: "Block mass storage",
          ruleType: "class",
          deviceClass: "08h",
          action: "Block",
          status: "Enabled",
          accessPermission: "Not-Applicable",
        },
        filter: { siteIds: DEFAULT_SITE_ID },
      });
      expect(rule.status).toBe(200);
      expect(rule.body.data).toMatchObject({
        interface: "USB",
        ruleType: "class",
        action: "Block",
        status: "Enabled",
        scope: "site",
        scopeId: DEFAULT_SITE_ID,
        order: 1,
      });
      expect(
        (
          await api(ctx.app, "POST", "/device-control", {
            data: { interface: "USB", ruleName: "No vendor", ruleType: "vendorId", action: "Allow", status: "Enabled" },
            filter: { siteIds: DEFAULT_SITE_ID },
          })
        ).status,
      ).toBe(400);
      expect(
        (await api(ctx.app, "GET", `/device-control?${query({ siteIds: DEFAULT_SITE_ID })}`)).body.data,
      ).toHaveLength(1);
      expect(
        (await api(ctx.app, "PUT", "/device-control/disable", { filter: { ids: [rule.body.data.id] } })).body.data
          .affected,
      ).toBe(1);
      expect(
        (await api(ctx.app, "PUT", `/device-control/${rule.body.data.id}`, { data: { action: "Allow" } })).body.data,
      ).toMatchObject({ action: "Allow", status: "Disabled" });
      expect(
        (await api(ctx.app, "DELETE", "/device-control", { filter: { ids: [rule.body.data.id] } })).body.data.affected,
      ).toBe(1);
    });
  });

  describe("misc", () => {
    it("exposes system info, activities, events, the inspector, and custom seeds", async () => {
      const info = await api(ctx.app, "GET", "/system/info");
      expect(info.body.data.release).toContain("Emulate");
      const activities = await api(ctx.app, "GET", `/activities?${query({ siteIds: DEFAULT_SITE_ID, limit: 100 })}`);
      expect(activities.body.data.length).toBeGreaterThan(5);
      expect(
        activities.body.data.every((activity: any) => activity.siteId === DEFAULT_SITE_ID || activity.agentId),
      ).toBe(true);
      for (const tab of [
        "hierarchy",
        "agents",
        "threats",
        "risks",
        "users",
        "protection",
        "activities",
        "events",
        "auth",
      ]) {
        const page = await ctx.app.request(`${s1TestBaseUrl}/?tab=${tab}`);
        expect(page.status).toBe(200);
        expect(await page.text()).toContain("SentinelOne");
      }
      expect((await ctx.app.request(`${s1TestBaseUrl}/_sentinelone/events`, { method: "DELETE" })).status).toBe(200);
      const custom = createS1TestApp(
        {
          api_tokens: [{ token: "pro-token" }],
          roles: [
            { id: "2153718167648641127", name: "MSP Admin PRO", scope: "account" },
            { id: "2143855039033122024", name: "SOC N1 PRO", scope: "site" },
          ],
          accounts: [
            {
              id: "2000000000000000001",
              name: "CYNA PRO",
              usageType: "mssp",
              sites: [
                {
                  id: "2000000000000000101",
                  name: "CUSTOMER ONE #C1",
                  externalId: "cust-1",
                  agents: [
                    { computerName: "c1-ws-01" },
                    { computerName: "c1-srv-01", osType: "linux", machineType: "server" },
                  ],
                },
              ],
            },
          ],
          users: [
            {
              email: "pro.admin@example.com",
              fullName: "Pro Admin",
              scope: "account",
              scopeRoles: [{ account: "CYNA PRO", roleId: "2153718167648641127" }],
            },
          ],
        },
        false,
      );
      const sites = await api(
        custom.app,
        "GET",
        `/sites?${query({ accountId: "2000000000000000001" })}`,
        undefined,
        "pro-token",
      );
      expect(sites.body.data.sites).toEqual([
        expect.objectContaining({
          id: "2000000000000000101",
          name: "CUSTOMER ONE #C1",
          externalId: "cust-1",
          activeLicenses: 2,
        }),
      ]);
      const agents = await api(
        custom.app,
        "GET",
        `/agents?${query({ siteIds: "2000000000000000101" })}`,
        undefined,
        "pro-token",
      );
      expect(agents.body.data).toHaveLength(2);
      const user = await api(
        custom.app,
        "GET",
        `/users?${query({ email: "pro.admin@example.com" })}`,
        undefined,
        "pro-token",
      );
      expect(user.body.data[0].scopeRoles[0]).toMatchObject({
        id: "2000000000000000001",
        roleId: "2153718167648641127",
        roleName: "MSP Admin PRO",
      });
      expect((await api(custom.app, "GET", "/sites")).status).toBe(401);
    });
  });
});
