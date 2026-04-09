import type { RouteContext } from "@emulators/core";
import {
  buildFreeBusyResponse,
  createCalendarEventRecord,
  deleteCalendarEventRecord,
  formatCalendarEventResource,
  formatCalendarResource,
  getCalendarById,
  getCalendarEventById,
  listCalendarEvents,
  listCalendarsForUser,
} from "../calendar-helpers.js";
import { googleApiError } from "../helpers.js";
import {
  getRecord,
  getRecordArray,
  parseCalendarEventInputFromBody,
  parseGoogleBody,
  requireGoogleAuth,
  requireGmailUser,
} from "../route-helpers.js";
import { getGoogleStore } from "../store.js";

export function calendarRoutes({ app, store, baseUrl }: RouteContext): void {
  const gs = getGoogleStore(store);

  // Google API Discovery Document for Calendar v3.
  // Enables google-api-python-client build("calendar", "v3") and similar SDK bootstrapping.
  // Returns a minimal document describing the routes this emulator actually implements.
  // No auth required — matches real Google behavior.
  app.get("/discovery/v1/apis/calendar/v3/rest", (c) => {
    const origin = baseUrl || new URL(c.req.url).origin;
    return c.json({
      kind: "discovery#restDescription",
      discoveryVersion: "v1",
      id: "calendar:v3",
      name: "calendar",
      version: "v3",
      title: "Calendar API",
      description: "Manipulates events and other calendar data.",
      protocol: "rest",
      rootUrl: `${origin}/`,
      basePath: "/calendar/v3/",
      baseUrl: `${origin}/calendar/v3/`,
      servicePath: "calendar/v3/",
      batchPath: "batch/calendar/v3",
      parameters: {},
      schemas: {},
      resources: {
        calendarList: {
          methods: {
            list: {
              id: "calendar.calendarList.list",
              path: "users/me/calendarList",
              httpMethod: "GET",
              description: "Returns the calendars on the user's calendar list.",
              response: { $ref: "CalendarList" },
            },
          },
        },
        events: {
          methods: {
            list: {
              id: "calendar.events.list",
              path: "calendars/{calendarId}/events",
              httpMethod: "GET",
              description: "Returns events on the specified calendar.",
              parameters: {
                calendarId: { type: "string", required: true, location: "path" },
                timeMin: { type: "string", location: "query", description: "Lower bound (RFC3339) for event end time." },
                timeMax: { type: "string", location: "query", description: "Upper bound (RFC3339) for event start time." },
                maxResults: { type: "integer", location: "query", description: "Maximum number of events returned." },
                pageToken: { type: "string", location: "query", description: "Token for pagination." },
                q: { type: "string", location: "query", description: "Free text search terms." },
                orderBy: { type: "string", location: "query", description: "Sort order (startTime or updated)." },
                singleEvents: { type: "boolean", location: "query", description: "Whether to expand recurring events into instances." },
                showDeleted: { type: "boolean", location: "query", description: "Whether to include deleted events." },
              },
              response: { $ref: "Events" },
            },
            insert: {
              id: "calendar.events.insert",
              path: "calendars/{calendarId}/events",
              httpMethod: "POST",
              description: "Creates an event.",
              parameters: {
                calendarId: { type: "string", required: true, location: "path" },
              },
              request: { $ref: "Event" },
              response: { $ref: "Event" },
            },
            delete: {
              id: "calendar.events.delete",
              path: "calendars/{calendarId}/events/{eventId}",
              httpMethod: "DELETE",
              description: "Deletes an event.",
              parameters: {
                calendarId: { type: "string", required: true, location: "path" },
                eventId: { type: "string", required: true, location: "path" },
              },
            },
          },
        },
        freebusy: {
          methods: {
            query: {
              id: "calendar.freebusy.query",
              path: "freeBusy",
              httpMethod: "POST",
              description: "Returns free/busy information for a set of calendars and groups.",
              request: { $ref: "FreeBusyRequest" },
              response: { $ref: "FreeBusyResponse" },
            },
          },
        },
      },
    });
  });

  app.get("/calendar/v3/users/:userId/calendarList", (c) => {
    const authEmail = requireGmailUser(c);
    if (authEmail instanceof Response) return authEmail;

    return c.json({
      kind: "calendar#calendarList",
      items: listCalendarsForUser(gs, authEmail).map((calendar) => formatCalendarResource(calendar)),
    });
  });

  app.get("/calendar/v3/calendars/:calendarId/events", (c) => {
    const authEmail = requireGoogleAuth(c);
    if (authEmail instanceof Response) return authEmail;

    const calendar = getCalendarById(gs, authEmail, c.req.param("calendarId"));
    if (!calendar) {
      return googleApiError(c, 404, "Requested entity was not found.", "notFound", "NOT_FOUND");
    }

    const url = new URL(c.req.url);
    const response = listCalendarEvents(gs, authEmail, calendar.google_id, {
      timeMin: url.searchParams.get("timeMin"),
      timeMax: url.searchParams.get("timeMax"),
      maxResults: url.searchParams.get("maxResults"),
      pageToken: url.searchParams.get("pageToken"),
      q: url.searchParams.get("q"),
      orderBy: url.searchParams.get("orderBy"),
    });

    return c.json({
      kind: "calendar#events",
      items: response.items.map((event) => formatCalendarEventResource(gs, event)),
      nextPageToken: response.nextPageToken,
    });
  });

  app.post("/calendar/v3/calendars/:calendarId/events", async (c) => {
    const authEmail = requireGoogleAuth(c);
    if (authEmail instanceof Response) return authEmail;

    const calendar = getCalendarById(gs, authEmail, c.req.param("calendarId"));
    if (!calendar) {
      return googleApiError(c, 404, "Requested entity was not found.", "notFound", "NOT_FOUND");
    }

    const body = await parseGoogleBody(c);
    const requestBody = getRecord(body, "requestBody") ?? body;
    const eventInput = parseCalendarEventInputFromBody(requestBody);

    if (
      (!eventInput.start_date_time && !eventInput.start_date) ||
      (!eventInput.end_date_time && !eventInput.end_date)
    ) {
      return googleApiError(c, 400, "Event start and end are required.", "invalidArgument", "INVALID_ARGUMENT");
    }

    const event = createCalendarEventRecord(gs, {
      user_email: authEmail,
      calendar_google_id: calendar.google_id,
      ...eventInput,
    });

    return c.json(formatCalendarEventResource(gs, event));
  });

  app.delete("/calendar/v3/calendars/:calendarId/events/:eventId", (c) => {
    const authEmail = requireGoogleAuth(c);
    if (authEmail instanceof Response) return authEmail;

    const event = getCalendarEventById(gs, authEmail, c.req.param("calendarId"), c.req.param("eventId"));
    if (!event) {
      return googleApiError(c, 404, "Requested entity was not found.", "notFound", "NOT_FOUND");
    }

    deleteCalendarEventRecord(gs, event);
    return c.body(null, 204);
  });

  app.post("/calendar/v3/freeBusy", async (c) => {
    const authEmail = requireGoogleAuth(c);
    if (authEmail instanceof Response) return authEmail;

    const body = await parseGoogleBody(c);
    const requestBody = getRecord(body, "requestBody") ?? body;
    const timeMin = typeof requestBody.timeMin === "string" ? requestBody.timeMin : undefined;
    const timeMax = typeof requestBody.timeMax === "string" ? requestBody.timeMax : undefined;
    const items = getRecordArray(requestBody, "items")
      .map((entry) => ({
        id: typeof entry.id === "string" ? entry.id : "",
      }))
      .filter((entry) => entry.id.length > 0);

    if (!timeMin || !timeMax) {
      return googleApiError(c, 400, "timeMin and timeMax are required.", "invalidArgument", "INVALID_ARGUMENT");
    }

    return c.json(
      buildFreeBusyResponse(gs, authEmail, {
        timeMin,
        timeMax,
        items,
      }),
    );
  });
}
