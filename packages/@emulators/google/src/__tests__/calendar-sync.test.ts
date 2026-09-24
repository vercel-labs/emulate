import { describe, expect, it } from "vitest";
import { Hono, Store, WebhookDispatcher, authMiddleware, type TokenMap } from "@emulators/core";
import { googlePlugin, seedFromConfig } from "../index.js";
import { syncCalendarEvents } from "../calendar-sync.js";
import { getGoogleStore } from "../store.js";

type EventPage = {
  items: Array<{ id: string; summary: string; status: string }>;
  updated: string;
  nextPageToken?: string;
  nextSyncToken?: string;
};

describe("Calendar incremental synchronization", () => {
  it("freezes pages and reports creations and deletions after the snapshot boundary", async () => {
    const store = new Store();
    const tokens: TokenMap = new Map([
      ["owner", { login: "owner@example.com", id: 1, scopes: [] }],
      ["other", { login: "other@example.com", id: 2, scopes: [] }],
    ]);
    const app = new Hono();
    app.use("*", authMiddleware(tokens));
    googlePlugin.register(app, store, new WebhookDispatcher(), "http://localhost", tokens);
    seedFromConfig(store, "http://localhost", {
      users: [{ email: "owner@example.com" }],
      calendars: [
        { id: "room", summary: "Room" },
        { id: "other", summary: "Other" },
        { id: "room", summary: "Other user room", user_email: "other@example.com" },
      ],
      calendar_events: ["a", "b"].map((id) => ({
        id,
        calendar_id: "room",
        summary: id,
        start_date_time: "2026-09-05T10:00:00Z",
        end_date_time: "2026-09-05T11:00:00Z",
      })),
    });
    const path = "/calendar/v3/calendars/room/events";
    const request = (url: string, method = "GET", body?: unknown) =>
      app.request(url, {
        method,
        headers: { Authorization: "Bearer owner", "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    const page = async (query: string) => {
      const response = await request(path + query);
      expect(response.status).toBe(200);
      return (await response.json()) as EventPage;
    };
    const first = await page("?maxResults=1");
    expect(first.items[0].id).toBe("a");
    expect(Number.isFinite(Date.parse(first.updated))).toBe(true);
    expect(first.nextSyncToken).toBeUndefined();
    const inserted = await request(path, "POST", {
      summary: "Created during paging",
      start: { date: "2026-09-08" },
      end: { date: "2026-09-09" },
    });
    expect(inserted.status).toBe(200);
    const insertedEvent = (await inserted.json()) as { id: string };
    const second = await page(`?maxResults=1&pageToken=${first.nextPageToken}`);
    expect(second.items[0].summary).toBe("b");
    expect(second.nextPageToken).toBeUndefined();
    expect(second.nextSyncToken).toBeTruthy();
    expect((await request(path + "/a", "DELETE")).status).toBe(204);
    const changes = await page(`?syncToken=${second.nextSyncToken}&maxResults=1`);
    expect(changes.items[0]).toMatchObject({ id: insertedEvent.id, summary: "Created during paging" });
    const deletion = await page(`?syncToken=${second.nextSyncToken}&maxResults=1&pageToken=${changes.nextPageToken}`);
    expect(deletion.items[0]).toMatchObject({ id: "a", status: "cancelled" });
    expect((await page(`?syncToken=${deletion.nextSyncToken}`)).items).toEqual([]);
    expect((await request(path + "?syncToken=invalid")).status).toBe(410);
    expect((await request(path.replace("/room/", "/other/") + `?syncToken=${deletion.nextSyncToken}`)).status).toBe(
      410,
    );
    expect((await request(path + `?syncToken=${deletion.nextSyncToken}&timeMin=2026-09-01T00:00:00Z`)).status).toBe(
      400,
    );
    expect((await request(path + "?pageToken=invalid")).status).toBe(400);
    expect((await request(path + `?maxResults=1&pageToken=${first.nextPageToken}:extra`)).status).toBe(400);
    expect((await request(path + `?maxResults=2&pageToken=${first.nextPageToken}`)).status).toBe(400);
    expect(
      (await app.request(path + `?syncToken=${deletion.nextSyncToken}`, { headers: { Authorization: "Bearer other" } }))
        .status,
    ).toBe(410);
    expect(
      (
        await app.request(path + `?maxResults=1&pageToken=${first.nextPageToken}`, {
          headers: { Authorization: "Bearer other" },
        })
      ).status,
    ).toBe(400);
    const snapshot = JSON.parse(JSON.stringify(store.snapshot()));
    store.reset();
    store.restore(snapshot);
    expect((await page(`?syncToken=${deletion.nextSyncToken}`)).items).toEqual([]);
    store.reset();
    seedFromConfig(store, "http://localhost", {
      users: [{ email: "owner@example.com" }],
      calendars: [{ id: "room", summary: "Room" }],
    });
    expect((await request(path + `?syncToken=${deletion.nextSyncToken}`)).status).toBe(410);
  });
});

it("applies full-sync filters to cancelled events and validates pagination inputs", async () => {
  const store = new Store();
  const tokens: TokenMap = new Map([["owner", { login: "owner@example.com", id: 1, scopes: [] }]]);
  const app = new Hono();
  app.use("*", authMiddleware(tokens));
  googlePlugin.register(app, store, new WebhookDispatcher(), "http://localhost", tokens);
  seedFromConfig(store, "http://localhost", {
    users: [{ email: "owner@example.com" }],
    calendars: [{ id: "room", summary: "Room" }],
    calendar_events: [
      {
        id: "cancelled",
        calendar_id: "room",
        summary: "Old event",
        status: "cancelled",
        start_date: "2026-09-01",
        end_date: "2026-09-02",
      },
      {
        id: "current",
        calendar_id: "room",
        summary: "Current event",
        start_date: "2026-09-05",
        end_date: "2026-09-06",
      },
    ],
  });
  const get = (query: string) =>
    app.request("/calendar/v3/calendars/room/events" + query, { headers: { Authorization: "Bearer owner" } });
  expect(await (await get("?showDeleted=true")).json()).toMatchObject({
    items: [{ id: "cancelled" }, { id: "current" }],
  });
  expect(await (await get("?showDeleted=true&timeMin=2026-09-04T00:00:00Z")).json()).toMatchObject({
    items: [{ id: "current" }],
  });
  expect(await (await get("?showDeleted=true&q=Current")).json()).toMatchObject({ items: [{ id: "current" }] });
  for (const query of ["?maxResults=0", "?maxResults=2501", "?maxResults=1.5", "?showDeleted=invalid"]) {
    expect((await get(query)).status).toBe(400);
  }
});

it("keeps every matching event when a full sync exceeds the ordinary list page size", async () => {
  const store = new Store();
  const tokens: TokenMap = new Map([["owner", { login: "owner@example.com", id: 1, scopes: [] }]]);
  const app = new Hono();
  app.use("*", authMiddleware(tokens));
  googlePlugin.register(app, store, new WebhookDispatcher(), "http://localhost", tokens);
  seedFromConfig(store, "http://localhost", {
    users: [{ email: "owner@example.com" }],
    calendars: [{ id: "room", summary: "Room" }],
    calendar_events: Array.from({ length: 251 }, (_, i) => ({
      id: `event-${i}`,
      calendar_id: "room",
      summary: `Event ${i}`,
      start_date: "2026-09-05",
      end_date: "2026-09-06",
    })),
  });
  const page = async (query: string) => {
    const response = await app.request("/calendar/v3/calendars/room/events" + query, {
      headers: { Authorization: "Bearer owner" },
    });
    expect(response.status).toBe(200);
    return (await response.json()) as EventPage;
  };
  const first = await page("?maxResults=250");
  expect(first.items).toHaveLength(250);
  expect(first.nextSyncToken).toBeUndefined();
  const second = await page(`?maxResults=250&pageToken=${first.nextPageToken}`);
  expect(second.items).toHaveLength(1);
  expect(new Set([...first.items, ...second.items].map((event) => event.id)).size).toBe(251);
  expect(second.nextPageToken).toBeUndefined();
  expect(second.nextSyncToken).toBeTruthy();
});

describe("Calendar sync retention", () => {
  function setup(description = "") {
    const store = new Store();
    const tokens: TokenMap = new Map([["owner", { login: "owner@example.com", id: 1, scopes: [] }]]);
    const app = new Hono();
    app.use("*", authMiddleware(tokens));
    googlePlugin.register(app, store, new WebhookDispatcher(), "http://localhost", tokens);
    seedFromConfig(store, "http://localhost", {
      users: [{ email: "owner@example.com" }],
      calendars: [{ id: "room", summary: "Room" }],
      calendar_events: ["a", "b", "c"].map((id) => ({
        id,
        calendar_id: "room",
        summary: id,
        description,
        start_date: "2026-09-05",
        end_date: "2026-09-06",
      })),
    });
    const gs = getGoogleStore(store);
    const sync = (options: Parameters<typeof syncCalendarEvents>[4] = {}) =>
      syncCalendarEvents(store, gs, "owner@example.com", "room", options);
    const get = (query: string) =>
      app.request("/calendar/v3/calendars/room/events" + query, { headers: { Authorization: "Bearer owner" } });
    const cached = () =>
      store.getData<Array<{ token: string; baseline: unknown[]; items: unknown[] }>>("google.calendar_sync")!;
    return { store, gs, sync, get, cached };
  }

  it("bounds serialized event bytes during repeated unchanged syncs and expires older tokens", async () => {
    // Each event contains 1 MiB of UTF-8 data, including multibyte characters.
    const { sync, get, cached } = setup("é".repeat(512 * 1024));
    const first = sync();
    let token = first.nextSyncToken;
    for (let i = 0; i < 12; i++) {
      const next = sync({ syncToken: token });
      expect(next.items).toEqual([]);
      token = next.nextSyncToken;
    }
    const retained = cached();
    expect(retained.length).toBeGreaterThan(1);
    expect(retained.length).toBeLessThan(13);
    const retainedBytes = retained.reduce(
      (total, entry) =>
        total + Buffer.byteLength(JSON.stringify(entry.baseline)) + Buffer.byteLength(JSON.stringify(entry.items)),
      0,
    );
    expect(retainedBytes).toBeLessThanOrEqual(32 * 1024 * 1024);
    expect((await get(`?syncToken=${first.nextSyncToken}`)).status).toBe(410);
    expect(sync({ syncToken: token }).items).toEqual([]);
  });

  it("keeps every page of the newest snapshot when it alone exceeds the byte budget", async () => {
    const { gs, sync, get, cached } = setup();
    const old = sync();
    const event = gs.calendarEvents.findBy("google_id", "c")[0];
    gs.calendarEvents.update(event.id, { description: "x".repeat(17 * 1024 * 1024) });
    const first = sync({ maxResults: "1" });
    expect(first.items.map((item) => item.google_id)).toEqual(["a"]);
    expect(cached()).toHaveLength(1);
    expect((await get(`?syncToken=${old.nextSyncToken}`)).status).toBe(410);
    // Later changes must not alter the oversized snapshot's remaining pages.
    const secondEvent = gs.calendarEvents.findBy("google_id", "b")[0];
    gs.calendarEvents.update(secondEvent.id, { summary: "Changed during pagination" });
    const second = sync({ maxResults: "1", pageToken: first.nextPageToken });
    expect(second.items[0]).toMatchObject({ google_id: "b", summary: "b" });
    const third = sync({ maxResults: "1", pageToken: second.nextPageToken });
    expect(third.items[0].google_id).toBe("c");
    expect(third.nextPageToken).toBeUndefined();
    expect(third.nextSyncToken).toBeTruthy();
    expect(sync({ syncToken: third.nextSyncToken }).items).toMatchObject([
      { google_id: "b", summary: "Changed during pagination" },
    ]);
  });

  it("also caps small snapshots at 1,000 entries after restoring persisted state", async () => {
    const { store, sync, get, cached } = setup();
    const first = sync();
    for (let i = 0; i < 999; i++) sync();
    store.restore(JSON.parse(JSON.stringify(store.snapshot())));
    const newest = sync();
    expect(cached()).toHaveLength(1000);
    expect((await get(`?syncToken=${first.nextSyncToken}`)).status).toBe(410);
    expect(sync({ syncToken: newest.nextSyncToken }).items).toEqual([]);
  });
});
