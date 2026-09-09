import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_CLIENT_ID,
  DEFAULT_MACHINE_ID,
  DEFAULT_OFFBOARDED_MACHINE_ID,
  DEFAULT_SECOND_TENANT_ID,
  DEFAULT_SERVER_MACHINE_ID,
  DEFAULT_TENANT_ID,
  getDefStore,
  parseFilter,
} from "../index.js";
import {
  accessToken,
  api,
  createDefenderTestApp,
  defenderTestBaseUrl,
  requestToken,
  type DefenderTestApp,
} from "./helpers.js";

const ONBOARDED_FILTER = `/api/machines?${new URLSearchParams({ $filter: "onboardingStatus eq 'Onboarded'" }).toString()}`;

describe("Defender for Endpoint plugin", () => {
  let ctx: DefenderTestApp;
  let token: string;

  beforeEach(async () => {
    ctx = createDefenderTestApp();
    token = await accessToken(ctx.app);
  });

  describe("authentication", () => {
    it("issues client_credentials tokens per tenant like login.microsoftonline.com", async () => {
      const response = await requestToken(ctx.app);
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ token_type: "Bearer", expires_in: 3600, ext_expires_in: 3600 });
      const payload = JSON.parse(Buffer.from(response.body.access_token.split(".")[1], "base64url").toString());
      expect(payload).toMatchObject({
        aud: "https://api.securitycenter.microsoft.com",
        tid: DEFAULT_TENANT_ID,
        appid: DEFAULT_CLIENT_ID,
      });
      expect(payload.roles).toContain("Machine.Read.All");
    });

    it("rejects bad secrets, unknown apps, unknown tenants, and other grant types", async () => {
      expect((await requestToken(ctx.app, DEFAULT_TENANT_ID, DEFAULT_CLIENT_ID, "wrong")).status).toBe(401);
      const unknown = await requestToken(ctx.app, DEFAULT_TENANT_ID, "missing-app");
      expect(unknown.status).toBe(401);
      expect(unknown.body.error).toBe("invalid_client");
      const tenant = await requestToken(ctx.app, "00000000-0000-4000-8000-00000000ffff");
      expect(tenant.status).toBe(400);
      expect(tenant.body.error_description).toContain("AADSTS90002");
      const grant = await ctx.app.request(`${defenderTestBaseUrl}/${DEFAULT_TENANT_ID}/oauth2/v2.0/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "grant_type=password&client_id=x",
      });
      expect(grant.status).toBe(400);
    });

    it("supports the common endpoint, the v1 endpoint, and basic client auth", async () => {
      const common = await ctx.app.request(`${defenderTestBaseUrl}/oauth2/v2.0/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${Buffer.from(`${DEFAULT_CLIENT_ID}:test_emulate_defender_client_secret`).toString("base64")}`,
        },
        body: JSON.stringify({ grant_type: "client_credentials" }),
      });
      expect(common.status).toBe(200);
      const v1 = await ctx.app.request(`${defenderTestBaseUrl}/${DEFAULT_SECOND_TENANT_ID}/oauth2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          resource: "https://api.securitycenter.microsoft.com",
          client_id: DEFAULT_CLIENT_ID,
          client_secret: "test_emulate_defender_client_secret",
        }).toString(),
      });
      expect(v1.status).toBe(200);
    });

    it("rejects API calls without a valid bearer token", async () => {
      const missing = await api(ctx.app, "GET", "/api/machines");
      expect(missing.status).toBe(401);
      expect(missing.body.error.code).toBe("Unauthorized");
      expect((await api(ctx.app, "GET", "/api/machines", undefined, "not-a-token")).status).toBe(401);
    });

    it("restricts apps to their consented tenants", async () => {
      const seeded = createDefenderTestApp({
        apps: [{ client_id: "scoped", client_secret: "s3cret", tenant_ids: [DEFAULT_SECOND_TENANT_ID] }],
      });
      expect((await requestToken(seeded.app, DEFAULT_SECOND_TENANT_ID, "scoped", "s3cret")).status).toBe(200);
      const denied = await requestToken(seeded.app, DEFAULT_TENANT_ID, "scoped", "s3cret");
      expect(denied.status).toBe(401);
      expect(denied.body.error).toBe("unauthorized_client");
    });
  });

  describe("machines (CyberHub flow)", () => {
    it("lists onboarded machines with the odata-query style $filter", async () => {
      const response = await api(ctx.app, "GET", ONBOARDED_FILTER, undefined, token);
      expect(response.status).toBe(200);
      expect(response.body["@odata.context"]).toBe(`${defenderTestBaseUrl}/api/$metadata#Machines`);
      expect(response.body.value).toHaveLength(3);
      expect(response.body.value.every((machine: any) => machine.onboardingStatus === "Onboarded")).toBe(true);
      const desktop = response.body.value.find((machine: any) => machine.id === DEFAULT_MACHINE_ID);
      expect(desktop).toMatchObject({
        computerDnsName: "desktop-01.contoso.local",
        osPlatform: "Windows11",
        osProcessor: "x64",
        version: "23H2",
        osBuild: 22631,
        onboardingStatus: "Onboarded",
      });
      expect(typeof desktop.lastSeen).toBe("string");
      const all = await api(ctx.app, "GET", "/api/machines", undefined, token);
      expect(all.body.value).toHaveLength(4);
    });

    it("scopes machines to the token's tenant", async () => {
      const fabrikam = await accessToken(ctx.app, DEFAULT_SECOND_TENANT_ID);
      const response = await api(ctx.app, "GET", ONBOARDED_FILTER, undefined, fabrikam);
      expect(response.body.value.map((machine: any) => machine.computerDnsName)).toEqual([
        "fab-ws-01.fabrikam.local",
        "fab-ubuntu-01.fabrikam.local",
      ]);
      expect((await api(ctx.app, "GET", `/api/machines/${DEFAULT_MACHINE_ID}`, undefined, fabrikam)).status).toBe(404);
    });

    it("supports $top, $skip, $orderby, $select, $count and nextLink paging", async () => {
      const first = await api(
        ctx.app,
        "GET",
        `/api/machines?${new URLSearchParams({ $top: "2", $orderby: "computerDnsName asc", $select: "id,computerDnsName", $count: "true" }).toString()}`,
        undefined,
        token,
      );
      expect(first.body["@odata.count"]).toBe(4);
      expect(first.body.value).toEqual([
        { id: DEFAULT_MACHINE_ID, computerDnsName: "desktop-01.contoso.local" },
        { id: expect.any(String), computerDnsName: "mbp-carol.contoso.local" },
      ]);
      expect(first.body["@odata.nextLink"]).toContain("%24skip=2");
      const next = await api(
        ctx.app,
        "GET",
        first.body["@odata.nextLink"].replace(defenderTestBaseUrl, ""),
        undefined,
        token,
      );
      expect(next.body.value.map((machine: any) => machine.computerDnsName)).toEqual([
        "old-kiosk-07.contoso.local",
        "srv-files-01.contoso.local",
      ]);
      expect(next.body["@odata.nextLink"]).toBeUndefined();
    });

    it("evaluates richer OData filters", async () => {
      const query = (filter: string) =>
        api(ctx.app, "GET", `/api/machines?${new URLSearchParams({ $filter: filter }).toString()}`, undefined, token);
      expect((await query("riskScore eq 'High' or exposureLevel eq 'High'")).body.value).toHaveLength(1);
      expect((await query("contains(computerDnsName, 'contoso') and osBuild ge 20000")).body.value).toHaveLength(2);
      expect((await query("machineTags/any(t: t eq 'laptop')")).body.value).toHaveLength(2);
      expect((await query("lastSeen gt 2026-06-01T00:00:00Z")).body.value).toHaveLength(3);
      expect((await query("osPlatform in ('macOS', 'Ubuntu')")).body.value).toHaveLength(1);
      expect((await query("not (healthStatus eq 'Active')")).body.value).toHaveLength(1);
      expect((await query("startswith(computerDnsName, 'srv')")).body.value[0].id).toBe(DEFAULT_SERVER_MACHINE_ID);
      const invalid = await query("onboardingStatus eq 'Onboarded");
      expect(invalid.status).toBe(400);
      expect(invalid.body.error.code).toBe("InvalidQuery");
      expect(parseFilter("a eq 1 and (b eq 2 or c ne null)")({ a: 1, b: 3, c: "x" })).toBe(true);
    });

    it("reads machine details, alerts, logon users, and related TVM data", async () => {
      const machine = await api(ctx.app, "GET", `/api/machines/${DEFAULT_SERVER_MACHINE_ID}`, undefined, token);
      expect(machine.body).toMatchObject({
        "@odata.context": `${defenderTestBaseUrl}/api/$metadata#Machines/$entity`,
        id: DEFAULT_SERVER_MACHINE_ID,
        rbacGroupName: "Servers",
        riskScore: "High",
      });
      expect(
        (await api(ctx.app, "GET", `/api/machines/${DEFAULT_SERVER_MACHINE_ID}/alerts`, undefined, token)).body.value,
      ).toHaveLength(1);
      const users = await api(
        ctx.app,
        "GET",
        `/api/machines/${DEFAULT_SERVER_MACHINE_ID}/logonusers`,
        undefined,
        token,
      );
      expect(users.body.value.map((user: any) => user.accountName)).toEqual(["svc-backup", "bob"]);
      expect(
        (
          await api(ctx.app, "GET", `/api/machines/${DEFAULT_SERVER_MACHINE_ID}/vulnerabilities`, undefined, token)
        ).body.value
          .map((item: any) => item.id)
          .sort(),
      ).toEqual(["CVE-2023-36049", "CVE-2024-38063"]);
      expect(
        (await api(ctx.app, "GET", `/api/machines/${DEFAULT_SERVER_MACHINE_ID}/software`, undefined, token)).body
          .value[0].id,
      ).toBe("microsoft-_-windows_10");
      expect(
        (
          await api(ctx.app, "GET", `/api/machines/${DEFAULT_SERVER_MACHINE_ID}/recommendations`, undefined, token)
        ).body.value.map((item: any) => item.id),
      ).toEqual(["va-_-microsoft-_-windows_10"]);
      expect(
        (await api(ctx.app, "GET", "/api/machines/findbytag?tag=laptop", undefined, token)).body.value,
      ).toHaveLength(2);
      expect(
        (
          await api(
            ctx.app,
            "GET",
            `/api/machines/findbyip?ip=10.0.1.10&timestamp=${encodeURIComponent(new Date().toISOString())}`,
            undefined,
            token,
          )
        ).body.value[0].id,
      ).toBe(DEFAULT_SERVER_MACHINE_ID);
      expect((await api(ctx.app, "GET", "/api/machines/unknown", undefined, token)).status).toBe(404);
    });

    it("adds and removes tags and sets the device value", async () => {
      const added = await api(
        ctx.app,
        "POST",
        `/api/machines/${DEFAULT_MACHINE_ID}/tags`,
        { Value: "vip", Action: "Add" },
        token,
      );
      expect(added.body.machineTags).toEqual(["finance", "laptop", "vip"]);
      const removed = await api(
        ctx.app,
        "POST",
        `/api/machines/${DEFAULT_MACHINE_ID}/tags`,
        { Value: "finance", Action: "Remove" },
        token,
      );
      expect(removed.body.machineTags).toEqual(["laptop", "vip"]);
      expect(
        (await api(ctx.app, "POST", `/api/machines/${DEFAULT_MACHINE_ID}/tags`, { Action: "Add" }, token)).status,
      ).toBe(400);
      const valued = await api(
        ctx.app,
        "POST",
        `/api/machines/${DEFAULT_MACHINE_ID}/setDeviceValue`,
        { DeviceValue: "High" },
        token,
      );
      expect(valued.body.deviceValue).toBe("High");
    });
  });

  describe("machine actions", () => {
    it("isolates, tracks progress, blocks duplicates, and cancels", async () => {
      const isolate = await api(
        ctx.app,
        "POST",
        `/api/machines/${DEFAULT_MACHINE_ID}/isolate`,
        { Comment: "Containment", IsolationType: "Full" },
        token,
      );
      expect(isolate.status).toBe(201);
      expect(isolate.body).toMatchObject({
        type: "Isolate",
        status: "Pending",
        machineId: DEFAULT_MACHINE_ID,
        requestorComment: "Containment",
        scope: "Full",
      });
      const duplicate = await api(
        ctx.app,
        "POST",
        `/api/machines/${DEFAULT_MACHINE_ID}/isolate`,
        { Comment: "Again" },
        token,
      );
      expect(duplicate.status).toBe(400);
      expect(duplicate.body.error.code).toBe("ActiveRequestAlreadyExists");
      expect(
        (await api(ctx.app, "POST", `/api/machines/${DEFAULT_MACHINE_ID}/runAntiVirusScan`, {}, token)).status,
      ).toBe(400);
      const list = await api(
        ctx.app,
        "GET",
        `/api/machineactions?${new URLSearchParams({ $filter: `machineId eq '${DEFAULT_MACHINE_ID}'` }).toString()}`,
        undefined,
        token,
      );
      expect(list.body.value).toHaveLength(1);
      const cancelled = await api(
        ctx.app,
        "POST",
        `/api/machineactions/${isolate.body.id}/cancel`,
        { Comment: "False alarm" },
        token,
      );
      expect(cancelled.body).toMatchObject({ status: "Cancelled", cancellationComment: "False alarm" });
      expect(
        (await api(ctx.app, "POST", `/api/machineactions/${isolate.body.id}/cancel`, { Comment: "twice" }, token))
          .status,
      ).toBe(400);
      const fetched = await api(ctx.app, "GET", `/api/machineactions/${isolate.body.id}`, undefined, token);
      expect(fetched.body.status).toBe("Cancelled");
    });

    it("completes actions according to the configured delays", async () => {
      await ctx.app.request(`${defenderTestBaseUrl}/_defender/simulate/action-delays`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ in_progress_after_ms: 0, succeeded_after_ms: 0 }),
      });
      const scan = await api(
        ctx.app,
        "POST",
        `/api/machines/${DEFAULT_MACHINE_ID}/runAntiVirusScan`,
        { Comment: "Weekly", ScanType: "Full" },
        token,
      );
      expect(scan.body.status).toBe("Succeeded");
      const collect = await api(
        ctx.app,
        "POST",
        `/api/machines/${DEFAULT_MACHINE_ID}/collectInvestigationPackage`,
        { Comment: "Forensics" },
        token,
      );
      const uri = await api(ctx.app, "GET", `/api/machineactions/${collect.body.id}/getPackageUri`, undefined, token);
      expect(uri.body.value).toContain("/_defender/packages/");
      const download = await ctx.app.request(uri.body.value);
      expect(download.status).toBe(200);
      expect(download.headers.get("content-type")).toBe("application/zip");
      const offboard = await api(
        ctx.app,
        "POST",
        `/api/machines/${DEFAULT_MACHINE_ID}/offboard`,
        { Comment: "Decommissioned" },
        token,
      );
      expect(offboard.status).toBe(201);
      expect((await api(ctx.app, "GET", ONBOARDED_FILTER, undefined, token)).body.value).toHaveLength(2);
      const live = await api(
        ctx.app,
        "POST",
        `/api/machines/${DEFAULT_SERVER_MACHINE_ID}/runliveresponse`,
        {
          Comment: "Collect",
          Commands: [{ type: "RunScript", params: [{ key: "ScriptName", value: "collect.ps1" }] }],
        },
        token,
      );
      expect(live.body.commands[0].commandStatus).toBe("Completed");
      const link = await api(
        ctx.app,
        "GET",
        `/api/machineactions/${live.body.id}/GetLiveResponseResultDownloadLink?index=0`,
        undefined,
        token,
      );
      expect(((await (await ctx.app.request(link.body.value)).json()) as any).script_name).toBe("collect.ps1");
      const quarantine = await api(
        ctx.app,
        "POST",
        `/api/machines/${DEFAULT_SERVER_MACHINE_ID}/StopAndQuarantineFile`,
        { Comment: "Kill", Sha1: "3f786850e387550fdab836ed7e6dc881de23001b" },
        token,
      );
      expect(quarantine.body.relatedFileInfo).toEqual({
        fileIdentifier: "3f786850e387550fdab836ed7e6dc881de23001b",
        fileIdentifierType: "Sha1",
      });
    });
  });

  describe("alerts", () => {
    it("lists, filters, and updates alerts", async () => {
      const all = await api(ctx.app, "GET", "/api/alerts", undefined, token);
      expect(all.body.value).toHaveLength(2);
      const high = await api(
        ctx.app,
        "GET",
        `/api/alerts?${new URLSearchParams({ $filter: "severity eq 'High' and status ne 'Resolved'" }).toString()}`,
        undefined,
        token,
      );
      expect(high.body.value).toHaveLength(1);
      const alert = high.body.value[0];
      expect(alert).toMatchObject({
        title: "Suspicious PowerShell command line",
        machineId: DEFAULT_SERVER_MACHINE_ID,
        computerDnsName: "srv-files-01.contoso.local",
        mitreTechniques: ["T1059.001"],
      });
      expect(alert.evidence).toHaveLength(3);
      const updated = await api(
        ctx.app,
        "PATCH",
        `/api/alerts/${alert.id}`,
        {
          status: "Resolved",
          assignedTo: "analyst@contoso.com",
          classification: "TruePositive",
          determination: "Malware",
          comment: "Contained",
        },
        token,
      );
      expect(updated.body).toMatchObject({
        status: "Resolved",
        assignedTo: "analyst@contoso.com",
        classification: "TruePositive",
        determination: "Malware",
      });
      expect(updated.body.resolvedTime).not.toBeNull();
      expect(updated.body.comments[0]).toMatchObject({ comment: "Contained" });
      expect((await api(ctx.app, "PATCH", `/api/alerts/${alert.id}`, { status: "Bogus" }, token)).status).toBe(400);
      expect((await api(ctx.app, "PATCH", `/api/alerts/${alert.id}`, {}, token)).status).toBe(400);
      expect((await api(ctx.app, "GET", `/api/alerts/${alert.id}/machine`, undefined, token)).body.id).toBe(
        DEFAULT_SERVER_MACHINE_ID,
      );
      expect((await api(ctx.app, "GET", `/api/alerts/${alert.id}/files`, undefined, token)).body.value[0].sha1).toBe(
        "3f786850e387550fdab836ed7e6dc881de23001b",
      );
      expect((await api(ctx.app, "GET", `/api/alerts/${alert.id}/ips`, undefined, token)).body.value).toEqual([
        { id: "185.220.101.7" },
      ]);
      expect((await api(ctx.app, "GET", `/api/alerts/${alert.id}/domains`, undefined, token)).body.value).toEqual([
        { host: "malicious.example.net" },
      ]);
      expect((await api(ctx.app, "GET", `/api/alerts/${alert.id}/user`, undefined, token)).body.accountName).toBe(
        "svc-backup",
      );
    });

    it("creates alerts by reference and batch updates them", async () => {
      const created = await api(
        ctx.app,
        "POST",
        "/api/alerts/CreateAlertByReference",
        {
          machineId: DEFAULT_MACHINE_ID,
          severity: "Low",
          title: "Custom detection",
          description: "Created by API",
          recommendedAction: "Investigate",
          eventTime: "2026-09-01T10:00:00Z",
          reportId: "20279",
          category: "Exploit",
        },
        token,
      );
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({
        title: "Custom detection",
        severity: "Low",
        detectionSource: "CustomerTI",
        category: "Exploit",
        status: "New",
      });
      expect(
        (
          await api(
            ctx.app,
            "POST",
            "/api/alerts/CreateAlertByReference",
            { machineId: DEFAULT_MACHINE_ID, title: "x" },
            token,
          )
        ).status,
      ).toBe(400);
      const ids = (await api(ctx.app, "GET", "/api/alerts", undefined, token)).body.value.map((alert: any) => alert.id);
      const batch = await api(
        ctx.app,
        "POST",
        "/api/alerts/batchUpdate",
        { alertIds: ids, status: "InProgress", assignedTo: "soc@contoso.com" },
        token,
      );
      expect(
        batch.body.value.every((alert: any) => alert.status === "InProgress" && alert.assignedTo === "soc@contoso.com"),
      ).toBe(true);
      const events = (await (
        await ctx.app.request(`${defenderTestBaseUrl}/_defender/events?type=alert.updated`)
      ).json()) as any;
      expect(events.events.length).toBe(ids.length);
    });
  });

  describe("threat and vulnerability management", () => {
    it("exposes vulnerabilities, software, recommendations, and scores", async () => {
      const vulnerabilities = await api(
        ctx.app,
        "GET",
        `/api/vulnerabilities?${new URLSearchParams({ $filter: "severity eq 'Critical'" }).toString()}`,
        undefined,
        token,
      );
      expect(vulnerabilities.body.value).toEqual([
        expect.objectContaining({ id: "CVE-2024-38063", exposedMachines: 2, publicExploit: true }),
      ]);
      const references = await api(
        ctx.app,
        "GET",
        "/api/vulnerabilities/CVE-2024-38063/machineReferences",
        undefined,
        token,
      );
      expect(references.body.value.map((machine: any) => machine.id).sort()).toEqual(
        [DEFAULT_MACHINE_ID, DEFAULT_SERVER_MACHINE_ID].sort(),
      );
      const machineVulns = await api(ctx.app, "GET", "/api/vulnerabilities/machinesVulnerabilities", undefined, token);
      expect(
        machineVulns.body.value.find(
          (row: any) => row.machineId === DEFAULT_SERVER_MACHINE_ID && row.cveId === "CVE-2024-38063",
        ),
      ).toMatchObject({ fixingKbId: "5041160", productName: "Windows 10" });
      const software = await api(ctx.app, "GET", "/api/software/google-_-chrome", undefined, token);
      expect(software.body).toMatchObject({
        name: "Chrome",
        vendor: "Google",
        exposedMachines: 1,
        publicExploit: true,
      });
      expect(
        (await api(ctx.app, "GET", "/api/software/google-_-chrome/machineReferences", undefined, token)).body.value,
      ).toHaveLength(2);
      expect(
        (await api(ctx.app, "GET", "/api/software/google-_-chrome/vulnerabilities", undefined, token)).body.value[0].id,
      ).toBe("CVE-2024-4947");
      expect(
        (await api(ctx.app, "GET", "/api/software/google-_-chrome/distributions", undefined, token)).body.value,
      ).toHaveLength(2);
      const recommendation = await api(
        ctx.app,
        "GET",
        "/api/recommendations/va-_-microsoft-_-windows_10",
        undefined,
        token,
      );
      expect(recommendation.body).toMatchObject({
        recommendationName: "Update Windows 10",
        exposedMachinesCount: 2,
        totalMachineCount: 3,
        publicExploit: true,
      });
      expect(
        (
          await api(
            ctx.app,
            "GET",
            "/api/recommendations/va-_-microsoft-_-windows_10/vulnerabilities",
            undefined,
            token,
          )
        ).body.value,
      ).toHaveLength(2);
      expect(
        (await api(ctx.app, "GET", "/api/recommendations/va-_-microsoft-_-windows_10/software", undefined, token)).body
          .id,
      ).toBe("microsoft-_-windows_10");
      const exposure = await api(ctx.app, "GET", "/api/exposureScore", undefined, token);
      expect(exposure.body.score).toBeGreaterThan(0);
      const byGroup = await api(ctx.app, "GET", "/api/exposureScore/ByMachineGroups", undefined, token);
      expect(byGroup.body.value.map((row: any) => row.rbacGroupName).sort()).toEqual(["Servers", "Workstations"]);
      const configuration = await api(ctx.app, "GET", "/api/configurationScore", undefined, token);
      expect(configuration.body.score).toBe(90.5);
      expect((await api(ctx.app, "GET", "/api/vulnerabilities/CVE-0000-0000", undefined, token)).status).toBe(404);
    });
  });

  describe("indicators", () => {
    it("creates, upserts, imports, and deletes indicators", async () => {
      const seeded = await api(ctx.app, "GET", "/api/indicators", undefined, token);
      expect(seeded.body.value).toHaveLength(1);
      const created = await api(
        ctx.app,
        "POST",
        "/api/indicators",
        {
          indicatorValue: "220e7d15b011d7fac48f2bd61114db1022197f7f",
          indicatorType: "FileSha1",
          action: "AlertAndBlock",
          title: "Bad file",
          description: "Known dropper",
          severity: "High",
          expirationTime: "2030-01-01T00:00:00Z",
        },
        token,
      );
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({
        indicatorType: "FileSha1",
        action: "AlertAndBlock",
        generateAlert: true,
        createdBy: DEFAULT_CLIENT_ID,
      });
      const upserted = await api(
        ctx.app,
        "POST",
        "/api/indicators",
        {
          indicatorValue: "220e7d15b011d7fac48f2bd61114db1022197f7f",
          indicatorType: "FileSha1",
          action: "Allowed",
          title: "Bad file",
          description: "Now allowed",
        },
        token,
      );
      expect(upserted.status).toBe(200);
      expect(upserted.body.id).toBe(created.body.id);
      expect(upserted.body.action).toBe("Allowed");
      expect(
        (
          await api(
            ctx.app,
            "POST",
            "/api/indicators",
            { indicatorValue: "nothex", indicatorType: "FileSha1", action: "Block", title: "x", description: "y" },
            token,
          )
        ).status,
      ).toBe(400);
      const imported = await api(
        ctx.app,
        "POST",
        "/api/indicators/import",
        {
          Indicators: [
            {
              indicatorValue: "1.2.3.4",
              indicatorType: "IpAddress",
              action: "Audit",
              title: "Scanner",
              description: "Noisy scanner",
            },
            { indicatorValue: "", indicatorType: "Url", action: "Block", title: "x", description: "y" },
          ],
        },
        token,
      );
      expect(imported.body.value.map((row: any) => row.isFailed)).toEqual([false, true]);
      expect((await api(ctx.app, "GET", "/api/indicators", undefined, token)).body.value).toHaveLength(3);
      expect((await api(ctx.app, "DELETE", `/api/indicators/${created.body.id}`, undefined, token)).status).toBe(204);
      const bulk = await api(
        ctx.app,
        "DELETE",
        "/api/indicators",
        { IndicatorIds: [imported.body.value[0].id, "9999"] },
        token,
      );
      expect(bulk.body.value.map((row: any) => row.isFailed)).toEqual([false, true]);
      expect((await api(ctx.app, "GET", "/api/indicators", undefined, token)).body.value).toHaveLength(1);
    });
  });

  describe("advanced hunting", () => {
    it("runs a KQL subset over device and alert tables", async () => {
      const run = (Query: string) => api(ctx.app, "POST", "/api/advancedqueries/run", { Query }, token);
      const onboarded = await run(
        'DeviceInfo\n| where OnboardingStatus == "Onboarded"\n| summarize count() by OSPlatform\n| sort by count_ desc',
      );
      expect(onboarded.status).toBe(200);
      expect(onboarded.body.Schema).toEqual([
        { Name: "OSPlatform", Type: "String" },
        { Name: "count_", Type: "Int64" },
      ]);
      expect(onboarded.body.Results).toEqual([
        { OSPlatform: "Windows11", count_: 1 },
        { OSPlatform: "WindowsServer2022", count_: 1 },
        { OSPlatform: "macOS", count_: 1 },
      ]);
      const alerts = await run('AlertInfo | where Severity == "High" | project AlertId, Title | take 5');
      expect(alerts.body.Results).toEqual([
        { AlertId: expect.any(String), Title: "Suspicious PowerShell command line" },
      ]);
      const vulnerable = await run('DeviceTvmSoftwareVulnerabilities | where CveId has "2024" | distinct DeviceName');
      expect(vulnerable.body.Results).toHaveLength(2);
      const recent = await run("DeviceInfo | where Timestamp > ago(7d) | count");
      expect(recent.body.Results).toEqual([{ Count: 3 }]);
      const invalid = await run("NoSuchTable | take 1");
      expect(invalid.status).toBe(400);
      expect(invalid.body.error.code).toBe("SemanticError");
      expect(
        (await api(ctx.app, "GET", "/api/advancedqueries/schema", undefined, token)).body.value.map(
          (table: any) => table.Name,
        ),
      ).toContain("DeviceInfo");
    });
  });

  describe("entities, simulation, and inspector", () => {
    it("exposes domain, file, ip, and user entity routes", async () => {
      expect(
        (await api(ctx.app, "GET", "/api/domains/malicious.example.net/alerts", undefined, token)).body.value,
      ).toHaveLength(1);
      expect(
        (await api(ctx.app, "GET", "/api/domains/malicious.example.net/machines", undefined, token)).body.value[0].id,
      ).toBe(DEFAULT_SERVER_MACHINE_ID);
      expect(
        (await api(ctx.app, "GET", "/api/domains/malicious.example.net/stats", undefined, token)).body
          .organizationPrevalence,
      ).toBe(1);
      const file = await api(ctx.app, "GET", "/api/files/3f786850e387550fdab836ed7e6dc881de23001b", undefined, token);
      expect(file.body.isPeFile).toBe(true);
      expect(
        (await api(ctx.app, "GET", "/api/files/3f786850e387550fdab836ed7e6dc881de23001b/stats", undefined, token)).body
          .topFileNames,
      ).toEqual(["powershell.exe"]);
      expect((await api(ctx.app, "GET", "/api/ips/185.220.101.7/alerts", undefined, token)).body.value).toHaveLength(1);
      expect((await api(ctx.app, "GET", "/api/users/CONTOSO%5Cbob/machines", undefined, token)).body.value[0].id).toBe(
        DEFAULT_SERVER_MACHINE_ID,
      );
      expect((await api(ctx.app, "GET", "/api/users/svc-backup/alerts", undefined, token)).body.value).toHaveLength(1);
      expect(
        (await api(ctx.app, "GET", "/api/machinegroups", undefined, token)).body.value
          .map((group: any) => group.name)
          .sort(),
      ).toEqual(["Servers", "Workstations"]);
    });

    it("simulates alerts and machine check-ins and serves the inspector", async () => {
      const simulated = await ctx.app.request(`${defenderTestBaseUrl}/_defender/simulate/alert`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          machineId: "mbp-carol.contoso.local",
          title: "Suspicious login",
          severity: "Low",
          evidence: [{ entityType: "Ip", ipAddress: "8.8.8.8" }],
        }),
      });
      expect(simulated.status).toBe(201);
      const alerts = await api(
        ctx.app,
        "GET",
        `/api/alerts?${new URLSearchParams({ $filter: "computerDnsName eq 'mbp-carol.contoso.local'" }).toString()}`,
        undefined,
        token,
      );
      expect(alerts.body.value[0]).toMatchObject({ title: "Suspicious login", severity: "Low" });
      const seen = await ctx.app.request(`${defenderTestBaseUrl}/_defender/simulate/machine`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          machineId: DEFAULT_OFFBOARDED_MACHINE_ID,
          onboardingStatus: "Onboarded",
          healthStatus: "Active",
        }),
      });
      expect(seen.status).toBe(200);
      expect((await api(ctx.app, "GET", ONBOARDED_FILTER, undefined, token)).body.value).toHaveLength(4);
      expect((await api(ctx.app, "GET", "/api", undefined, token)).body.tenant.name).toBe("Contoso");
      for (const tab of ["machines", "alerts", "actions", "tvm", "indicators", "tenants", "events", "auth"]) {
        const page = await ctx.app.request(`${defenderTestBaseUrl}/?tab=${tab}`);
        expect(page.status).toBe(200);
        expect(await page.text()).toContain("Defender for Endpoint");
      }
      const cleared = await ctx.app.request(`${defenderTestBaseUrl}/_defender/events`, { method: "DELETE" });
      expect(cleared.status).toBe(200);
    });

    it("seeds custom tenants without defaults", async () => {
      const bare = createDefenderTestApp(
        {
          apps: [{ client_id: "acb57369-de24-4642-8890-5f09746d18d7", client_secret: "secret" }],
          tenants: [
            {
              id: "11111111-1111-4111-8111-111111111111",
              name: "Customer A",
              machines: [{ computerDnsName: "a-1" }, { computerDnsName: "a-2", onboardingStatus: "InsufficientInfo" }],
            },
            {
              id: "22222222-2222-4222-8222-222222222222",
              name: "Customer B",
              machines: [{ computerDnsName: "b-1", osPlatform: "Ubuntu", version: "24.4" }],
            },
          ],
        },
        false,
      );
      const ds = getDefStore(bare.store);
      expect(ds.machines.count()).toBe(3);
      const tokenA = (
        await requestToken(
          bare.app,
          "11111111-1111-4111-8111-111111111111",
          "acb57369-de24-4642-8890-5f09746d18d7",
          "secret",
        )
      ).body.access_token;
      const tokenB = (
        await requestToken(
          bare.app,
          "22222222-2222-4222-8222-222222222222",
          "acb57369-de24-4642-8890-5f09746d18d7",
          "secret",
        )
      ).body.access_token;
      expect((await api(bare.app, "GET", ONBOARDED_FILTER, undefined, tokenA)).body.value).toHaveLength(1);
      expect((await api(bare.app, "GET", ONBOARDED_FILTER, undefined, tokenB)).body.value[0]).toMatchObject({
        computerDnsName: "b-1",
        osPlatform: "Ubuntu",
        version: "24.4",
        osBuild: null,
      });
    });
  });
});
