import { describe, expect, it } from "vitest";
import { Hono, Store, WebhookDispatcher, authMiddleware, type TokenMap } from "@emulators/core";
import type { GoogleDirectoryBuilding, GoogleDirectoryCalendarResource } from "../entities.js";
import { googlePlugin, seedFromConfig } from "../index.js";

describe("Directory room discovery", () => {
  it("discovers paginated buildings and usable room calendars without leaking another user's resources", async () => {
    const store = new Store();
    const tokens: TokenMap = new Map([
      ["owner", { login: "owner@example.com", id: 1, scopes: [] }],
      ["other", { login: "other@example.com", id: 2, scopes: [] }],
    ]);
    const app = new Hono();
    app.use("*", authMiddleware(tokens));
    googlePlugin.register(app, store, new WebhookDispatcher(), "http://localhost", tokens);
    const seed = {
      users: [{ email: "owner@example.com" }],
      directory_buildings: [
        { buildingId: "hq", buildingName: "HQ", floorNames: ["1"] },
        { buildingId: "annex", buildingName: "Annex" },
        { buildingId: "hq", buildingName: "Ignored duplicate" },
      ],
      directory_calendar_resources: [
        {
          resourceId: "room-1",
          resourceEmail: "room-1@resource.calendar.google.com",
          resourceName: "Meeting Room",
          buildingId: "hq",
          floorName: "1",
          capacity: 6,
        },
        {
          resourceId: "room-1",
          resourceEmail: "duplicate@resource.calendar.google.com",
          resourceName: "Ignored duplicate",
        },
      ],
    };
    seedFromConfig(store, "http://localhost", seed);
    seedFromConfig(store, "http://localhost", seed);
    seedFromConfig(store, "http://localhost", {
      directory_calendar_resources: [
        {
          ...seed.directory_calendar_resources[0],
          resourceEmail: "changed@resource.calendar.google.com",
          resourceName: "Changed room",
        },
      ],
    });
    const root = "/admin/directory/v1/customer/my_customer/resources/";
    const get = (path: string, token = "owner") => app.request(path, { headers: { Authorization: `Bearer ${token}` } });
    const firstResponse = await get(root + "buildings?maxResults=1");
    expect(firstResponse.status).toBe(200);
    const first = (await firstResponse.json()) as {
      buildings: GoogleDirectoryBuilding[];
      nextPageToken: string;
    };
    expect(first.buildings).toEqual([expect.objectContaining({ buildingId: "hq", buildingName: "HQ" })]);
    for (const field of ["user_email", "id", "created_at", "updated_at"]) {
      expect(first.buildings[0]).not.toHaveProperty(field);
    }
    const second = (await (await get(root + `buildings?maxResults=1&pageToken=${first.nextPageToken}`)).json()) as {
      buildings: GoogleDirectoryBuilding[];
      nextPageToken?: string;
    };
    expect(second.buildings[0].buildingId).toBe("annex");
    expect(second.nextPageToken).toBeUndefined();
    expect(await (await get(root + "buildings/hq")).json()).toMatchObject({ buildingId: "hq", buildingName: "HQ" });
    expect((await get(root + "buildings/hq", "other")).status).toBe(404);
    const rooms = (await (await get(root + "calendars")).json()) as { items: GoogleDirectoryCalendarResource[] };
    expect(rooms.items).toHaveLength(1);
    expect(rooms.items[0]).toMatchObject({ resourceId: "room-1", capacity: 6, buildingId: "hq" });
    const calendars = (await (await get("/calendar/v3/users/me/calendarList")).json()) as {
      items: Array<{ id: string; primary?: boolean }>;
    };
    expect(calendars.items.find((calendar) => calendar.primary)?.id).toBe("primary");
    expect(calendars.items.map((calendar) => calendar.id)).not.toContain("changed@resource.calendar.google.com");
    expect(calendars.items.map((calendar) => calendar.id)).not.toContain("duplicate@resource.calendar.google.com");
    const eventsUrl = `/calendar/v3/calendars/${encodeURIComponent(rooms.items[0].resourceEmail)}/events`;
    const created = await app.request(eventsUrl, {
      method: "POST",
      headers: { Authorization: "Bearer owner", "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: "Room booking",
        start: { dateTime: "2026-09-05T10:00:00Z" },
        end: { dateTime: "2026-09-05T11:00:00Z" },
      }),
    });
    expect(created.status).toBe(200);
    expect(((await (await get(eventsUrl)).json()) as { items: Array<{ summary: string }> }).items[0].summary).toBe(
      "Room booking",
    );
    expect(((await (await get(root + "calendars", "other")).json()) as { items: unknown[] }).items).toEqual([]);
    expect((await get(eventsUrl, "other")).status).toBe(404);
    for (const path of ["buildings", "buildings/hq", "calendars"]) {
      expect((await app.request(root + path)).status).toBe(401);
    }
    expect((await get(root + "buildings?maxResults=0")).status).toBe(400);
    expect((await get(root + "buildings?pageToken=invalid")).status).toBe(400);
    expect((await get(root.replace("my_customer", "unknown") + "buildings")).status).toBe(404);
    expect((await get(root + "buildings/missing")).status).toBe(404);
    expect((await get(root + "calendars?maxResults=501")).status).toBe(400);
    expect((await get(root + "calendars?pageToken=-1")).status).toBe(400);
    const snapshot = JSON.parse(JSON.stringify(store.snapshot()));
    store.reset();
    expect(await (await get(root + "buildings")).json()).toMatchObject({ buildings: [] });
    expect(await (await get(root + "calendars")).json()).toMatchObject({ items: [] });
    store.restore(snapshot);
    expect(await (await get(root + "buildings/hq")).json()).toMatchObject({ buildingId: "hq" });
    expect(await (await get(root + "calendars")).json()).toMatchObject({ items: [{ resourceId: "room-1" }] });
    seedFromConfig(store, "http://localhost", {
      directory_buildings: [{ user_email: "other@example.com", buildingId: "hq", buildingName: "Other HQ" }],
      directory_calendar_resources: [
        {
          user_email: "other@example.com",
          resourceId: "room-1",
          resourceEmail: "other-room@resource.calendar.google.com",
          resourceName: "Other Room",
        },
      ],
    });
    expect(await (await get(root + "buildings/hq", "other")).json()).toMatchObject({ buildingName: "Other HQ" });
    expect(await (await get(root + "buildings/hq")).json()).toMatchObject({ buildingName: "HQ" });
    expect(await (await get(root + "calendars", "other")).json()).toMatchObject({
      items: [{ resourceName: "Other Room" }],
    });
  });
});
