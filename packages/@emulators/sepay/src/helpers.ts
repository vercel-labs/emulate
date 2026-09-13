import type { Context, ContentfulStatusCode } from "@emulators/core";
import { constantTimeSecretEqual } from "@emulators/core";
import type { SepayTransaction } from "./entities.js";
import type { SepayStore } from "./store.js";

export function money(value: number | string | null | undefined): string {
  const num = typeof value === "number" ? value : parseFloat(String(value ?? "0"));
  return (Number.isFinite(num) ? num : 0).toFixed(2);
}

export function formatTransaction(tx: SepayTransaction): Record<string, unknown> {
  return {
    id: tx.sepay_id,
    gateway: tx.gateway,
    bank_brand_name: tx.gateway,
    account_number: tx.account_number,
    sub_account: tx.sub_account,
    transaction_date: tx.transaction_date,
    transfer_type: tx.transfer_type,
    amount_in: tx.amount_in,
    amount_out: tx.amount_out,
    accumulated: tx.accumulated,
    code: tx.code,
    transaction_content: tx.transaction_content,
    reference_number: tx.reference_number,
  };
}

export function toWebhookPayload(tx: SepayTransaction): Record<string, unknown> {
  return {
    id: Number(tx.sepay_id) || tx.sepay_id,
    gateway: tx.gateway,
    transactionDate: tx.transaction_date,
    accountNumber: tx.account_number,
    subAccount: tx.sub_account ?? "",
    amountIn: parseFloat(tx.amount_in),
    amountOut: parseFloat(tx.amount_out),
    accumulated: parseFloat(tx.accumulated),
    code: tx.code,
    transactionContent: tx.transaction_content,
    referenceNumber: tx.reference_number,
    body: tx.transaction_content,
  };
}

export function sepayError(c: Context, status: number, error: string): Response {
  return c.json({ status, error, messages: { error: true } }, status as ContentfulStatusCode);
}

export function requireSepayAuth(c: Context, ss: SepayStore): boolean | Response {
  const header = c.req.header("Authorization") ?? "";
  if (!header.toLowerCase().startsWith("bearer ")) return sepayError(c, 401, "Unauthorized");
  const token = header.slice(7).trim();
  const keys = ss.apiKeys.all();
  const valid = keys.some((key) => constantTimeSecretEqual(token, key.token));
  if (!valid) return sepayError(c, 401, "Unauthorized");
  return true;
}

export async function dispatchSepayWebhooks(ss: SepayStore, event: string, payload: unknown): Promise<void> {
  const body = JSON.stringify(payload);
  for (const target of ss.webhookTargets.all()) {
    let status: number | null = null;
    let success = false;
    let error: string | null = null;
    try {
      const response = await fetch(target.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${target.api_key}`,
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      status = response.status;
      success = response.ok;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    ss.webhookDeliveries.insert({
      target_url: target.url,
      event,
      request_body: payload,
      status_code: status,
      success,
      error,
    });
  }
}
