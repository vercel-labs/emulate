import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getSlackStore } from "../store.js";
import {
  authHeaders,
  captureFetchRequests,
  createSlackTestApp,
  registerSlackEventSubscription,
  startSlackTestEmulator,
} from "./helpers.js";
import type { SlackTestApp } from "./helpers.js";

async function post(setup: SlackTestApp, path: string, body: unknown, headers = authHeaders()) {
  const response = await setup.app.request(path, { method: "POST", headers, body: JSON.stringify(body) });
  return response.json() as Promise<Record<string, unknown>>;
}

async function emit(setup: SlackTestApp) {
  const channel = getSlackStore(setup.store).channels.findOneBy("name", "general")!;
  await post(setup, "/api/chat.postMessage", { channel: channel.channel_id, text: "Process this once" });
  return (setup.webhooks.getDeliveries().at(-1)!.payload as { event_id: string }).event_id;
}

const retry = (setup: SlackTestApp, body: unknown) => post(setup, "/_slack/simulate/event-retry", body);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Slack event retries", () => {
  it("resends the exact event with retry headers and a fresh valid Slack signature", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const setup = createSlackTestApp();
    setup.store.setData("slack.signing_secret", "slack-secret");
    const capture = captureFetchRequests();
    registerSlackEventSubscription(setup.webhooks, ["message"]);
    const eventId = await emit(setup);
    const before = getSlackStore(setup.store).messages.all();
    vi.setSystemTime(new Date("2026-01-01T00:05:00Z"));

    expect(await retry(setup, { event_id: eventId })).toEqual({
      ok: true,
      event_id: eventId,
      retry_num: 1,
      delivery_id: 2,
      success: true,
      status_code: 200,
    });
    const original = capture.requests[0]!.init;
    const request = capture.requests[1]!.init;
    const headers = request.headers as Record<string, string>;
    expect(request.body).toBe(original.body);
    expect(headers).toMatchObject({
      "Content-Type": "application/json",
      "X-Slack-Retry-Num": "1",
      "X-Slack-Retry-Reason": "http_timeout",
      "X-Slack-Request-Timestamp": "1767225900",
    });
    expect(headers["X-Slack-Signature"]).toBe(
      `v0=${createHmac("sha256", "slack-secret").update(`v0:${headers["X-Slack-Request-Timestamp"]}:${request.body}`).digest("hex")}`,
    );
    expect(headers["X-Slack-Signature"]).not.toBe((original.headers as Record<string, string>)["X-Slack-Signature"]);
    expect(original.headers).not.toHaveProperty("X-Slack-Retry-Num");
    expect(headers).not.toHaveProperty("X-GitHub-Event");
    expect(getSlackStore(setup.store).messages.all()).toEqual(before);
    expect(setup.webhooks.getDeliveries()).toHaveLength(2);
  });

  it("shows event IDs and retry attempts in the inspector", async () => {
    const setup = createSlackTestApp();
    captureFetchRequests();
    registerSlackEventSubscription(setup.webhooks);
    const eventId = await emit(setup);
    await retry(setup, { event_id: eventId });
    const response = await setup.app.request("/?tab=events");
    const html = await response.text();
    expect(html).toContain(eventId);
    expect(html).toContain("Event ID");
    expect(html).toContain("Retry");
  });

  it("lets an HTTP receiver deduplicate a failed event and its signed retry", async () => {
    const received: Array<{ event_id: string; body: string; retry?: string }> = [];
    const processed = new Set<string>();
    const errors: unknown[] = [];
    const receiver = createServer(async (req, res) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks).toString();
        expect(req.headers["x-slack-signature"]).toBe(
          `v0=${createHmac("sha256", "http-secret").update(`v0:${req.headers["x-slack-request-timestamp"]}:${body}`).digest("hex")}`,
        );
        const payload = JSON.parse(body) as { event_id: string };
        received.push({
          event_id: payload.event_id,
          body,
          retry: req.headers["x-slack-retry-num"] as string | undefined,
        });
        processed.add(payload.event_id);
        res.writeHead(received.length === 1 ? 503 : 200).end();
      } catch (error) {
        errors.push(error);
        res.writeHead(500).end();
      }
    });
    let emulator: Awaited<ReturnType<typeof startSlackTestEmulator>> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        receiver.once("error", reject);
        receiver.listen(0, "127.0.0.1", resolve);
      });
      const receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
      emulator = await startSlackTestEmulator((setup) => {
        setup.store.setData("slack.signing_secret", "http-secret");
        setup.webhooks.register({ owner: "slack", url: receiverUrl, events: ["message"], active: true });
      });
      const channel = getSlackStore(emulator.store).channels.findOneBy("name", "general")!.channel_id;
      await fetch(`${emulator.url}/api/chat.postMessage`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ channel, text: "Deduplicate me" }),
      });
      expect(received).toHaveLength(1);
      const response = await fetch(`${emulator.url}/_slack/simulate/event-retry`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ event_id: received[0]!.event_id, reason: "http_error" }),
      });
      expect(await response.json()).toMatchObject({ ok: true, retry_num: 1, success: true, status_code: 200 });
      expect(received).toHaveLength(2);
      expect(received[1]!.body).toBe(received[0]!.body);
      expect(received.map((request) => request.retry)).toEqual([undefined, "1"]);
      expect(processed.size).toBe(1);
      expect(errors).toEqual([]);
      expect(emulator.webhooks.getDeliveries().map((delivery) => delivery.status_code)).toEqual([503, 200]);
    } finally {
      await emulator?.close();
      if (receiver.listening)
        await new Promise<void>((resolve, reject) => receiver.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("increments per event and targets only its latest recorded recipient", async () => {
    const setup = createSlackTestApp();
    const capture = captureFetchRequests();
    registerSlackEventSubscription(setup.webhooks, ["message"]);
    setup.webhooks.register({ owner: "slack", url: "https://hooks.example/second", events: ["message"], active: true });
    const first = await emit(setup);
    const second = await emit(setup);
    expect(await retry(setup, { event_id: first, reason: "http_error" })).toMatchObject({ retry_num: 1 });
    expect(await retry(setup, { event_id: first, reason: "connection_failed" })).toMatchObject({ retry_num: 2 });
    expect(await retry(setup, { event_id: second })).toMatchObject({ retry_num: 1 });
    expect(capture.requests.slice(4).map((request) => request.url)).toEqual(
      Array(3).fill("https://hooks.example/second"),
    );
    expect(capture.requests[4]!.init.headers).toMatchObject({ "X-Slack-Retry-Reason": "http_error" });
    expect(capture.requests[5]!.init.headers).toMatchObject({ "X-Slack-Retry-Reason": "connection_failed" });
  });

  it("records failed retries and counts them on the next attempt", async () => {
    const setup = createSlackTestApp();
    captureFetchRequests(503);
    registerSlackEventSubscription(setup.webhooks);
    const eventId = await emit(setup);
    expect(setup.webhooks.getDeliveries()).toHaveLength(1);
    expect(await retry(setup, { event_id: eventId })).toMatchObject({ retry_num: 1, success: false, status_code: 503 });
    vi.mocked(fetch).mockRejectedValueOnce(new Error("offline"));
    expect(await retry(setup, { event_id: eventId })).toMatchObject({
      retry_num: 2,
      success: false,
      status_code: null,
    });
    expect(setup.webhooks.getDeliveries()).toHaveLength(3);
  });

  it("allocates distinct retry numbers to concurrent requests", async () => {
    const setup = createSlackTestApp();
    const capture = captureFetchRequests();
    registerSlackEventSubscription(setup.webhooks);
    const eventId = await emit(setup);
    const responses = await Promise.all(Array.from({ length: 5 }, () => retry(setup, { event_id: eventId })));
    expect(responses.map((response) => response.retry_num)).toEqual([1, 2, 3, 4, 5]);
    expect(
      capture.requests.slice(1).map((request) => (request.init.headers as Record<string, string>)["X-Slack-Retry-Num"]),
    ).toEqual(["1", "2", "3", "4", "5"]);
  });

  it.each([
    {},
    { event_id: "" },
    { event_id: 1 },
    { event_id: "Ev1", reason: "bad\r\nheader" },
    { event_id: "Ev1", reason: ["http_error"] },
  ])("rejects invalid arguments: %j", async (body) => {
    expect(await retry(createSlackTestApp(), body)).toEqual({ ok: false, error: "invalid_arguments" });
  });

  it("requires authentication and rejects revoked tokens", async () => {
    const setup = createSlackTestApp();
    expect(
      await post(setup, "/_slack/simulate/event-retry", { event_id: "Ev1" }, { "Content-Type": "application/json" }),
    ).toEqual({ ok: false, error: "not_authed" });
    setup.store.setData("slack.revoked_tokens", new Set(["xoxb-test-token"]));
    expect(await retry(setup, { event_id: "Ev1" })).toEqual({ ok: false, error: "token_revoked" });
  });

  it("does not replay another service's deliveries or non-event payloads", async () => {
    const setup = createSlackTestApp();
    const capture = captureFetchRequests();
    setup.webhooks.register({ owner: "other", url: "https://hooks.example/other", events: ["*"], active: true });
    await setup.webhooks.dispatch("message", undefined, { type: "event_callback", event_id: "EvOther" }, "other");
    registerSlackEventSubscription(setup.webhooks);
    await setup.webhooks.dispatch("message", undefined, { type: "url_verification", event_id: "EvChallenge" }, "slack");
    for (const event_id of ["EvMissing", "EvOther", "EvChallenge"]) {
      expect(await retry(setup, { event_id })).toEqual({ ok: false, error: "event_not_found" });
    }
    expect(capture.requests).toHaveLength(2);
  });

  it("does not fall back to another subscriber when the latest is inactive", async () => {
    const setup = createSlackTestApp();
    const capture = captureFetchRequests();
    registerSlackEventSubscription(setup.webhooks);
    const eventId = await emit(setup);
    setup.webhooks.updateSubscription(1, { active: false });
    expect(await retry(setup, { event_id: eventId })).toEqual({ ok: false, error: "subscription_inactive" });
    expect(capture.requests).toHaveLength(1);
  });
});
