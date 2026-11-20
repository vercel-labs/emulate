import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Expo as ExpoClass } from "expo-server-sdk";

vi.mock("@emulators/expo-push", async () => import("../index.js"));

interface EmulatorHandle {
  readonly url: string;
  close(): Promise<void>;
}

let emulator: EmulatorHandle;
let origin: string;
let Expo: typeof ExpoClass;

const ALICE = "ExponentPushToken[alice-phone]";
const BOB = "ExponentPushToken[bob-phone]";

async function control(path: string, init?: RequestInit) {
  const response = await fetch(`${origin}${path}`, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  expect(response.status).toBeLessThan(300);
  return response.json() as Promise<{ data: unknown }>;
}

beforeAll(async () => {
  const entry = new URL("../../../../emulate/src/api.ts", import.meta.url).href;
  const { createEmulator } = (await import(entry)) as {
    createEmulator(options: { service: "expo-push"; port: number }): Promise<EmulatorHandle>;
  };
  emulator = await createEmulator({ service: "expo-push", port: 0 });
  origin = new URL(emulator.url).origin;
  // expo-server-sdk reads EXPO_BASE_URL once, when it is first imported.
  process.env.EXPO_BASE_URL = origin;
  ({ Expo } = await import("expo-server-sdk"));
});

afterAll(async () => {
  delete process.env.EXPO_BASE_URL;
  await emulator.close();
});

beforeEach(async () => {
  await control("/_expo-push/reset", { method: "POST" });
});

describe("expo-server-sdk against the emulator", () => {
  it("sends a message and reads its receipt", async () => {
    const expo = new Expo();
    const [ticket] = await expo.sendPushNotificationsAsync([
      { to: ALICE, title: "Reminder", body: "Haircut at 10:00" },
    ]);
    expect(ticket.status).toBe("ok");
    const id = (ticket as { id: string }).id;
    expect(await expo.getPushNotificationReceiptsAsync([id])).toEqual({ [id]: { status: "ok" } });

    const messages = (await control(`/_expo-push/messages?token=${encodeURIComponent(ALICE)}`)).data as Array<{
      message: { title: string };
    }>;
    expect(messages.map((m) => m.message.title)).toEqual(["Reminder"]);
  });

  it("sends 250 recipients through chunkPushNotifications, over the gzip threshold", async () => {
    const expo = new Expo();
    const messages = Array.from({ length: 250 }, (_, i) => ({
      to: `ExponentPushToken[device-${i}]`,
      body: `Appointment ${i}`,
      data: { appointmentId: i },
    }));
    const chunks = expo.chunkPushNotifications(messages);
    expect(chunks.map((chunk) => chunk.length)).toEqual([100, 100, 50]);
    const tickets = (await Promise.all(chunks.map((chunk) => expo.sendPushNotificationsAsync(chunk)))).flat();
    expect(tickets).toHaveLength(250);
    expect(tickets.every((t) => t.status === "ok")).toBe(true);
    expect(new Set(tickets.map((t) => (t as { id: string }).id)).size).toBe(250);

    const ids = tickets.map((t) => (t as { id: string }).id);
    const receipts = await expo.getPushNotificationReceiptsAsync(ids);
    expect(Object.keys(receipts)).toHaveLength(250);
  });

  it("returns an error ticket for a malformed token and keeps the ticket order", async () => {
    const expo = new Expo();
    const tickets = await expo.sendPushNotificationsAsync([
      { to: ALICE, body: "a" },
      { to: "garbage", body: "b" },
      { to: [BOB], body: "c" },
    ]);
    expect(tickets.map((t) => t.status)).toEqual(["ok", "error", "ok"]);
    expect(tickets[1]).toMatchObject({ details: { error: "DeviceNotRegistered" } });
  });

  it("surfaces DeviceNotRegistered on the receipt once a device is marked unregistered", async () => {
    await control("/_expo-push/devices", {
      method: "POST",
      body: JSON.stringify({ token: ALICE, registered: false }),
    });
    const expo = new Expo();
    const [ticket] = await expo.sendPushNotificationsAsync([{ to: ALICE, body: "hello" }]);
    expect(ticket.status).toBe("ok");
    const id = (ticket as { id: string }).id;
    const receipts = await expo.getPushNotificationReceiptsAsync([id]);
    expect(receipts[id]).toMatchObject({ status: "error", details: { error: "DeviceNotRegistered" } });
  });

  it("retries a 429 the way the SDK does and records every attempt", async () => {
    await control("/_expo-push/rules", {
      method: "PUT",
      body: JSON.stringify({ failures: [{ times: 2, fail: { at: "request" } }] }),
    });
    const expo = new Expo({ retryMinTimeout: 1 });
    const [ticket] = await expo.sendPushNotificationsAsync([{ to: ALICE, body: "flaky" }]);
    expect(ticket.status).toBe("ok");
    const requests = (await control("/_expo-push/requests")).data as Array<{ status: number }>;
    expect(requests.map((r) => r.status)).toEqual([429, 429, 200]);
  });

  it("throws the request error with its code when retries are exhausted", async () => {
    await control("/_expo-push/rules", {
      method: "PUT",
      body: JSON.stringify({ failures: [{ fail: { at: "request", status: 503, code: "SERVICE_UNAVAILABLE" } }] }),
    });
    const expo = new Expo();
    await expect(expo.sendPushNotificationsAsync([{ to: ALICE, body: "x" }])).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      statusCode: 503,
    });
  });

  it("throws VALIDATION_ERROR for a message the service rejects", async () => {
    const expo = new Expo();
    await expect(expo.sendPushNotificationsAsync([{ to: ALICE, priority: "urgent" as "high" }])).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      statusCode: 400,
    });
  });

  it("honours accessToken the same way Expo's enhanced push security does", async () => {
    // The access token is part of the seed, so start a second emulator that has one.
    const entry = new URL("../../../../emulate/src/api.ts", import.meta.url).href;
    const { createEmulator } = (await import(entry)) as {
      createEmulator(options: {
        service: "expo-push";
        port: number;
        seed: { "expo-push": { accessToken: string } };
      }): Promise<EmulatorHandle>;
    };
    const secured = await createEmulator({
      service: "expo-push",
      port: 0,
      seed: { "expo-push": { accessToken: "expo-access" } },
    });
    try {
      const url = new URL(secured.url).origin;
      const send = (token?: string) =>
        fetch(`${url}/--/api/v2/push/send`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify([{ to: ALICE }]),
        });
      expect((await send()).status).toBe(401);
      expect((await send("expo-access")).status).toBe(200);
    } finally {
      await secured.close();
    }
  });
});
