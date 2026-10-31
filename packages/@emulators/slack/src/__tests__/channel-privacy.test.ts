import { createHmac } from "node:crypto";
import { WebClient } from "@slack/web-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getSlackStore, seedFromConfig } from "../index.js";
import {
  captureFetchRequests,
  createSlackTestApp,
  registerSlackEventSubscription,
  slackTestBaseUrl,
  startSlackTestEmulator,
  type SlackTestApp,
} from "./helpers.js";

const adminToken = "privacy-admin";
const scope = "admin.conversations:write";
const methods = ["convertToPrivate", "convertToPublic"] as const;

function configure(setup: SlackTestApp) {
  seedFromConfig(setup.store, slackTestBaseUrl, {
    users: [{ name: "outsider" }],
    channels: [{ name: "privacy-test" }],
    tokens: [
      { token: adminToken, type: "user", user: "admin", scopes: [scope] },
      { token: "privacy-outsider", type: "user", user: "outsider", scopes: [scope] },
      { token: "privacy-bot", type: "bot", user: "admin", scopes: [scope] },
      { token: "privacy-test-token", type: "test", user: "admin", scopes: [scope] },
      { token: "privacy-no-scope", type: "user", user: "admin", scopes: [] },
    ],
    signing_secret: "privacy-signing-secret",
  });
  const ss = getSlackStore(setup.store);
  const channel = ss.channels.findOneBy("name", "privacy-test")!;
  ss.channels.update(channel.id, { members: ["U000000001"], num_members: 1 });
  return { ...setup, channel: channel.channel_id };
}

async function call(
  setup: SlackTestApp,
  method: string,
  body: Record<string, unknown> = {},
  token: string | null = adminToken,
) {
  const response = await setup.app.request(`/api/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, any>;
}

async function convert(setup: SlackTestApp & { channel: string }, method: string, token = adminToken) {
  return call(setup, `admin.conversations.${method}`, { channel_id: setup.channel }, token);
}

afterEach(() => vi.unstubAllGlobals());

describe("Slack channel privacy", () => {
  it("changes visibility and list types without losing channel identity, members, or history", async () => {
    const setup = configure(createSlackTestApp());
    const ss = getSlackStore(setup.store);
    const before = ss.channels.findOneBy("channel_id", setup.channel)!;
    await call(setup, "chat.postMessage", { channel: setup.channel, text: "keep this history" });
    expect(await call(setup, "conversations.info", { channel: setup.channel }, "privacy-outsider")).toMatchObject({
      ok: true,
      channel: { is_private: false },
    });

    expect(await convert(setup, "convertToPrivate")).toEqual({ ok: true });
    expect(ss.channels.findOneBy("channel_id", setup.channel)).toMatchObject({
      channel_id: before.channel_id,
      name: before.name,
      members: before.members,
      num_members: before.num_members,
      topic: before.topic,
      purpose: before.purpose,
      is_private: true,
      is_channel: false,
    });
    expect(await call(setup, "conversations.info", { channel: setup.channel })).toMatchObject({
      channel: { id: setup.channel, is_private: true, is_channel: false, is_group: true },
    });
    for (const method of ["info", "history", "members"]) {
      expect(await call(setup, `conversations.${method}`, { channel: setup.channel }, "privacy-outsider")).toEqual({
        ok: false,
        error: "not_in_channel",
      });
    }
    const publicList = await call(setup, "conversations.list", { types: "public_channel" });
    expect(publicList.channels.some((channel: { id: string }) => channel.id === setup.channel)).toBe(false);
    const privateList = await call(setup, "conversations.list", { types: "private_channel" });
    expect(privateList.channels).toEqual([expect.objectContaining({ id: setup.channel })]);

    const restored = configure(createSlackTestApp());
    restored.store.restore(JSON.parse(JSON.stringify(setup.store.snapshot())));
    restored.channel = setup.channel;
    expect(await call(restored, "conversations.info", { channel: setup.channel })).toMatchObject({
      channel: { is_private: true },
    });
    expect(await convert(restored, "convertToPublic")).toEqual({ ok: true });
    expect(await call(restored, "conversations.info", { channel: setup.channel }, "privacy-outsider")).toMatchObject({
      channel: { is_private: false, is_channel: true, is_group: false },
    });
    const history = await call(restored, "conversations.history", { channel: setup.channel }, "privacy-outsider");
    expect(history.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: "keep this history" }),
        expect.objectContaining({ subtype: "channel_convert_to_private" }),
        expect.objectContaining({ subtype: "channel_convert_to_public" }),
      ]),
    );
  });

  it("dispatches signed conversion messages after updating privacy, including shared-channel metadata", async () => {
    const setup = configure(createSlackTestApp());
    const ss = getSlackStore(setup.store);
    const channel = ss.channels.findOneBy("channel_id", setup.channel)!;
    ss.channels.update(channel.id, { is_ext_shared: true });
    registerSlackEventSubscription(setup.webhooks, ["message"]);
    const captured = captureFetchRequests();

    for (const [method, channelType] of [
      ["convertToPrivate", "group"],
      ["convertToPublic", "channel"],
    ]) {
      expect(await convert(setup, method)).toEqual({ ok: true });
      const request = captured.requests.at(-1)!;
      const payload = captured.jsonBodies().at(-1) as Record<string, any>;
      const subtype = method === "convertToPrivate" ? "channel_convert_to_private" : "channel_convert_to_public";
      expect(payload).toMatchObject({
        type: "event_callback",
        team_id: "T000000001",
        is_ext_shared_channel: true,
        event: { type: "message", subtype, channel: setup.channel, channel_type: channelType, user: "U000000001" },
      });
      expect(payload.event.event_ts).toBe(payload.event.ts);
      expect(ss.messages.findOneBy("ts", payload.event.ts)?.subtype).toBe(subtype);
      const headers = new Headers(request.init.headers);
      const timestamp = headers.get("X-Slack-Request-Timestamp");
      const signature = createHmac("sha256", "privacy-signing-secret")
        .update(`v0:${timestamp}:${request.init.body}`)
        .digest("hex");
      expect(headers.get("X-Slack-Signature")).toBe(`v0=${signature}`);
    }
    expect(captured.requests).toHaveLength(2);
  });

  it.each(methods)("checks authentication, token type, admin status, and scopes for %s", async (method) => {
    const setup = configure(createSlackTestApp());
    const ss = getSlackStore(setup.store);
    const channel = ss.channels.findOneBy("channel_id", setup.channel)!;
    ss.channels.update(channel.id, { is_private: method === "convertToPublic" });
    const before = setup.store.snapshot();
    expect(await call(setup, `admin.conversations.${method}`, { channel_id: setup.channel }, null)).toEqual({
      ok: false,
      error: "not_authed",
    });
    for (const token of ["privacy-bot", "privacy-test-token"]) {
      expect(await convert(setup, method, token)).toEqual({ ok: false, error: "not_allowed_token_type" });
    }
    expect(await convert(setup, method, "privacy-outsider")).toMatchObject({ ok: false, error: "missing_scope" });
    expect(setup.store.snapshot()).toEqual(before);

    setup.store.setData("slack.strict_scopes", true);
    expect(await convert(setup, method, "privacy-no-scope")).toEqual({
      ok: false,
      error: "missing_scope",
      needed: scope,
      provided: "",
    });
    expect(ss.messages.all()).toHaveLength(0);
    expect(await convert(setup, method)).toEqual({ ok: true });
  });

  it("allows scope-free user tokens in relaxed mode and admin conversions without membership", async () => {
    const setup = configure(createSlackTestApp());
    const ss = getSlackStore(setup.store);
    const channel = ss.channels.findOneBy("channel_id", setup.channel)!;
    ss.channels.update(channel.id, { members: [], num_members: 0 });
    expect(await convert(setup, "convertToPrivate", "privacy-no-scope")).toEqual({ ok: true });
    expect(await convert(setup, "convertToPublic", "privacy-no-scope")).toEqual({ ok: true });
    expect(ss.channels.findOneBy("channel_id", setup.channel)?.members).toEqual([]);
  });

  it.each(methods)("rejects missing channels, DMs, MPIMs, and repeated %s without side effects", async (method) => {
    const setup = configure(createSlackTestApp());
    const ss = getSlackStore(setup.store);
    const channel = ss.channels.findOneBy("channel_id", setup.channel)!;
    const error = method === "convertToPrivate" ? "channel_type_not_supported" : "not_supported";
    for (const body of [{}, { channel_id: "C_MISSING" }]) {
      expect(await call(setup, `admin.conversations.${method}`, body)).toEqual({
        ok: false,
        error: "channel_not_found",
      });
    }
    for (const flags of [
      { is_im: true, is_mpim: false },
      { is_im: false, is_mpim: true },
      { is_im: false, is_mpim: false, is_private: method === "convertToPrivate" },
    ]) {
      ss.channels.update(channel.id, flags);
      const before = setup.store.snapshot();
      expect(await convert(setup, method)).toEqual({ ok: false, error });
      expect(setup.store.snapshot()).toEqual(before);
    }
    if (method === "convertToPrivate") {
      expect(await call(setup, `admin.conversations.${method}`, { channel_id: "C000000001" })).toEqual({
        ok: false,
        error,
      });
    }
    expect(ss.messages.all()).toHaveLength(0);
  });

  it("supports both admin methods through WebClient and updates existing file shares", async () => {
    const emulator = await startSlackTestEmulator((setup) => {
      configure(setup);
    });
    try {
      const ss = getSlackStore(emulator.store);
      const channel = ss.channels.findOneBy("name", "privacy-test")!.channel_id;
      const client = new WebClient(adminToken, { slackApiUrl: `${emulator.url}/api/` });
      const upload = await client.files.getUploadURLExternal({ filename: "privacy.txt", length: 4 });
      expect((await fetch(upload.upload_url!, { method: "POST", body: "test" })).ok).toBe(true);
      await client.files.completeUploadExternal({ files: [{ id: upload.file_id! }], channel_id: channel });
      const shares = ss.files.findOneBy("file_id", upload.file_id!)!.shares.public![channel];
      expect((await client.files.info({ file: upload.file_id! })).file?.is_public).toBe(true);

      expect(await client.admin.conversations.convertToPrivate({ channel_id: channel })).toMatchObject({ ok: true });
      const privateFile = (await client.files.info({ file: upload.file_id! })).file!;
      expect(privateFile).toMatchObject({ is_public: false, channels: [], groups: [channel] });
      expect(privateFile.shares?.private?.[channel]).toEqual(shares);
      expect(privateFile.shares?.public).toBeUndefined();
      expect(await call(emulator, "files.info", { file: upload.file_id! }, "privacy-outsider")).toEqual({
        ok: false,
        error: "file_not_found",
      });

      expect(await client.admin.conversations.convertToPublic({ channel_id: channel })).toMatchObject({ ok: true });
      const publicFile = (await client.files.info({ file: upload.file_id! })).file!;
      expect(publicFile).toMatchObject({ is_public: true, channels: [channel], groups: [] });
      expect(publicFile.shares?.public?.[channel]).toEqual(shares);
      expect(publicFile.shares?.private).toBeUndefined();
      expect(await call(emulator, "files.info", { file: upload.file_id! }, "privacy-outsider")).toMatchObject({
        ok: true,
      });
    } finally {
      await emulator.close();
    }
  });
});
