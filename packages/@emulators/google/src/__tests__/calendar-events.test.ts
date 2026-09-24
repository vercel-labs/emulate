import { gzipSync } from "node:zlib";
import { expect, it } from "vitest";
import { Hono, Store, WebhookDispatcher, authMiddleware, type TokenMap } from "@emulators/core";
import { googlePlugin, seedFromConfig } from "../index.js";

it("preserves client event IDs, organizers and omitted fields through Java-style writes", async () => {
  const store = new Store();
  const tokens: TokenMap = new Map([["owner", { login: "owner@example.com", id: 1, scopes: [] }]]);
  const app = new Hono();
  app.use("*", authMiddleware(tokens));
  googlePlugin.register(app, store, new WebhookDispatcher(), "http://localhost", tokens);
  seedFromConfig(store, "http://localhost", {
    users: [{ email: "owner@example.com" }],
    calendars: [
      { id: "room", summary: "Room" },
      { id: "other", summary: "Other" },
    ],
  });
  const path = "/calendar/v3/calendars/room/events";
  const headers = { Authorization: "Bearer owner", "Content-Type": "application/json" };
  const event = {
    id: "booking-id",
    organizer: { email: "organizer@example.com" },
    summary: "Booking",
    start: { date: "2026-09-05" },
    end: { date: "2026-09-06" },
    attendees: [{ email: "guest@example.com" }],
  };
  const post = (url: string, body: unknown) =>
    app.request(url, { method: "POST", headers, body: JSON.stringify(body) });
  expect(await (await post(path, event)).json()).toMatchObject(event);
  expect((await post(path, event)).status).toBe(409);
  expect((await post(path.replace("/room/", "/other/"), event)).status).toBe(200);
  expect((await post(path, { ...event, id: "recur", recurrence: ["RRULE:FREQ=DAILY"] })).status).toBe(400);
  const patched = await app.request(path + "/booking-id", {
    method: "POST",
    headers: { ...headers, "X-HTTP-Method-Override": "PATCH", "Content-Encoding": "gzip" },
    body: new Uint8Array(gzipSync(JSON.stringify({ id: "cannot-change-id", summary: "Updated" }))),
  });
  expect(patched.status).toBe(200);
  expect(await patched.json()).toMatchObject({ ...event, summary: "Updated" });
  expect((await post(path + "/booking-id", {})).status).toBe(405);
  expect(
    (await app.request(path + "/booking-id", { method: "PATCH", headers, body: JSON.stringify({ recurrence: [] }) }))
      .status,
  ).toBe(400);
});

it("preserves transparent availability through summary-only PATCH and supports explicit opaque updates", async () => {
  const store = new Store();
  const tokens: TokenMap = new Map([["owner", { login: "owner@example.com", id: 1, scopes: [] }]]);
  const app = new Hono();
  app.use("*", authMiddleware(tokens));
  googlePlugin.register(app, store, new WebhookDispatcher(), "http://localhost", tokens);
  seedFromConfig(store, "http://localhost", {
    users: [{ email: "owner@example.com" }],
    calendars: [{ id: "room", summary: "Room" }],
  });
  const path = "/calendar/v3/calendars/room/events";
  const headers = { Authorization: "Bearer owner", "Content-Type": "application/json" };
  const request = (url: string, method: string, body: unknown) =>
    app.request(url, { method, headers, body: JSON.stringify(body) });
  const freeBusy = async () => {
    const response = await request("/calendar/v3/freeBusy", "POST", {
      timeMin: "2026-09-05T00:00:00.000Z",
      timeMax: "2026-09-06T00:00:00.000Z",
      items: [{ id: "room" }],
    });
    expect(response.status).toBe(200);
    return response.json();
  };
  const created = await request(path, "POST", {
    id: "transparent-event",
    summary: "Available",
    transparency: "transparent",
    start: { date: "2026-09-05" },
    end: { date: "2026-09-06" },
  });
  expect(created.status).toBe(200);
  expect(await freeBusy()).toMatchObject({ calendars: { room: { busy: [] } } });

  const eventPath = path + "/transparent-event";
  const patched = await request(eventPath, "PATCH", { summary: "Still available" });
  expect(patched.status).toBe(200);
  expect(await freeBusy()).toMatchObject({ calendars: { room: { busy: [] } } });
  expect(await patched.json()).toMatchObject({ summary: "Still available", transparency: "transparent" });
  expect(await (await app.request(eventPath, { headers })).json()).toMatchObject({ transparency: "transparent" });

  const opaque = await request(eventPath, "PATCH", { transparency: "opaque" });
  expect(opaque.status).toBe(200);
  expect(await opaque.json()).toMatchObject({ transparency: "opaque" });
  expect(await freeBusy()).toMatchObject({
    calendars: {
      room: { busy: [{ start: "2026-09-05T00:00:00.000Z", end: "2026-09-06T00:00:00.000Z" }] },
    },
  });
});
