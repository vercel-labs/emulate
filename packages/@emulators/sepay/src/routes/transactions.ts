import type { Context, RouteContext } from "@emulators/core";
import { getSepayStore } from "../store.js";
import { formatTransaction, requireSepayAuth, sepayError } from "../helpers.js";

export function transactionRoutes({ app, store }: RouteContext): void {
  const ss = getSepayStore(store);

  app.get("/userapi/transactions/list", (c) => {
    const auth = requireSepayAuth(c, ss);
    if (auth instanceof Response) return auth;

    let items = ss.transactions.all();
    const accountNumber = c.req.query("account_number");
    if (accountNumber) items = items.filter((tx) => tx.account_number === accountNumber);
    const reference = c.req.query("reference_number") ?? c.req.query("reference_code");
    if (reference) items = items.filter((tx) => tx.reference_number === reference);
    const sinceId = c.req.query("since_id");
    if (sinceId) items = items.filter((tx) => Number(tx.sepay_id) >= Number(sinceId));
    const amountIn = c.req.query("amount_in");
    if (amountIn) items = items.filter((tx) => parseFloat(tx.amount_in) === parseFloat(amountIn));
    const amountOut = c.req.query("amount_out");
    if (amountOut) items = items.filter((tx) => parseFloat(tx.amount_out) === parseFloat(amountOut));

    items.sort((a, b) => Number(b.sepay_id) - Number(a.sepay_id));

    const limitRaw = parseInt(c.req.query("limit") ?? "", 10);
    const limit = Math.min(Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 5000, 5000);
    const offsetRaw = parseInt(c.req.query("offset") ?? "0", 10);
    const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? offsetRaw : 0;
    items = items.slice(offset, offset + limit);

    return c.json({
      status: 200,
      error: null,
      messages: { success: true },
      transactions: items.map(formatTransaction),
    });
  });

  const getTransaction = (c: Context): Response => {
    const auth = requireSepayAuth(c, ss);
    if (auth instanceof Response) return auth;
    const id = c.req.param("id");
    const tx =
      ss.transactions.findOneBy("sepay_id", id) ?? ss.transactions.findOneBy("sepay_id", String(parseInt(id, 10)));
    if (!tx) return sepayError(c, 404, "Not found");
    return c.json({
      status: 200,
      error: null,
      messages: { success: true },
      transaction: formatTransaction(tx),
    });
  };

  app.get("/userapi/transactions/details/:id", (c) => getTransaction(c));
  app.get("/userapi/transactions/:id", (c) => getTransaction(c));
}
