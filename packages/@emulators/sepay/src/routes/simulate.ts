import type { Context, RouteContext } from "@emulators/core";
import { getSepayStore } from "../store.js";
import {
  dispatchSepayWebhooks,
  formatTransaction,
  money,
  requireSepayAuth,
  sepayError,
  toWebhookPayload,
} from "../helpers.js";
import type { SepayTransaction, SepayTransferType } from "../entities.js";

export function simulateRoutes({ app, store }: RouteContext): void {
  const ss = getSepayStore(store);

  app.post("/userapi/simulate/transaction", async (c: Context): Promise<Response> => {
    const auth = requireSepayAuth(c, ss);
    if (auth instanceof Response) return auth;

    let body: Record<string, unknown> = {};
    try {
      const parsed = await c.req.json();
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed;
    } catch {
      return sepayError(c, 400, "Invalid JSON body");
    }

    const str = (key: string): string | null => {
      const value = body[key];
      return typeof value === "string" || typeof value === "number" ? String(value) : null;
    };

    const amountIn = str("amountIn");
    const amountOut = str("amountOut");
    const amount = str("amount");
    let transferType = (str("transferType") ?? "") as SepayTransferType;
    if (transferType !== "in" && transferType !== "out") {
      const inAmount = parseFloat(amountIn ?? amount ?? "0");
      transferType = parseFloat(amountOut ?? "0") > 0 && !(inAmount > 0) ? "out" : "in";
    }
    const resolvedAmountIn = transferType === "in" ? (amountIn ?? amount ?? "0") : "0";
    const resolvedAmountOut = transferType === "out" ? (amountOut ?? amount ?? "0") : "0";

    const maxExisting = ss.transactions.all().reduce((max, tx) => Math.max(max, Number(tx.sepay_id) || 0), 100000);
    const id = str("id") ?? String(maxExisting + 1);

    const tx: SepayTransaction = ss.transactions.insert({
      sepay_id: id,
      gateway: str("gateway") ?? "Vietcombank",
      transaction_date: str("transactionDate") ?? new Date().toISOString().slice(0, 19).replace("T", " "),
      account_number: str("accountNumber") ?? ss.bankAccounts.all()[0]?.account_number ?? "",
      sub_account: str("subAccount"),
      amount_in: money(resolvedAmountIn),
      amount_out: money(resolvedAmountOut),
      accumulated: money(str("accumulated")),
      code: str("code"),
      transaction_content: str("content") ?? str("transactionContent") ?? "",
      reference_number: str("referenceNumber"),
      transfer_type: transferType,
    });

    await dispatchSepayWebhooks(ss, "transaction", toWebhookPayload(tx));

    return c.json({
      status: 200,
      error: null,
      messages: { success: true },
      transaction: formatTransaction(tx),
    });
  });
}
