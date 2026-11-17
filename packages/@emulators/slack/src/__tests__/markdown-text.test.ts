import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { WebClient } from "@slack/web-api";
import { getSlackStore } from "../index.js";
import {
  authHeaders,
  createSlackTestApp,
  slackTestBaseUrl as base,
  slackTestToken,
  startSlackTestEmulator,
  type SlackTestApp,
  type SlackTestEmulator,
} from "./helpers.js";

const markdown = "**Deploy finished**\n\n- api: ok\n- web: ok";
const blocks = [{ type: "section", text: { type: "mrkdwn", text: "*Deploy finished*" } }];

describe("Slack plugin - markdown_text", () => {
  let app: SlackTestApp["app"];
  let store: SlackTestApp["store"];

  beforeEach(() => {
    ({ app, store } = createSlackTestApp());
  });

  async function call(method: string, payload: Record<string, unknown>, form = false) {
    const res = await app.request(`${base}/api/${method}`, {
      method: "POST",
      headers: authHeaders(form ? "application/x-www-form-urlencoded" : "application/json"),
      body: form
        ? new URLSearchParams(
            Object.entries(payload).map(([key, value]): [string, string] => [
              key,
              typeof value === "string" ? value : JSON.stringify(value),
            ]),
          ).toString()
        : JSON.stringify(payload),
    });
    return (await res.json()) as Record<string, any>;
  }

  it("posts a message from markdown_text alone, in JSON and form bodies", async () => {
    for (const form of [false, true]) {
      const posted = await call("chat.postMessage", { channel: "C000000001", markdown_text: markdown }, form);
      expect(posted.ok).toBe(true);
      expect(posted.message.text).toBe(markdown);
      expect(posted.message.blocks).toBeUndefined();

      const history = await call("conversations.history", { channel: "C000000001", limit: 1 });
      expect(history.messages[0].text).toBe(markdown);
    }
  });

  it("returns markdown_text_conflict alongside text or blocks", async () => {
    for (const form of [false, true]) {
      const withText = await call(
        "chat.postMessage",
        { channel: "C000000001", markdown_text: markdown, text: "Deploy finished" },
        form,
      );
      expect(withText).toEqual({ ok: false, error: "markdown_text_conflict" });

      const withBlocks = await call(
        "chat.postMessage",
        { channel: "C000000001", markdown_text: markdown, blocks },
        form,
      );
      expect(withBlocks).toEqual({ ok: false, error: "markdown_text_conflict" });
    }
    expect(getSlackStore(store).messages.findBy("channel_id", "C000000001")).toHaveLength(0);
  });

  it("allows attachments, an empty text, and empty blocks next to markdown_text", async () => {
    const attachments = [{ fallback: "Logs", text: "Logs attached" }];
    const posted = await call("chat.postMessage", {
      channel: "C000000001",
      markdown_text: markdown,
      text: "",
      blocks: [],
      attachments,
    });
    expect(posted.ok).toBe(true);
    expect(posted.message.text).toBe(markdown);
    expect(posted.message.attachments).toEqual(attachments);
  });

  it("treats an empty markdown_text as no text", async () => {
    expect(await call("chat.postMessage", { channel: "C000000001", markdown_text: "" })).toEqual({
      ok: false,
      error: "no_text",
    });
    const withText = await call("chat.postMessage", { channel: "C000000001", markdown_text: "", text: "plain" });
    expect(withText.ok).toBe(true);
    expect(withText.message.text).toBe("plain");
  });

  it("updates a message with markdown_text and clears its blocks", async () => {
    const posted = await call("chat.postMessage", { channel: "C000000001", text: "Deploying", blocks });
    const updated = await call("chat.update", { channel: "C000000001", ts: posted.ts, markdown_text: markdown });
    expect(updated.ok).toBe(true);
    expect(updated.text).toBe(markdown);
    expect(updated.message.text).toBe(markdown);
    expect(updated.message.blocks).toBeUndefined();

    const conflict = await call("chat.update", {
      channel: "C000000001",
      ts: posted.ts,
      markdown_text: markdown,
      blocks,
    });
    expect(conflict).toEqual({ ok: false, error: "markdown_text_conflict" });
  });

  it("accepts markdown_text in ephemeral and scheduled messages", async () => {
    const ephemeral = await call("chat.postEphemeral", {
      channel: "C000000001",
      user: "U000000001",
      markdown_text: markdown,
    });
    expect(ephemeral.ok).toBe(true);
    expect(getSlackStore(store).ephemeralMessages.findOneBy("ts", ephemeral.message_ts)?.text).toBe(markdown);
    expect(
      await call("chat.postEphemeral", {
        channel: "C000000001",
        user: "U000000001",
        markdown_text: markdown,
        text: "x",
      }),
    ).toEqual({ ok: false, error: "markdown_text_conflict" });

    const postAt = Math.floor(Date.now() / 1000) + 3600;
    const scheduled = await call("chat.scheduleMessage", {
      channel: "C000000001",
      post_at: postAt,
      markdown_text: markdown,
    });
    expect(scheduled.ok).toBe(true);
    expect(scheduled.message.text).toBe(markdown);
    expect(
      await call("chat.scheduleMessage", { channel: "C000000001", post_at: postAt, markdown_text: markdown, blocks }),
    ).toEqual({ ok: false, error: "markdown_text_conflict" });
  });
});

describe("Slack plugin - markdown_text through @slack/web-api", () => {
  let emulator: SlackTestEmulator | undefined;
  let client: WebClient;

  beforeAll(async () => {
    emulator = await startSlackTestEmulator();
    client = new WebClient(slackTestToken, { slackApiUrl: `${emulator.url}/api/`, retryConfig: { retries: 0 } });
  });

  afterAll(async () => {
    await emulator?.close();
  });

  it("posts and updates with markdown_text and surfaces the conflict error", async () => {
    const posted = await client.chat.postMessage({ channel: "C000000001", markdown_text: markdown });
    expect(posted.message?.text).toBe(markdown);

    const updated = await client.chat.update({ channel: "C000000001", ts: posted.ts!, markdown_text: "**Done**" });
    expect(updated.text).toBe("**Done**");

    await expect(
      client.chat.postMessage({ channel: "C000000001", markdown_text: markdown, text: "Deploy finished" } as never),
    ).rejects.toMatchObject({ data: { ok: false, error: "markdown_text_conflict" } });
  });
});
