import type { RouteContext } from "@emulators/core";

const servicePath = "calendar/v3/";
const basePath = "/calendar/v3/";

export function calendarDiscoveryRoutes({ app, baseUrl }: Pick<RouteContext, "app" | "baseUrl">): void {
  app.get("/discovery/v1/apis/calendar/v3/rest", () => {
    const serviceBaseUrl = baseUrl.replace(/\/+$/, "");

    return Response.json({
      kind: "discovery#restDescription",
      discoveryVersion: "v1",
      id: "calendar:v3",
      name: "calendar",
      version: "v3",
      revision: "emulate",
      title: "Calendar API",
      description: "Manipulates events and other calendar data.",
      documentationLink: "https://developers.google.com/workspace/calendar/firstapp",
      ownerDomain: "google.com",
      ownerName: "Google",
      protocol: "rest",
      baseUrl: `${serviceBaseUrl}/${servicePath}`,
      basePath,
      rootUrl: `${serviceBaseUrl}/`,
      servicePath,
      batchPath: "batch/calendar/v3",
      parameters: {
        alt: { type: "string", location: "query", default: "json", enum: ["json"] },
        fields: { type: "string", location: "query" },
        key: { type: "string", location: "query" },
        oauth_token: { type: "string", location: "query" },
        prettyPrint: { type: "boolean", location: "query", default: "true" },
      },
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
              parameterOrder: ["calendarId"],
              parameters: {
                calendarId: {
                  location: "path",
                  type: "string",
                  required: true,
                  description:
                    "Calendar identifier. Use the primary keyword for the authenticated user's primary calendar.",
                },
                timeMin: {
                  location: "query",
                  type: "string",
                  format: "date-time",
                  description: "Lower bound for an event's end time to filter by.",
                },
                timeMax: {
                  location: "query",
                  type: "string",
                  format: "date-time",
                  description: "Upper bound for an event's start time to filter by.",
                },
                maxResults: {
                  location: "query",
                  type: "integer",
                  format: "int32",
                  description: "Maximum number of events returned on one page.",
                },
                pageToken: {
                  location: "query",
                  type: "string",
                  description: "Token specifying which result page to return.",
                },
                q: {
                  location: "query",
                  type: "string",
                  description: "Free text search terms for matching events.",
                },
                orderBy: {
                  location: "query",
                  type: "string",
                  description: "The order of the events returned in the result.",
                },
              },
              response: { $ref: "Events" },
            },
            insert: {
              id: "calendar.events.insert",
              path: "calendars/{calendarId}/events",
              httpMethod: "POST",
              description: "Creates an event.",
              parameterOrder: ["calendarId"],
              parameters: {
                calendarId: {
                  location: "path",
                  type: "string",
                  required: true,
                  description:
                    "Calendar identifier. Use the primary keyword for the authenticated user's primary calendar.",
                },
              },
              request: { $ref: "Event" },
              response: { $ref: "Event" },
            },
            delete: {
              id: "calendar.events.delete",
              path: "calendars/{calendarId}/events/{eventId}",
              httpMethod: "DELETE",
              description: "Deletes an event.",
              parameterOrder: ["calendarId", "eventId"],
              parameters: {
                calendarId: {
                  location: "path",
                  type: "string",
                  required: true,
                  description:
                    "Calendar identifier. Use the primary keyword for the authenticated user's primary calendar.",
                },
                eventId: {
                  location: "path",
                  type: "string",
                  required: true,
                  description: "Event identifier.",
                },
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
              description: "Returns free/busy information for a set of calendars.",
              request: { $ref: "FreeBusyRequest" },
              response: { $ref: "FreeBusyResponse" },
            },
          },
        },
      },
      schemas: {
        CalendarListEntry: {
          id: "CalendarListEntry",
          type: "object",
          properties: {
            kind: { type: "string" },
            etag: { type: "string" },
            id: { type: "string" },
            summary: { type: "string" },
            description: { type: "string" },
            timeZone: { type: "string" },
            selected: { type: "boolean" },
            primary: { type: "boolean" },
            accessRole: { type: "string" },
            backgroundColor: { type: "string" },
            foregroundColor: { type: "string" },
          },
        },
        CalendarList: {
          id: "CalendarList",
          type: "object",
          properties: {
            kind: { type: "string" },
            items: { type: "array", items: { $ref: "CalendarListEntry" } },
            nextPageToken: { type: "string" },
          },
        },
        EventDateTime: {
          id: "EventDateTime",
          type: "object",
          properties: {
            dateTime: { type: "string", format: "date-time" },
            date: { type: "string", format: "date" },
            timeZone: { type: "string" },
          },
        },
        EventAttendee: {
          id: "EventAttendee",
          type: "object",
          properties: {
            email: { type: "string" },
            displayName: { type: "string" },
            responseStatus: { type: "string" },
            organizer: { type: "boolean" },
            self: { type: "boolean" },
          },
        },
        EntryPoint: {
          id: "EntryPoint",
          type: "object",
          properties: {
            entryPointType: { type: "string" },
            uri: { type: "string" },
            label: { type: "string" },
          },
        },
        ConferenceData: {
          id: "ConferenceData",
          type: "object",
          properties: {
            entryPoints: { type: "array", items: { $ref: "EntryPoint" } },
          },
        },
        Event: {
          id: "Event",
          type: "object",
          properties: {
            kind: { type: "string" },
            etag: { type: "string" },
            id: { type: "string" },
            status: { type: "string" },
            htmlLink: { type: "string" },
            hangoutLink: { type: "string" },
            summary: { type: "string" },
            description: { type: "string" },
            location: { type: "string" },
            created: { type: "string", format: "date-time" },
            updated: { type: "string", format: "date-time" },
            start: { $ref: "EventDateTime" },
            end: { $ref: "EventDateTime" },
            attendees: { type: "array", items: { $ref: "EventAttendee" } },
            conferenceData: { $ref: "ConferenceData" },
            transparency: { type: "string" },
          },
        },
        Events: {
          id: "Events",
          type: "object",
          properties: {
            kind: { type: "string" },
            etag: { type: "string" },
            summary: { type: "string" },
            description: { type: "string" },
            timeZone: { type: "string" },
            accessRole: { type: "string" },
            items: { type: "array", items: { $ref: "Event" } },
            nextPageToken: { type: "string" },
          },
        },
        FreeBusyRequestItem: {
          id: "FreeBusyRequestItem",
          type: "object",
          properties: {
            id: { type: "string" },
          },
        },
        FreeBusyRequest: {
          id: "FreeBusyRequest",
          type: "object",
          properties: {
            timeMin: { type: "string", format: "date-time" },
            timeMax: { type: "string", format: "date-time" },
            timeZone: { type: "string" },
            items: { type: "array", items: { $ref: "FreeBusyRequestItem" } },
          },
        },
        TimePeriod: {
          id: "TimePeriod",
          type: "object",
          properties: {
            start: { type: "string", format: "date-time" },
            end: { type: "string", format: "date-time" },
          },
        },
        FreeBusyCalendar: {
          id: "FreeBusyCalendar",
          type: "object",
          properties: {
            busy: { type: "array", items: { $ref: "TimePeriod" } },
          },
        },
        FreeBusyResponse: {
          id: "FreeBusyResponse",
          type: "object",
          properties: {
            kind: { type: "string" },
            timeMin: { type: "string", format: "date-time" },
            timeMax: { type: "string", format: "date-time" },
            calendars: {
              type: "object",
              additionalProperties: { $ref: "FreeBusyCalendar" },
            },
          },
        },
      },
    });
  });
}
