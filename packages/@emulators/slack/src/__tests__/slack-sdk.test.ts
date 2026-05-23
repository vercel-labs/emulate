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
    const created = await client.conversations.create({ name: "sdk-membership" });
    const channel = created.channel!.id!;

    const leave = await client.conversations.leave({ channel });
    expect(leave.ok).toBe(true);

    const join = await client.conversations.join({ channel });
    expect(join.ok).toBe(true);
    expect((join.channel as { num_members?: number } | undefined)?.num_members).toBe(1);

    const members = await client.conversations.members({ channel });
    expect(members.ok).toBe(true);
    expect(members.members).toContain("U000000001");

    const list = await client.conversations.list();
    expect(list.ok).toBe(true);
    expect(list.channels?.map((ch) => ch.name)).toContain("sdk-membership");
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

    const bot = await client.bots.info({ bot: "B000000001" });
    expect(bot.ok).toBe(true);
    expect(bot.bot?.name).toBe("test-bot");
  });
});
