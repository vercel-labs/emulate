import { gzipSync } from "node:zlib";
import { describe, it, expect, beforeEach } from "vitest";
import { Hono, Store, WebhookDispatcher, createApiErrorHandler, createErrorHandler } from "@emulators/core";
import {
  addFailure,
  expoPushPlugin,
  resetExpoPush,
  seedFromConfig,
  sentMessages,
  sentTo,
  setDeviceRegistered,
} from "../index.js";
import type { ExpoPushSeedConfig } from "../index.js";

const base = "http://localhost:4000";
const ALICE = "ExponentPushToken[alice-phone]";
const BOB = "ExpoPushToken[bob-phone]";

function createTestApp(config?: ExpoPushSeedConfig) {
  const store = new Store();
  const app = new Hono();
  app.onError(createApiErrorHandler());
  app.use("*", createErrorHandler());
  expoPushPlugin.register(app as never, store, new WebhookDispatcher(), base);
  expoPushPlugin.seed?.(store, base);
  if (config) seedFromConfig(store, base, config);
  return { app, store };
}

function send(app: Hono, body: unknown, headers: Record<string, string> = {}) {
  return app.request(`${base}/--/api/v2/push/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function receipts(app: Hono, ids: string[]) {
  return app.request(`${base}/--/api/v2/push/getReceipts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids }),
  });
}

type Ticket = { status: string; id?: string; message?: string; details?: { error: string } };

describe("Expo Push plugin - send", () => {
  let app: Hono;
  let store: Store;

  beforeEach(() => {
    ({ app, store } = createTestApp());
  });

  it("returns one ok ticket with an id for a message in an array", async () => {
    const res = await send(app, [{ to: ALICE, title: "Reminder", body: "Haircut at 10:00" }]);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Ticket[] };
    expect(data).toHaveLength(1);
    expect(data[0].status).toBe("ok");
    expect(data[0].id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("returns a bare ticket object for a single message object to a single recipient", async () => {
    const res = await send(app, { to: ALICE, title: "Reminder" });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Ticket };
    expect(Array.isArray(data)).toBe(false);
    expect(data.status).toBe("ok");
    expect(data.id).toMatch(/^[0-9a-f]{8}-/);
    const bad = (await (await send(app, { to: "nope" })).json()) as { data: Ticket };
    expect(bad.data.status).toBe("error");
    expect(bad.data.details?.error).toBe("DeviceNotRegistered");
  });

  it("keeps an array of tickets for a single message object sent to several recipients", async () => {
    const res = await send(app, { to: [ALICE, BOB], title: "Reminder" });
    const { data } = (await res.json()) as { data: Ticket[] };
    expect(data).toHaveLength(2);
  });

  it("accepts the critical sound object that expo-server-sdk types allow", async () => {
    for (const sound of [{ critical: true, name: "default", volume: 0.5 }, { name: null }, {}, "default", null]) {
      const res = await send(app, [{ to: ALICE, title: "Alarm", sound }]);
      expect(res.status).toBe(200);
    }
    expect(sentTo(store, ALICE)[0].message.sound).toEqual({ critical: true, name: "default", volume: 0.5 });
  });

  it("returns tickets in request order and expands a to array into one ticket per token", async () => {
    const res = await send(app, [
      { to: ALICE, body: "one" },
      { to: [BOB, ALICE], body: "two" },
    ]);
    const { data } = (await res.json()) as { data: Ticket[] };
    expect(data.map((t) => t.status)).toEqual(["ok", "ok", "ok"]);
    expect(sentMessages(store).map((m) => [m.token, m.message.body])).toEqual([
      [ALICE, "one"],
      [BOB, "two"],
      [ALICE, "two"],
    ]);
  });

  it("accepts a gzip-compressed body, as expo-server-sdk sends over 1 KiB", async () => {
    const res = await app.request(`${base}/--/api/v2/push/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Encoding": "gzip" },
      body: gzipSync(Buffer.from(JSON.stringify([{ to: ALICE, body: "zipped" }]))),
    });
    expect(res.status).toBe(200);
    expect(sentTo(store, ALICE)[0].message.body).toBe("zipped");
  });

  it("rejects malformed token with a DeviceNotRegistered error ticket and no id", async () => {
    const res = await send(app, [{ to: "not-a-token", body: "x" }]);
    const { data } = (await res.json()) as { data: Ticket[] };
    expect(data[0]).toEqual({
      status: "error",
      message: '"not-a-token" is not a registered push notification recipient',
      details: { error: "DeviceNotRegistered" },
    });
    expect(sentMessages(store)[0].receipt).toBeNull();
  });

  it("answers MessageTooBig for a payload over 4096 bytes and delivers its neighbours", async () => {
    const res = await send(app, [
      { to: ALICE, data: { blob: "x".repeat(5000) } },
      { to: BOB, body: "small" },
    ]);
    const { data } = (await res.json()) as { data: Ticket[] };
    expect(data[0].details?.error).toBe("MessageTooBig");
    expect(data[1].status).toBe("ok");
  });

  it("validates fields with a VALIDATION_ERROR request error", async () => {
    for (const [message, expected] of [
      [{ body: "no recipient" }, '"to" is required'],
      [{ to: ALICE, priority: "urgent" }, '"priority" must be one of [default, normal, high]'],
      [{ to: ALICE, data: "str" }, '"data" must be an object'],
      [{ to: ALICE, badge: "1" }, '"badge" must be a number'],
      [{ to: ALICE, sound: 5 }, '"sound" must be a string, null, or an object'],
      [{ to: ALICE, sound: { critical: "yes" } }, '"sound.critical" must be a boolean'],
      [{ to: ALICE, sound: { name: 3 } }, '"sound.name" must be a string or null'],
      [{ to: ALICE, sound: { volume: "loud" } }, '"sound.volume" must be a number'],
    ] as const) {
      const res = await send(app, message);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { errors: Array<{ code: string; message: string }> };
      expect(body.errors[0]).toEqual({ code: "VALIDATION_ERROR", message: expected });
    }
    expect(sentMessages(store)).toHaveLength(0);
  });

  it("rejects bodies that are not JSON", async () => {
    const res = await send(app, "{nope");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { errors: Array<{ code: string }> }).errors[0].code).toBe("VALIDATION_ERROR");
  });

  it("rejects more than 100 recipients with PUSH_TOO_MANY_NOTIFICATIONS", async () => {
    const res = await send(
      app,
      Array.from({ length: 101 }, (_, i) => ({ to: `ExponentPushToken[t${i}]` })),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { errors: Array<{ code: string }> }).errors[0].code).toBe(
      "PUSH_TOO_MANY_NOTIFICATIONS",
    );
    expect(sentMessages(store)).toHaveLength(0);
  });

  it("rejects tokens from two projects in one request with PUSH_TOO_MANY_EXPERIENCE_IDS", async () => {
    ({ app, store } = createTestApp({
      devices: [
        { token: ALICE, project: "@acme/blink" },
        { token: BOB, project: "@acme/crowdia" },
      ],
    }));
    const res = await send(app, [{ to: ALICE }, { to: BOB }]);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errors: Array<{ code: string; details: Record<string, string[]> }> };
    expect(body.errors[0].code).toBe("PUSH_TOO_MANY_EXPERIENCE_IDS");
    expect(body.errors[0].details).toEqual({ "@acme/blink": [ALICE], "@acme/crowdia": [BOB] });
  });

  it("requires the access token when one is configured", async () => {
    ({ app, store } = createTestApp({ accessToken: "secret-token" }));
    expect((await send(app, { to: ALICE })).status).toBe(401);
    expect((await send(app, { to: ALICE }, { Authorization: "Bearer wrong" })).status).toBe(401);
    expect((await send(app, { to: ALICE }, { Authorization: "Bearer secret-token" })).status).toBe(200);
    expect((await receipts(app, [])).status).toBe(401);
  });
});

describe("Expo Push plugin - receipts", () => {
  it("returns an ok receipt per ticket id and omits unknown ids", async () => {
    const { app } = createTestApp();
    const sent = (await (await send(app, [{ to: ALICE }, { to: BOB }])).json()) as { data: Ticket[] };
    const ids = sent.data.map((t) => t.id as string);
    const res = await receipts(app, [...ids, "00000000-0000-4000-8000-000000000000"]);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown }).data).toEqual({
      [ids[0]]: { status: "ok" },
      [ids[1]]: { status: "ok" },
    });
  });

  it("reports DeviceNotRegistered on the receipt of an unregistered device, not on the ticket", async () => {
    const { app, store } = createTestApp({ devices: [{ token: ALICE, registered: false }] });
    const sent = (await (await send(app, [{ to: ALICE }])).json()) as { data: Ticket[] };
    expect(sent.data[0].status).toBe("ok");
    const body = (await (await receipts(app, [sent.data[0].id as string])).json()) as {
      data: Record<string, Ticket>;
    };
    expect(body.data[sent.data[0].id as string].details?.error).toBe("DeviceNotRegistered");

    setDeviceRegistered(store, BOB, false);
    const second = (await (await send(app, [{ to: BOB }])).json()) as { data: Ticket[] };
    const again = (await (await receipts(app, [second.data[0].id as string])).json()) as {
      data: Record<string, Ticket>;
    };
    expect(again.data[second.data[0].id as string].status).toBe("error");
  });

  it("rejects more than 1000 ids with PUSH_TOO_MANY_RECEIPTS", async () => {
    const { app } = createTestApp();
    const res = await receipts(
      app,
      Array.from({ length: 1001 }, (_, i) => String(i)),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { errors: Array<{ code: string }> }).errors[0].code).toBe("PUSH_TOO_MANY_RECEIPTS");
  });

  it("requires ids to be an array of strings", async () => {
    const { app } = createTestApp();
    const res = await app.request(`${base}/--/api/v2/push/getReceipts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: "abc" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("Expo Push plugin - injectable failures", () => {
  it("fails a matching token at the ticket stage and leaves other tokens alone", async () => {
    const { app } = createTestApp({
      failures: [{ match: { token: ALICE }, fail: { at: "ticket", error: "MessageRateExceeded" } }],
    });
    const { data } = (await (await send(app, [{ to: ALICE }, { to: BOB }])).json()) as { data: Ticket[] };
    expect(data[0]).toMatchObject({ status: "error", details: { error: "MessageRateExceeded" } });
    expect(data[1].status).toBe("ok");
  });

  it("fails at the receipt stage and matches on title, body, channelId, and data", async () => {
    const { app } = createTestApp({
      failures: [
        {
          match: { title: "Reminder", body: "10:00", channelId: "reminders", data: { appointmentId: 7 } },
          fail: { at: "receipt", error: "MismatchSenderId", message: "sender mismatch" },
        },
      ],
    });
    const hit = (await (
      await send(app, {
        to: ALICE,
        title: "Reminder for you",
        body: "Haircut at 10:00",
        channelId: "reminders",
        data: { appointmentId: 7, extra: true },
      })
    ).json()) as { data: Ticket };
    const miss = (await (
      await send(app, { to: ALICE, title: "Reminder", body: "10:00", data: { appointmentId: 8 } })
    ).json()) as {
      data: Ticket;
    };
    const got = (await (await receipts(app, [hit.data.id as string, miss.data.id as string])).json()) as {
      data: Record<string, Ticket>;
    };
    expect(got.data[hit.data.id as string]).toMatchObject({ status: "error", message: "sender mismatch" });
    expect(got.data[miss.data.id as string]).toEqual({ status: "ok" });
  });

  it("fails the whole request with a request-level error and records no messages", async () => {
    const { app, store } = createTestApp({
      failures: [{ match: { token: ALICE }, times: 1, fail: { at: "request" } }],
    });
    const first = await send(app, [{ to: BOB }, { to: ALICE }]);
    expect(first.status).toBe(429);
    expect(((await first.json()) as { errors: Array<{ code: string }> }).errors[0].code).toBe("TOO_MANY_REQUESTS");
    expect(sentMessages(store)).toHaveLength(0);
    // times: 1 is spent, so a retry of the same request goes through.
    expect((await send(app, [{ to: BOB }, { to: ALICE }])).status).toBe(200);
    expect(sentMessages(store)).toHaveLength(2);
  });

  it("supports a custom request-level status, code, and message", async () => {
    const { app } = createTestApp({
      failures: [{ fail: { at: "request", status: 503, code: "SERVICE_UNAVAILABLE", message: "try later" } }],
    });
    const res = await send(app, { to: ALICE });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { errors: unknown[] }).errors[0]).toEqual({
      code: "SERVICE_UNAVAILABLE",
      message: "try later",
    });
  });

  it("applies the first matching rule with budget left, in order", async () => {
    const { app } = createTestApp({
      failures: [
        { id: "first-two", times: 2, fail: { at: "ticket", error: "MessageRateExceeded" } },
        { id: "after", fail: { at: "ticket", error: "InvalidCredentials" } },
      ],
    });
    const { data } = (await (await send(app, [{ to: ALICE }, { to: ALICE }, { to: ALICE }])).json()) as {
      data: Ticket[];
    };
    expect(data.map((t) => t.details?.error)).toEqual([
      "MessageRateExceeded",
      "MessageRateExceeded",
      "InvalidCredentials",
    ]);
  });

  it("does not spend rule hits on malformed tokens", async () => {
    const { app } = createTestApp({ failures: [{ times: 1, fail: { at: "ticket", error: "MessageRateExceeded" } }] });
    const { data } = (await (await send(app, [{ to: "bad" }, { to: ALICE }])).json()) as { data: Ticket[] };
    expect(data[0].details?.error).toBe("DeviceNotRegistered");
    expect(data[1].details?.error).toBe("MessageRateExceeded");
  });

  it("rejects an invalid seed with the path of the problem", () => {
    expect(() => createTestApp({ failures: [{ fail: { at: "ticket", error: "Nope" as never } }] })).toThrow(
      /failures\[0\]\.fail\.error/,
    );
    expect(() => createTestApp({ failures: [{ match: { color: "red" } as never, fail: { at: "ok" } }] })).toThrow(
      /failures\[0\]\.match\.color: unknown key/,
    );
    expect(() => createTestApp({ nope: 1 } as never)).toThrow(/config\.nope: unknown key/);
  });
});

describe("Expo Push plugin - seeded variants", () => {
  const variants = [
    { at: "ok" },
    { at: "ticket", error: "MessageRateExceeded" },
    { at: "receipt", error: "DeviceNotRegistered" },
  ] as const;

  async function outcomes(seed: number, count: number): Promise<string[]> {
    const { app } = createTestApp({ seed, failures: [{ id: "flaky", fail: [...variants] }] });
    const out: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const { data } = (await (await send(app, [{ to: ALICE }])).json()) as { data: Ticket[] };
      if (data[0].status === "error") out.push("ticket:" + data[0].details?.error);
      else {
        const r = (await (await receipts(app, [data[0].id as string])).json()) as { data: Record<string, Ticket> };
        out.push("receipt:" + r.data[data[0].id as string].status);
      }
    }
    return out;
  }

  it("replays the same order for the same seed and covers every variant each cycle", async () => {
    const a = await outcomes(7, 6);
    const b = await outcomes(7, 6);
    expect(a).toEqual(b);
    expect(a.slice(0, 3)).toEqual(a.slice(3, 6));
    expect(new Set(a.slice(0, 3)).size).toBe(3);
  });

  it("changes the order for a different seed", async () => {
    const orders = new Set<string>();
    for (let seed = 0; seed < 12; seed += 1) orders.add((await outcomes(seed, 3)).join("|"));
    expect(orders.size).toBeGreaterThan(1);
  });

  it("gives the same ticket ids to the same seed and different ids to a different seed", async () => {
    const ids = async (seed: number) => {
      const { app } = createTestApp({ seed });
      return ((await (await send(app, [{ to: ALICE }, { to: BOB }])).json()) as { data: Ticket[] }).data.map(
        (t) => t.id,
      );
    };
    expect(await ids(5)).toEqual(await ids(5));
    expect(await ids(5)).not.toEqual(await ids(6));
    expect(new Set(await ids(5)).size).toBe(2);
  });
});

describe("Expo Push plugin - assertions and control routes", () => {
  it("records what each token was sent, with the original fields", async () => {
    const { app, store } = createTestApp();
    await send(app, [
      { to: ALICE, title: "A", data: { appointmentId: 1 }, sound: "default" },
      { to: BOB, title: "B" },
    ]);
    const [record] = sentTo(store, ALICE);
    expect(record.message).toEqual({ to: ALICE, title: "A", data: { appointmentId: 1 }, sound: "default" });
    expect(sentTo(store, BOB)).toHaveLength(1);
    expect(sentTo(store, "ExponentPushToken[nobody]")).toHaveLength(0);
  });

  it("lists messages at /_expo-push/messages with filters", async () => {
    const { app } = createTestApp();
    await send(app, [{ to: ALICE, title: "Reminder" }, { to: BOB, title: "Promo" }, { to: "bad" }]);
    const get = async (q: string) =>
      ((await (await app.request(`${base}/_expo-push/messages${q}`)).json()) as { data: Array<{ token: string }> })
        .data;
    expect(await get("")).toHaveLength(3);
    expect((await get(`?token=${encodeURIComponent(ALICE)}`)).map((m) => m.token)).toEqual([ALICE]);
    expect(await get("?title=Promo")).toHaveLength(1);
    expect(await get("?status=error")).toHaveLength(1);
  });

  it("records failed requests too", async () => {
    const { app } = createTestApp();
    await send(app, { body: "no to" });
    await send(app, { to: ALICE });
    const { data } = (await (await app.request(`${base}/_expo-push/requests`)).json()) as {
      data: Array<{ status: number; error_code: string | null; recipients: number }>;
    };
    expect(data.map((r) => [r.status, r.error_code, r.recipients])).toEqual([
      [400, "VALIDATION_ERROR", 0],
      [200, null, 1],
    ]);
  });

  it("replaces rules with PUT /_expo-push/rules and zeroes their hit counts", async () => {
    const { app } = createTestApp();
    const put = (failures: unknown) =>
      app.request(`${base}/_expo-push/rules`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ failures }),
      });
    expect((await put([{ times: 1, fail: { at: "ticket", error: "MessageRateExceeded" } }])).status).toBe(200);
    expect(((await (await send(app, [{ to: ALICE }])).json()) as { data: Ticket[] }).data[0].status).toBe("error");
    expect(((await (await send(app, [{ to: ALICE }])).json()) as { data: Ticket[] }).data[0].status).toBe("ok");
    await put([{ times: 1, fail: { at: "ticket", error: "MessageRateExceeded" } }]);
    expect(((await (await send(app, [{ to: ALICE }])).json()) as { data: Ticket[] }).data[0].status).toBe("error");
    expect((await put([{ fail: { at: "ticket", error: "Nope" } }])).status).toBe(400);
  });

  it("registers a device with POST /_expo-push/devices", async () => {
    const { app } = createTestApp();
    const post = (body: unknown) =>
      app.request(`${base}/_expo-push/devices`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await post({ token: ALICE, registered: false })).status).toBe(201);
    expect((await post({ token: ALICE, registered: true })).status).toBe(200);
    expect((await post({ registered: true })).status).toBe(400);
  });

  it("resets the call record and rules to the seed", async () => {
    const { app, store } = createTestApp({
      failures: [{ id: "seeded", times: 1, fail: { at: "ticket", error: "MessageRateExceeded" } }],
    });
    await send(app, { to: ALICE });
    addFailure(store, { id: "extra", fail: { at: "ticket", error: "InvalidCredentials" } });
    expect(sentMessages(store)).toHaveLength(1);
    const reset = await app.request(`${base}/_expo-push/reset`, { method: "POST" });
    expect(reset.status).toBe(200);
    expect(sentMessages(store)).toHaveLength(0);
    // The seeded rule has its budget back and the runtime rule is gone.
    const { data } = (await (await send(app, [{ to: ALICE }, { to: ALICE }])).json()) as { data: Ticket[] };
    expect(data.map((t) => t.status)).toEqual(["error", "ok"]);
    resetExpoPush(store);
    expect(sentMessages(store)).toHaveLength(0);
  });

  it("refuses control calls that come from another site", async () => {
    const { app } = createTestApp();
    const res = await app.request(`${base}/_expo-push/reset`, {
      method: "POST",
      headers: { Origin: "https://evil.example", Host: "localhost:4000" },
    });
    expect(res.status).toBe(403);
    const same = await app.request(`${base}/_expo-push/reset`, {
      method: "POST",
      headers: { Origin: "http://localhost:4000", Host: "localhost:4000" },
    });
    expect(same.status).toBe(200);
  });

  it("renders sent notifications at /inbox", async () => {
    const { app } = createTestApp();
    expect(await (await app.request(`${base}/inbox`)).text()).toContain("No notifications sent yet");
    await send(app, { to: ALICE, title: "Haircut <b>today</b>" });
    const html = await (await app.request(`${base}/inbox`)).text();
    expect(html).toContain("Haircut &lt;b&gt;today&lt;/b&gt;");
    expect(html).toContain("1 notification sent");
  });
});
