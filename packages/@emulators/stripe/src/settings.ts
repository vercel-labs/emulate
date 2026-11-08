import type { Store } from "@emulators/core";
import { readInt } from "./helpers.js";

/** What happens to a subscription once every retry of its invoice has failed. */
export type AfterRetriesSubscription = "cancel" | "unpaid" | "past_due" | "pause";

/** What happens to the invoice once every retry has failed. */
export type AfterRetriesInvoice = "open" | "uncollectible";

export interface AfterRetries {
  subscription: AfterRetriesSubscription;
  invoice: AfterRetriesInvoice;
}

/**
 * The account's Billing settings that Stripe keeps in the Dashboard (Settings, Billing,
 * Subscriptions and emails, and Revenue recovery, Retries). The emulator reads and writes them
 * at /_stripe/billing/settings.
 */
export interface BillingSettings {
  /** Days before a renewal that invoice.upcoming is sent. 0 turns the event off. */
  upcoming_renewal_days: number;
  /**
   * The custom retry schedule: each entry is the number of days after the previous attempt
   * that the next retry runs. Smart Retries are not modelled.
   */
  retry_schedule_days: number[];
  after_retries: AfterRetries;
}

export interface BillingSettingsInput {
  upcoming_renewal_days?: number;
  retry_schedule_days?: number[];
  after_retries?: Partial<AfterRetries>;
}

export const DEFAULT_BILLING_SETTINGS: BillingSettings = {
  upcoming_renewal_days: 3,
  retry_schedule_days: [3, 5, 7],
  after_retries: { subscription: "cancel", invoice: "open" },
};

/** The Dashboard offers at most 45 days for upcoming renewal events. */
export const MAX_UPCOMING_RENEWAL_DAYS = 45;

/** A custom retry schedule has at most three retries. */
export const MAX_RETRIES = 3;

/** The longest gap the emulator accepts between two attempts. */
export const MAX_RETRY_DAYS = 60;

const AFTER_RETRIES_SUBSCRIPTION: readonly AfterRetriesSubscription[] = ["cancel", "unpaid", "past_due", "pause"];
const AFTER_RETRIES_INVOICE: readonly AfterRetriesInvoice[] = ["open", "uncollectible"];

const SETTINGS_KEY = "stripe.billing_settings";

export function getBillingSettings(store: Store): BillingSettings {
  const stored = store.getData<Partial<BillingSettings>>(SETTINGS_KEY) ?? {};
  return {
    ...DEFAULT_BILLING_SETTINGS,
    ...stored,
    retry_schedule_days: [...(stored.retry_schedule_days ?? DEFAULT_BILLING_SETTINGS.retry_schedule_days)],
    after_retries: { ...DEFAULT_BILLING_SETTINGS.after_retries, ...stored.after_retries },
  };
}

export function setBillingSettings(store: Store, settings: BillingSettings): void {
  store.setData(SETTINGS_KEY, {
    ...settings,
    retry_schedule_days: [...settings.retry_schedule_days],
    after_retries: { ...settings.after_retries },
  });
}

type SettingsError = { param: string; message: string };

export type ParsedBillingSettings = { ok: true; settings: BillingSettings } | { ok: false; error: SettingsError };

/** A list param sent as a JSON array, as `name[0]=...` form fields, or as "" to clear it. */
function readRetrySchedule(value: unknown): number[] | SettingsError {
  const error = {
    param: "retry_schedule_days",
    message: `Invalid retry_schedule_days: must be a list of at most ${MAX_RETRIES} integers from 1 to ${MAX_RETRY_DAYS}.`,
  };
  if (value === "") return [];
  const entries = Array.isArray(value)
    ? value
    : value && typeof value === "object"
      ? Object.values(value as Record<string, unknown>)
      : undefined;
  if (!entries || entries.length > MAX_RETRIES) return error;
  const days: number[] = [];
  for (const entry of entries) {
    const day = readInt(entry);
    if (day === undefined || day < 1 || day > MAX_RETRY_DAYS) return error;
    days.push(day);
  }
  return days;
}

function readChoice<T extends string>(value: unknown, choices: readonly T[], param: string): T | SettingsError {
  if (typeof value === "string" && (choices as readonly string[]).includes(value)) return value as T;
  return { param, message: `Invalid ${param}: must be one of ${choices.join(", ")}.` };
}

function isError(value: unknown): value is SettingsError {
  return typeof value === "object" && value !== null && "param" in value && "message" in value;
}

/** Apply the keys `input` sets to `current`. Unknown keys are ignored. */
export function parseBillingSettings(input: Record<string, unknown>, current: BillingSettings): ParsedBillingSettings {
  const settings: BillingSettings = {
    ...current,
    retry_schedule_days: [...current.retry_schedule_days],
    after_retries: { ...current.after_retries },
  };
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
  if (input.retry_schedule_days !== undefined) {
    const schedule = readRetrySchedule(input.retry_schedule_days);
    if (isError(schedule)) return { ok: false, error: schedule };
    settings.retry_schedule_days = schedule;
  }
  const after = input.after_retries;
  if (after !== undefined) {
    if (!after || typeof after !== "object" || Array.isArray(after)) {
      return { ok: false, error: { param: "after_retries", message: "Invalid after_retries: must be an object." } };
    }
    const { subscription, invoice } = after as Record<string, unknown>;
    if (subscription !== undefined) {
      const choice = readChoice(subscription, AFTER_RETRIES_SUBSCRIPTION, "after_retries[subscription]");
      if (isError(choice)) return { ok: false, error: choice };
      settings.after_retries.subscription = choice;
    }
    if (invoice !== undefined) {
      const choice = readChoice(invoice, AFTER_RETRIES_INVOICE, "after_retries[invoice]");
      if (isError(choice)) return { ok: false, error: choice };
      settings.after_retries.invoice = choice;
    }
  }
  return { ok: true, settings };
}

export function formatBillingSettings(settings: BillingSettings) {
  return {
    object: "billing_settings" as const,
    upcoming_renewal_days: settings.upcoming_renewal_days,
    retry_schedule_days: [...settings.retry_schedule_days],
    after_retries: { ...settings.after_retries },
  };
}
