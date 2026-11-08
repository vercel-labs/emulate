import type { Store } from "@emulators/core";
import { readInt } from "./helpers.js";

/**
 * The account's Billing settings that Stripe keeps in the Dashboard (Settings, Billing,
 * Subscriptions and emails). The emulator reads and writes them at /_stripe/billing/settings.
 */
export interface BillingSettings {
  /** Days before a renewal that invoice.upcoming is sent. 0 turns the event off. */
  upcoming_renewal_days: number;
}

export type BillingSettingsInput = Partial<BillingSettings>;

export const DEFAULT_BILLING_SETTINGS: BillingSettings = {
  upcoming_renewal_days: 3,
};

/** The Dashboard offers at most 45 days for upcoming renewal events. */
export const MAX_UPCOMING_RENEWAL_DAYS = 45;

const SETTINGS_KEY = "stripe.billing_settings";

export function getBillingSettings(store: Store): BillingSettings {
  return { ...DEFAULT_BILLING_SETTINGS, ...store.getData<Partial<BillingSettings>>(SETTINGS_KEY) };
}

export function setBillingSettings(store: Store, settings: BillingSettings): void {
  store.setData(SETTINGS_KEY, { ...settings });
}

export type ParsedBillingSettings =
  | { ok: true; settings: BillingSettings }
  | { ok: false; error: { param: string; message: string } };

/** Apply the keys `input` sets to `current`. Unknown keys are ignored. */
export function parseBillingSettings(input: Record<string, unknown>, current: BillingSettings): ParsedBillingSettings {
  const settings = { ...current };
  if (input.upcoming_renewal_days !== undefined) {
    const days = readInt(input.upcoming_renewal_days);
    if (days === undefined || days < 0 || days > MAX_UPCOMING_RENEWAL_DAYS) {
      return {
        ok: false,
        error: {
          param: "upcoming_renewal_days",
          message: `Invalid upcoming_renewal_days: must be an integer from 0 to ${MAX_UPCOMING_RENEWAL_DAYS}.`,
        },
      };
    }
    settings.upcoming_renewal_days = days;
  }
  return { ok: true, settings };
}

export function formatBillingSettings(settings: BillingSettings) {
  return { object: "billing_settings" as const, upcoming_renewal_days: settings.upcoming_renewal_days };
}
