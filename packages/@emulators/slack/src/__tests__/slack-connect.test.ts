import { createHmac } from "node:crypto";
import { WebClient } from "@slack/web-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getSlackStore, seedFromConfig } from "../index.js";
import {
  authHeaders,
  captureFetchRequests,
  createSlackTestApp,
  registerSlackEventSubscription,
  slackTestBaseUrl as base,
  slackTestToken,
  startSlackTestEmulator,
  type SlackTestApp,
} from "./helpers.js";

const foreignTeam = "T_EXTERNAL";
const localTeam = "T000000001";
const botUser = "U_CONNECT_BOT";

function configure(setup: SlackTestApp) {
  seedFromConfig(setup.store, base, {
    users: [
      { name: "partner", team_id: foreignTeam },
      { name: "colleague" },
      { name: "stranger", team_id: "T_STRANGER", is_stranger: true },
    ],
    oauth_apps: [
      {
        app_id: "A_CONNECT",
        client_id: "connect",
        client_secret: "secret",
        name: "Connect Bot",
        redirect_uris: [],
        bot_user_id: botUser,
      },
    ],
    tokens: [
      {
        token: "xoxp-partner",
        type: "user",
        user: "partner",
        scopes: ["chat:write", "channels:join", "channels:write"],
      },
    ],
    signing_secret: "connect-signing-secret",
  });
  const ss = getSlackStore(setup.store);
  const foreign = ss.users.findOneBy("name", "partner")!;
  setup.tokenMap.set("external-dev-token", { login: foreign.user_id, id: foreign.id, scopes: [] });
  return setup;
}

function call(setup: SlackTestApp, method: string, body: unknown, token?: string) {
  return setup.app
    .request(`/api/${method}`, {
      method: "POST",
      headers: token ? { ...authHeaders(), Authorization: `Bearer ${token}` } : authHeaders(),
      body: JSON.stringify(body),
    })
    .then((response) => response.json() as Promise<Record<string, any>>);
}

async function createSharedChannel(setup: SlackTestApp, isPrivate = false) {
  const created = await call(setup, "conversations.create", { name: "partners", is_private: isPrivate });
  const channel = created.channel.id as string;
  const user = getSlackStore(setup.store).users.findOneBy("name", "partner")!.user_id;
  expect(await call(setup, "conversations.invite", { channel, users: `${user},${botUser}` })).toMatchObject({
    ok: true,
  });
  return { channel, user };
}

afterEach(() => vi.unstubAllGlobals());

describe("Slack Connect fixtures", () => {
  it("returns each user's workspace and stranger flag through user reads", async () => {
    const setup = configure(createSlackTestApp());
    const ss = getSlackStore(setup.store);
    for (const [name, team_id, is_stranger] of [
      ["partner", foreignTeam, false],
      ["colleague", localTeam, false],
      ["stranger", "T_STRANGER", true],
    ] as const) {
      const user = ss.users.findOneBy("name", name)!;
      expect(await call(setup, "users.info", { user: user.user_id })).toMatchObject({
        user: { id: user.user_id, team_id, is_stranger },
      });
      expect((await call(setup, "users.list", {})).members).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: user.user_id, team_id, is_stranger })]),
      );
    }
  });

  it("recognizes seeded external members and explicit shared channels", async () => {
    const setup = configure(createSlackTestApp());
    seedFromConfig(setup.store, base, { channels: [{ name: "seeded-partners" }] });
    const seeded = getSlackStore(setup.store).channels.findOneBy("name", "seeded-partners")!;
    expect(await call(setup, "conversations.info", { channel: seeded.channel_id })).toMatchObject({
      channel: { is_ext_shared: true, is_shared: true },
    });

    const local = createSlackTestApp();
    seedFromConfig(local.store, base, { channels: [{ name: "shared-fixture", is_ext_shared: true }] });
    const shared = getSlackStore(local.store).channels.findOneBy("name", "shared-fixture")!;
    expect(await call(local, "conversations.info", { channel: shared.channel_id })).toMatchObject({
      channel: { is_ext_shared: true, is_shared: true },
    });
    expect(await call(local, "conversations.info", { channel: "C000000001" })).toMatchObject({
      channel: { is_ext_shared: false, is_shared: false },
    });
  });

  it.each([false, true])(
    "marks invited external members in a private=%s channel and retains sharing after a kick",
    async (isPrivate) => {
      const setup = configure(createSlackTestApp());
      const { channel, user } = await createSharedChannel(setup, isPrivate);
      const info = await call(setup, "conversations.info", { channel });
      expect(info.channel).toMatchObject({ is_private: isPrivate, is_ext_shared: true, is_shared: true });
      expect(
        (await call(setup, "conversations.list", { types: isPrivate ? "private_channel" : "public_channel" })).channels,
      ).toEqual(expect.arrayContaining([expect.objectContaining({ id: channel, is_ext_shared: true })]));
      expect(await call(setup, "conversations.kick", { channel, user })).toMatchObject({ ok: true });
      expect((await call(setup, "conversations.members", { channel })).members).not.toContain(user);
      expect((await call(setup, "conversations.info", { channel })).channel.is_ext_shared).toBe(true);
    },
  );

  it("marks an external user's join and retains sharing after they leave", async () => {
    const setup = configure(createSlackTestApp());
    const { channel } = await call(setup, "conversations.create", { name: "join-test" });
    expect(await call(setup, "conversations.join", { channel: channel.id }, "xoxp-partner")).toMatchObject({
      channel: { is_ext_shared: true },
    });
    expect(await call(setup, "conversations.leave", { channel: channel.id }, "xoxp-partner")).toMatchObject({
      ok: true,
    });
    expect((await call(setup, "conversations.info", { channel: channel.id })).channel.is_ext_shared).toBe(true);
  });

  it("does not mark a channel shared when an invite is rejected", async () => {
    const setup = configure(createSlackTestApp());
    const { channel } = await call(setup, "conversations.create", { name: "atomic-invite" });
    const foreign = getSlackStore(setup.store).users.findOneBy("name", "partner")!;
    expect(
      await call(setup, "conversations.invite", { channel: channel.id, users: `${foreign.user_id},U_MISSING` }),
    ).toMatchObject({ ok: false });
    expect((await call(setup, "conversations.info", { channel: channel.id })).channel.is_ext_shared).toBe(false);
  });

  it.each(["xoxp-partner", "external-dev-token"])(
    "distinguishes a foreign author from the receiving workspace with %s",
    async (token) => {
      const setup = configure(createSlackTestApp());
      const { channel, user } = await createSharedChannel(setup);
      const parent = await call(setup, "chat.postMessage", { channel, text: "Local thread" });
      const capture = captureFetchRequests();
      registerSlackEventSubscription(setup.webhooks, ["message", "app_mention"]);
      const posted = await call(
        setup,
        "chat.postMessage",
        { channel, text: `<@${botUser}> help`, thread_ts: parent.ts },
        token,
      );
      expect(posted.ok).toBe(true);
      expect(capture.jsonBodies()).toEqual([
        expect.objectContaining({
          team_id: localTeam,
          is_ext_shared_channel: true,
          event: expect.objectContaining({ type: "message", user, ts: posted.ts, thread_ts: parent.ts }),
        }),
        expect.objectContaining({
          team_id: localTeam,
          is_ext_shared_channel: true,
          api_app_id: "A_CONNECT",
          authorizations: [expect.objectContaining({ team_id: localTeam, user_id: botUser, is_bot: true })],
          event: expect.objectContaining({
            type: "app_mention",
            user,
            user_team: foreignTeam,
            source_team: foreignTeam,
            ts: posted.ts,
            thread_ts: parent.ts,
          }),
        }),
      ]);
      const mention = capture.requests[1]!.init;
      const headers = mention.headers as Record<string, string>;
      expect(headers["X-Slack-Signature"]).toBe(
        `v0=${createHmac("sha256", "connect-signing-secret").update(`v0:${headers["X-Slack-Request-Timestamp"]}:${mention.body}`).digest("hex")}`,
      );
      expect((await call(setup, "conversations.replies", { channel, ts: parent.ts })).messages).toEqual(
        expect.arrayContaining([expect.objectContaining({ user, ts: posted.ts })]),
      );
    },
  );

  it("keeps local authors local in shared channels", async () => {
    const setup = configure(createSlackTestApp());
    const { channel } = await createSharedChannel(setup);
    const capture = captureFetchRequests();
    registerSlackEventSubscription(setup.webhooks, ["app_mention"]);
    await call(setup, "chat.postMessage", { channel, text: `<@${botUser}> local author` });
    const [payload] = capture.jsonBodies() as Array<Record<string, any>>;
    expect(payload).toMatchObject({ team_id: localTeam, is_ext_shared_channel: true, event: { user: "U000000001" } });
    expect(payload!.event).not.toHaveProperty("user_team");
  });

  it("marks updates, reactions, and deletions in shared channels", async () => {
    const setup = configure(createSlackTestApp());
    const { channel } = await createSharedChannel(setup);
    const capture = captureFetchRequests();
    registerSlackEventSubscription(setup.webhooks);
    const posted = await call(setup, "chat.postMessage", { channel, text: "before" });
    await call(setup, "chat.update", { channel, ts: posted.ts, text: "after" });
    await call(setup, "reactions.add", { channel, timestamp: posted.ts, name: "wave" });
    await call(setup, "reactions.remove", { channel, timestamp: posted.ts, name: "wave" });
    await call(setup, "chat.delete", { channel, ts: posted.ts });
    expect(capture.jsonBodies()).toHaveLength(5);
    for (const payload of capture.jsonBodies())
      expect(payload).toMatchObject({ team_id: localTeam, is_ext_shared_channel: true });
  });

  it("keeps private channel access restricted for an uninvited external user", async () => {
    const setup = configure(createSlackTestApp());
    const { channel } = await call(setup, "conversations.create", { name: "private-local", is_private: true });
    expect(await call(setup, "conversations.info", { channel: channel.id }, "xoxp-partner")).toMatchObject({
      ok: false,
      error: "not_in_channel",
    });
    expect(
      await call(setup, "chat.postMessage", { channel: channel.id, text: "No access" }, "xoxp-partner"),
    ).toMatchObject({ ok: false, error: "not_in_channel" });
    expect(
      (await call(setup, "conversations.list", { types: "private_channel" }, "xoxp-partner")).channels,
    ).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: channel.id })]));
  });

  it("reads older snapshots without Connect fields using local defaults", async () => {
    const setup = createSlackTestApp();
    setup.store.restore(JSON.parse(JSON.stringify(setup.store.snapshot())));
    expect((await call(setup, "users.info", { user: "U000000001" })).user).toMatchObject({
      team_id: localTeam,
      is_stranger: false,
    });
    expect((await call(setup, "conversations.info", { channel: "C000000001" })).channel).toMatchObject({
      is_shared: false,
      is_ext_shared: false,
    });
    const capture = captureFetchRequests();
    registerSlackEventSubscription(setup.webhooks);
    await call(setup, "chat.postMessage", { channel: "C000000001", text: "Local message" });
    expect(capture.jsonBodies()[0]).toMatchObject({ team_id: localTeam, is_ext_shared_channel: false });
  });

  it("preserves shared state across snapshots after the external member leaves", async () => {
    const setup = configure(createSlackTestApp());
    const { channel, user } = await createSharedChannel(setup);
    await call(setup, "conversations.kick", { channel, user });
    const snapshot = JSON.parse(JSON.stringify(setup.store.snapshot()));
    const restored = createSlackTestApp();
    restored.store.restore(snapshot);
    expect((await call(restored, "conversations.info", { channel })).channel.is_ext_shared).toBe(true);
    expect((await call(restored, "users.info", { user })).user.team_id).toBe(foreignTeam);
  });

  it("supports the Slack SDK's user and conversation reads over HTTP", async () => {
    const emulator = await startSlackTestEmulator((setup) => {
      configure(setup);
    });
    try {
      const client = new WebClient(slackTestToken, { slackApiUrl: `${emulator.url}/api/` });
      const foreign = getSlackStore(emulator.store).users.findOneBy("name", "partner")!;
      const created = await client.conversations.create({ name: "sdk-connect" });
      const channel = created.channel!.id!;
      await client.conversations.invite({ channel, users: foreign.user_id });
      expect((await client.users.info({ user: foreign.user_id })).user).toMatchObject({
        team_id: foreignTeam,
        is_stranger: false,
      });
      expect((await client.users.list({})).members).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: foreign.user_id, team_id: foreignTeam })]),
      );
      expect((await client.conversations.info({ channel })).channel).toMatchObject({
        is_ext_shared: true,
        is_shared: true,
      });
      expect((await client.conversations.list()).channels).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: channel, is_ext_shared: true })]),
      );
    } finally {
      await emulator.close();
    }
  });
});
