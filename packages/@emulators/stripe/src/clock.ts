import type { StripeStore } from "./store.js";

/** Whose clock a timestamp is read from. Objects of a customer on a test clock follow that clock. */
export interface ClockScope {
  customerId?: string | null;
}

/**
 * The current time in Unix seconds for objects in `scope`. Every billing object takes its
 * `created` from here, so test clocks can later move it without touching the call sites.
 * Until test clocks exist this is the wall clock for everyone.
 */
export function nowFor(_ss: StripeStore, _scope: ClockScope = {}): number {
  return Math.floor(Date.now() / 1000);
}
