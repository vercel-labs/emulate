export function buildCalendarDiscoveryDocument(baseUrl: string) {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");
  const rootUrl = `${normalizedBaseUrl}/`;
  const calendarBaseUrl = `${normalizedBaseUrl}/calendar/v3/`;

  return {
    kind: "discovery#restDescription",
    discoveryVersion: "v1",
    id: "calendar:v3",
    name: "calendar",
    version: "v3",
    title: "Calendar API",
    description: "Emulated Google Calendar API for local development and testing.",
    protocol: "rest",
    rootUrl,
    servicePath: "calendar/v3/",
    basePath: new URL(calendarBaseUrl).pathname,
    baseUrl: calendarBaseUrl,
    batchPath: "batch/calendar/v3",
    parameters: {},
    schemas: {
      CalendarList: {
        id: "CalendarList",
        type: "object",
        description: "A collection of calendars in the authenticated user's calendar list.",
        properties: {
          kind: { type: "string", description: "Identifies this as a calendar list." },
          items: {
            type: "array",
            description: "Calendars in the list.",
            items: { $ref: "CalendarListEntry" },
          },
        },
      },
      CalendarListEntry: {
        id: "CalendarListEntry",
        type: "object",
        description: "A calendar in the authenticated user's calendar list.",
        properties: {
          kind: { type: "string", description: "Identifies this as a calendar list entry." },
          etag: { type: "string", description: "ETag of the entry." },
          id: { type: "string", description: "Calendar identifier." },
          summary: { type: "string", description: "Calendar title." },
          description: { type: "string", description: "Calendar description." },
          timeZone: { type: "string", description: "Calendar time zone." },
          selected: { type: "boolean", description: "Whether the calendar is selected in the UI." },
          primary: { type: "boolean", description: "Whether this is the authenticated user's primary calendar." },
          accessRole: { type: "string", description: "Authenticated user's access role for the calendar." },
          backgroundColor: { type: "string", description: "Calendar background color." },
          foregroundColor: { type: "string", description: "Calendar foreground color." },
        },
      },
      Events: {
        id: "Events",
        type: "object",
        description: "Events returned from a calendar.",
        properties: {
          kind: { type: "string", description: "Identifies this as an events collection." },
          nextPageToken: { type: "string", description: "Token for the next page of results." },
          items: {
            type: "array",
            description: "Events on the calendar.",
            items: { $ref: "Event" },
          },
        },
      },
      Event: {
        id: "Event",
        type: "object",
        description: "A Google Calendar event.",
        properties: {
          kind: { type: "string", description: "Identifies this as an event." },
          etag: { type: "string", description: "ETag of the event." },
          id: { type: "string", description: "Event identifier." },
          status: { type: "string", description: "Event status." },
          htmlLink: { type: "string", description: "Absolute link to the event in Google Calendar." },
          hangoutLink: { type: "string", description: "Absolute link to the associated video conference." },
          summary: { type: "string", description: "Event title." },
          description: { type: "string", description: "Event description." },
          location: { type: "string", description: "Geographic location of the event." },
          created: { type: "string", format: "date-time", description: "Creation time." },
          updated: { type: "string", format: "date-time", description: "Last modification time." },
          start: { $ref: "EventDateTime", description: "Event start time." },
          end: { $ref: "EventDateTime", description: "Event end time." },
          attendees: {
            type: "array",
            description: "Event attendees.",
            items: { $ref: "EventAttendee" },
          },
          conferenceData: { $ref: "ConferenceData", description: "Conference details for the event." },
          transparency: { type: "string", description: "Whether the event blocks time on the calendar." },
        },
      },
      EventDateTime: {
        id: "EventDateTime",
        type: "object",
        description: "An event date or date and time.",
        properties: {
          date: { type: "string", format: "date", description: "Date for an all-day event." },
          dateTime: { type: "string", format: "date-time", description: "Date and time for a timed event." },
          timeZone: { type: "string", description: "Time zone for the value." },
        },
      },
      EventAttendee: {
        id: "EventAttendee",
        type: "object",
        description: "An attendee of an event.",
        properties: {
          email: { type: "string", description: "Attendee email address." },
          displayName: { type: "string", description: "Attendee display name." },
          responseStatus: { type: "string", description: "Attendee response status." },
          organizer: { type: "boolean", description: "Whether the attendee is the organizer." },
          self: { type: "boolean", description: "Whether this attendee represents the authenticated user." },
        },
      },
      ConferenceData: {
        id: "ConferenceData",
        type: "object",
        description: "Conference information attached to an event.",
        properties: {
          entryPoints: {
            type: "array",
            description: "Ways to join the conference.",
            items: { $ref: "EntryPoint" },
          },
        },
      },
      EntryPoint: {
        id: "EntryPoint",
        type: "object",
        description: "A way to join an event conference.",
        properties: {
          entryPointType: { type: "string", description: "Type of conference entry point." },
          uri: { type: "string", description: "URI for joining the conference." },
          label: { type: "string", description: "User-visible entry point label." },
        },
      },
      FreeBusyRequest: {
        id: "FreeBusyRequest",
        type: "object",
        description: "A free and busy query.",
        properties: {
          timeMin: {
            type: "string",
            format: "date-time",
            description: "Start of the query interval.",
            required: true,
          },
          timeMax: {
            type: "string",
            format: "date-time",
            description: "End of the query interval.",
            required: true,
          },
          items: {
            type: "array",
            description: "Calendars to query.",
            required: true,
            items: { $ref: "FreeBusyRequestItem" },
          },
        },
      },
      FreeBusyRequestItem: {
        id: "FreeBusyRequestItem",
        type: "object",
        description: "A calendar requested in a free and busy query.",
        properties: {
          id: { type: "string", description: "Calendar identifier.", required: true },
        },
      },
      FreeBusyResponse: {
        id: "FreeBusyResponse",
        type: "object",
        description: "Free and busy information for requested calendars.",
        properties: {
          kind: { type: "string", description: "Identifies this as a free and busy response." },
          timeMin: { type: "string", format: "date-time", description: "Start of the query interval." },
          timeMax: { type: "string", format: "date-time", description: "End of the query interval." },
          calendars: {
            type: "object",
            description: "Free and busy results keyed by calendar identifier.",
            additionalProperties: { $ref: "FreeBusyCalendar" },
          },
        },
      },
      FreeBusyCalendar: {
        id: "FreeBusyCalendar",
        type: "object",
        description: "Free and busy intervals for one calendar.",
        properties: {
          busy: {
            type: "array",
            description: "Intervals during which the calendar is busy.",
            items: { $ref: "TimePeriod" },
          },
        },
      },
      TimePeriod: {
        id: "TimePeriod",
        type: "object",
        description: "A time interval.",
        properties: {
          start: { type: "string", format: "date-time", description: "Start of the interval." },
          end: { type: "string", format: "date-time", description: "End of the interval." },
        },
      },
    },
    resources: {
      calendarList: {
        methods: {
          list: {
            id: "calendar.calendarList.list",
            path: "users/me/calendarList",
            httpMethod: "GET",
            description: "Returns the calendars in the authenticated user's calendar list.",
            parameterOrder: [],
            parameters: {},
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
                type: "string",
                description: "Calendar identifier. Use primary for the authenticated user's primary calendar.",
                location: "path",
                required: true,
              },
              timeMin: {
                type: "string",
                format: "date-time",
                description: "Lower bound for event end times.",
                location: "query",
              },
              timeMax: {
                type: "string",
                format: "date-time",
                description: "Upper bound for event start times.",
                location: "query",
              },
              maxResults: {
                type: "integer",
                format: "int32",
                description: "Maximum number of events returned on one page.",
                location: "query",
                minimum: "1",
                maximum: "250",
              },
              pageToken: {
                type: "string",
                description: "Token specifying the result page to return.",
                location: "query",
              },
              q: {
                type: "string",
                description: "Free text search terms.",
                location: "query",
              },
              orderBy: {
                type: "string",
                description: "Order of events in the result.",
                location: "query",
                enum: ["startTime"],
              },
              singleEvents: {
                type: "boolean",
                description: "Whether recurring events should be expanded into instances.",
                location: "query",
              },
            },
            response: { $ref: "Events" },
          },
          insert: {
            id: "calendar.events.insert",
            path: "calendars/{calendarId}/events",
            httpMethod: "POST",
            description: "Creates an event on the specified calendar.",
            parameterOrder: ["calendarId"],
            parameters: {
              calendarId: {
                type: "string",
                description: "Calendar identifier. Use primary for the authenticated user's primary calendar.",
                location: "path",
                required: true,
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
                type: "string",
                description: "Calendar identifier. Use primary for the authenticated user's primary calendar.",
                location: "path",
                required: true,
              },
              eventId: {
                type: "string",
                description: "Event identifier.",
                location: "path",
                required: true,
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
            description: "Returns free and busy information for a set of calendars.",
            parameterOrder: [],
            parameters: {},
            request: { $ref: "FreeBusyRequest" },
            response: { $ref: "FreeBusyResponse" },
          },
        },
      },
    },
  };
}
