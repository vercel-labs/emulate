import type { Entity } from "@emulators/core";

export interface SepayApiKey extends Entity {
  token: string;
  label: string;
}

export interface SepayBankAccount extends Entity {
  bin: string;
  account_number: string;
  name: string;
}

export interface SepayWebhookTarget extends Entity {
  url: string;
  api_key: string;
}

export type SepayTransferType = "in" | "out";

export interface SepayTransaction extends Entity {
  sepay_id: string;
  gateway: string;
  transaction_date: string;
  account_number: string;
  sub_account: string | null;
  amount_in: string;
  amount_out: string;
  accumulated: string;
  code: string | null;
  transaction_content: string;
  reference_number: string | null;
  transfer_type: SepayTransferType;
}

export interface SepayWebhookDelivery extends Entity {
  target_url: string;
  event: string;
  request_body: unknown;
  status_code: number | null;
  success: boolean;
  error: string | null;
}
