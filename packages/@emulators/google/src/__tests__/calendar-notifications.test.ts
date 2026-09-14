import { createServer, type IncomingHttpHeaders } from "node:http";
import { describe, expect, it } from "vitest";
import { Hono, Store, WebhookDispatcher, authMiddleware, type TokenMap } from "@emulators/core";
import { getGoogleStore, googlePlugin, seedFromConfig } from "../index.js";
import { requireGoogleAuth } from "../route-helpers.js";

describe("Calendar notifications", () => {
  it("delivers sync and mutation callbacks, isolates channels, and stops delivery", async () => {
    const received: IncomingHttpHeaders[] = [];
    const server = createServer((request, response) => {
      received.push(request.headers);
      response.writeHead(204).end();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing callback address");
      const store = new Store();
      const tokens: TokenMap = new Map([
        ["owner", { login: "owner@example.com", id: 1, scopes: [] }],
        ["other", { login: "other@example.com", id: 2, scopes: [] }],
      ]);
      const app = new Hono();
      app.use("*", authMiddleware(tokens));
      googlePlugin.register(app, store, new WebhookDispatcher(), "http://localhost", tokens);
      // A later event API can register PATCH independently of notification code.
      app.patch("/calendar/v3/calendars/:calendarId/events/:eventId", async (c) => {
        const email = requireGoogleAuth(c);
        if (email instanceof Response) return email;
        const gs = getGoogleStore(store);
        const event = gs.calendarEvents
          .findBy("user_email", email)
          .find(
            (entry) =>
              entry.calendar_google_id === c.req.param("calendarId") && entry.google_id === c.req.param("eventId"),
          );
        if (!event) return c.json({ error: "Not found" }, 404);
        const body = await c.req.json<{ summary: string }>();
        gs.calendarEvents.update(event.id, { summary: body.summary });
        return c.json({ id: event.google_id, summary: body.summary });
      });
      seedFromConfig(store, "http://localhost", {
        users: [{ email: "owner@example.com" }],
        calendars: [
          { id: "room", summary: "Room" },
          { id: "other-calendar", summary: "Other calendar" },
          { id: "room", summary: "Other room", user_email: "other@example.com" },
        ],
      });
      const path = "/calendar/v3/calendars/room/events";
      const request = (url: string, method: string, body?: unknown, token = "owner") =>
        app.request(url, {
          method,
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
      const watch = {
        id: "room-channel",
        type: "webhook",
        address: `http://127.0.0.1:${address.port}/callback/room`,
        token: "callback-token",
      };
      const response = await app.request(path + "/watch", {
        method: "POST",
        headers: { Authorization: "Bearer owner", "Content-Type": "application/json" },
        body: JSON.stringify(watch),
      });
      expect(response.status).toBe(200);
      const channel = (await response.json()) as {
        id: string;
        resourceId: string;
        resourceUri: string;
        expiration: string;
      };
      expect(Number(channel.expiration)).toBeGreaterThan(Date.now());
      expect(received[0]).toMatchObject({
        "x-goog-resource-state": "sync",
        "x-goog-channel-id": channel.id,
        "x-goog-resource-id": channel.resourceId,
        "x-goog-channel-token": "callback-token",
        "x-goog-message-number": "1",
      });
      expect((await request(path + "/watch", "POST", watch)).status).toBe(400);
      expect((await request(path, "GET")).status).toBe(200);
      expect(
        (
          await request(path.replace("/room/", "/other-calendar/"), "POST", {
            summary: "Another calendar",
            start: { date: "2026-09-06" },
            end: { date: "2026-09-07" },
          })
        ).status,
      ).toBe(200);
      expect((await request(path, "POST", {})).status).toBe(400);
      expect((await request(path + "/missing", "DELETE")).status).toBe(404);
      expect((await request(path + "/missing", "PATCH", { summary: "Missing" })).status).toBe(404);
      expect((await app.request(path, { method: "POST" })).status).toBe(401);
      expect(received).toHaveLength(1);
      expect(
        (
          await request(
            path,
            "POST",
            { summary: "Other booking", start: { date: "2026-09-06" }, end: { date: "2026-09-07" } },
            "other",
          )
        ).status,
      ).toBe(200);
      expect(received).toHaveLength(1);
      expect((await request("/calendar/v3/channels/stop", "POST", channel, "other")).status).toBe(404);
      const eventResponse = await request(path, "POST", {
        summary: "Booking",
        start: { dateTime: "2026-09-05T10:00:00Z" },
        end: { dateTime: "2026-09-05T11:00:00Z" },
      });
      const event = (await eventResponse.json()) as { id: string };
      expect(received.at(-1)).toMatchObject({ "x-goog-resource-state": "exists", "x-goog-message-number": "2" });
      expect((await request(path + "/" + event.id, "PATCH", { summary: "Updated booking" })).status).toBe(200);
      expect(
        getGoogleStore(store)
          .calendarEvents.all()
          .find((entry) => entry.google_id === event.id)?.summary,
      ).toBe("Updated booking");
      await request(path + "/" + event.id, "DELETE");
      expect(received).toHaveLength(4);
      expect(received.map((entry) => entry["x-goog-message-number"])).toEqual(["1", "2", "3", "4"]);
      expect(getGoogleStore(store).calendarChannels.all()[0].last_delivery_status).toBe(204);
      expect((await request("/calendar/v3/channels/stop", "POST", channel)).status).toBe(204);
      await request(path, "POST", {
        summary: "After stop",
        start: { date: "2026-09-06" },
        end: { date: "2026-09-07" },
      });
      expect(received).toHaveLength(4);
      expect((await request("/calendar/v3/channels/stop", "POST", channel)).status).toBe(404);
      expect((await request(path + "/watch", "POST", { ...watch, address: "file:///tmp/callback" })).status).toBe(400);
      expect((await request(path + "/watch", "POST", { ...watch, expiration: "1" })).status).toBe(400);
      expect((await request(path + "/watch", "POST", watch)).status).toBe(200);
      const gs = getGoogleStore(store);
      gs.calendarChannels.update(gs.calendarChannels.all()[0].id, { expiration: Date.now() - 1 });
      const beforeExpiredWrite = received.length;
      expect((await request(path, "POST", { start: { date: "2026-09-06" }, end: { date: "2026-09-07" } })).status).toBe(
        200,
      );
      expect(received).toHaveLength(beforeExpiredWrite);
      store.reset();
      expect(gs.calendarChannels.all()).toEqual([]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});

it("keeps mutations when a callback fails and records the delivery outcome", async () => {
  let disconnect = false;
  const server = createServer((request, response) => {
    if (disconnect) request.socket.destroy();
    else response.writeHead(503).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing callback address");
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
    const post = (url: string, body: unknown) =>
      app.request(url, { method: "POST", headers, body: JSON.stringify(body) });
    expect(
      (await post(path + "/watch", { id: "failing", type: "web_hook", address: `http://127.0.0.1:${address.port}` }))
        .status,
    ).toBe(200);
    const gs = getGoogleStore(store);
    expect(gs.calendarChannels.all()[0].last_delivery_status).toBe(503);
    const first = await post(path, {
      id: "saved",
      summary: "Saved",
      start: { date: "2026-09-05" },
      end: { date: "2026-09-06" },
    });
    expect(first.status).toBe(200);
    expect(gs.calendarChannels.all()[0].last_delivery_status).toBe(503);
    const saved = (await first.json()) as { id: string };
    expect(gs.calendarEvents.all().find((entry) => entry.google_id === saved.id)?.summary).toBe("Saved");
    disconnect = true;
    expect((await app.request(path + "/" + saved.id, { method: "DELETE", headers })).status).toBe(204);
    expect(gs.calendarChannels.all()[0]).toMatchObject({ last_delivery_status: null, message_number: 3 });
    expect(gs.calendarEvents.all().find((entry) => entry.google_id === saved.id)).toBeUndefined();
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
