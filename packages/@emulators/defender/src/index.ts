import type { AppEnv, Hono, ServicePlugin, Store, TokenMap, WebhookDispatcher } from "@emulators/core";
import type {
  AlertSeverity,
  AlertStatus,
  DefAlertEvidence,
  DefMachine,
  DeviceValue,
  ExposureLevel,
  HealthStatus,
  IndicatorAction,
  IndicatorType,
  OnboardingStatus,
  RiskScore,
} from "./entities.js";
import type { Fmt } from "./formatters.js";
import { guid, machineId as newMachineId, nowIso, shortHex } from "./helpers.js";
import { actionRoutes } from "./routes/actions.js";
import { alertRoutes, createAlert } from "./routes/alerts.js";
import { authRoutes } from "./routes/auth.js";
import { huntingRoutes } from "./routes/hunting.js";
import { indicatorRoutes, upsertIndicator } from "./routes/indicators.js";
import { inspectorRoutes } from "./routes/inspector.js";
import { machineRoutes } from "./routes/machines.js";
import { miscRoutes } from "./routes/misc.js";
import { tvmRoutes } from "./routes/tvm.js";
import type { DefRouteContext } from "./route-utils.js";
import { getDefStore, setActionDelays, type DefStore } from "./store.js";

export { getDefStore, type DefStore } from "./store.js";
export * from "./entities.js";
export { parseFilter, applyOData } from "./odata.js";
export { runHuntingQuery } from "./routes/hunting.js";
export { createAlert, type CreateAlertInput } from "./routes/alerts.js";

export interface DefenderSeedMachine {
  id?: string;
  computerDnsName: string;
  osPlatform?: string;
  osVersion?: string;
  version?: string;
  osBuild?: number | null;
  osProcessor?: string;
  osArchitecture?: string;
  onboardingStatus?: OnboardingStatus;
  healthStatus?: HealthStatus;
  riskScore?: RiskScore;
  exposureLevel?: ExposureLevel;
  deviceValue?: DeviceValue;
  rbacGroupId?: number;
  rbacGroupName?: string | null;
  lastSeen?: string;
  firstSeen?: string;
  lastIpAddress?: string;
  lastExternalIpAddress?: string;
  agentVersion?: string;
  machineTags?: string[];
  isAadJoined?: boolean;
  aadDeviceId?: string | null;
  defenderAvStatus?: string;
  managedBy?: string;
  isolated?: boolean;
  logonUsers?: Array<{ accountName: string; accountDomain?: string; isDomainAdmin?: boolean; logonTypes?: string }>;
  software?: Array<{ id: string; version?: string }>;
  vulnerabilities?: Array<{ cve: string; software?: string; fixingKbId?: string; productVersion?: string }>;
}

export interface DefenderSeedAlert {
  machine: string;
  title: string;
  description?: string;
  severity?: AlertSeverity;
  status?: AlertStatus;
  category?: string;
  detectionSource?: string;
  threatName?: string;
  threatFamilyName?: string;
  mitreTechniques?: string[];
  eventTime?: string;
  relatedUser?: { userName: string; domainName: string };
  evidence?: Array<Partial<DefAlertEvidence>>;
}

export interface DefenderSeedTenant {
  id?: string;
  name: string;
  machines?: DefenderSeedMachine[];
  alerts?: DefenderSeedAlert[];
  vulnerabilities?: Array<{
    cve: string;
    name?: string;
    description?: string;
    severity?: "Low" | "Medium" | "High" | "Critical";
    cvssV3?: number;
    publishedOn?: string;
    publicExploit?: boolean;
    exploitVerified?: boolean;
    tags?: string[];
  }>;
  software?: Array<{
    id: string;
    name: string;
    vendor?: string;
    weaknesses?: number;
    publicExploit?: boolean;
    impactScore?: number;
  }>;
  recommendations?: Array<{
    id?: string;
    name: string;
    productName?: string;
    category?: string;
    subCategory?: string;
    severityScore?: number;
    remediationType?: string;
    software?: string;
    cves?: string[];
    configScoreImpact?: number;
    exposureImpact?: number;
  }>;
  indicators?: Array<{
    value: string;
    type: IndicatorType;
    action: IndicatorAction;
    title: string;
    description: string;
    severity?: AlertSeverity;
    expirationTime?: string;
  }>;
}

export interface DefenderSeedConfig {
  port?: number;
  baseUrl?: string;
  apps?: Array<{ client_id: string; client_secret: string; name?: string; tenant_ids?: string[]; roles?: string[] }>;
  tenants?: DefenderSeedTenant[];
  action_delays?: { in_progress_after_ms?: number; succeeded_after_ms?: number };
}

export const DEFAULT_CLIENT_ID = "00000000-0000-4000-8000-00000000c1e0";
export const DEFAULT_CLIENT_SECRET = "test_emulate_defender_client_secret";
export const DEFAULT_TENANT_ID = "00000000-0000-4000-8000-0000000000de";
export const DEFAULT_TENANT_NAME = "Contoso";
export const DEFAULT_SECOND_TENANT_ID = "00000000-0000-4000-8000-0000000001de";
export const DEFAULT_SECOND_TENANT_NAME = "Fabrikam";
export const DEFAULT_MACHINE_ID = "4899036531e374137f63289c3267bad772c13fef";
export const DEFAULT_SERVER_MACHINE_ID = "7f1c3a4b2e5d6c8f9a0b1c2d3e4f5a6b7c8d9e0f";
export const DEFAULT_MAC_MACHINE_ID = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
export const DEFAULT_OFFBOARDED_MACHINE_ID = "0f9e8d7c6b5a49382716051423344556677889aa";

export const DEFAULT_SEED: DefenderSeedConfig = {
  apps: [{ client_id: DEFAULT_CLIENT_ID, client_secret: DEFAULT_CLIENT_SECRET, name: "Emulate Defender app" }],
  tenants: [
    {
      id: DEFAULT_TENANT_ID,
      name: DEFAULT_TENANT_NAME,
      software: [
        { id: "microsoft-_-windows_10", name: "Windows 10", vendor: "Microsoft", weaknesses: 12, impactScore: 3.2 },
        {
          id: "microsoft-_-edge_chromium-based",
          name: "Edge Chromium-based",
          vendor: "Microsoft",
          weaknesses: 4,
          impactScore: 1.1,
        },
        {
          id: "google-_-chrome",
          name: "Chrome",
          vendor: "Google",
          weaknesses: 7,
          publicExploit: true,
          impactScore: 2.4,
        },
      ],
      vulnerabilities: [
        {
          cve: "CVE-2024-38063",
          name: "Windows TCP/IP Remote Code Execution Vulnerability",
          severity: "Critical",
          cvssV3: 9.8,
          publishedOn: "2024-08-13T00:00:00Z",
          publicExploit: true,
          tags: ["ZeroDay"],
        },
        {
          cve: "CVE-2024-4947",
          name: "Google Chrome V8 Type Confusion",
          severity: "High",
          cvssV3: 8.8,
          publishedOn: "2024-05-15T00:00:00Z",
          publicExploit: true,
          exploitVerified: true,
        },
        {
          cve: "CVE-2023-36049",
          name: ".NET and Visual Studio Elevation of Privilege",
          severity: "Medium",
          cvssV3: 6.5,
          publishedOn: "2023-11-14T00:00:00Z",
        },
      ],
      recommendations: [
        {
          id: "va-_-microsoft-_-windows_10",
          name: "Update Windows 10",
          productName: "Windows 10",
          category: "Software update",
          subCategory: "Application",
          severityScore: 8.5,
          remediationType: "Update",
          software: "microsoft-_-windows_10",
          cves: ["CVE-2024-38063", "CVE-2023-36049"],
          exposureImpact: 3.1,
        },
        {
          id: "va-_-google-_-chrome",
          name: "Update Chrome",
          productName: "Chrome",
          category: "Software update",
          subCategory: "Application",
          severityScore: 7.2,
          remediationType: "Update",
          software: "google-_-chrome",
          cves: ["CVE-2024-4947"],
          exposureImpact: 1.8,
        },
        {
          id: "sca-_-asr_block_office_child_processes",
          name: "Block Office applications from creating child processes",
          productName: "Attack surface reduction",
          category: "Security controls",
          subCategory: "Attack surface reduction",
          severityScore: 6.0,
          remediationType: "ConfigurationChange",
          configScoreImpact: 9.5,
        },
      ],
      machines: [
        {
          id: DEFAULT_MACHINE_ID,
          computerDnsName: "desktop-01.contoso.local",
          osPlatform: "Windows11",
          version: "23H2",
          osBuild: 22631,
          onboardingStatus: "Onboarded",
          healthStatus: "Active",
          riskScore: "Medium",
          exposureLevel: "Medium",
          rbacGroupId: 1,
          rbacGroupName: "Workstations",
          lastIpAddress: "10.0.0.21",
          machineTags: ["finance", "laptop"],
          isAadJoined: true,
          logonUsers: [{ accountName: "alice", accountDomain: "CONTOSO", isDomainAdmin: false }],
          software: [
            { id: "microsoft-_-windows_10", version: "10.0.22631.3447" },
            { id: "microsoft-_-edge_chromium-based", version: "124.0.2478.51" },
            { id: "google-_-chrome", version: "124.0.6367.60" },
          ],
          vulnerabilities: [
            {
              cve: "CVE-2024-38063",
              software: "microsoft-_-windows_10",
              fixingKbId: "5041585",
              productVersion: "10.0.22631.3447",
            },
            { cve: "CVE-2024-4947", software: "google-_-chrome", productVersion: "124.0.6367.60" },
          ],
        },
        {
          id: DEFAULT_SERVER_MACHINE_ID,
          computerDnsName: "srv-files-01.contoso.local",
          osPlatform: "WindowsServer2022",
          version: "21H2",
          osBuild: 20348,
          onboardingStatus: "Onboarded",
          healthStatus: "Active",
          riskScore: "High",
          exposureLevel: "High",
          rbacGroupId: 2,
          rbacGroupName: "Servers",
          lastIpAddress: "10.0.1.10",
          machineTags: ["server", "file-share"],
          logonUsers: [
            { accountName: "svc-backup", accountDomain: "CONTOSO", isDomainAdmin: true, logonTypes: "Batch" },
            { accountName: "bob", accountDomain: "CONTOSO" },
          ],
          software: [{ id: "microsoft-_-windows_10", version: "10.0.20348.2402" }],
          vulnerabilities: [
            {
              cve: "CVE-2024-38063",
              software: "microsoft-_-windows_10",
              fixingKbId: "5041160",
              productVersion: "10.0.20348.2402",
            },
            { cve: "CVE-2023-36049", software: "microsoft-_-windows_10", productVersion: "10.0.20348.2402" },
          ],
        },
        {
          id: DEFAULT_MAC_MACHINE_ID,
          computerDnsName: "mbp-carol.contoso.local",
          osPlatform: "macOS",
          version: "14.4.1",
          osBuild: null,
          osProcessor: "arm64",
          osArchitecture: "arm64",
          onboardingStatus: "Onboarded",
          healthStatus: "Active",
          riskScore: "None",
          exposureLevel: "Low",
          rbacGroupId: 1,
          rbacGroupName: "Workstations",
          lastIpAddress: "10.0.0.45",
          machineTags: ["engineering", "laptop"],
          logonUsers: [{ accountName: "carol", accountDomain: "CONTOSO" }],
          software: [{ id: "google-_-chrome", version: "124.0.6367.79" }],
        },
        {
          id: DEFAULT_OFFBOARDED_MACHINE_ID,
          computerDnsName: "old-kiosk-07.contoso.local",
          osPlatform: "Windows10",
          version: "21H2",
          osBuild: 19044,
          onboardingStatus: "CanBeOnboarded",
          healthStatus: "Inactive",
          riskScore: "None",
          exposureLevel: "None",
          rbacGroupId: 1,
          rbacGroupName: "Workstations",
          lastIpAddress: "10.0.0.90",
          lastSeen: "2026-01-15T08:30:00.000Z",
        },
      ],
      alerts: [
        {
          machine: DEFAULT_SERVER_MACHINE_ID,
          title: "Suspicious PowerShell command line",
          description: "A PowerShell process launched with an encoded command line typical of malware droppers.",
          severity: "High",
          category: "Execution",
          threatName: "Trojan:PowerShell/Nemucod",
          mitreTechniques: ["T1059.001"],
          relatedUser: { userName: "svc-backup", domainName: "CONTOSO" },
          evidence: [
            {
              entityType: "Process",
              fileName: "powershell.exe",
              filePath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0",
              processId: 4412,
              processCommandLine: "powershell.exe -nop -w hidden -enc SQBFAFgA",
              sha1: "3f786850e387550fdab836ed7e6dc881de23001b",
              sha256: "8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4",
              accountName: "svc-backup",
              domainName: "CONTOSO",
            },
            { entityType: "Ip", ipAddress: "185.220.101.7" },
            { entityType: "Url", url: "http://malicious.example.net/payload.ps1", domainName: "malicious.example.net" },
          ],
        },
        {
          machine: DEFAULT_MACHINE_ID,
          title: "Malware was detected and blocked",
          description: "Microsoft Defender Antivirus blocked a known malicious file.",
          severity: "Medium",
          status: "Resolved",
          category: "Malware",
          detectionSource: "WindowsDefenderAv",
          threatName: "Trojan:Win32/Wacatac.B!ml",
          threatFamilyName: "Wacatac",
          relatedUser: { userName: "alice", domainName: "CONTOSO" },
          evidence: [
            {
              entityType: "File",
              fileName: "invoice_2024.exe",
              filePath: "C:\\Users\\alice\\Downloads",
              sha1: "da39a3ee5e6b4b0d3255bfef95601890afd80709",
              sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
              detectionStatus: "Blocked",
            },
          ],
        },
      ],
      indicators: [
        {
          value: "malicious.example.net",
          type: "DomainName",
          action: "Block",
          title: "Known C2 domain",
          description: "Command and control domain observed in the PowerShell campaign.",
          severity: "High",
        },
      ],
    },
    {
      id: DEFAULT_SECOND_TENANT_ID,
      name: DEFAULT_SECOND_TENANT_NAME,
      machines: [
        {
          computerDnsName: "fab-ws-01.fabrikam.local",
          osPlatform: "Windows11",
          version: "24H2",
          osBuild: 26100,
          rbacGroupId: 1,
          rbacGroupName: "Workstations",
          lastIpAddress: "192.168.10.11",
          logonUsers: [{ accountName: "dave", accountDomain: "FABRIKAM" }],
        },
        {
          computerDnsName: "fab-ubuntu-01.fabrikam.local",
          osPlatform: "Ubuntu",
          version: "22.4",
          osBuild: null,
          osProcessor: "x64",
          rbacGroupId: 2,
          rbacGroupName: "Servers",
          lastIpAddress: "192.168.10.50",
          healthStatus: "Active",
        },
      ],
    },
  ],
};

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function ipToMac(ip: string): string {
  const parts = ip.split(".").map((part) => Number(part) || 0);
  return `00-15-5D-${pad(parts[1] ?? 0)
    .slice(-2)
    .toUpperCase()}-${(parts[2] ?? 0).toString(16).padStart(2, "0").toUpperCase()}-${(parts[3] ?? 0).toString(16).padStart(2, "0").toUpperCase()}`;
}

function seedMachine(ds: DefStore, tenantId: string, entry: DefenderSeedMachine): DefMachine | undefined {
  const existing =
    (entry.id && ds.machines.findBy("machine_id", entry.id).find((candidate) => candidate.tenant_id === tenantId)) ||
    ds.machines.findBy("computerDnsName", entry.computerDnsName).find((candidate) => candidate.tenant_id === tenantId);
  if (existing) return existing;
  const now = nowIso();
  const lastIp =
    entry.lastIpAddress ?? `10.0.${Math.floor(ds.machines.count() / 250)}.${(ds.machines.count() % 250) + 2}`;
  const osPlatform = entry.osPlatform ?? "Windows11";
  const machine = ds.machines.insert({
    tenant_id: tenantId,
    machine_id: entry.id ?? newMachineId(),
    computerDnsName: entry.computerDnsName,
    firstSeen: entry.firstSeen ?? new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString(),
    lastSeen: entry.lastSeen ?? now,
    osPlatform,
    osVersion: entry.osVersion ?? null,
    osProcessor: entry.osProcessor ?? "x64",
    version: entry.version ?? "Other",
    lastIpAddress: lastIp,
    lastExternalIpAddress: entry.lastExternalIpAddress ?? "203.0.113.24",
    agentVersion: entry.agentVersion ?? "10.8760.26100.2894",
    osBuild: entry.osBuild === undefined ? null : entry.osBuild,
    healthStatus: entry.healthStatus ?? "Active",
    deviceValue: entry.deviceValue ?? "Normal",
    rbacGroupId: entry.rbacGroupId ?? 0,
    rbacGroupName: entry.rbacGroupName === undefined ? null : entry.rbacGroupName,
    riskScore: entry.riskScore ?? "None",
    exposureLevel: entry.exposureLevel ?? "Low",
    isAadJoined: entry.isAadJoined ?? false,
    aadDeviceId: entry.aadDeviceId ?? (entry.isAadJoined ? guid() : null),
    machineTags: entry.machineTags ?? [],
    defenderAvStatus:
      entry.defenderAvStatus ?? (osPlatform.toLowerCase().includes("windows") ? "Updated" : "NotSupported"),
    onboardingStatus: entry.onboardingStatus ?? "Onboarded",
    osArchitecture: entry.osArchitecture ?? "64-bit",
    managedBy: entry.managedBy ?? (entry.isAadJoined ? "Intune" : "Unknown"),
    managedByStatus: entry.isAadJoined ? "Success" : "Unknown",
    ipAddresses: [{ ipAddress: lastIp, macAddress: ipToMac(lastIp), type: "Ethernet", operationalStatus: "Up" }],
    vmMetadata: null,
    isolated: entry.isolated ?? false,
    code_execution_restricted: false,
    isExcluded: false,
    exclusionReason: null,
  });
  for (const user of entry.logonUsers ?? []) {
    ds.logonUsers.insert({
      tenant_id: tenantId,
      machine_id: machine.machine_id,
      user_id: `${user.accountDomain ?? "WORKGROUP"}\\${user.accountName}`,
      accountName: user.accountName,
      accountDomain: user.accountDomain ?? "WORKGROUP",
      accountSid: `S-1-5-21-${shortHex(9).replace(/[a-f]/g, "1")}-${1000 + ds.logonUsers.count()}`,
      firstSeen: machine.firstSeen,
      lastSeen: machine.lastSeen,
      logonTypes: user.logonTypes ?? "Interactive",
      logOnMachinesCount: 1,
      isDomainAdmin: user.isDomainAdmin ?? false,
      isOnlyNetworkUser: false,
    });
  }
  for (const software of entry.software ?? []) {
    if (!ds.software.findBy("software_id", software.id).some((candidate) => candidate.tenant_id === tenantId)) {
      const [vendor, name] = software.id.includes("-_-") ? software.id.split("-_-") : ["Unknown", software.id];
      ds.software.insert({
        tenant_id: tenantId,
        software_id: software.id,
        name: name.replace(/_/g, " "),
        vendor: vendor.replace(/_/g, " "),
        weaknesses: 0,
        publicExploit: false,
        activeAlert: false,
        exposedMachines: 0,
        impactScore: 0,
      });
    }
    ds.machineSoftware.insert({
      tenant_id: tenantId,
      machine_id: machine.machine_id,
      software_id: software.id,
      version: software.version ?? "1.0.0",
      installed_on: machine.firstSeen,
    });
  }
  for (const vulnerability of entry.vulnerabilities ?? []) {
    if (!ds.vulnerabilities.findBy("cve_id", vulnerability.cve).some((candidate) => candidate.tenant_id === tenantId)) {
      ds.vulnerabilities.insert({
        tenant_id: tenantId,
        cve_id: vulnerability.cve,
        name: vulnerability.cve,
        description: "",
        severity: "Medium",
        cvssV3: 5.0,
        cvssVector: null,
        exposedMachines: 0,
        publishedOn: now,
        updatedOn: now,
        firstDetected: now,
        publicExploit: false,
        exploitVerified: false,
        exploitInKit: false,
        exploitTypes: [],
        exploitUris: [],
        cveSupportability: "Supported",
        tags: [],
        epss: null,
      });
    }
    ds.machineVulnerabilities.insert({
      tenant_id: tenantId,
      machine_id: machine.machine_id,
      cve_id: vulnerability.cve,
      software_id: vulnerability.software ?? null,
      fixing_kb_id: vulnerability.fixingKbId ?? null,
      product_version: vulnerability.productVersion ?? null,
    });
  }
  return machine;
}

function refreshCounts(ds: DefStore, tenantId: string): void {
  for (const vulnerability of ds.vulnerabilities.findBy("tenant_id", tenantId)) {
    const exposed = new Set(
      ds.machineVulnerabilities
        .findBy("cve_id", vulnerability.cve_id)
        .filter((link) => link.tenant_id === tenantId)
        .map((link) => link.machine_id),
    ).size;
    if (exposed !== vulnerability.exposedMachines)
      ds.vulnerabilities.update(vulnerability.id, { exposedMachines: exposed });
  }
  for (const software of ds.software.findBy("tenant_id", tenantId)) {
    const links = ds.machineVulnerabilities
      .findBy("tenant_id", tenantId)
      .filter((link) => link.software_id === software.software_id);
    const exposed = new Set(links.map((link) => link.machine_id)).size;
    const weaknesses = Math.max(software.weaknesses, new Set(links.map((link) => link.cve_id)).size);
    if (exposed !== software.exposedMachines || weaknesses !== software.weaknesses)
      ds.software.update(software.id, { exposedMachines: exposed, weaknesses });
  }
  const total = ds.machines
    .findBy("tenant_id", tenantId)
    .filter((machine) => machine.onboardingStatus === "Onboarded").length;
  for (const recommendation of ds.recommendations.findBy("tenant_id", tenantId)) {
    const machineIds = new Set<string>();
    if (recommendation.software_id)
      for (const link of ds.machineSoftware.findBy("software_id", recommendation.software_id))
        if (link.tenant_id === tenantId) machineIds.add(link.machine_id);
    for (const cve of recommendation.cve_ids)
      for (const link of ds.machineVulnerabilities.findBy("cve_id", cve))
        if (link.tenant_id === tenantId) machineIds.add(link.machine_id);
    const exposed = recommendation.recommendationCategory === "Security controls" ? total : machineIds.size;
    if (exposed !== recommendation.exposedMachinesCount || total !== recommendation.totalMachineCount)
      ds.recommendations.update(recommendation.id, { exposedMachinesCount: exposed, totalMachineCount: total });
  }
}

export function seedFromConfig(
  store: Store,
  _baseUrl: string,
  config: DefenderSeedConfig,
  _webhooks?: WebhookDispatcher,
): void {
  const ds = getDefStore(store);
  if (config.action_delays) {
    const current = { in_progress_after_ms: 1000, succeeded_after_ms: 3000 };
    setActionDelays(ds, {
      in_progress_after_ms: config.action_delays.in_progress_after_ms ?? current.in_progress_after_ms,
      succeeded_after_ms: config.action_delays.succeeded_after_ms ?? current.succeeded_after_ms,
    });
  }

  for (const entry of config.apps ?? []) {
    if (!entry.client_id || ds.apps.findOneBy("client_id", entry.client_id)) continue;
    ds.apps.insert({
      client_id: entry.client_id,
      client_secret: entry.client_secret,
      name: entry.name ?? entry.client_id,
      tenant_ids: entry.tenant_ids ?? null,
      roles: entry.roles ?? [],
    });
  }
  if (ds.apps.count() === 0)
    ds.apps.insert({
      client_id: DEFAULT_CLIENT_ID,
      client_secret: DEFAULT_CLIENT_SECRET,
      name: "Emulate Defender app",
      tenant_ids: null,
      roles: [],
    });

  for (const entry of config.tenants ?? []) {
    const tenant =
      (entry.id && ds.tenants.findOneBy("tenant_id", entry.id)) ||
      ds.tenants.all().find((candidate) => candidate.name.toLowerCase() === entry.name.toLowerCase()) ||
      ds.tenants.insert({ tenant_id: entry.id ?? guid(), name: entry.name });
    const tenantId = tenant.tenant_id;
    const now = nowIso();
    for (const software of entry.software ?? []) {
      const existing = ds.software
        .findBy("software_id", software.id)
        .find((candidate) => candidate.tenant_id === tenantId);
      const fields = {
        name: software.name,
        vendor: software.vendor ?? "Unknown",
        weaknesses: software.weaknesses ?? 0,
        publicExploit: software.publicExploit ?? false,
        activeAlert: false,
        impactScore: software.impactScore ?? 0,
      };
      if (existing) ds.software.update(existing.id, fields);
      else ds.software.insert({ tenant_id: tenantId, software_id: software.id, exposedMachines: 0, ...fields });
    }
    for (const vulnerability of entry.vulnerabilities ?? []) {
      const existing = ds.vulnerabilities
        .findBy("cve_id", vulnerability.cve)
        .find((candidate) => candidate.tenant_id === tenantId);
      const fields = {
        name: vulnerability.name ?? vulnerability.cve,
        description: vulnerability.description ?? vulnerability.name ?? "",
        severity: vulnerability.severity ?? "Medium",
        cvssV3: vulnerability.cvssV3 ?? 5.0,
        cvssVector: null,
        publishedOn: vulnerability.publishedOn ?? now,
        updatedOn: now,
        publicExploit: vulnerability.publicExploit ?? false,
        exploitVerified: vulnerability.exploitVerified ?? false,
        exploitInKit: false,
        exploitTypes: vulnerability.publicExploit ? ["PrivilegeEscalation"] : [],
        exploitUris: [],
        cveSupportability: "Supported",
        tags: vulnerability.tags ?? [],
        epss: null,
      };
      if (existing) ds.vulnerabilities.update(existing.id, fields);
      else
        ds.vulnerabilities.insert({
          tenant_id: tenantId,
          cve_id: vulnerability.cve,
          exposedMachines: 0,
          firstDetected: now,
          ...fields,
        });
    }
    for (const machine of entry.machines ?? []) seedMachine(ds, tenantId, machine);
    for (const recommendation of entry.recommendations ?? []) {
      const recommendationId =
        recommendation.id ?? `va-_-${recommendation.name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
      if (
        ds.recommendations
          .findBy("recommendation_id", recommendationId)
          .some((candidate) => candidate.tenant_id === tenantId)
      )
        continue;
      const software = recommendation.software
        ? ds.software
            .findBy("software_id", recommendation.software)
            .find((candidate) => candidate.tenant_id === tenantId)
        : undefined;
      ds.recommendations.insert({
        tenant_id: tenantId,
        recommendation_id: recommendationId,
        productName: recommendation.productName ?? software?.name ?? recommendation.name,
        recommendationName: recommendation.name,
        weaknesses: recommendation.cves?.length ?? 0,
        vendor: software?.vendor ?? "Microsoft",
        recommendedVersion: "",
        recommendedVendor: "",
        recommendedProgram: "",
        recommendationCategory: recommendation.category ?? "Software update",
        subCategory: recommendation.subCategory ?? "",
        severityScore: recommendation.severityScore ?? 5,
        publicExploit: (recommendation.cves ?? []).some((cve) =>
          ds.vulnerabilities
            .findBy("cve_id", cve)
            .some((candidate) => candidate.tenant_id === tenantId && candidate.publicExploit),
        ),
        activeAlert: false,
        associatedThreats: [],
        remediationType: recommendation.remediationType ?? "Update",
        status: "Active",
        configScoreImpact: recommendation.configScoreImpact ?? 0,
        exposureImpact: recommendation.exposureImpact ?? 0,
        totalMachineCount: 0,
        exposedMachinesCount: 0,
        nonProductivityImpactedAssets: 0,
        relatedComponent: software?.name ?? recommendation.name,
        software_id: software?.software_id ?? null,
        cve_ids: recommendation.cves ?? [],
      });
    }
    for (const alert of entry.alerts ?? []) {
      const machine =
        ds.machines.findBy("machine_id", alert.machine).find((candidate) => candidate.tenant_id === tenantId) ??
        ds.machines.findBy("computerDnsName", alert.machine).find((candidate) => candidate.tenant_id === tenantId);
      if (!machine) continue;
      if (
        ds.alerts
          .findBy("machine_id", machine.machine_id)
          .some((candidate) => candidate.tenant_id === tenantId && candidate.title === alert.title)
      )
        continue;
      createAlert(ds, {
        tenantId,
        machineId: machine.machine_id,
        title: alert.title,
        description: alert.description,
        severity: alert.severity,
        status: alert.status,
        category: alert.category,
        detectionSource: alert.detectionSource,
        threatName: alert.threatName ?? null,
        threatFamilyName: alert.threatFamilyName ?? null,
        mitreTechniques: alert.mitreTechniques,
        eventTime: alert.eventTime,
        relatedUser: alert.relatedUser ?? null,
        evidence: alert.evidence,
      });
    }
    for (const indicator of entry.indicators ?? []) {
      upsertIndicator(ds, {
        tenantId,
        clientId: ds.apps.all()[0]?.client_id ?? DEFAULT_CLIENT_ID,
        body: {
          indicatorValue: indicator.value,
          indicatorType: indicator.type,
          action: indicator.action,
          title: indicator.title,
          description: indicator.description,
          severity: indicator.severity,
          expirationTime: indicator.expirationTime,
          source: "Seed",
        },
      });
    }
    refreshCounts(ds, tenantId);
  }
  if (ds.tenants.count() === 0) ds.tenants.insert({ tenant_id: DEFAULT_TENANT_ID, name: DEFAULT_TENANT_NAME });
}

export const defenderPlugin: ServicePlugin = {
  name: "defender",
  register(app: Hono<AppEnv>, store: Store, _webhooks: WebhookDispatcher, baseUrl: string, _tokenMap?: TokenMap): void {
    const ds = getDefStore(store);
    const fmt: Fmt = { ds, baseUrl };
    const rc: DefRouteContext = { app, ds, fmt, baseUrl };
    authRoutes(rc);
    machineRoutes(rc);
    actionRoutes(rc);
    alertRoutes(rc);
    tvmRoutes(rc);
    indicatorRoutes(rc);
    huntingRoutes(rc);
    miscRoutes(rc);
    inspectorRoutes(rc);
  },
  seed(store: Store, baseUrl: string): void {
    seedFromConfig(store, baseUrl, DEFAULT_SEED);
  },
};

export default defenderPlugin;
