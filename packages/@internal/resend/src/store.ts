import { Store, type Collection } from "@internal/core";
import type {
  ResendEmail,
  ResendDomain,
  ResendApiKey,
  ResendContact,
  ResendAudience,
  ResendWebhook,
} from "./entities.js";

export interface ResendStore {
  emails: Collection<ResendEmail>;
  domains: Collection<ResendDomain>;
  apiKeys: Collection<ResendApiKey>;
  contacts: Collection<ResendContact>;
  audiences: Collection<ResendAudience>;
  webhooks: Collection<ResendWebhook>;
}

export function getResendStore(store: Store): ResendStore {
  return {
    emails: store.collection<ResendEmail>("resend.emails", []),
    domains: store.collection<ResendDomain>("resend.domains", ["name"]),
    apiKeys: store.collection<ResendApiKey>("resend.api_keys", ["token"]),
    contacts: store.collection<ResendContact>("resend.contacts", ["email"]),
    audiences: store.collection<ResendAudience>("resend.audiences", ["name"]),
    webhooks: store.collection<ResendWebhook>("resend.webhooks", []),
  };
}
