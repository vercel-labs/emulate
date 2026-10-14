import { Store, type Collection } from "@emulators/core";
import type {
  ResendEmail,
  ResendDomain,
  ResendApiKey,
  ResendAudience,
  ResendContact,
  ResendIdempotencyRecord,
  ResendSendAttempt,
} from "./entities.js";

export const ALLOWLIST_DATA_KEY = "allowlist";

export interface ResendStore {
  emails: Collection<ResendEmail>;
  idempotencyKeys: Collection<ResendIdempotencyRecord>;
  sendAttempts: Collection<ResendSendAttempt>;
  domains: Collection<ResendDomain>;
  apiKeys: Collection<ResendApiKey>;
  audiences: Collection<ResendAudience>;
  contacts: Collection<ResendContact>;
}

export function getResendStore(store: Store): ResendStore {
  return {
    emails: store.collection<ResendEmail>("resend.emails", ["uuid"]),
    idempotencyKeys: store.collection<ResendIdempotencyRecord>("resend.idempotency_keys", ["idempotency_key"]),
    sendAttempts: store.collection<ResendSendAttempt>("resend.send_attempts"),
    domains: store.collection<ResendDomain>("resend.domains", ["uuid", "name"]),
    apiKeys: store.collection<ResendApiKey>("resend.api_keys", ["uuid"]),
    audiences: store.collection<ResendAudience>("resend.audiences", ["uuid"]),
    contacts: store.collection<ResendContact>("resend.contacts", ["uuid", "audience_id"]),
  };
}
