import { randomUUID } from "node:crypto";
import type { Store } from "@emulators/core";
import type { GoogleCalendarEvent } from "./entities.js";
import { getMatchingCalendarEvents, type ListCalendarEventsOptions } from "./calendar-helpers.js";
import type { GoogleStore } from "./store.js";

const MAX_SYNC_SNAPSHOTS = 1000;
const MAX_SYNC_EVENT_BYTES = 32 * 1024 * 1024;

interface SyncSnapshot {
  token: string;
  userEmail: string;
  calendarId: string;
  baseline: GoogleCalendarEvent[];
  items: GoogleCalendarEvent[];
  eventBytes: number;
  updated: string;
  requestKey: string;
}

export class CalendarSyncError extends Error {
  constructor(
    public status: 400 | 410,
    message: string,
  ) {
    super(message);
  }
}

// Snapshots freeze paginated results and the associated sync boundary. Retaining
// the full prior state also lets incremental sync report deleted event IDs.
export function syncCalendarEvents(
  store: Store,
  gs: GoogleStore,
  userEmail: string,
  calendarId: string,
  options: ListCalendarEventsOptions & { syncToken?: string | null },
) {
  const snapshots = store.getData<SyncSnapshot[]>("google.calendar_sync") ?? [];
  const limit = Number(options.maxResults ?? 250);
  if (!Number.isInteger(limit) || limit < 1 || limit > 2500) throw new CalendarSyncError(400, "Invalid maxResults.");
  if (options.showDeleted != null && !["true", "false"].includes(options.showDeleted)) {
    throw new CalendarSyncError(400, "Invalid showDeleted.");
  }
  if (
    options.syncToken &&
    (options.timeMin || options.timeMax || options.q || options.orderBy || options.showDeleted === "false")
  ) {
    throw new CalendarSyncError(400, "Incompatible sync parameters.");
  }
  const requestKey = JSON.stringify({ ...options, pageToken: undefined });
  let snapshot: SyncSnapshot | undefined;
  let offset = 0;
  if (options.pageToken) {
    const [token, rawOffset, extra] = options.pageToken.split(":");
    offset = Number(rawOffset);
    snapshot = snapshots.find(
      (entry) => entry.token === token && entry.userEmail === userEmail && entry.calendarId === calendarId,
    );
    if (
      !snapshot ||
      extra !== undefined ||
      !rawOffset ||
      !Number.isSafeInteger(offset) ||
      offset < 1 ||
      offset >= snapshot.items.length ||
      offset % limit !== 0 ||
      snapshot.requestKey !== requestKey
    ) {
      throw new CalendarSyncError(400, "Invalid page token.");
    }
  } else {
    const baseline = structuredClone(
      gs.calendarEvents.findBy("user_email", userEmail).filter((event) => event.calendar_google_id === calendarId),
    );
    let items: GoogleCalendarEvent[] = [];
    if (options.syncToken) {
      const previous = snapshots.find(
        (entry) =>
          entry.token === options.syncToken && entry.userEmail === userEmail && entry.calendarId === calendarId,
      );
      if (!previous) throw new CalendarSyncError(410, "Sync token expired or invalid.");
      const oldEvents = new Map(previous.baseline.map((event) => [event.google_id, event]));
      for (const event of baseline) {
        if (JSON.stringify(oldEvents.get(event.google_id)) !== JSON.stringify(event)) items.push(event);
        oldEvents.delete(event.google_id);
      }
      items.push(...Array.from(oldEvents.values(), (event) => ({ ...event, status: "cancelled" })));
    } else {
      items = getMatchingCalendarEvents(gs, userEmail, calendarId, options);
    }
    snapshot = {
      token: randomUUID(),
      userEmail,
      calendarId,
      baseline,
      items: structuredClone(items),
      eventBytes: Buffer.byteLength(JSON.stringify(baseline)) + Buffer.byteLength(JSON.stringify(items)),
      updated: new Date().toISOString(),
      requestKey,
    };
    snapshots.push(snapshot);
    // Keep the newest snapshot even if it exceeds the budget, so its pages remain
    // available. Evicted sync tokens trigger the client's normal full resync.
    let retainedBytes = snapshot.eventBytes;
    let start = snapshots.length - 1;
    while (start > 0 && snapshots.length - start < MAX_SYNC_SNAPSHOTS) {
      const previousBytes = snapshots[start - 1].eventBytes;
      if (retainedBytes + previousBytes > MAX_SYNC_EVENT_BYTES) break;
      retainedBytes += previousBytes;
      start--;
    }
    store.setData("google.calendar_sync", snapshots.slice(start));
  }
  const hasMore = offset + limit < snapshot.items.length;
  return {
    items: snapshot.items.slice(offset, offset + limit),
    updated: snapshot.updated,
    nextPageToken: hasMore ? `${snapshot.token}:${offset + limit}` : undefined,
    nextSyncToken: hasMore ? undefined : snapshot.token,
  };
}
