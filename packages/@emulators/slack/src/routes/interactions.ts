import { randomUUID } from "node:crypto";
import type { RouteContext } from "@emulators/core";
import type { SlackJsonObject, SlackMessage, SlackView } from "../entities.js";
import { dispatchSlackEvent } from "../events.js";
import {
  formatSlackMessage,
  formatSlackView,
  generateTs,
  hasSlackMessageContent,
  normalizeSlackMessageText,
  parseSlackBody,
  parseSlackRichMessageFields,
  slackBotMessageFields,
  slackError,
  slackOk,
} from "../helpers.js";
import { slackRequestHeaders } from "../signing.js";
import { getSlackStore } from "../store.js";
import { createSlackView, createSlackViewTrigger, MAX_MODAL_STACK_DEPTH, parseViewPayload } from "../view-state.js";

export function interactionRoutes({ app, store, baseUrl, webhooks }: RouteContext): void {
  const ss = () => getSlackStore(store);
  const submitting = new Set<string>();
  const findUser = (value: unknown) =>
    ss()
      .users.all()
      .find((user) => !user.deleted && !user.is_bot && (user.user_id === value || user.name === value));
  const interactionApp = (appId: string | undefined) =>
    appId
      ? ss().oauthApps.findOneBy("app_id", appId)
      : ss().oauthApps.all().length === 1
        ? ss().oauthApps.all()[0]
        : undefined;
  const commonPayload = (appId: string, userId: string, teamId: string) => {
    const user = ss().users.findOneBy("user_id", userId)!;
    const team = ss().teams.findOneBy("team_id", teamId);
    return {
      api_app_id: appId,
      token: store.getData<string>("slack.verification_token") ?? "emulate-verification-token",
      team: { id: teamId, domain: team?.domain ?? "emulate" },
      user: { id: user.user_id, username: user.name, name: user.name, team_id: user.team_id },
      enterprise: null,
      is_enterprise_install: false,
    };
  };

  async function deliver(appId: string, url: string, payload: SlackJsonObject) {
    const delivery = ss().interactionDeliveries.insert({
      app_id: appId,
      type: String(payload.type),
      payload,
      status_code: null,
      success: false,
    });
    const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
    try {
      const response = await fetch(url, {
        method: "POST",
        body,
        headers: slackRequestHeaders(store, body, "application/x-www-form-urlencoded"),
        signal: AbortSignal.timeout(3000),
      });
      const responseBody = await response.text();
      ss().interactionDeliveries.update(delivery.id, {
        status_code: response.status,
        success: response.status === 200,
      });
      return { id: delivery.id, ok: response.status === 200, body: responseBody };
    } catch {
      return { id: delivery.id, ok: false, body: "" };
    }
  }

  app.post("/_slack/simulate/block-actions", async (c) => {
    if (!c.get("authUser")) return slackError(c, "not_authed");
    const body = await parseSlackBody(c);
    const user = findUser(body.user ?? c.get("authUser")!.login);
    if (!user) return slackError(c, "user_not_found");
    const channel = ss()
      .channels.all()
      .find((item) => item.channel_id === body.channel || item.name === body.channel);
    if (!channel || channel.is_archived) return slackError(c, "channel_not_found");
    if (!channel.members.includes(user.user_id) && !channel.members.includes(user.name))
      return slackError(c, "not_in_channel");
    const message =
      ss()
        .messages.findBy("channel_id", channel.channel_id)
        .find((item) => item.ts === body.message_ts) ??
      ss()
        .ephemeralMessages.findBy("channel_id", channel.channel_id)
        .find((item) => item.ts === body.message_ts && item.target_user === user.user_id);
    if (!message) return slackError(c, "message_not_found");
    const ephemeral = "target_user" in message;
    const candidates = (message.blocks ?? []).flatMap((block, index) => {
      const elements =
        block.type === "actions" && Array.isArray(block.elements)
          ? block.elements
          : block.type === "section"
            ? [block.accessory]
            : [];
      return elements.filter(isObject).map((element) => ({ block, element, index }));
    });
    const selectors = ["action_id", "text", "url"].filter((key) => typeof body[key] === "string" && body[key]);
    if (!selectors.length) return slackError(c, "invalid_arguments");
    const matches = candidates.filter(({ element }) =>
      selectors.every(
        (key) => (key === "text" && isObject(element.text) ? element.text.text : element[key]) === body[key],
      ),
    );
    if (!matches.length) return slackError(c, "action_not_found");
    if (matches.length > 1) return slackError(c, "ambiguous_action");
    const { block, element, index } = matches[0]!;
    if (element.type !== "button") return slackError(c, "unsupported_element");
    const owner =
      message.interaction_app_id ??
      message.app_id ??
      ss()
        .installations.all()
        .find((item) => item.bot_user_id === message.user)?.app_id ??
      (message.bot_id ? ss().bots.findOneBy("bot_id", message.bot_id)?.app_id : undefined);
    const targetApp = interactionApp(owner);
    if (!targetApp?.app_id || !targetApp.interactivity_url) return slackError(c, "interactivity_not_configured");
    const installation = ss()
      .installations.findBy("app_id", targetApp.app_id)
      .find((item) => item.team_id === channel.team_id);
    if (!installation) return slackError(c, "app_not_installed");
    const trigger = createSlackViewTrigger(store, {
      team_id: channel.team_id,
      user_id: user.user_id,
      app_id: targetApp.app_id,
    });
    const response = ss().responseUrls.insert({
      response_id: randomUUID(),
      app_id: targetApp.app_id,
      bot_id: installation.bot_id,
      bot_user_id: installation.bot_user_id,
      channel_id: channel.channel_id,
      message_ts: message.ts,
      user_id: user.user_id,
      is_ephemeral: ephemeral,
      expires_at: Date.now() + 30 * 60 * 1000,
      uses: 0,
    });
    const payload = {
      ...commonPayload(targetApp.app_id, user.user_id, channel.team_id),
      type: "block_actions",
      trigger_id: trigger.trigger_id,
      container: { type: "message", message_ts: message.ts, channel_id: channel.channel_id, is_ephemeral: ephemeral },
      channel: { id: channel.channel_id, name: channel.name },
      message: formatSlackMessage(message),
      response_url: `${baseUrl.replace(/\/$/, "")}/_slack/response/${response.response_id}`,
      actions: [
        {
          type: "button",
          action_id: element.action_id,
          block_id: block.block_id ?? `block_${index}`,
          text: element.text,
          ...(typeof element.value === "string" ? { value: element.value } : {}),
          ...(typeof element.url === "string" ? { url: element.url } : {}),
          action_ts: generateTs(),
        },
      ],
      state: { values: {} },
    };
    const delivery = await deliver(targetApp.app_id, targetApp.interactivity_url, payload);
    if (!delivery.ok) return c.json({ ok: false, error: "interactivity_delivery_failed", delivery_id: delivery.id });
    return slackOk(c, { delivery_id: delivery.id, payload });
  });

  app.post("/_slack/simulate/view-submission", async (c) => {
    if (!c.get("authUser")) return slackError(c, "not_authed");
    const body = await parseSlackBody(c);
    const view = typeof body.view_id === "string" ? ss().views.findOneBy("view_id", body.view_id) : undefined;
    if (!view || view.type !== "modal") return slackError(c, "view_not_found");
    const user = findUser(body.user ?? view.user_id);
    if (!user || user.user_id !== view.user_id) return slackError(c, "user_not_found");
    if (!view.submit) return slackError(c, "view_not_submittable");
    if (ss().views.findOneBy("previous_view_id", view.view_id)) return slackError(c, "view_not_visible");
    if (submitting.has(view.view_id)) return slackError(c, "view_submission_in_progress");
    const targetApp = interactionApp(view.app_id);
    if (!targetApp?.interactivity_url) return slackError(c, "interactivity_not_configured");
    if (
      !ss()
        .installations.findBy("app_id", view.app_id)
        .some((item) => item.team_id === view.team_id)
    )
      return slackError(c, "app_not_installed");
    const state = submissionState(view, body.values ?? {});
    if (typeof state === "string") return slackError(c, state);
    const submitted = ss().views.update(view.id, { state })!;
    const payload = {
      ...commonPayload(view.app_id, user.user_id, view.team_id),
      type: "view_submission",
      view: formatSlackView(submitted),
      response_urls: [],
    };
    submitting.add(view.view_id);
    try {
      const delivery = await deliver(view.app_id, targetApp.interactivity_url, payload);
      if (!delivery.ok) return c.json({ ok: false, error: "interactivity_delivery_failed", delivery_id: delivery.id });
      let acknowledgement: unknown = {};
      if (delivery.body.trim()) {
        try {
          acknowledgement = JSON.parse(delivery.body);
        } catch {
          return slackError(c, "invalid_interaction_response");
        }
      }
      if (!isObject(acknowledgement)) return slackError(c, "invalid_interaction_response");
      const result = applySubmissionResponse(submitted, acknowledgement);
      if (typeof result === "string") return slackError(c, result);
      return slackOk(c, { delivery_id: delivery.id, payload, ...result });
    } finally {
      submitting.delete(view.view_id);
    }
  });

  function applySubmissionResponse(view: SlackView, response: SlackJsonObject): SlackJsonObject | string {
    const action = response.response_action;
    if (action === "errors") {
      if (
        !isObject(response.errors) ||
        Object.entries(response.errors).some(
          ([key, value]) =>
            typeof value !== "string" || !view.blocks.some((block) => block.block_id === key && block.type === "input"),
        )
      )
        return "invalid_interaction_response";
      return { response_action: action, errors: response.errors, view: formatSlackView(view) };
    }
    if (action === "update" || action === "push") {
      const parsed = parseViewPayload(response.view, "modal");
      if (!parsed.view) return "invalid_interaction_response";
      const next = parsed.view;
      if (
        next.external_id &&
        ss()
          .views.all()
          .some(
            (other) =>
              other.team_id === view.team_id &&
              other.external_id === next.external_id &&
              (action === "push" || other.view_id !== view.view_id),
          )
      )
        return "duplicate_external_id";
      if (action === "update") {
        const previousValues = isObject(view.state.values) ? view.state.values : {};
        next.state = {
          values: Object.fromEntries(
            next.blocks.flatMap((block) => {
              const element = isObject(block.element) ? block.element : {};
              const blockId = String(block.block_id);
              const actionId = String(element.action_id);
              const old = isObject(previousValues[blockId]) ? previousValues[blockId] : {};
              return block.type === "input" && old[actionId] ? [[blockId, { [actionId]: old[actionId] }]] : [];
            }),
          ),
        };
        const updated = ss().views.update(view.id, {
          ...next,
          hash: generateTs(),
          updated: Math.floor(Date.now() / 1000),
        })!;
        return { response_action: action, view: formatSlackView(updated) };
      }
      if (ss().views.findBy("root_view_id", view.root_view_id).length >= MAX_MODAL_STACK_DEPTH)
        return "push_limit_reached";
      const pushed = createSlackView(store, next, {
        team_id: view.team_id,
        user_id: view.user_id,
        app_id: view.app_id,
        bot_id: view.bot_id,
        root_view_id: view.root_view_id,
        previous_view_id: view.view_id,
      });
      return { response_action: action, view: formatSlackView(pushed) };
    }
    if (action !== undefined && action !== "clear") return "invalid_interaction_response";
    if (action === undefined && Object.keys(response).length) return "invalid_interaction_response";
    if (action === "clear") {
      for (const item of ss().views.findBy("root_view_id", view.root_view_id)) {
        if (item.app_id === view.app_id && item.user_id === view.user_id) ss().views.delete(item.id);
      }
    } else ss().views.delete(view.id);
    return { response_action: action ?? "close" };
  }

  app.post("/_slack/response/:id", async (c) => {
    const body = await parseSlackBody(c);
    const response = ss().responseUrls.findOneBy("response_id", c.req.param("id"));
    if (!response) return slackError(c, "invalid_response_url", 404);
    if (response.expires_at <= Date.now() || response.uses >= 5) return slackError(c, "expired_response_url", 410);
    const replace = body.replace_original === true || body.replace_original === "true";
    const remove = body.delete_original === true || body.delete_original === "true";
    const inChannel = body.response_type === "in_channel";
    if (body.response_type !== undefined && !["ephemeral", "in_channel"].includes(String(body.response_type)))
      return slackError(c, "invalid_arguments");
    if (replace && remove) return slackError(c, "invalid_arguments");
    const rich = parseSlackRichMessageFields(body);
    if (rich.error) return slackError(c, rich.error);
    const normalized = normalizeSlackMessageText(typeof body.text === "string" ? body.text : "");
    const hasContent = hasSlackMessageContent(normalized.text, rich.fields);
    if (!remove && !hasContent) return slackError(c, "no_text");
    const sourceCollection = response.is_ephemeral ? ss().ephemeralMessages : ss().messages;
    const source = sourceCollection
      .findBy("channel_id", response.channel_id)
      .find((item) => item.ts === response.message_ts);
    if ((replace || remove) && !source) return slackError(c, "message_not_found");
    const channel = ss().channels.findOneBy("channel_id", response.channel_id);
    if (!channel) return slackError(c, "channel_not_found");
    ss().responseUrls.update(response.id, { uses: response.uses + 1 });
    if (remove && source) {
      sourceCollection.delete(source.id);
      if (!response.is_ephemeral) {
        for (const pin of ss()
          .pins.findBy("message_ts", source.ts)
          .filter((pin) => pin.channel_id === source.channel_id))
          ss().pins.delete(pin.id);
        await messageEvent(channel.team_id, {
          type: "message",
          subtype: "message_deleted",
          channel: source.channel_id,
          deleted_ts: source.ts,
          previous_message: formatSlackMessage(source),
          ts: generateTs(),
        });
      }
    }
    if (replace && source) {
      const updated = sourceCollection.update(source.id, {
        ...rich.fields,
        ...(source.bot_id ? { bot_id: source.bot_id, app_id: source.app_id } : {}),
        ...(typeof body.text === "string"
          ? { text: normalized.text, blocks: rich.fields.blocks, attachments: rich.fields.attachments }
          : {}),
        edited: { user: response.bot_user_id, ts: generateTs() },
      })!;
      if (!response.is_ephemeral)
        await messageEvent(channel.team_id, {
          type: "message",
          subtype: "message_changed",
          channel: source.channel_id,
          ts: generateTs(),
          message: formatSlackMessage(updated),
          previous_message: formatSlackMessage(source),
        });
    } else if (hasContent) {
      const message: Omit<SlackMessage, "id" | "created_at" | "updated_at"> = {
        ...rich.fields,
        ts: generateTs(),
        channel_id: response.channel_id,
        user: response.bot_user_id,
        ...slackBotMessageFields(store, response.bot_id, channel.team_id, response.app_id),
        interaction_app_id: response.app_id,
        text: normalized.text,
        type: "message",
        subtype: "bot_message",
        reply_count: 0,
        reply_users: [],
        reactions: [],
        ...(typeof body.thread_ts === "string" ? { thread_ts: body.thread_ts } : {}),
      };
      if (inChannel) {
        const inserted = ss().messages.insert(message);
        if (message.thread_ts) {
          const parent = ss()
            .messages.findBy("channel_id", response.channel_id)
            .find((item) => item.ts === message.thread_ts);
          if (parent)
            ss().messages.update(parent.id, {
              reply_count: parent.reply_count + 1,
              reply_users: [...new Set([...parent.reply_users, response.bot_user_id])],
            });
        }
        await messageEvent(channel.team_id, {
          ...formatSlackMessage(inserted),
          type: "message",
          channel: response.channel_id,
        });
      } else ss().ephemeralMessages.insert({ ...message, target_user: response.user_id });
    }
    return slackOk(c, {});
  });

  async function messageEvent(teamId: string, event: SlackJsonObject) {
    await dispatchSlackEvent(store, webhooks, teamId, event);
  }
}

function isObject(value: unknown): value is SlackJsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function submissionState(view: SlackView, supplied: unknown): SlackJsonObject | string {
  if (!isObject(supplied)) return "invalid_values";
  const blocks = view.blocks.filter((block) => block.type === "input");
  if (Object.keys(supplied).some((id) => !blocks.some((block) => block.block_id === id))) return "invalid_values";
  if (new Set(blocks.map((block) => block.block_id)).size !== blocks.length) return "invalid_view";
  const entries: Array<[string, unknown]> = [];
  for (const block of blocks) {
    if (typeof block.block_id !== "string" || !isObject(block.element) || typeof block.element.action_id !== "string")
      return "invalid_view";
    const element = block.element;
    const provided = Object.hasOwn(supplied, block.block_id);
    const value = supplied[block.block_id];
    const previousValues = isObject(view.state.values) ? view.state.values : {};
    const blockState = previousValues[block.block_id];
    const previousBlock = isObject(blockState) ? blockState : {};
    const actionState = previousBlock[element.action_id as string];
    const previous = isObject(actionState) && actionState.type === element.type ? actionState : {};
    let state: SlackJsonObject;
    if (element.type === "plain_text_input") {
      const text = provided
        ? value
        : Object.hasOwn(previous, "value")
          ? previous.value
          : (element.initial_value ?? null);
      if (text !== null && typeof text !== "string") return "invalid_values";
      if (block.optional !== true && !text) return "missing_required_value";
      if (
        typeof text === "string" &&
        ((typeof element.min_length === "number" && Array.from(text).length < element.min_length) ||
          (typeof element.max_length === "number" && Array.from(text).length > element.max_length))
      )
        return "invalid_values";
      state = { type: element.type, value: text || null };
    } else if (["static_select", "multi_static_select", "radio_buttons", "checkboxes"].includes(String(element.type))) {
      const multiple = element.type === "multi_static_select" || element.type === "checkboxes";
      const options = (
        Array.isArray(element.options)
          ? element.options
          : Array.isArray(element.option_groups)
            ? element.option_groups
                .filter(isObject)
                .flatMap((group) => (Array.isArray(group.options) ? group.options : []))
            : []
      ).filter(isObject);
      const initial = multiple
        ? Array.isArray(element.initial_options)
          ? element.initial_options.filter(isObject).map((item) => item.value)
          : []
        : isObject(element.initial_option)
          ? element.initial_option.value
          : null;
      const previousSelection = multiple
        ? Array.isArray(previous.selected_options)
          ? previous.selected_options.filter(isObject).map((item) => item.value)
          : initial
        : Object.hasOwn(previous, "selected_option")
          ? isObject(previous.selected_option)
            ? previous.selected_option.value
            : null
          : initial;
      const selected = provided ? value : previousSelection;
      if (
        multiple
          ? !Array.isArray(selected) || !selected.every((item) => typeof item === "string")
          : selected !== null && typeof selected !== "string"
      )
        return "invalid_values";
      const values = multiple ? (selected as string[]) : selected === null ? [] : [selected];
      if (block.optional !== true && !values.length) return "missing_required_value";
      if (
        new Set(values).size !== values.length ||
        values.some((item) => !options.some((option) => option.value === item))
      )
        return "invalid_values";
      if (typeof element.max_selected_items === "number" && values.length > element.max_selected_items)
        return "invalid_values";
      const selectedOptions = values.map((item) => options.find((option) => option.value === item)!);
      state = {
        type: element.type,
        [multiple ? "selected_options" : "selected_option"]: multiple ? selectedOptions : (selectedOptions[0] ?? null),
      };
    } else return "unsupported_element";
    entries.push([block.block_id, { [element.action_id as string]: state }]);
  }
  return { values: Object.fromEntries(entries) };
}
