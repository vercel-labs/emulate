import { Store, type Collection } from "@emulators/core";
import type {
  SepayApiKey,
  SepayBankAccount,
  SepayTransaction,
  SepayWebhookDelivery,
  SepayWebhookTarget,
} from "./entities.js";

export interface SepayStore {
  apiKeys: Collection<SepayApiKey>;
  bankAccounts: Collection<SepayBankAccount>;
  webhookTargets: Collection<SepayWebhookTarget>;
  transactions: Collection<SepayTransaction>;
  webhookDeliveries: Collection<SepayWebhookDelivery>;
}

export function getSepayStore(store: Store): SepayStore {
  return {
    apiKeys: store.collection<SepayApiKey>("sepay.api_keys", ["token"]),
    bankAccounts: store.collection<SepayBankAccount>("sepay.bank_accounts", ["bin", "account_number"]),
    webhookTargets: store.collection<SepayWebhookTarget>("sepay.webhook_targets", ["url"]),
    transactions: store.collection<SepayTransaction>("sepay.transactions", ["sepay_id", "account_number"]),
    webhookDeliveries: store.collection<SepayWebhookDelivery>("sepay.webhook_deliveries", ["target_url"]),
  };
}
