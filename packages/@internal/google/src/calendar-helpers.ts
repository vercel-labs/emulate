import { generateUid, normalizeLimit, parseOffset } from "./helpers.js";
import type {
  GoogleCalendar,
  GoogleCalendarConferenceEntryPoint,
  GoogleCalendarEvent,
  GoogleCalendarEventAttendee,
} from "./entities.js";
import type { GoogleStore } from "./store.js";

export interface GoogleCalendarInput {
  google_id?: string;
  user_email: string;
  summary: string;
  description?: string | null;
  time_zone?: string;
  primary?: boolean;
  selected?: boolean;
  access_role?: string;
  background_color?: string | null;
  foreground_color?: string | null;
}

export interface GoogleCalendarEventInput {
  google_id?: string;
  user_email: string;
  calendar_google_id: string;
  status?: string;
  summary?: string;
  description?: string | null;
  location?: string | null;
  start_date_time?: string | null;
  start_date?: string | null;
  end_date_time?: string | null;
  end_date?: string | null;
  attendees?: GoogleCalendarEventAttendee[];
  conference_entry_points?: GoogleCalendarConferenceEntryPoint[];
  hangout_link?: string | null;
  transparency?: string | null;
}

export interface ListCalendarEventsOptions {
  timeMin?: string | null;
  timeMax?: string | null;
  maxResults?: string | null;
  pageToken?: string | null;
  q?: string | null;
  orderBy?: string | null;
}

export function ensureDefaultCalendars(gs: GoogleStore, userEmail: string): void {
  const existing = gs.calendars.findBy("user_email", userEmail);
  if (existing.length > 0) {
    if (!existing.some((calendar) => calendar.primary)) {
      gs.calendars.update(existing[0].id, { primary: true });
    }
    return;
  }

  gs.calendars.insert({
    google_id: "primary",
    user_email: userEmail,
    summary: userEmail,
    description: null,
    time_zone: "UTC",
    primary: true,
    selected: true,
    access_role: "owner",
    background_color: null,
    foreground_color: null,
  });
}

export function createCalendarRecord(gs: GoogleStore, input: GoogleCalendarInput): GoogleCalendar {
  const calendarId = input.google_id ?? generateUid("cal");
  const existing = gs.calendars
    .findBy("user_email", input.user_email)
    .find((calendar) => calendar.google_id === calendarId);
  if (existing) return existing;

  const inserted = gs.calendars.insert({
    google_id: calendarId,
    user_email: input.user_email,
    summary: input.summary,
    description: input.description ?? null,
    time_zone: input.time_zone ?? "UTC",
    primary: input.primary ?? false,
    selected: input.selected ?? true,
    access_role: input.access_role ?? "owner",
    background_color: input.background_color ?? null,
    foreground_color: input.foreground_color ?? null,
  });

  if (inserted.primary) {
    for (const calendar of gs.calendars.findBy("user_email", input.user_email)) {
      if (calendar.id !== inserted.id && calendar.primary) {
        gs.calendars.update(calendar.id, { primary: false });
      }
    }
  }

  return inserted;
}

export function listCalendarsForUser(gs: GoogleStore, userEmail: string): GoogleCalendar[] {
  ensureDefaultCalendars(gs, userEmail);
  return gs.calendars
    .findBy("user_email", userEmail)
    .sort((a, b) => Number(b.primary) - Number(a.primary) || a.summary.localeCompare(b.summary));
}

export function getCalendarById(gs: GoogleStore, userEmail: string, calendarId: string): GoogleCalendar | undefined {
  ensureDefaultCalendars(gs, userEmail);
  if (calendarId === "primary") {
    const calendars = listCalendarsForUser(gs, userEmail);
    return calendars.find((calendar) => calendar.primary) ?? calendars[0];
  }

  return gs.calendars
    .findBy("user_email", userEmail)
    .find((calendar) => calendar.google_id === calendarId);
}

export function formatCalendarResource(calendar: GoogleCalendar) {
  return {
    kind: "calendar#calendarListEntry",
    etag: `"${calendar.google_id}"`,
    id: calendar.google_id,
    summary: calendar.summary,
    description: calendar.description ?? undefined,
    timeZone: calendar.time_zone,
    selected: calendar.selected,
    primary: calendar.primary || undefined,
    accessRole: calendar.access_role,
    backgroundColor: calendar.background_color ?? undefined,
    foregroundColor: calendar.foreground_color ?? undefined,
  };
}

export function createCalendarEventRecord(gs: GoogleStore, input: GoogleCalendarEventInput): GoogleCalendarEvent {
  const calendar = getCalendarById(gs, input.user_email, input.calendar_google_id);
  if (!calendar) {
    throw new Error("Calendar not found");
  }

  const eventId = input.google_id ?? generateUid("evt");
  const existing = gs.calendarEvents
    .findBy("user_email", input.user_email)
    .find((event) => event.google_id === eventId);
  if (existing) return existing;

  const hangoutLink =
    input.hangout_link ??
    input.conference_entry_points?.find((entry) => entry.entry_point_type === "video")?.uri ??
    null;

  return gs.calendarEvents.insert({
    google_id: eventId,
    user_email: input.user_email,
    calendar_google_id: calendar.google_id,
    status: input.status ?? "confirmed",
    summary: input.summary ?? "Untitled Event",
    description: input.description ?? null,
    location: input.location ?? null,
    html_link: buildCalendarEventLink(calendar.google_id, eventId),
    hangout_link: hangoutLink,
    start_date_time: input.start_date_time ?? null,
    start_date: input.start_date ?? null,
    end_date_time: input.end_date_time ?? null,
    end_date: input.end_date ?? null,
    attendees: input.attendees ?? [],
    conference_entry_points: input.conference_entry_points ?? [],
    transparency: input.transparency ?? null,
  });
}

export function getCalendarEventById(
  gs: GoogleStore,
  userEmail: string,
  calendarId: string,
  eventId: string,
): GoogleCalendarEvent | undefined {
  const calendar = getCalendarById(gs, userEmail, calendarId);
  if (!calendar) return undefined;

  return gs.calendarEvents
    .findBy("user_email", userEmail)
    .find((event) => event.calendar_google_id === calendar.google_id && event.google_id === eventId);
}

export function deleteCalendarEventRecord(gs: GoogleStore, event: GoogleCalendarEvent): boolean {
  return gs.calendarEvents.delete(event.id);
}

export function listCalendarEvents(
  gs: GoogleStore,
  userEmail: string,
  calendarId: string,
  options: ListCalendarEventsOptions,
): {
  items: GoogleCalendarEvent[];
  nextPageToken?: string;
} {
  const calendar = getCalendarById(gs, userEmail, calendarId);
  if (!calendar) return { items: [] };

  let events = gs.calendarEvents
    .findBy("user_email", userEmail)
    .filter((event) => event.calendar_google_id === calendar.google_id)
    .filter((event) => event.status !== "cancelled");

  if (options.timeMin || options.timeMax) {
    const min = options.timeMin ? Date.parse(options.timeMin) : null;
    const max = options.timeMax ? Date.parse(options.timeMax) : null;
    events = events.filter((event) => eventOverlapsRange(event, min, max));
  }

  if (options.q?.trim()) {
    const needle = options.q.trim().toLowerCase();
    events = events.filter((event) => searchableCalendarEvent(event).includes(needle));
  }

  events.sort((a, b) => getEventSortTime(a) - getEventSortTime(b));
  if (options.orderBy && options.orderBy !== "startTime") {
    events.sort((a, b) => a.summary.localeCompare(b.summary));
  }

  const offset = parseOffset(options.pageToken);
  const limit = normalizeLimit(options.maxResults, 10, 250);

  return {
    items: events.slice(offset, offset + limit),
    nextPageToken: offset + limit < events.length ? String(offset + limit) : undefined,
  };
}

export function formatCalendarEventResource(gs: GoogleStore, event: GoogleCalendarEvent) {
  const calendar = getCalendarById(gs, event.user_email, event.calendar_google_id);

  return {
    kind: "calendar#event",
    etag: `"${event.google_id}"`,
    id: event.google_id,
    status: event.status,
    htmlLink: event.html_link ?? undefined,
    hangoutLink: event.hangout_link ?? undefined,
    summary: event.summary,
    description: event.description ?? undefined,
    location: event.location ?? undefined,
    created: event.created_at,
    updated: event.updated_at,
    start: formatCalendarDateRange(event, "start", calendar?.time_zone ?? "UTC"),
    end: formatCalendarDateRange(event, "end", calendar?.time_zone ?? "UTC"),
    attendees: event.attendees.map((attendee) => ({
      email: attendee.email,
      displayName: attendee.display_name ?? undefined,
      responseStatus: attendee.response_status ?? undefined,
      organizer: attendee.organizer || undefined,
      self: attendee.self || undefined,
    })),
    conferenceData:
      event.conference_entry_points.length > 0
        ? {
            entryPoints: event.conference_entry_points.map((entry) => ({
              entryPointType: entry.entry_point_type,
              uri: entry.uri,
              label: entry.label ?? undefined,
            })),
          }
        : undefined,
  };
}

export function buildFreeBusyResponse(
  gs: GoogleStore,
  userEmail: string,
  request: {
    timeMin: string;
    timeMax: string;
    items: Array<{ id: string }>;
  },
) {
  const calendars: Record<string, { busy: Array<{ start: string; end: string }> }> = {};
  const min = Date.parse(request.timeMin);
  const max = Date.parse(request.timeMax);

  for (const item of request.items) {
    const calendar = getCalendarById(gs, userEmail, item.id);
    if (!calendar) continue;

    const busy = gs.calendarEvents
      .findBy("user_email", userEmail)
      .filter((event) => event.calendar_google_id === calendar.google_id)
      .filter((event) => event.status !== "cancelled" && event.transparency !== "transparent")
      .filter((event) => eventOverlapsRange(event, min, max))
      .sort((a, b) => getEventSortTime(a) - getEventSortTime(b))
      .map((event) => ({
        start: event.start_date_time ?? `${event.start_date}T00:00:00.000Z`,
        end: event.end_date_time ?? `${event.end_date}T00:00:00.000Z`,
      }));

    calendars[item.id] = { busy };
  }

  return {
    kind: "calendar#freeBusy",
    timeMin: request.timeMin,
    timeMax: request.timeMax,
    calendars,
  };
}

function buildCalendarEventLink(calendarId: string, eventId: string): string {
  return `https://calendar.google.com/calendar/u/0/r/eventedit/${calendarId}/${eventId}`;
}

function formatCalendarDateRange(
  event: GoogleCalendarEvent,
  prefix: "start" | "end",
  timeZone: string,
) {
  const dateTime = prefix === "start" ? event.start_date_time : event.end_date_time;
  const date = prefix === "start" ? event.start_date : event.end_date;

  if (dateTime) {
    return {
      dateTime,
      timeZone,
    };
  }

  return {
    date: date ?? undefined,
    timeZone,
  };
}

function searchableCalendarEvent(event: GoogleCalendarEvent): string {
  return [
    event.summary,
    event.description ?? "",
    event.location ?? "",
    ...event.attendees.map((attendee) => attendee.email),
    ...event.attendees.map((attendee) => attendee.display_name ?? ""),
  ]
    .join(" ")
    .toLowerCase();
}

function eventOverlapsRange(event: GoogleCalendarEvent, min: number | null, max: number | null): boolean {
  const start = getEventSortTime(event);
  const end = getEventEndTime(event);

  if (min != null && end <= min) return false;
  if (max != null && start >= max) return false;
  return true;
}

function getEventSortTime(event: GoogleCalendarEvent): number {
  return parseCalendarTimestamp(event.start_date_time, event.start_date);
}

function getEventEndTime(event: GoogleCalendarEvent): number {
  return parseCalendarTimestamp(event.end_date_time, event.end_date);
}

function parseCalendarTimestamp(dateTime: string | null, date: string | null): number {
  if (dateTime) {
    const parsed = Date.parse(dateTime);
    if (Number.isFinite(parsed)) return parsed;
  }

  if (date) {
    const parsed = Date.parse(`${date}T00:00:00.000Z`);
    if (Number.isFinite(parsed)) return parsed;
  }

  return Date.now();
}
