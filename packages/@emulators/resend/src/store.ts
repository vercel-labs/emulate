import { Store, type Collection } from "@emulators/core";
import type {
  ResendEmail,
  ResendIdempotencyRecord,
  ResendDomain,
  ResendApiKey,
  ResendAudience,
  ResendContact,
} from "./entities.js";

export interface ResendStore {
  emails: Collection<ResendEmail>;
  idempotencyRecords: Collection<ResendIdempotencyRecord>;
  domains: Collection<ResendDomain>;
  apiKeys: Collection<ResendApiKey>;
  audiences: Collection<ResendAudience>;
  contacts: Collection<ResendContact>;
}

export function getResendStore(store: Store): ResendStore {
  return {
    emails: store.collection<ResendEmail>("resend.emails", ["uuid"]),
    idempotencyRecords: store.collection<ResendIdempotencyRecord>("resend.idempotency_records", ["lookup_digest"]),
    domains: store.collection<ResendDomain>("resend.domains", ["uuid", "name"]),
    apiKeys: store.collection<ResendApiKey>("resend.api_keys", ["uuid"]),
    audiences: store.collection<ResendAudience>("resend.audiences", ["uuid"]),
    contacts: store.collection<ResendContact>("resend.contacts", ["uuid", "audience_id"]),
  };
}
