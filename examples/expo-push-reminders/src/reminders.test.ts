import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createEmulator, type Emulator } from "emulate";
import type { Expo as ExpoClass } from "expo-server-sdk";
import { sendReminders } from "./reminders.js";

const PHONE = "ExponentPushToken[customer-phone]";
const TABLET = "ExponentPushToken[customer-tablet]";
const OLD_PHONE = "ExponentPushToken[customer-old-phone]";

let emulator: Emulator;
let origin: string;
let Expo: typeof ExpoClass;

beforeAll(async () => {
  emulator = await createEmulator({
    service: "expo-push",
    port: 0,
    seed: { "expo-push": { devices: [{ token: OLD_PHONE, registered: false }] } },
  });
  origin = new URL(emulator.url).origin;
  // expo-server-sdk reads EXPO_BASE_URL when it is first imported, so import it now.
  process.env.EXPO_BASE_URL = origin;
  ({ Expo } = await import("expo-server-sdk"));
});

afterAll(async () => {
  delete process.env.EXPO_BASE_URL;
  await emulator.close();
});

beforeEach(() => emulator.reset());

async function messagesTo(token: string) {
  const response = await fetch(`${origin}/_expo-push/messages?token=${encodeURIComponent(token)}`);
  return ((await response.json()) as { data: Array<{ message: { body: string; data: { appointmentId: number } } }> })
    .data;
}

describe("sendReminders", () => {
  it("sends one reminder per device and asserts what each device was sent", async () => {
    const result = await sendReminders(new Expo(), [
      { id: 41, service: "Haircut", startsAt: "10:00", pushTokens: [PHONE, TABLET] },
    ]);
    expect(result).toEqual({ deadTokens: [], sent: 2 });
    expect((await messagesTo(PHONE)).map((m) => m.message.body)).toEqual(["Haircut at 10:00"]);
    expect((await messagesTo(TABLET)).map((m) => m.message.data.appointmentId)).toEqual([41]);
  });

  it("reports a device whose receipt says DeviceNotRegistered, without failing the others", async () => {
    const result = await sendReminders(new Expo(), [
      { id: 42, service: "Beard trim", startsAt: "11:30", pushTokens: [OLD_PHONE, PHONE] },
    ]);
    expect(result.deadTokens).toEqual([OLD_PHONE]);
    expect(result.sent).toBe(2);
  });

  it("reports a malformed token from the ticket, before any receipt exists", async () => {
    const result = await sendReminders(new Expo(), [
      { id: 43, service: "Colour", startsAt: "14:00", pushTokens: ["not-a-token", PHONE] },
    ]);
    expect(result.deadTokens).toEqual(["not-a-token"]);
  });

  it("survives a rate limited request because the SDK retries it", async () => {
    await fetch(`${origin}/_expo-push/rules`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ failures: [{ times: 1, fail: { at: "request" } }] }),
    });
    const result = await sendReminders(new Expo({ retryMinTimeout: 1 }), [
      { id: 44, service: "Haircut", startsAt: "16:00", pushTokens: [PHONE] },
    ]);
    expect(result).toEqual({ deadTokens: [], sent: 1 });
    expect(await messagesTo(PHONE)).toHaveLength(1);
  });
});
