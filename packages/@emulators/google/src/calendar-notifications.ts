import { randomUUID } from "node:crypto";
import type { RouteContext } from "@emulators/core";
import { getCalendarById } from "./calendar-helpers.js";
import { googleApiError } from "./helpers.js";
import { parseGoogleBody, requireGoogleAuth } from "./route-helpers.js";
import { getGoogleStore, type GoogleStore } from "./store.js";
import type { GoogleCalendarChannel } from "./entities.js";

async function deliver(gs: GoogleStore, channel: GoogleCalendarChannel, state: "sync" | "exists") {
  if (channel.expiration <= Date.now() || !gs.calendarChannels.get(channel.id)) return;
  const messageNumber = channel.message_number + 1;
  gs.calendarChannels.update(channel.id, { message_number: messageNumber });
  let status: number | null = null;
  try {
    const response = await fetch(channel.address, {
      method: "POST",
      headers: {
        "X-Goog-Channel-ID": channel.channel_id,
        "X-Goog-Resource-ID": channel.resource_id,
        "X-Goog-Resource-URI": channel.resource_uri,
        "X-Goog-Resource-State": state,
        "X-Goog-Message-Number": String(messageNumber),
        "X-Goog-Channel-Expiration": new Date(channel.expiration).toUTCString(),
        ...(channel.token ? { "X-Goog-Channel-Token": channel.token } : {}),
      },
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    });
    status = response.status;
    await response.body?.cancel();
  } catch {
    // A failed callback must not roll back a committed Calendar mutation.
  }
  if (gs.calendarChannels.get(channel.id)?.resource_id === channel.resource_id) {
    gs.calendarChannels.update(channel.id, { last_delivery_status: status });
  }
}

async function notifyCalendarChange(gs: GoogleStore, email: string, calendarId: string): Promise<void> {
  await Promise.all(
    gs.calendarChannels
      .findBy("user_email", email)
      .filter((channel) => channel.calendar_google_id === calendarId)
      .map((channel) => deliver(gs, channel, "exists")),
  );
}

export function calendarNotificationRoutes({ app, store, baseUrl }: RouteContext): void {
  const gs = getGoogleStore(store);
  // Observe committed event changes independently of the mutation handlers.
  app.use("/calendar/v3/calendars/:calendarId/:eventPath{events(?:/[^/]+)?}", async (c, next) => {
    const createsEvent = c.req.method === "POST" && /\/events\/?$/.test(c.req.path);
    const changesEvent = ["PATCH", "DELETE"].includes(c.req.method) && /\/events\/[^/]+$/.test(c.req.path);
    if (!createsEvent && !changesEvent) return next();
    const email = requireGoogleAuth(c);
    if (email instanceof Response) return next();
    const calendar = getCalendarById(gs, email, c.req.param("calendarId"));
    if (!calendar) return next();
    const eventState = () =>
      JSON.stringify(
        gs.calendarEvents
          .findBy("user_email", email)
          .filter((event) => event.calendar_google_id === calendar.google_id),
      );
    const before = eventState();
    await next();
    if (before !== eventState()) await notifyCalendarChange(gs, email, calendar.google_id);
  });

  app.post("/calendar/v3/calendars/:calendarId/events/watch", async (c) => {
    const email = requireGoogleAuth(c);
    if (email instanceof Response) return email;
    const calendar = getCalendarById(gs, email, c.req.param("calendarId"));
    if (!calendar) return googleApiError(c, 404, "Calendar not found.", "notFound", "NOT_FOUND");
    const body = await parseGoogleBody(c);
    let address: URL;
    try {
      address = new URL(String(body.address));
    } catch {
      return googleApiError(c, 400, "Invalid callback address.", "invalidArgument", "INVALID_ARGUMENT");
    }
    if (
      typeof body.id !== "string" ||
      !body.id ||
      !["web_hook", "webhook"].includes(String(body.type)) ||
      !["http:", "https:"].includes(address.protocol) ||
      address.username ||
      address.password
    ) {
      return googleApiError(c, 400, "Invalid channel.", "invalidArgument", "INVALID_ARGUMENT");
    }
    if (
      gs.calendarChannels.all().some((channel) => channel.channel_id === body.id && channel.expiration > Date.now())
    ) {
      return googleApiError(c, 400, "Channel ID is already in use.", "channelIdNotUnique", "INVALID_ARGUMENT");
    }
    const expiration = Math.min(Number(body.expiration ?? Date.now() + 604800000), Date.now() + 604800000);
    if (!Number.isFinite(expiration) || expiration <= Date.now())
      return googleApiError(c, 400, "Invalid expiration.", "invalidArgument", "INVALID_ARGUMENT");
    const channel = gs.calendarChannels.insert({
      channel_id: body.id,
      user_email: email,
      calendar_google_id: calendar.google_id,
      resource_id: randomUUID(),
      resource_uri: `${baseUrl}/calendar/v3/calendars/${encodeURIComponent(calendar.google_id)}/events`,
      address: address.href,
      token: typeof body.token === "string" ? body.token : undefined,
      expiration,
      message_number: 0,
    });
    await deliver(gs, channel, "sync");
    return c.json({
      kind: "api#channel",
      id: channel.channel_id,
      resourceId: channel.resource_id,
      resourceUri: channel.resource_uri,
      expiration: String(expiration),
      token: channel.token,
    });
  });
  app.post("/calendar/v3/channels/stop", async (c) => {
    const email = requireGoogleAuth(c);
    if (email instanceof Response) return email;
    const body = await parseGoogleBody(c);
    const channel = gs.calendarChannels
      .findBy("user_email", email)
      .find((entry) => entry.channel_id === body.id && entry.resource_id === body.resourceId);
    if (!channel) return googleApiError(c, 404, "Channel not found.", "notFound", "NOT_FOUND");
    gs.calendarChannels.delete(channel.id);
    return c.body(null, 204);
  });
}
