import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebClient } from "@slack/web-api";
import { getSlackStore } from "../index.js";
import { slackTestToken, startSlackTestEmulator, type SlackTestEmulator } from "./helpers.js";

describe("Slack plugin - real @slack/web-api WebClient baseline", () => {
  let emulator: SlackTestEmulator | undefined;
  let client: WebClient;

  beforeAll(async () => {
    emulator = await startSlackTestEmulator(({ store }) => {
      getSlackStore(store).bots.insert({
        bot_id: "B000000001",
        name: "test-bot",
        deleted: false,
        icons: { image_48: "" },
      });
    });

    client = new WebClient(slackTestToken, {
      slackApiUrl: `${emulator.url}/api/`,
    });
  });

  afterAll(async () => {
    await emulator?.close();
  });

  it("calls auth.test and team.info through the Slack SDK", async () => {
    const auth = await client.auth.test();
    expect(auth.ok).toBe(true);
    expect(auth.user_id).toBe("U000000001");

    const team = await client.team.info();
    expect(team.ok).toBe(true);
    expect(team.team?.name).toBe("Emulate");
  });

  it("uses an OAuth generated bot token through the Slack SDK", async () => {
    expect(emulator).toBeDefined();
    const ss = getSlackStore(emulator!.store);
    ss.oauthApps.insert({
      app_id: "A000000777",
      client_id: "77777.00001",
      client_secret: "sdk-secret",
      name: "SDK OAuth App",
      redirect_uris: ["http://localhost:3000/slack/callback"],
      scopes: ["chat:write", "channels:read"],
      bot_id: "B000000777",
      bot_user_id: "U000000777",
      bot_name: "sdk-oauth-app",
    });

    const params = new URLSearchParams({
      user_id: "U000000001",
      redirect_uri: "http://localhost:3000/slack/callback",
      scope: "chat:write,channels:read",
      state: "sdk",
      client_id: "77777.00001",
    });
    const callback = await fetch(`${emulator!.url}/oauth/v2/authorize/callback`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params,
      redirect: "manual",
    });
    expect(callback.status).toBe(302);
    const code = new URL(callback.headers.get("Location")!).searchParams.get("code");
    expect(code).toBeDefined();

    const oauthClient = new WebClient(undefined, {
      slackApiUrl: `${emulator!.url}/api/`,
    });
    const exchanged = (await oauthClient.apiCall("oauth.v2.access", {
      code: code!,
      client_id: "77777.00001",
      client_secret: "sdk-secret",
      redirect_uri: "http://localhost:3000/slack/callback",
    })) as any;
    expect(exchanged.ok).toBe(true);
    expect(exchanged.access_token).toMatch(/^xoxb-/);
    expect(exchanged.bot_user_id).toBe("U000000777");

    const generatedClient = new WebClient(exchanged.access_token, {
      slackApiUrl: `${emulator!.url}/api/`,
    });
    const auth = await generatedClient.auth.test();
    expect(auth.ok).toBe(true);
    expect(auth.user_id).toBe("U000000777");
    expect(auth.bot_id).toBe("B000000777");

    const channel = ss.channels.findOneBy("name", "general")!.channel_id;
    const posted = await generatedClient.chat.postMessage({ channel, text: "from generated OAuth token" });
    expect(posted.ok).toBe(true);
    expect(posted.message?.user).toBe("U000000777");
  });

  it("round trips chat writes and conversation reads through the Slack SDK", async () => {
    const created = await client.conversations.create({ name: "sdk-baseline" });
    expect(created.ok).toBe(true);
    const channel = created.channel?.id;
    expect(channel).toBeDefined();

    const posted = await client.chat.postMessage({ channel: channel!, text: "hello from WebClient" });
    expect(posted.ok).toBe(true);
    expect(posted.ts).toBeDefined();

    const updated = await client.chat.update({ channel: channel!, ts: posted.ts!, text: "updated from WebClient" });
    expect(updated.ok).toBe(true);
    expect(updated.text).toBe("updated from WebClient");

    const history = await client.conversations.history({ channel: channel! });
    expect(history.ok).toBe(true);
    expect(history.messages?.[0]?.text).toBe("updated from WebClient");

    const reply = await client.chat.postMessage({
      channel: channel!,
      text: "reply from WebClient",
      thread_ts: posted.ts,
    });
    expect(reply.ok).toBe(true);

    const replies = await client.conversations.replies({ channel: channel!, ts: posted.ts! });
    expect(replies.ok).toBe(true);
    expect(replies.messages?.map((message) => message.text)).toEqual([
      "updated from WebClient",
      "reply from WebClient",
    ]);

    const permalink = await client.chat.getPermalink({ channel: channel!, message_ts: reply.ts! });
    expect(permalink.ok).toBe(true);
    expect(permalink.channel).toBe(channel);
    expect(permalink.permalink).toContain(`/archives/${channel}/p${reply.ts!.replace(".", "")}`);
    expect(permalink.permalink).toContain(`thread_ts=${posted.ts}`);

    const deleted = await client.chat.delete({ channel: channel!, ts: posted.ts! });
    expect(deleted.ok).toBe(true);
  });

  it("round trips rich chat messages through the Slack SDK", async () => {
    expect(emulator).toBeDefined();
    const channel = getSlackStore(emulator!.store).channels.findOneBy("name", "general")!.channel_id;
    const blocks = [{ type: "section", text: { type: "plain_text", text: "rich from WebClient" } }];
    const attachments = [{ color: "#ecb22e", text: "legacy attachment" }];
    const metadata = { event_type: "sdk_rich_message", event_payload: { id: "sdk_1" } };

    const posted = await client.chat.postMessage({
      channel,
      text: "rich from WebClient",
      blocks,
      attachments,
      metadata,
      unfurl_links: false,
      unfurl_media: false,
      client_msg_id: "sdk-client-message-1",
    } as any);
    expect(posted.ok).toBe(true);
    expect((posted.message as any).blocks).toEqual(blocks);
    expect((posted.message as any).attachments).toEqual(attachments);
    expect((posted.message as any).metadata).toEqual(metadata);
    expect((posted.message as any).unfurl_links).toBe(false);
    expect((posted.message as any).unfurl_media).toBe(false);
    expect((posted.message as any).client_msg_id).toBe("sdk-client-message-1");

    const history = await client.conversations.history({ channel });
    const message = history.messages?.find((item) => item.ts === posted.ts) as any;
    expect(message.blocks).toEqual(blocks);
    expect(message.attachments).toEqual(attachments);
    expect(message.metadata).toEqual(metadata);
  });

  it("exercises ephemeral and scheduled messages through the Slack SDK", async () => {
    expect(emulator).toBeDefined();
    const channel = getSlackStore(emulator!.store).channels.findOneBy("name", "general")!.channel_id;

    const ephemeral = await client.chat.postEphemeral({
      channel,
      user: "U000000001",
      text: "ephemeral from WebClient",
    });
    expect(ephemeral.ok).toBe(true);
    expect(ephemeral.message_ts).toBeDefined();

    const history = await client.conversations.history({ channel });
    expect(history.messages?.some((message) => message.ts === ephemeral.message_ts)).toBe(false);

    const postAt = Math.floor(Date.now() / 1000) + 3600;
    const scheduled = await client.chat.scheduleMessage({
      channel,
      text: "scheduled from WebClient",
      post_at: postAt,
    });
    expect(scheduled.ok).toBe(true);
    expect(scheduled.scheduled_message_id).toMatch(/^Q/);

    const scheduledList = await client.chat.scheduledMessages.list({ channel });
    expect(scheduledList.ok).toBe(true);
    expect(scheduledList.scheduled_messages?.[0]).toMatchObject({
      id: scheduled.scheduled_message_id,
      channel_id: channel,
      post_at: postAt,
      text: "scheduled from WebClient",
    });

    const deleted = await client.chat.deleteScheduledMessage({
      channel,
      scheduled_message_id: scheduled.scheduled_message_id!,
    });
    expect(deleted.ok).toBe(true);
  });

  it("exercises conversation membership through the Slack SDK", async () => {
    getSlackStore(emulator!.store).users.insert({
      user_id: "U000000010",
      team_id: "T000000001",
      name: "sdk-membership-peer",
      real_name: "sdk-membership-peer",
      email: "sdk-membership-peer@emulate.dev",
      is_admin: false,
      is_bot: false,
      deleted: false,
      profile: {
        display_name: "sdk-membership-peer",
        real_name: "sdk-membership-peer",
        email: "sdk-membership-peer@emulate.dev",
        image_48: "",
        image_192: "",
      },
    });

    const created = await client.conversations.create({ name: "sdk-membership" });
    const channel = created.channel!.id!;
    await client.conversations.invite({ channel, users: "U000000010" });

    const leave = await client.conversations.leave({ channel });
    expect(leave.ok).toBe(true);

    const join = await client.conversations.join({ channel });
    expect(join.ok).toBe(true);
    expect((join.channel as { num_members?: number } | undefined)?.num_members).toBe(2);

    const members = await client.conversations.members({ channel });
    expect(members.ok).toBe(true);
    expect(members.members).toContain("U000000001");

    const list = await client.conversations.list();
    expect(list.ok).toBe(true);
    expect(list.channels?.map((ch) => ch.name)).toContain("sdk-membership");
  });

  it("exercises conversation lifecycle writes through the Slack SDK", async () => {
    const created = await client.conversations.create({ name: "sdk-lifecycle" });
    const channel = created.channel!.id!;

    const topic = await client.conversations.setTopic({ channel, topic: "SDK lifecycle topic" });
    expect(topic.ok).toBe(true);
    expect((topic.channel as any).topic.value).toBe("SDK lifecycle topic");

    const purpose = await client.conversations.setPurpose({ channel, purpose: "SDK lifecycle purpose" });
    expect(purpose.ok).toBe(true);
    expect((purpose as any).purpose).toBe("SDK lifecycle purpose");

    const renamed = await client.conversations.rename({ channel, name: "sdk-lifecycle-renamed" });
    expect(renamed.ok).toBe(true);
    expect(renamed.channel?.name).toBe("sdk-lifecycle-renamed");

    const archived = await client.conversations.archive({ channel });
    expect(archived.ok).toBe(true);

    const archivedInfo = await client.conversations.info({ channel });
    expect((archivedInfo.channel as any).is_archived).toBe(true);

    const list = await client.conversations.list({ exclude_archived: true });
    expect(list.channels?.map((ch) => ch.id)).not.toContain(channel);

    const unarchived = await client.conversations.unarchive({ channel });
    expect(unarchived.ok).toBe(true);

    const unarchivedInfo = await client.conversations.info({ channel });
    expect((unarchivedInfo.channel as any).is_archived).toBe(false);
  });

  it("exercises membership and DM writes through the Slack SDK", async () => {
    expect(emulator).toBeDefined();
    const ss = getSlackStore(emulator!.store);
    ss.users.insert({
      user_id: "U000000002",
      team_id: "T000000001",
      name: "sdk-teammate",
      real_name: "sdk-teammate",
      email: "sdk-teammate@emulate.dev",
      is_admin: false,
      is_bot: false,
      deleted: false,
      profile: {
        display_name: "sdk-teammate",
        real_name: "sdk-teammate",
        email: "sdk-teammate@emulate.dev",
        image_48: "",
        image_192: "",
      },
    });

    const created = await client.conversations.create({ name: "sdk-membership-dms" });
    const channel = created.channel!.id!;

    const invited = await client.conversations.invite({ channel, users: "U000000002" });
    expect(invited.ok).toBe(true);

    const members = await client.conversations.members({ channel });
    expect(members.members).toContain("U000000002");

    const kicked = await client.conversations.kick({ channel, user: "U000000002" });
    expect(kicked.ok).toBe(true);

    const dm = await client.conversations.open({ users: "U000000002", return_im: true } as any);
    expect(dm.ok).toBe(true);
    const dmChannel = dm.channel!.id!;
    expect((dm.channel as any).is_im).toBe(true);

    const posted = await client.chat.postMessage({ channel: "U000000002", text: "DM from WebClient" });
    expect(posted.ok).toBe(true);
    expect(posted.channel).toBe(dmChannel);

    await expect(client.conversations.mark({ channel: dmChannel, ts: posted.ts! })).resolves.toMatchObject({
      ok: true,
    });

    const closed = await client.conversations.close({ channel: dmChannel });
    expect(closed.ok).toBe(true);
  });

  it("exercises users, reactions, and bots through the Slack SDK", async () => {
    expect(emulator).toBeDefined();
    const channel = getSlackStore(emulator!.store).channels.findOneBy("name", "general")!.channel_id;
    const posted = await client.chat.postMessage({ channel, text: "react via WebClient" });

    await expect(client.reactions.add({ channel, timestamp: posted.ts!, name: "thumbsup" })).resolves.toMatchObject({
      ok: true,
    });

    const reactions = await client.reactions.get({ channel, timestamp: posted.ts! });
    expect(reactions.ok).toBe(true);
    expect(reactions.message?.reactions?.[0]?.name).toBe("thumbsup");

    await expect(client.reactions.remove({ channel, timestamp: posted.ts!, name: "thumbsup" })).resolves.toMatchObject({
      ok: true,
    });

    const users = await client.users.list({});
    expect(users.ok).toBe(true);
    expect(users.members?.map((user) => user.id)).toContain("U000000001");

    const user = await client.users.info({ user: "U000000001" });
    expect(user.ok).toBe(true);
    expect(user.user?.name).toBe("admin");

    const byEmail = await client.users.lookupByEmail({ email: "admin@emulate.dev" });
    expect(byEmail.ok).toBe(true);
    expect(byEmail.user?.id).toBe("U000000001");

    const profile = await client.users.profile.get({ user: "U000000001" });
    expect(profile.ok).toBe(true);
    expect(profile.profile?.display_name).toBe("admin");

    const setProfile = await client.users.profile.set({
      user: "U000000001",
      profile: {
        display_name: "SDK Admin",
        status_text: "Testing profile writes",
        status_emoji: ":test_tube:",
      },
    });
    expect(setProfile.ok).toBe(true);
    expect(setProfile.profile?.display_name).toBe("SDK Admin");
    expect(setProfile.profile?.status_text).toBe("Testing profile writes");

    const away = await client.users.setPresence({ presence: "away" });
    expect(away.ok).toBe(true);

    const presence = await client.users.getPresence({ user: "U000000001" });
    expect(presence.ok).toBe(true);
    expect(presence.presence).toBe("away");

    const bot = await client.bots.info({ bot: "B000000001" });
    expect(bot.ok).toBe(true);
    expect(bot.bot?.name).toBe("test-bot");
  });

  it("uploads files through the Slack SDK uploadV2 helper", async () => {
    expect(emulator).toBeDefined();
    const channel = getSlackStore(emulator!.store).channels.findOneBy("name", "general")!.channel_id;

    const uploaded = (await client.files.uploadV2({
      channel_id: channel,
      content: "SDK upload body",
      filename: "sdk-upload.txt",
      title: "SDK Upload",
      initial_comment: "SDK file upload",
    })) as any;
    expect(uploaded.ok).toBe(true);
    const completed = (uploaded.files as any[])[0];
    const file = completed.files[0];
    expect(file.title).toBe("SDK Upload");
    expect(file.channels).toContain(channel);

    const download = await fetch(file.url_private, { headers: { Authorization: `Bearer ${slackTestToken}` } });
    expect(download.status).toBe(200);
    expect(await download.text()).toBe("SDK upload body");

    const info = await client.files.info({ file: file.id });
    expect(info.ok).toBe(true);
    expect(info.file?.title).toBe("SDK Upload");

    const list = await client.files.list({ channel });
    expect(list.ok).toBe(true);
    expect(list.files?.map((item) => item.id)).toContain(file.id);

    const deleted = await client.files.delete({ file: file.id! });
    expect(deleted.ok).toBe(true);
  });
});
