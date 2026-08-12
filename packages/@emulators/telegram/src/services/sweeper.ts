import type { Store } from "@emulators/core";
import { getTelegramStore } from "../store.js";

// Retention caps. Tests create ~100 files / ~50 callbacks, so caps of
// a few thousand are generous enough to never trip during realistic
// test runs while preventing unbounded growth in long-lived processes.
const MAX_FILES = 2000;
const MAX_CALLBACK_QUERIES = 500;
const MAX_DRAFT_SNAPSHOTS = 2000;
const MAX_FAULTS = 500;

function trimByAge<T extends { id: number }>(all: T[], max: number): T[] {
  if (all.length <= max) return [];
  // Oldest first — Collection autoId is monotonic, so id ordering == age.
  return all.sort((a, b) => a.id - b.id).slice(0, all.length - max);
}

/** Prune unbounded per-store collections. Safe to call from any write
 *  path; delegates to the collection's own delete() so indexes stay
 *  consistent. */
export function sweep(store: Store): void {
  const ts = getTelegramStore(store);
  for (const victim of trimByAge(ts.files.all(), MAX_FILES)) ts.files.delete(victim.id);
  for (const victim of trimByAge(ts.callbackQueries.all(), MAX_CALLBACK_QUERIES)) {
    ts.callbackQueries.delete(victim.id);
  }
  for (const victim of trimByAge(ts.draftSnapshots.all(), MAX_DRAFT_SNAPSHOTS)) {
    ts.draftSnapshots.delete(victim.id);
  }
  for (const victim of trimByAge(ts.faults.all(), MAX_FAULTS)) ts.faults.delete(victim.id);
}
