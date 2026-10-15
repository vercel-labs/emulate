import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getSlackStore, seedFromConfig } from "../index.js";
import {
  authHeaders,
  captureFetchRequests,
  registerSlackEventSubscription,
  createSlackTestApp,
  slackTestBaseUrl as base,
  startSlackTestEmulator,
  type SlackTestApp,
} from "./helpers.js";

const appId = "A_INTERACTIVE";
const botId = "B_INTERACTIVE";
const botUserId = "U_INTERACTIVE";
const botToken = "xoxb-interactive";
const secret = "interaction-signing-secret";
const actionBlocks = [
  {
    type: "actions",
    block_id: "buttons",
    elements: [
      { type: "button", action_id: "open", text: { type: "plain_text", text: "Open form" }, value: "item-42" },
    ],
  },
];
const option = (value: string) => ({ text: { type: "plain_text", text: value }, value });
const inputBlocks = [
  {
    type: "input",
    block_id: "name",
    label: { type: "plain_text", text: "Name" },
    element: { type: "plain_text_input", action_id: "name_input" },
  },
  {
    type: "input",
    block_id: "choice",
    label: { type: "plain_text", text: "Choice" },
    element: { type: "static_select", action_id: "choice_input", options: [option("one"), option("two")] },
  },
  {
    type: "input",
    block_id: "many",
    optional: true,
    label: { type: "plain_text", text: "Many" },
    element: { type: "multi_static_select", action_id: "many_input", options: [option("one"), option("two")] },
  },
];
const modal = (blocks: unknown[] = inputBlocks) => ({
  type: "modal",
  title: { type: "plain_text", text: "Example form" },
  submit: { type: "plain_text", text: "Submit" },
  callback_id: "form",
  private_metadata: "item-42",
  blocks,
});

function configure(setup: SlackTestApp, interactivityUrl = "https://app.example/interactions") {
  seedFromConfig(setup.store, base, {
    signing_secret: secret,
    oauth_apps: [
      {
        app_id: appId,
        bot_id: botId,
        bot_user_id: botUserId,
        name: "Interactive",
        client_id: "interactive",
        client_secret: "secret",
        redirect_uris: [],
        interactivity_url: interactivityUrl,
      },
    ],
    tokens: [{ token: botToken, type: "bot", user_id: botUserId, app_id: appId, bot_id: botId }],
  });
  return setup;
}

async function post(setup: SlackTestApp, path: string, body: unknown, token = botToken) {
  const response = await setup.app.request(`${base}${path}`, {
    method: "POST",
    headers: { ...authHeaders(), Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return (await response.json()) as Record<string, any>;
}

function receiver(response = "", status = 200) {
  const payloads: Array<Record<string, any>> = [];
  const fetch = vi.fn(async (_url: unknown, init: RequestInit) => {
    const raw = String(init.body);
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(headers["X-Slack-Signature"]).toBe(
      `v0=${createHmac("sha256", secret).update(`v0:${headers["X-Slack-Request-Timestamp"]}:${raw}`).digest("hex")}`,
    );
    payloads.push(JSON.parse(new URLSearchParams(raw).get("payload")!));
    return new Response(response, { status });
  });
  vi.stubGlobal("fetch", fetch);
  return { fetch, payloads };
}

async function click(
  setup: SlackTestApp,
  blocks: Array<Record<string, unknown>> = actionBlocks,
  extra: Record<string, unknown> = {},
) {
  const posted = await post(setup, "/api/chat.postMessage", { channel: "general", text: "Choose an action", blocks });
  expect(posted.ok).toBe(true);
  return post(setup, "/_slack/simulate/block-actions", {
    channel: posted.channel,
    message_ts: posted.ts,
    action_id: "open",
    user: "admin",
    ...extra,
  });
}

async function openModal(setup: SlackTestApp, blocks: unknown[] = inputBlocks, viewId?: string) {
  const trigger = await post(setup, "/api/views.generateTriggerId", {
    user_id: "U000000001",
    ...(viewId ? { view_id: viewId } : {}),
  });
  const opened = await post(setup, viewId ? "/api/views.push" : "/api/views.open", {
    trigger_id: trigger.trigger_id,
    view: modal(blocks),
  });
  expect(opened.ok).toBe(true);
  return opened.view as Record<string, any>;
}

describe("Slack interactions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("delivers signed button actions and an app-bound, single-use modal trigger", async () => {
    const setup = configure(createSlackTestApp());
    const received = receiver();
    const result = await click(setup);
    expect(result.ok).toBe(true);
    expect(received.payloads).toHaveLength(1);
    const payload = received.payloads[0]!;
    expect(payload).toMatchObject({
      type: "block_actions",
      api_app_id: appId,
      user: { id: "U000000001" },
      team: { id: "T000000001" },
      container: { type: "message", is_ephemeral: false },
      actions: [
        { type: "button", block_id: "buttons", action_id: "open", value: "item-42", action_ts: expect.any(String) },
      ],
    });
    expect(getSlackStore(setup.store).interactionDeliveries.all()[0]).toMatchObject({
      success: true,
      status_code: 200,
      payload,
    });
    const opened = await post(setup, "/api/views.open", { trigger_id: payload.trigger_id, view: modal() });
    expect(opened.view).toMatchObject({ app_id: appId });
    expect(getSlackStore(setup.store).views.all()[0]!.user_id).toBe("U000000001");
    expect(await post(setup, "/api/views.open", { trigger_id: payload.trigger_id, view: modal() })).toMatchObject({
      error: "exchanged_trigger_id",
    });
  });

  it("routes user-token messages to their owning app when several apps are installed", async () => {
    const setup = configure(createSlackTestApp());
    seedFromConfig(setup.store, base, {
      oauth_apps: [
        {
          app_id: "A_OTHER",
          name: "Other",
          client_id: "other",
          client_secret: "other",
          redirect_uris: [],
          interactivity_url: "https://other.example/interactions",
        },
      ],
      tokens: [{ token: "xoxp-owner", type: "user", user_id: "U000000001", app_id: appId }],
    });
    const received = receiver();
    const posted = await post(
      setup,
      "/api/chat.postMessage",
      { channel: "general", blocks: actionBlocks },
      "xoxp-owner",
    );
    const clicked = await post(setup, "/_slack/simulate/block-actions", {
      channel: "general",
      message_ts: posted.ts,
      action_id: "open",
      user: "admin",
    });
    expect(clicked.ok).toBe(true);
    expect(received.fetch.mock.calls[0]![0]).toBe("https://app.example/interactions");
    expect(received.payloads[0]!.api_app_id).toBe(appId);
    const userView = await post(
      setup,
      "/api/views.open",
      { trigger_id: clicked.payload.trigger_id, view: modal() },
      "xoxp-owner",
    );
    expect(userView.view).toMatchObject({ app_id: appId, bot_id: botId });
    const secondClick = await post(setup, "/_slack/simulate/block-actions", {
      channel: "general",
      message_ts: posted.ts,
      action_id: "open",
      user: "admin",
    });
    const trigger = secondClick.payload.trigger_id;
    seedFromConfig(setup.store, base, {
      tokens: [{ token: "other-token", type: "bot", user_id: "U000000001", app_id: "A_OTHER" }],
    });
    expect(await post(setup, "/api/views.open", { trigger_id: trigger, view: modal() }, "other-token")).toMatchObject({
      error: "invalid_trigger_id",
    });
  });

  it("finds section buttons by text or URL and rejects ambiguous or unsupported actions", async () => {
    const setup = configure(createSlackTestApp());
    receiver();
    const section = [
      {
        type: "section",
        block_id: "section",
        text: { type: "plain_text", text: "Details" },
        accessory: { ...actionBlocks[0]!.elements[0], url: "https://example.com/item" },
      },
    ];
    expect((await click(setup, section, { action_id: undefined, text: "Open form" })).ok).toBe(true);
    expect((await click(setup, section, { action_id: undefined, url: "https://example.com/item" })).ok).toBe(true);
    const duplicate = [{ ...actionBlocks[0], elements: [...actionBlocks[0]!.elements, ...actionBlocks[0]!.elements] }];
    expect(await click(setup, duplicate)).toMatchObject({ error: "ambiguous_action" });
    expect(
      await click(setup, [
        { ...actionBlocks[0], elements: [{ ...actionBlocks[0]!.elements[0]!, type: "static_select" }] },
      ]),
    ).toMatchObject({ error: "unsupported_element" });
    expect(await click(setup, actionBlocks, { action_id: "missing" })).toMatchObject({ error: "action_not_found" });
  });

  it("rejects unauthenticated and inaccessible simulations before sending callbacks", async () => {
    const setup = configure(createSlackTestApp());
    const received = receiver();
    const posted = await post(setup, "/api/chat.postMessage", { channel: "general", blocks: actionBlocks });
    const body = { channel: "general", message_ts: posted.ts, action_id: "open", user: "admin" };
    expect(await post(setup, "/_slack/simulate/block-actions", body, "unknown")).toMatchObject({ error: "not_authed" });
    expect(await post(setup, "/_slack/simulate/block-actions", { ...body, user: "missing" })).toMatchObject({
      error: "user_not_found",
    });
    expect(await post(setup, "/_slack/simulate/block-actions", { ...body, message_ts: "missing" })).toMatchObject({
      error: "message_not_found",
    });
    const ss = getSlackStore(setup.store);
    const channel = ss.channels.all()[0]!;
    ss.channels.update(channel.id, { members: [] });
    expect(await post(setup, "/_slack/simulate/block-actions", body)).toMatchObject({ error: "not_in_channel" });
    expect(received.fetch).not.toHaveBeenCalled();
  });

  it("requires an installed app and configured interactivity URL", async () => {
    const setup = configure(createSlackTestApp());
    const received = receiver();
    const ss = getSlackStore(setup.store);
    const target = ss.oauthApps.all()[0]!;
    ss.oauthApps.update(target.id, { interactivity_url: undefined });
    expect(await click(setup)).toMatchObject({ error: "interactivity_not_configured" });
    ss.oauthApps.update(target.id, { interactivity_url: "https://app.example/interactions" });
    ss.installations.delete(ss.installations.all()[0]!.id);
    expect(await click(setup)).toMatchObject({ error: "app_not_installed" });
    expect(received.fetch).not.toHaveBeenCalled();
    expect(ss.viewTriggers.all()).toHaveLength(0);
  });

  it("supports private response messages, public replies, replacement, and deletion", async () => {
    const setup = configure(createSlackTestApp());
    receiver();
    const clicked = await click(setup);
    const path = new URL(clicked.payload.response_url).pathname;
    const capture = captureFetchRequests();
    registerSlackEventSubscription(setup.webhooks, ["message"]);
    const ss = getSlackStore(setup.store);
    const messages = ss.messages.all().length;
    expect(await post(setup, path, { text: "Only you" }, "")).toEqual({ ok: true });
    expect(ss.messages.all()).toHaveLength(messages);
    expect(ss.ephemeralMessages.all()[0]).toMatchObject({ target_user: "U000000001", text: "Only you" });
    expect(
      await post(
        setup,
        path,
        { text: "Public", response_type: "in_channel", thread_ts: clicked.payload.message.ts },
        "",
      ),
    ).toEqual({ ok: true });
    expect(ss.messages.findOneBy("ts", clicked.payload.message.ts)!.reply_count).toBe(1);
    const replies = await post(setup, "/api/conversations.replies", {
      channel: ss.channels.findOneBy("name", "general")!.channel_id,
      ts: clicked.payload.message.ts,
    });
    expect(replies.messages.find((message: any) => message.text === "Public")).toMatchObject({
      bot_id: botId,
      app_id: appId,
      bot_profile: { id: botId, app_id: appId },
    });
    expect(
      await post(setup, path, { text: "Changed", replace_original: true, bot_id: "B_SPOOF", app_id: "A_SPOOF" }, ""),
    ).toEqual({ ok: true });
    expect(ss.messages.findOneBy("ts", clicked.payload.message.ts)).toMatchObject({
      text: "Changed",
      blocks: undefined,
      bot_id: botId,
      app_id: appId,
      bot_profile: { id: botId, app_id: appId },
    });
    expect(await post(setup, path, { delete_original: true }, "")).toEqual({ ok: true });
    expect(ss.messages.findOneBy("ts", clicked.payload.message.ts)).toBeUndefined();
    const envelopes = capture.jsonBodies() as Array<Record<string, any>>;
    expect(envelopes).toHaveLength(3);
    for (const envelope of envelopes) {
      expect(envelope).toMatchObject({
        api_app_id: appId,
        authorizations: [expect.objectContaining({ user_id: botUserId, is_bot: true })],
        event: { type: "message", channel_type: "channel", event_ts: expect.any(String) },
      });
      const message = envelope.event.message ?? envelope.event.previous_message ?? envelope.event;
      expect(message).toMatchObject({ bot_id: botId, app_id: appId, bot_profile: { id: botId, app_id: appId } });
    }
  });

  it("keeps ephemeral interactions and replacements private to the acting user", async () => {
    const setup = configure(createSlackTestApp());
    receiver();
    seedFromConfig(setup.store, base, { users: [{ name: "alice" }] });
    const ss = getSlackStore(setup.store);
    const channel = ss.channels.all()[0]!;
    ss.channels.update(channel.id, { members: [...channel.members, ss.users.findOneBy("name", "alice")!.user_id] });
    const ephemeral = await post(setup, "/api/chat.postEphemeral", {
      channel: "general",
      user: "U000000001",
      blocks: actionBlocks,
    });
    const body = { channel: "general", message_ts: ephemeral.message_ts, action_id: "open" };
    expect(await post(setup, "/_slack/simulate/block-actions", { ...body, user: "alice" })).toMatchObject({
      error: "message_not_found",
    });
    const clicked = await post(setup, "/_slack/simulate/block-actions", { ...body, user: "admin" });
    expect(clicked.payload.container.is_ephemeral).toBe(true);
    const before = getSlackStore(setup.store).messages.all().length;
    expect(
      await post(
        setup,
        new URL(clicked.payload.response_url).pathname,
        { replace_original: true, response_type: "in_channel", text: "Still private" },
        "",
      ),
    ).toEqual({ ok: true });
    expect(getSlackStore(setup.store).messages.all()).toHaveLength(before);
    expect(getSlackStore(setup.store).ephemeralMessages.all()[0]!.text).toBe("Still private");
  });

  it("expires response URLs after five uses or thirty minutes, including after restore", async () => {
    const setup = configure(createSlackTestApp());
    receiver();
    const clicked = await click(setup);
    const path = new URL(clicked.payload.response_url).pathname;
    expect(await post(setup, path, { replace_original: true })).toMatchObject({ error: "no_text" });
    for (let i = 0; i < 5; i++) expect(await post(setup, path, { text: `Reply ${i}` }, "")).toEqual({ ok: true });
    expect(await post(setup, path, { text: "Too many" }, "")).toMatchObject({ error: "expired_response_url" });
    const fresh = await click(setup);
    const freshPath = new URL(fresh.payload.response_url).pathname;
    const restored = configure(createSlackTestApp());
    restored.store.restore(JSON.parse(JSON.stringify(setup.store.snapshot())));
    vi.useFakeTimers();
    vi.advanceTimersByTime(30 * 60 * 1000);
    expect(await post(restored, freshPath, { text: "Too late" }, "")).toMatchObject({ error: "expired_response_url" });
    expect(await post(restored, "/_slack/response/missing", { text: "Unknown" }, "")).toMatchObject({
      error: "invalid_response_url",
    });
  });

  it("enforces the response URL limit across concurrent replies", async () => {
    const setup = configure(createSlackTestApp());
    receiver();
    const clicked = await click(setup);
    const path = new URL(clicked.payload.response_url).pathname;
    const replies = await Promise.all(
      Array.from({ length: 8 }, (_, index) => post(setup, path, { text: `Reply ${index}` }, "")),
    );
    expect(replies.filter((reply) => reply.ok)).toHaveLength(5);
    expect(replies.filter((reply) => reply.error === "expired_response_url")).toHaveLength(3);
    expect(getSlackStore(setup.store).responseUrls.all()[0]!.uses).toBe(5);
  });

  it("persists new interaction records after restoring an older snapshot", async () => {
    const setup = configure(createSlackTestApp());
    const snapshot = setup.store.snapshot();
    delete snapshot.collections["slack.response_urls"];
    delete snapshot.collections["slack.interaction_deliveries"];
    setup.store.restore(JSON.parse(JSON.stringify(snapshot)));
    seedFromConfig(setup.store, base, {
      oauth_apps: [
        {
          app_id: appId,
          client_id: "interactive",
          client_secret: "secret",
          name: "Interactive",
          redirect_uris: [],
          interactivity_url: "https://updated.example/interactions",
        },
      ],
    });
    const received = receiver();
    const clicked = await click(setup);
    expect(clicked.ok).toBe(true);
    expect(received.fetch.mock.calls[0]![0]).toBe("https://updated.example/interactions");
    const saved = setup.store.snapshot();
    expect(saved.collections["slack.response_urls"]!.items).toHaveLength(1);
    expect(saved.collections["slack.interaction_deliveries"]!.items).toHaveLength(1);
  });

  it("submits typed input state and closes an acknowledged view", async () => {
    const setup = configure(createSlackTestApp());
    const received = receiver();
    const view = await openModal(setup);
    const result = await post(setup, "/_slack/simulate/view-submission", {
      view_id: view.id,
      values: { name: "Alex & Casey", choice: "two", many: ["one", "two"] },
    });
    expect(result).toMatchObject({ ok: true, response_action: "close" });
    expect(received.payloads[0]).toMatchObject({
      type: "view_submission",
      api_app_id: appId,
      view: {
        callback_id: "form",
        private_metadata: "item-42",
        state: {
          values: {
            name: { name_input: { type: "plain_text_input", value: "Alex & Casey" } },
            choice: { choice_input: { type: "static_select", selected_option: option("two") } },
            many: { many_input: { type: "multi_static_select", selected_options: [option("one"), option("two")] } },
          },
        },
      },
    });
    expect(getSlackStore(setup.store).views.findOneBy("view_id", view.id)).toBeUndefined();
  });

  it.each(["errors", "update", "push", "clear"])(
    "applies the %s acknowledgement to the modal stack",
    async (action) => {
      const setup = configure(createSlackTestApp());
      const root = await openModal(setup, []);
      const view = await openModal(setup, inputBlocks, root.id);
      const response =
        action === "errors"
          ? { response_action: action, errors: { name: "Try a different name" } }
          : action === "update" || action === "push"
            ? { response_action: action, view: modal() }
            : { response_action: action };
      receiver(JSON.stringify(response));
      const result = await post(setup, "/_slack/simulate/view-submission", {
        view_id: view.id,
        values: { name: "Alex", choice: "one" },
      });
      expect(result).toMatchObject({ ok: true, response_action: action });
      const ss = getSlackStore(setup.store);
      if (action === "clear") expect(ss.views.all()).toHaveLength(0);
      if (action === "errors") {
        expect(ss.views.all()).toHaveLength(2);
        expect(result.errors.name).toBe("Try a different name");
      }
      if (action === "update") {
        expect(result.view.id).toBe(view.id);
        expect(result.view.state.values.name.name_input.value).toBe("Alex");
        expect(result.view.hash).not.toBe(view.hash);
      }
      if (action === "push") {
        expect(result.view.previous_view_id).toBe(view.id);
        expect(result.view.root_view_id).toBe(root.id);
        expect(ss.views.all()).toHaveLength(3);
      }
    },
  );

  it("retains entered values when a validation error is resubmitted", async () => {
    const setup = configure(createSlackTestApp());
    const view = await openModal(setup);
    receiver(JSON.stringify({ response_action: "errors", errors: { name: "Choose another name" } }));
    expect(
      await post(setup, "/_slack/simulate/view-submission", {
        view_id: view.id,
        values: { name: "Alex", choice: "two", many: ["one"] },
      }),
    ).toMatchObject({ ok: true, response_action: "errors" });
    const received = receiver();
    expect(
      await post(setup, "/_slack/simulate/view-submission", { view_id: view.id, values: { name: "Casey" } }),
    ).toMatchObject({ ok: true });
    expect(received.payloads[0]!.view.state.values).toMatchObject({
      name: { name_input: { value: "Casey" } },
      choice: { choice_input: { selected_option: option("two") } },
      many: { many_input: { selected_options: [option("one")] } },
    });
  });

  it("sends initial input values and supports checkboxes and radio buttons", async () => {
    const setup = configure(createSlackTestApp());
    const received = receiver();
    const blocks = [
      { ...inputBlocks[0], element: { type: "plain_text_input", action_id: "name_input", initial_value: "Alex" } },
      {
        ...inputBlocks[1],
        element: {
          type: "radio_buttons",
          action_id: "choice_input",
          options: [option("one")],
          initial_option: option("one"),
        },
      },
      {
        ...inputBlocks[2],
        element: {
          type: "checkboxes",
          action_id: "many_input",
          options: [option("one")],
          initial_options: [option("one")],
        },
      },
    ];
    const view = await openModal(setup, blocks);
    expect(await post(setup, "/_slack/simulate/view-submission", { view_id: view.id })).toMatchObject({ ok: true });
    expect(received.payloads[0]!.view.state.values).toMatchObject({
      name: { name_input: { type: "plain_text_input", value: "Alex" } },
      choice: { choice_input: { type: "radio_buttons", selected_option: option("one") } },
      many: { many_input: { type: "checkboxes", selected_options: [option("one")] } },
    });
  });

  it("only closes the submitted top view and enforces stack visibility and depth", async () => {
    const setup = configure(createSlackTestApp());
    receiver();
    const root = await openModal(setup, []);
    const middle = await openModal(setup, [], root.id);
    const top = await openModal(setup, [], middle.id);
    expect(await post(setup, "/_slack/simulate/view-submission", { view_id: root.id })).toMatchObject({
      error: "view_not_visible",
    });
    receiver(JSON.stringify({ response_action: "push", view: modal([]) }));
    expect(await post(setup, "/_slack/simulate/view-submission", { view_id: top.id })).toMatchObject({
      error: "push_limit_reached",
    });
    receiver();
    expect(await post(setup, "/_slack/simulate/view-submission", { view_id: top.id })).toMatchObject({
      ok: true,
      response_action: "close",
    });
    expect(
      getSlackStore(setup.store)
        .views.all()
        .map((view) => view.view_id),
    ).toEqual([root.id, middle.id]);
  });

  it.each([
    [{ name: "Alex", choice: "bad" }, "invalid_values"],
    [{ name: "Alex" }, "missing_required_value"],
    [{ name: ["Alex"], choice: "one" }, "invalid_values"],
    [{ name: "Alex", choice: "one", many: ["one", "one"] }, "invalid_values"],
    [{ name: "Alex", choice: "one", unknown: "value" }, "invalid_values"],
  ])("rejects invalid submission values before delivering a callback", async (values, error) => {
    const setup = configure(createSlackTestApp());
    const received = receiver();
    const view = await openModal(setup);
    expect(await post(setup, "/_slack/simulate/view-submission", { view_id: view.id, values })).toMatchObject({
      error,
    });
    expect(received.fetch).not.toHaveBeenCalled();
    expect(getSlackStore(setup.store).views.all()).toHaveLength(1);
  });

  it("reports callback failures and malformed acknowledgements without closing views", async () => {
    const setup = configure(createSlackTestApp());
    const view = await openModal(setup, []);
    for (const [body, status, error] of [
      ["failure", 500, "interactivity_delivery_failed"],
      ["bad json", 200, "invalid_interaction_response"],
      ['{"response_action":"unknown"}', 200, "invalid_interaction_response"],
    ] as const) {
      receiver(body, status);
      expect(await post(setup, "/_slack/simulate/view-submission", { view_id: view.id })).toMatchObject({ error });
      expect(getSlackStore(setup.store).views.findOneBy("view_id", view.id)).toBeDefined();
    }
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Receiver offline")));
    expect(await click(setup)).toMatchObject({ error: "interactivity_delivery_failed" });
    expect(getSlackStore(setup.store).interactionDeliveries.all().at(-1)).toMatchObject({
      success: false,
      status_code: null,
    });
  });

  it("prevents concurrent submissions of the same modal", async () => {
    const setup = configure(createSlackTestApp());
    const view = await openModal(setup, []);
    let acknowledge!: (response: Response) => void;
    const callback = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          acknowledge = resolve;
        }),
    );
    vi.stubGlobal("fetch", callback);
    const first = post(setup, "/_slack/simulate/view-submission", { view_id: view.id });
    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1));
    expect(await post(setup, "/_slack/simulate/view-submission", { view_id: view.id })).toMatchObject({
      error: "view_submission_in_progress",
    });
    acknowledge(new Response("", { status: 200 }));
    expect(await first).toMatchObject({ ok: true, response_action: "close" });
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("keeps three-second trigger expiry by default and supports a local override", async () => {
    const setup = configure(createSlackTestApp());
    receiver();
    vi.useFakeTimers();
    const clicked = await click(setup);
    vi.advanceTimersByTime(3000);
    expect(
      await post(setup, "/api/views.open", { trigger_id: clicked.payload.trigger_id, view: modal() }),
    ).toMatchObject({ error: "expired_trigger_id" });
    seedFromConfig(setup.store, base, { view_trigger_ttl_seconds: 30 });
    const later = await click(setup);
    vi.advanceTimersByTime(4000);
    expect(await post(setup, "/api/views.open", { trigger_id: later.payload.trigger_id, view: modal() })).toMatchObject(
      { ok: true },
    );
  });

  it("runs a signed click, response URL, modal open, and submission over HTTP", async () => {
    let emulator: Awaited<ReturnType<typeof startSlackTestEmulator>> | undefined;
    let receiverServer: Server | undefined;
    const received: Array<Record<string, any>> = [];
    let openedView: Record<string, any> | undefined;
    const errors: unknown[] = [];
    try {
      receiverServer = createServer(async (req, res) => {
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(Buffer.from(chunk));
          const raw = Buffer.concat(chunks).toString();
          expect(req.headers["x-slack-signature"]).toBe(
            `v0=${createHmac("sha256", secret).update(`v0:${req.headers["x-slack-request-timestamp"]}:${raw}`).digest("hex")}`,
          );
          const payload = JSON.parse(new URLSearchParams(raw).get("payload")!);
          received.push(payload);
          if (payload.type === "block_actions") {
            const opened = await fetch(`${emulator!.url}/api/views.open`, {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${botToken}` },
              body: JSON.stringify({ trigger_id: payload.trigger_id, view: modal() }),
            });
            openedView = (await opened.json()) as Record<string, any>;
            const reply = await fetch(payload.response_url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ text: "Thanks for clicking" }),
            });
            expect(await reply.json()).toEqual({ ok: true });
          }
          res.writeHead(200).end();
        } catch (error) {
          errors.push(error);
          res.writeHead(500).end();
        }
      });
      await new Promise<void>((resolve) => receiverServer!.listen(0, "127.0.0.1", resolve));
      const receiverUrl = `http://127.0.0.1:${(receiverServer.address() as AddressInfo).port}/interactions`;
      emulator = await startSlackTestEmulator((setup) => {
        configure(setup, receiverUrl);
      });
      const clicked = await click(emulator);
      expect(errors).toEqual([]);
      expect(clicked.ok).toBe(true);
      expect(openedView!.ok).toBe(true);
      const submitted = await post(emulator, "/_slack/simulate/view-submission", {
        view_id: openedView!.view.id,
        values: { name: "Alex", choice: "one" },
      });
      expect(submitted.ok).toBe(true);
      expect(errors).toEqual([]);
      expect(received.map((payload) => payload.type)).toEqual(["block_actions", "view_submission"]);
      expect(getSlackStore(emulator.store).ephemeralMessages.all().at(-1)!.text).toBe("Thanks for clicking");
      expect(getSlackStore(emulator.store).views.all()).toHaveLength(0);
    } finally {
      await emulator?.close();
      if (receiverServer) await new Promise<void>((resolve) => receiverServer!.close(() => resolve()));
    }
  });
});
