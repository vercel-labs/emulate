import type { ChargebeeTransaction } from "../entities.js";
import { formatTransaction } from "../formatters.js";
import { chargebeeList, invalidStateError, num, parseChargebeeBody, strOrNull } from "../helpers.js";
import { refundInvoice } from "../refunds.js";
import {
  api,
  findCustomer,
  findInvoice,
  findSubscription,
  findTransaction,
  type ChargebeeRouteContext,
} from "../route-utils.js";

export function transactionRoutes(rc: ChargebeeRouteContext): void {
  const { app, cs, ctx } = rc;

  const list = (filter: (txn: ChargebeeTransaction) => boolean) =>
    cs.transactions.all().filter((txn) => !txn.deleted && filter(txn));

  app.get(
    "/api/v2/transactions",
    api(cs, (c) =>
      chargebeeList(
        c,
        list(() => true),
        "transaction",
        (txn) => ({ transaction: formatTransaction(txn) }),
      ),
    ),
  );

  app.get(
    "/api/v2/customers/:id/transactions",
    api(cs, (c) => {
      const customer = findCustomer(cs, c.req.param("id"));
      return chargebeeList(
        c,
        list((txn) => txn.customer_id === customer.cb_id),
        "transaction",
        (txn) => ({
          transaction: formatTransaction(txn),
        }),
      );
    }),
  );

  app.get(
    "/api/v2/subscriptions/:id/transactions",
    api(cs, (c) => {
      const sub = findSubscription(cs, c.req.param("id"));
      return chargebeeList(
        c,
        list((txn) => txn.subscription_id === sub.cb_id),
        "transaction",
        (txn) => ({
          transaction: formatTransaction(txn),
        }),
      );
    }),
  );

  app.get(
    "/api/v2/transactions/:id",
    api(cs, (c) => c.json({ transaction: formatTransaction(findTransaction(cs, c.req.param("id"))) })),
  );

  app.post(
    "/api/v2/transactions/:id/refund",
    api(cs, async (c) => {
      const transaction = findTransaction(cs, c.req.param("id"));
      if (transaction.type !== "payment" || transaction.status !== "success") {
        throw invalidStateError("Only successful payment transactions can be refunded");
      }
      const body = await parseChargebeeBody(c);
      const link = transaction.linked_invoices[0];
      if (!link) throw invalidStateError("Transaction is not linked to an invoice");
      const invoice = findInvoice(cs, link.invoice_id);
      const result = await refundInvoice(ctx, invoice, {
        amount: num(body.amount) ?? transaction.amount,
        customerNotes: strOrNull(body.comment),
      });
      return c.json({ transaction: formatTransaction(result.transaction) });
    }),
  );
}
