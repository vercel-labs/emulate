import { randomBytes } from "crypto";
import type { Hono } from "@emulators/core";
import type { AppEnv, RouteContext, ServicePlugin, Store, TokenMap, WebhookDispatcher } from "@emulators/core";
import { getSepayStore } from "./store.js";
import { transactionRoutes } from "./routes/transactions.js";
import { simulateRoutes } from "./routes/simulate.js";
import { qrRoutes } from "./routes/qr.js";

export { getSepayStore, type SepayStore } from "./store.js";
export * from "./entities.js";
export { buildVietQrString } from "./vietqr.js";

export const DEFAULT_API_KEY = "sepay_test_api_key";
export const DEFAULT_WEBHOOK_API_KEY = "sepay_test_webhook_key";
const DEFAULT_BANK_BIN = "970436";
const DEFAULT_BANK_ACCOUNT = "0071000888888";

export interface SepaySeedConfig {
  port?: number;
  api_keys?: Array<{
    token: string;
    label?: string;
  }>;
  webhook_targets?: Array<{
    url: string;
    api_key?: string;
  }>;
  bank_accounts?: Array<{
    bin: string;
    account_number: string;
    name: string;
  }>;
  transactions?: Array<{
    id: string | number;
    gateway?: string;
    transactionDate?: string;
    accountNumber?: string;
    subAccount?: string;
    transferType: "in" | "out";
    amount: number | string;
    accumulated?: number | string;
    code?: string | null;
    content: string;
    referenceNumber?: string | null;
  }>;
}

function seedDefaults(store: Store): void {
  const ss = getSepayStore(store);
  if (!ss.apiKeys.findOneBy("token", DEFAULT_API_KEY)) {
    ss.apiKeys.insert({ token: DEFAULT_API_KEY, label: "Local API Key" });
  }
  if (!ss.bankAccounts.findOneBy("account_number", DEFAULT_BANK_ACCOUNT)) {
    ss.bankAccounts.insert({
      bin: DEFAULT_BANK_BIN,
      account_number: DEFAULT_BANK_ACCOUNT,
      name: "NGUYEN VAN A",
    });
  }
}

export function seedFromConfig(store: Store, _baseUrl: string, config: SepaySeedConfig): void {
  const ss = getSepayStore(store);

  for (const key of config.api_keys ?? []) {
    if (ss.apiKeys.findOneBy("token", key.token)) continue;
    ss.apiKeys.insert({ token: key.token, label: key.label ?? "API Key" });
  }

  for (const target of config.webhook_targets ?? []) {
    if (ss.webhookTargets.findOneBy("url", target.url)) continue;
    ss.webhookTargets.insert({ url: target.url, api_key: target.api_key ?? DEFAULT_WEBHOOK_API_KEY });
  }

  for (const account of config.bank_accounts ?? []) {
    if (ss.bankAccounts.findOneBy("account_number", account.account_number)) continue;
    ss.bankAccounts.insert(account);
  }
  for (const tx of config.transactions ?? []) {
    const sepayId = String(tx.id);
    if (ss.transactions.findOneBy("sepay_id", sepayId)) continue;
    const rawDate = tx.transactionDate as string | Date | undefined;
    // YAML parsers turn unquoted timestamps into Date objects
    const transactionDate =
      rawDate instanceof Date
        ? rawDate.toISOString().slice(0, 19).replace("T", " ")
        : typeof rawDate === "string" && rawDate.length > 0
          ? rawDate
          : new Date().toISOString().slice(0, 19).replace("T", " ");
    ss.transactions.insert({
      sepay_id: sepayId,
      gateway: tx.gateway ?? "Vietcombank",
      transaction_date: transactionDate,
      account_number: tx.accountNumber ?? ss.bankAccounts.all()[0]?.account_number ?? "",
      sub_account: tx.subAccount ?? null,
      amount_in: tx.transferType === "in" ? Number(tx.amount).toFixed(2) : "0.00",
      amount_out: tx.transferType === "out" ? Number(tx.amount).toFixed(2) : "0.00",
      accumulated: tx.accumulated !== undefined ? Number(tx.accumulated).toFixed(2) : "0.00",
      code: tx.code ?? null,
      transaction_content: tx.content,
      reference_number: tx.referenceNumber ?? null,
      transfer_type: tx.transferType,
    });
  }
}

export function materializeSepaySeedConfig(config: SepaySeedConfig): {
  config: SepaySeedConfig;
  generatedSecrets: Array<{ kind: string; id: string; label: string; value: string }>;
} {
  const generatedSecrets: Array<{ kind: string; id: string; label: string; value: string }> = [];
  const resolved: SepaySeedConfig = { ...config };

  if (!resolved.api_keys || resolved.api_keys.length === 0) {
    const token = `sepay_${randomBytes(16).toString("hex")}`;
    generatedSecrets.push({ kind: "sepay.api_key", id: "api_key", label: "SePay API Key", value: token });
    resolved.api_keys = [{ token, label: "Generated API Key" }];
  }

  resolved.webhook_targets = (resolved.webhook_targets ?? []).map((target) => {
    if (target.api_key) return target;
    const apiKey = `sepay_whk_${randomBytes(16).toString("hex")}`;
    generatedSecrets.push({
      kind: "sepay.webhook_api_key",
      id: target.url,
      label: target.url,
      value: apiKey,
    });
    return { ...target, api_key: apiKey };
  });

  return { config: resolved, generatedSecrets };
}

export const sepayPlugin: ServicePlugin = {
  name: "sepay",
  register(app: Hono<AppEnv>, store: Store, _webhooks: WebhookDispatcher, baseUrl: string, tokenMap?: TokenMap): void {
    const ctx: RouteContext = { app, store, webhooks: _webhooks, baseUrl, tokenMap };
    transactionRoutes(ctx);
    simulateRoutes(ctx);
    qrRoutes(ctx);
  },
  seed(store: Store): void {
    seedDefaults(store);
  },
};

export default sepayPlugin;
