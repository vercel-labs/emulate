const commonParameters = {
  alt: {
    type: "string",
    description: "Data format for the response.",
    enum: ["json"],
    default: "json",
    location: "query",
  },
  fields: {
    type: "string",
    description: "Selector specifying which fields to include in a partial response.",
    location: "query",
  },
  key: {
    type: "string",
    description: "API key for the current project.",
    location: "query",
  },
  oauth_token: {
    type: "string",
    description: "OAuth 2.0 token for the current user.",
    location: "query",
  },
  prettyPrint: {
    type: "boolean",
    description: "Returns the response with indentations and line breaks.",
    default: "true",
    location: "query",
  },
  quotaUser: {
    type: "string",
    description: "An opaque string that represents a user for quota purposes.",
    location: "query",
  },
  userIp: {
    type: "string",
    description: "Deprecated. Please use quotaUser instead.",
    location: "query",
  },
};

const calendarScopes = {
  "https://www.googleapis.com/auth/calendar": {
    description: "See, edit, share, and permanently delete all the calendars you can access using Google Calendar",
  },
  "https://www.googleapis.com/auth/calendar.acls": {
    description: "See and change the sharing permissions of Google calendars you own",
  },
  "https://www.googleapis.com/auth/calendar.acls.readonly": {
    description: "See the sharing permissions of Google calendars you own",
  },
  "https://www.googleapis.com/auth/calendar.app.created": {
    description: "Make secondary Google calendars, and see, create, change, and delete events on them",
  },
  "https://www.googleapis.com/auth/calendar.calendars": {
    description: "See and change the properties of Google calendars you have access to, and create secondary calendars",
  },
  "https://www.googleapis.com/auth/calendar.calendars.readonly": {
    description:
      "See the title, description, default time zone, and other properties of Google calendars you have access to",
  },
  "https://www.googleapis.com/auth/calendar.calendarlist": {
    description: "See, add, and remove Google calendars you are subscribed to",
  },
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly": {
    description: "See the list of Google calendars you are subscribed to",
  },
  "https://www.googleapis.com/auth/calendar.events": {
    description: "View and edit events on all your calendars",
  },
  "https://www.googleapis.com/auth/calendar.events.freebusy": {
    description: "See the availability on Google calendars you have access to",
  },
  "https://www.googleapis.com/auth/calendar.events.owned": {
    description: "See, create, change, and delete events on Google calendars you own",
  },
  "https://www.googleapis.com/auth/calendar.events.owned.readonly": {
    description: "See the events on Google calendars you own",
  },
  "https://www.googleapis.com/auth/calendar.events.public.readonly": {
    description: "See the events on public calendars",
  },
  "https://www.googleapis.com/auth/calendar.events.readonly": {
    description: "View events on all your calendars",
  },
  "https://www.googleapis.com/auth/calendar.freebusy": {
    description: "View your availability in your calendars",
  },
  "https://www.googleapis.com/auth/calendar.readonly": {
    description: "See and download any calendar you can access using your Google Calendar",
  },
};

const calendarIdParameter = {
  type: "string",
  description: 'Calendar identifier. Use the "primary" keyword to access the primary calendar.',
  location: "path",
  required: true,
};

const userIdParameter = {
  type: "string",
  description: 'User identifier. Use the "me" keyword to refer to the authenticated user.',
  location: "path",
  required: true,
};

const eventListParameters = {
  calendarId: calendarIdParameter,
  maxResults: {
    type: "integer",
    format: "int32",
    minimum: "1",
    location: "query",
    description: "Maximum number of events returned on one result page.",
  },
  orderBy: {
    type: "string",
    enum: ["startTime", "updated"],
    location: "query",
    description: "The order of the events returned in the result.",
  },
  pageToken: {
    type: "string",
    location: "query",
    description: "Token specifying which result page to return.",
  },
  q: {
    type: "string",
    location: "query",
    description: "Free text search terms to find events.",
  },
  timeMax: {
    type: "string",
    format: "date-time",
    location: "query",
    description: "Upper bound for an event's start time to filter by.",
  },
  timeMin: {
    type: "string",
    format: "date-time",
    location: "query",
    description: "Lower bound for an event's end time to filter by.",
  },
};

export function buildCalendarDiscoveryDocument(baseUrl: string) {
  const rootUrl = `${baseUrl.replace(/\/$/, "")}/`;

  return {
    kind: "discovery#restDescription",
    discoveryVersion: "v1",
    id: "calendar:v3",
    name: "calendar",
    version: "v3",
    revision: "local",
    title: "Calendar API",
    description: "Manipulates events and other calendar data.",
    documentationLink: "https://developers.google.com/workspace/calendar/firstapp",
    protocol: "rest",
    rootUrl,
    servicePath: "calendar/v3/",
    basePath: "/calendar/v3/",
    baseUrl: `${rootUrl}calendar/v3/`,
    parameters: commonParameters,
    auth: {
      oauth2: {
        scopes: calendarScopes,
      },
    },
    resources: {
      calendarList: {
        methods: {
          list: {
            id: "calendar.calendarList.list",
            path: "users/{userId}/calendarList",
            httpMethod: "GET",
            description: "Returns the calendars on the user's calendar list.",
            parameterOrder: ["userId"],
            parameters: {
              userId: userIdParameter,
            },
            response: { $ref: "CalendarList" },
            scopes: [
              "https://www.googleapis.com/auth/calendar",
              "https://www.googleapis.com/auth/calendar.calendarlist",
              "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
              "https://www.googleapis.com/auth/calendar.readonly",
            ],
          },
        },
      },
      events: {
        methods: {
          get: {
            id: "calendar.events.get",
            path: "calendars/{calendarId}/events/{eventId}",
            httpMethod: "GET",
            description: "Returns an event.",
            parameterOrder: ["calendarId", "eventId"],
            parameters: {
              calendarId: calendarIdParameter,
              eventId: { type: "string", location: "path", required: true },
            },
            response: { $ref: "Event" },
            scopes: [
              "https://www.googleapis.com/auth/calendar",
              "https://www.googleapis.com/auth/calendar.events",
              "https://www.googleapis.com/auth/calendar.readonly",
              "https://www.googleapis.com/auth/calendar.events.readonly",
            ],
          },
          patch: {
            id: "calendar.events.patch",
            path: "calendars/{calendarId}/events/{eventId}",
            httpMethod: "PATCH",
            description: "Updates supplied event fields, preserving omitted fields.",
            parameterOrder: ["calendarId", "eventId"],
            parameters: {
              calendarId: calendarIdParameter,
              eventId: { type: "string", location: "path", required: true },
            },
            request: { $ref: "Event" },
            response: { $ref: "Event" },
            scopes: ["https://www.googleapis.com/auth/calendar", "https://www.googleapis.com/auth/calendar.events"],
          },

          list: {
            id: "calendar.events.list",
            path: "calendars/{calendarId}/events",
            httpMethod: "GET",
            description: "Returns events on the specified calendar.",
            parameterOrder: ["calendarId"],
            parameters: eventListParameters,
            response: { $ref: "Events" },
            scopes: [
              "https://www.googleapis.com/auth/calendar",
              "https://www.googleapis.com/auth/calendar.app.created",
              "https://www.googleapis.com/auth/calendar.events",
              "https://www.googleapis.com/auth/calendar.events.freebusy",
              "https://www.googleapis.com/auth/calendar.events.owned",
              "https://www.googleapis.com/auth/calendar.events.owned.readonly",
              "https://www.googleapis.com/auth/calendar.events.public.readonly",
              "https://www.googleapis.com/auth/calendar.events.readonly",
              "https://www.googleapis.com/auth/calendar.readonly",
            ],
          },
          insert: {
            id: "calendar.events.insert",
            path: "calendars/{calendarId}/events",
            httpMethod: "POST",
            description: "Creates an event.",
            parameterOrder: ["calendarId"],
            parameters: { calendarId: calendarIdParameter },
            request: { $ref: "Event" },
            response: { $ref: "Event" },
            scopes: [
              "https://www.googleapis.com/auth/calendar",
              "https://www.googleapis.com/auth/calendar.app.created",
              "https://www.googleapis.com/auth/calendar.events",
              "https://www.googleapis.com/auth/calendar.events.owned",
            ],
          },
          delete: {
            id: "calendar.events.delete",
            path: "calendars/{calendarId}/events/{eventId}",
            httpMethod: "DELETE",
            description: "Deletes an event.",
            parameterOrder: ["calendarId", "eventId"],
            parameters: {
              calendarId: calendarIdParameter,
              eventId: {
                type: "string",
                description: "Event identifier.",
                location: "path",
                required: true,
              },
            },
            scopes: [
              "https://www.googleapis.com/auth/calendar",
              "https://www.googleapis.com/auth/calendar.app.created",
              "https://www.googleapis.com/auth/calendar.events",
              "https://www.googleapis.com/auth/calendar.events.owned",
            ],
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
            scopes: [
              "https://www.googleapis.com/auth/calendar",
              "https://www.googleapis.com/auth/calendar.events.freebusy",
              "https://www.googleapis.com/auth/calendar.freebusy",
              "https://www.googleapis.com/auth/calendar.readonly",
            ],
          },
        },
      },
    },
    schemas: {
      CalendarList: {
        id: "CalendarList",
        type: "object",
        properties: {
          kind: { type: "string" },
          nextPageToken: { type: "string" },
          items: { type: "array", items: { $ref: "CalendarListEntry" } },
        },
      },
      CalendarListEntry: {
        id: "CalendarListEntry",
        type: "object",
        properties: {
          kind: { type: "string" },
          id: { type: "string" },
          summary: { type: "string" },
          description: { type: "string" },
          timeZone: { type: "string" },
          primary: { type: "boolean" },
          selected: { type: "boolean" },
          accessRole: { type: "string" },
        },
      },
      Event: {
        id: "Event",
        type: "object",
        properties: {
          kind: { type: "string" },
          id: { type: "string" },
          status: { type: "string" },
          summary: { type: "string" },
          description: { type: "string" },
          location: { type: "string" },
          start: { $ref: "EventDateTime" },
          end: { $ref: "EventDateTime" },
          organizer: { type: "object", properties: { email: { type: "string" } } },
          attendees: { type: "array", items: { $ref: "EventAttendee" } },
          hangoutLink: { type: "string" },
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
      EventDateTime: {
        id: "EventDateTime",
        type: "object",
        properties: {
          date: { type: "string", format: "date" },
          dateTime: { type: "string", format: "date-time" },
          timeZone: { type: "string" },
        },
      },
      Events: {
        id: "Events",
        type: "object",
        properties: {
          kind: { type: "string" },
          nextPageToken: { type: "string" },
          items: { type: "array", items: { $ref: "Event" } },
        },
      },
      FreeBusyCalendar: {
        id: "FreeBusyCalendar",
        type: "object",
        properties: {
          errors: { type: "array", items: { type: "object" } },
          busy: { type: "array", items: { $ref: "TimePeriod" } },
        },
      },
      FreeBusyRequest: {
        id: "FreeBusyRequest",
        type: "object",
        properties: {
          timeMin: { type: "string", format: "date-time" },
          timeMax: { type: "string", format: "date-time" },
          items: { type: "array", items: { $ref: "FreeBusyRequestItem" } },
        },
      },
      FreeBusyRequestItem: {
        id: "FreeBusyRequestItem",
        type: "object",
        properties: {
          id: { type: "string" },
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
      TimePeriod: {
        id: "TimePeriod",
        type: "object",
        properties: {
          start: { type: "string", format: "date-time" },
          end: { type: "string", format: "date-time" },
        },
      },
    },
  };
}
