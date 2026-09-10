import type { AppEnv, Hono, ServicePlugin, Store, TokenMap, WebhookDispatcher } from "@emulators/core";
import {
  CYBERSOAR_SERVICES,
  MAIL_SENT_TAG,
  type CybersoarService,
  type CybersoarStatus,
  type CybersoarVerdict,
} from "./entities.js";
import { alertRoutes, createAlert, ensureCustomer } from "./routes/alerts.js";
import { inspectorRoutes } from "./routes/inspector.js";
import { miscRoutes } from "./routes/misc.js";
import { getCsStore, logEvent, type CsStore } from "./store.js";

export { getCsStore, type CsStore } from "./store.js";
export * from "./entities.js";
export { createAlert, closeAlert, filterAlerts, formatAlert, type CreateAlertInput } from "./routes/alerts.js";

export interface CybersoarSeedAlert {
  id?: string;
  caseId?: string;
  customer: string;
  msp?: string;
  service: CybersoarService;
  ruleName: string;
  ruleId?: string;
  ruleRuntime?: string;
  description?: string;
  criticity?: number;
  status?: CybersoarStatus;
  verdict?: CybersoarVerdict;
  tags?: string[];
  ingestAt?: string;
  createdAt?: string;
  closedAt?: string | null;
  analyst?: string | null;
}

export interface CybersoarSeedCustomer {
  id?: string;
  name: string;
  msp?: string;
  slug?: string;
  msp_slug?: string;
  services?: CybersoarService[];
  generate_alerts?: number;
  generate_days?: number;
}

export interface CybersoarSeedConfig {
  port?: number;
  baseUrl?: string;
  api_keys?: Array<{ api_key: string; name?: string }>;
  customers?: CybersoarSeedCustomer[];
  alerts?: CybersoarSeedAlert[];
}

export const DEFAULT_API_KEY = "test_emulate_cybersoar_api_key";
export const DEFAULT_MSP = "Nimbus MSP";
export const DEFAULT_CUSTOMER = "Acme Corp";
export const DEFAULT_CUSTOMER_ID = "00000000-0000-4000-8000-00000000ac3e";
export const DEFAULT_SECOND_CUSTOMER_ID = "00000000-0000-4000-8000-00000000610b";
export const DEFAULT_THIRD_CUSTOMER_ID = "00000000-0000-4000-8000-000000001e7c";

interface RuleTemplate {
  service: CybersoarService;
  ruleName: string;
  ruleId: string;
  runtime: string;
  criticity: number;
  description: string;
}

export const RULE_CATALOG: RuleTemplate[] = [
  {
    service: "SENTINELONE",
    ruleName: "Malware detected by Static AI engine",
    ruleId: "s1-static-ai-malware",
    runtime: "sentinelone",
    criticity: 3,
    description: "SentinelOne Static AI classified a file as malicious and quarantined it.",
  },
  {
    service: "SENTINELONE",
    ruleName: "Suspicious PowerShell execution",
    ruleId: "s1-suspicious-powershell",
    runtime: "kql",
    criticity: 2,
    description: "Encoded PowerShell command line observed on an endpoint.",
  },
  {
    service: "SENTINELONE",
    ruleName: "Ransomware behavior blocked",
    ruleId: "s1-ransomware-behavior",
    runtime: "sentinelone",
    criticity: 4,
    description: "Behavioral AI blocked mass file encryption activity.",
  },
  {
    service: "MS365_DEFENDER",
    ruleName: "Sign-in from anonymous IP address",
    ruleId: "mde-anonymous-ip-signin",
    runtime: "kql",
    criticity: 3,
    description: "A user signed in from a Tor exit node or anonymizing proxy.",
  },
  {
    service: "MS365_DEFENDER",
    ruleName: "Credential dumping attempt",
    ruleId: "mde-credential-dumping",
    runtime: "kql",
    criticity: 4,
    description: "LSASS memory access consistent with credential theft tooling.",
  },
  {
    service: "SOPHOS",
    ruleName: "Potentially unwanted application blocked",
    ruleId: "sophos-pua-blocked",
    runtime: "sophos",
    criticity: 1,
    description: "Sophos blocked a PUA installer.",
  },
  {
    service: "MS365",
    ruleName: "Impossible travel sign-in",
    ruleId: "m365-impossible-travel",
    runtime: "kql",
    criticity: 3,
    description: "Successful sign-ins from two distant locations within a short interval.",
  },
  {
    service: "MS365",
    ruleName: "Mass download by a single user",
    ruleId: "m365-mass-download",
    runtime: "kql",
    criticity: 2,
    description: "A user downloaded an unusual volume of SharePoint files.",
  },
  {
    service: "MS365",
    ruleName: "Inbox forwarding rule created",
    ruleId: "m365-inbox-forwarding",
    runtime: "kql",
    criticity: 3,
    description: "A new mailbox rule forwards mail to an external address.",
  },
  {
    service: "ACTIVE_DIRECTORY",
    ruleName: "Account added to Domain Admins",
    ruleId: "ad-domain-admins-add",
    runtime: "sigma",
    criticity: 4,
    description: "Event 4728 added a member to the Domain Admins group.",
  },
  {
    service: "ACTIVE_DIRECTORY",
    ruleName: "Multiple failed logons (brute force)",
    ruleId: "ad-brute-force",
    runtime: "sigma",
    criticity: 2,
    description: "More than 50 failed logons for one account within 5 minutes.",
  },
  {
    service: "ACTIVE_DIRECTORY",
    ruleName: "Kerberoasting attempt",
    ruleId: "ad-kerberoasting",
    runtime: "sigma",
    criticity: 3,
    description: "Unusual volume of RC4 service ticket requests.",
  },
  {
    service: "FIREWALL",
    ruleName: "Port scan from external IP",
    ruleId: "fw-port-scan",
    runtime: "suricata",
    criticity: 1,
    description: "Sequential connection attempts across many destination ports.",
  },
  {
    service: "FIREWALL",
    ruleName: "Blocked command and control beacon",
    ruleId: "fw-c2-beacon",
    runtime: "suricata",
    criticity: 4,
    description: "Outbound connection to a known C2 indicator was denied.",
  },
  {
    service: "FIREWALL",
    ruleName: "VPN login outside business hours",
    ruleId: "fw-vpn-off-hours",
    runtime: "kql",
    criticity: 2,
    description: "Remote access VPN authentication between 01:00 and 05:00 local time.",
  },
];

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

export function generateAlerts(
  cs: CsStore,
  customer: ReturnType<typeof ensureCustomer>,
  count: number,
  days: number,
  seed: number,
): void {
  const random = lcg(seed);
  const rules = RULE_CATALOG.filter((rule) => customer.services.includes(rule.service));
  const now = Date.now();
  let caseCounter = 0;
  for (let index = 0; index < count; index++) {
    const rule = rules[Math.floor(random() * rules.length)];
    const ageMs = Math.floor(random() * days * 86400000);
    const ingestAt = new Date(now - ageMs).toISOString();
    const recent = ageMs < 2 * 86400000;
    const status: CybersoarStatus = recent && random() < 0.6 ? "WAITING_ANALYST" : "CLOSED";
    const roll = random();
    const verdict: CybersoarVerdict =
      status === "WAITING_ANALYST"
        ? "NEW"
        : roll < 0.45
          ? "TP"
          : roll < 0.85
            ? "FP"
            : roll < 0.95
              ? "INDETERMINATE"
              : "OTHER";
    const notify = status === "CLOSED" && (verdict === "TP" ? random() < 0.9 : random() < 0.15);
    const newCase = index === 0 || random() < 0.7;
    if (newCase) caseCounter++;
    const suffix = String(seed % 1000).padStart(3, "0");
    createAlert(cs, {
      id: `a${suffix}0000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      caseId: `CASE-${suffix}-${String(caseCounter).padStart(4, "0")}`,
      customer,
      service: rule.service,
      ruleName: rule.ruleName,
      ruleId: rule.ruleId,
      ruleRuntime: rule.runtime,
      description: rule.description,
      criticity: Math.min(4, Math.max(1, rule.criticity + (random() < 0.2 ? 1 : 0) - (random() < 0.2 ? 1 : 0))),
      status,
      verdict,
      tags: notify ? [MAIL_SENT_TAG] : [],
      ingestAt,
      closedAt:
        status === "CLOSED"
          ? new Date(Date.parse(ingestAt) + Math.floor(random() * 6 + 1) * 3600000).toISOString()
          : null,
      analyst: status === "CLOSED" ? ["soc-analyst-1", "soc-analyst-2", "soc-lead"][Math.floor(random() * 3)] : null,
    });
  }
}

export const DEFAULT_SEED: CybersoarSeedConfig = {
  api_keys: [{ api_key: DEFAULT_API_KEY, name: "emulate" }],
  customers: [
    { id: DEFAULT_CUSTOMER_ID, name: DEFAULT_CUSTOMER, msp: DEFAULT_MSP, generate_alerts: 60, generate_days: 120 },
    {
      id: DEFAULT_SECOND_CUSTOMER_ID,
      name: "Globex Industries",
      msp: DEFAULT_MSP,
      services: ["SENTINELONE", "MS365", "FIREWALL"],
      generate_alerts: 25,
      generate_days: 120,
    },
    {
      id: DEFAULT_THIRD_CUSTOMER_ID,
      name: "Initech",
      msp: "Direct",
      services: ["MS365_DEFENDER", "MS365", "ACTIVE_DIRECTORY"],
      generate_alerts: 15,
      generate_days: 60,
    },
  ],
  alerts: [
    {
      id: "a0000000-0000-4000-8000-00000000f101",
      caseId: "CASE-FIXED-0001",
      customer: DEFAULT_CUSTOMER,
      msp: DEFAULT_MSP,
      service: "MS365",
      ruleName: "Inbox forwarding rule created",
      criticity: 3,
      status: "CLOSED",
      verdict: "TP",
      tags: [MAIL_SENT_TAG],
      ingestAt: new Date(Date.now() - 3 * 86400000).toISOString(),
      analyst: "soc-analyst-1",
    },
    {
      id: "a0000000-0000-4000-8000-00000000f102",
      caseId: "CASE-FIXED-0002",
      customer: DEFAULT_CUSTOMER,
      msp: DEFAULT_MSP,
      service: "FIREWALL",
      ruleName: "Port scan from external IP",
      criticity: 1,
      status: "CLOSED",
      verdict: "FP",
      tags: [],
      ingestAt: new Date(Date.now() - 5 * 86400000).toISOString(),
      analyst: "soc-analyst-2",
    },
    {
      id: "a0000000-0000-4000-8000-00000000f103",
      caseId: "CASE-FIXED-0003",
      customer: DEFAULT_CUSTOMER,
      msp: DEFAULT_MSP,
      service: "SENTINELONE",
      ruleName: "Ransomware behavior blocked",
      criticity: 4,
      status: "WAITING_ANALYST",
      verdict: "NEW",
      tags: [],
      ingestAt: new Date(Date.now() - 3600000).toISOString(),
    },
  ],
};

export function seedFromConfig(
  store: Store,
  _baseUrl: string,
  config: CybersoarSeedConfig,
  _webhooks?: WebhookDispatcher,
): void {
  const cs = getCsStore(store);
  for (const entry of config.api_keys ?? []) {
    if (!entry.api_key || cs.apiKeys.findOneBy("api_key", entry.api_key)) continue;
    cs.apiKeys.insert({ api_key: entry.api_key, name: entry.name ?? "cybersoar" });
  }
  if (cs.apiKeys.count() === 0) cs.apiKeys.insert({ api_key: DEFAULT_API_KEY, name: "emulate" });
  let seedIndex = 0;
  for (const entry of config.customers ?? []) {
    seedIndex++;
    const before = cs.customers.count();
    const customer = ensureCustomer(cs, {
      id: entry.id,
      name: entry.name,
      msp: entry.msp,
      slug: entry.slug,
      msp_slug: entry.msp_slug,
      services: entry.services,
    });
    const fresh = cs.customers.count() > before;
    if (fresh && entry.generate_alerts && entry.generate_alerts > 0)
      generateAlerts(
        cs,
        customer,
        entry.generate_alerts,
        entry.generate_days ?? 90,
        seedIndex * 7919 + entry.name.length,
      );
  }
  for (const entry of config.alerts ?? []) {
    if (entry.id && cs.alerts.findOneBy("alert_id", entry.id)) continue;
    if (!CYBERSOAR_SERVICES.includes(entry.service)) continue;
    const customer = ensureCustomer(cs, { name: entry.customer, msp: entry.msp });
    createAlert(cs, { ...entry, customer });
  }
  logEvent(cs, "seed.applied", "config", { customers: cs.customers.count(), alerts: cs.alerts.count() });
}

export const cybersoarPlugin: ServicePlugin = {
  name: "cybersoar",
  register(app: Hono<AppEnv>, store: Store, _webhooks: WebhookDispatcher, baseUrl: string, _tokenMap?: TokenMap): void {
    const cs: CsStore = getCsStore(store);
    inspectorRoutes(app, cs, baseUrl);
    miscRoutes(app, cs);
    alertRoutes(app, cs);
  },
  seed(store: Store, baseUrl: string): void {
    seedFromConfig(store, baseUrl, DEFAULT_SEED);
  },
};

export default cybersoarPlugin;
