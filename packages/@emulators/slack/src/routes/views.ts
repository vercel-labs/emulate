import type { Context, RouteContext } from "@emulators/core";
import type { SlackToken, SlackView } from "../entities.js";
import { getSlackStore } from "../store.js";
import { formatSlackView, generateSlackId, generateTs, parseSlackBody, slackError, slackOk } from "../helpers.js";

import {
  createSlackView,
  createSlackViewTrigger,
  parseViewPayload,
  MAX_MODAL_STACK_DEPTH,
  type ParsedViewPayload,
} from "../view-state.js";

interface ConsumedTrigger {
  user_id?: string;
  app_id?: string;
  view_id?: string;
}

export function viewsRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const ss = () => getSlackStore(store);
  const teamId = () => ss().teams.all()[0]?.team_id ?? "T000000001";

  app.post("/api/views.publish", async (c) => {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");

    const body = await parseSlackBody(c);
    const userId = resolveUserId(stringField(body.user_id));
    if (!userId) return slackError(c, "user_not_found");

    const parsed = parseViewPayload(body.view, "home");
    if (parsed.error || !parsed.view) return slackError(c, parsed.error ?? "invalid_view");
    const viewPayload = parsed.view;

    const actor = viewActor(c);
    const existing = ss()
      .views.all()
      .find((view) => view.type === "home" && view.user_id === userId && view.app_id === actor.app_id);
    const hash = stringField(body.hash);
    if (existing && hash && hash !== existing.hash) return slackError(c, "hash_conflict");
    if (findDuplicateExternalId(viewPayload.external_id, existing?.view_id)) {
      return slackError(c, "duplicate_external_id");
    }

    const now = nowSeconds();
    const view =
      existing ??
      ss().views.insert({
        ...viewPayload,
        view_id: generateSlackId("V"),
        team_id: teamId(),
        user_id: userId,
        hash: generateTs(),
        root_view_id: "",
        app_id: actor.app_id,
        bot_id: actor.bot_id,
        created: now,
        updated: now,
      });

    const updated = ss().views.update(view.id, {
      ...viewPayload,
      root_view_id: view.root_view_id || view.view_id,
      hash: generateTs(),
      updated: now,
    })!;
    return slackOk(c, { view: formatSlackView(updated) });
  });

  app.post("/api/views.open", async (c) => {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");

    const body = await parseSlackBody(c);
    const parsed = parseViewPayload(body.view, "modal");
    if (parsed.error || !parsed.view) return slackError(c, parsed.error ?? "invalid_view");
    const viewPayload = parsed.view;

    const actor = viewActor(c);
    const trigger = consumeTrigger(viewExchangeId(body), actor.app_id);
    if (trigger.error) return slackError(c, trigger.error);
    const userId = trigger.value!.user_id!;
    if (!resolveUserId(userId)) return slackError(c, "user_not_found");
    if (findDuplicateExternalId(viewPayload.external_id)) return slackError(c, "duplicate_external_id");

    const view = createView(viewPayload, {
      user_id: userId,
      app_id: actor.app_id,
      bot_id: actor.bot_id,
    });
    return slackOk(c, { view: formatSlackView(view) });
  });

  app.post("/api/views.update", async (c) => {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");

    const body = await parseSlackBody(c);
    const view = findView(stringField(body.view_id), stringField(body.external_id));
    if (!view) return slackError(c, "not_found");
    const actor = viewActor(c);
    if (view.app_id !== actor.app_id) return slackError(c, "not_found");

    const hash = stringField(body.hash);
    if (hash && hash !== view.hash) return slackError(c, "hash_conflict");

    const parsed = parseViewPayload(body.view, view.type, view.type);
    if (parsed.error || !parsed.view) return slackError(c, parsed.error ?? "invalid_view");
    const viewPayload = parsed.view;
    if (findDuplicateExternalId(viewPayload.external_id, view.view_id)) {
      return slackError(c, "duplicate_external_id");
    }

    const updated = ss().views.update(view.id, {
      ...viewPayload,
      hash: generateTs(),
      updated: nowSeconds(),
    })!;
    return slackOk(c, { view: formatSlackView(updated) });
  });

  app.post("/api/views.push", async (c) => {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");

    const body = await parseSlackBody(c);
    const parsed = parseViewPayload(body.view, "modal");
    if (parsed.error || !parsed.view) return slackError(c, parsed.error ?? "invalid_view");
    const viewPayload = parsed.view;

    const actor = viewActor(c);
    const trigger = consumeTrigger(viewExchangeId(body), actor.app_id);
    if (trigger.error) return slackError(c, trigger.error);
    const userId = trigger.value!.user_id!;
    if (!resolveUserId(userId)) return slackError(c, "user_not_found");
    if (findDuplicateExternalId(viewPayload.external_id)) return slackError(c, "duplicate_external_id");

    const parent = trigger.value?.view_id ? ss().views.findOneBy("view_id", trigger.value.view_id) : undefined;
    if (!parent || parent.type !== "modal" || parent.user_id !== userId) return slackError(c, "view_not_found");
    if (modalStackDepth(parent) >= MAX_MODAL_STACK_DEPTH) return slackError(c, "push_limit_reached");

    const view = createView(viewPayload, {
      user_id: userId,
      app_id: actor.app_id,
      bot_id: actor.bot_id,
      previous_view_id: parent?.view_id,
      root_view_id: parent?.root_view_id ?? parent?.view_id,
    });
    return slackOk(c, { view: formatSlackView(view) });
  });

  app.post("/api/views.generateTriggerId", async (c) => {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");

    const body = await parseSlackBody(c);
    const referencedView = stringField(body.view_id)
      ? ss().views.findOneBy("view_id", stringField(body.view_id))
      : undefined;
    if (stringField(body.view_id) && !referencedView) return slackError(c, "view_not_found");
    const actor = viewActor(c);
    if (referencedView && referencedView.app_id !== actor.app_id) return slackError(c, "view_not_found");

    const userId = resolveUserId(stringField(body.user_id)) ?? referencedView?.user_id ?? resolveUserId(authUser.login);
    if (!userId || !resolveUserId(userId)) return slackError(c, "user_not_found");

    const trigger = createSlackViewTrigger(store, {
      team_id: teamId(),
      user_id: userId,
      app_id: actor.app_id,
      ...(referencedView ? { view_id: referencedView.view_id } : {}),
    });
    return slackOk(c, { trigger_id: trigger.trigger_id, expires_at: trigger.expires_at });
  });

  function createView(
    parsed: ParsedViewPayload,
    options: {
      user_id: string;
      app_id: string;
      bot_id: string;
      root_view_id?: string;
      previous_view_id?: string;
    },
  ): SlackView {
    return createSlackView(store, parsed, { ...options, team_id: teamId() });
  }

  function findView(viewId: string, externalId: string): SlackView | undefined {
    if (viewId) return ss().views.findOneBy("view_id", viewId);
    if (externalId) return ss().views.findOneBy("external_id", externalId);
    return undefined;
  }

  function findDuplicateExternalId(externalId: string, currentViewId?: string): SlackView | undefined {
    if (!externalId) return undefined;
    return ss()
      .views.all()
      .find((view) => view.team_id === teamId() && view.external_id === externalId && view.view_id !== currentViewId);
  }

  function resolveUserId(value: string): string | undefined {
    if (!value) return undefined;
    return ss().users.findOneBy("user_id", value)?.user_id ?? ss().users.findOneBy("name", value)?.user_id;
  }

  function modalStackDepth(view: SlackView): number {
    const rootViewId = view.root_view_id || view.view_id;
    return ss()
      .views.all()
      .filter((candidate) => candidate.type === "modal" && candidate.root_view_id === rootViewId).length;
  }

  function viewActor(c: Context): { app_id: string; bot_id: string } {
    const token = authTokenRecord(c);
    const appId =
      token?.app_id ??
      (token?.client_id ? ss().oauthApps.findOneBy("client_id", token.client_id)?.app_id : undefined) ??
      ss().oauthApps.all()[0]?.app_id ??
      "A000000001";
    const installation = ss()
      .installations.findBy("app_id", appId)
      .find((item) => item.team_id === (token?.team_id ?? teamId()));
    const botId = token?.bot_id ?? installation?.bot_id ?? ss().bots.all()[0]?.bot_id ?? "B000000001";
    return { app_id: appId, bot_id: botId };
  }

  function authTokenRecord(c: Context): SlackToken | undefined {
    const token = c.get("authToken") as string | undefined;
    return token ? ss().tokens.findOneBy("token", token) : undefined;
  }

  function consumeTrigger(triggerId: string, appId: string): { value?: ConsumedTrigger; error?: string } {
    if (!triggerId) return { error: "invalid_trigger_id" };
    const trigger = ss().viewTriggers.findOneBy("trigger_id", triggerId);
    if (!trigger) return { error: "invalid_trigger_id" };
    if (trigger.app_id !== appId) return { error: "invalid_trigger_id" };
    if (trigger.used) return { error: "exchanged_trigger_id" };
    if (trigger.expires_at <= Date.now() / 1000) return { error: "expired_trigger_id" };
    const updated = ss().viewTriggers.update(trigger.id, { used: true }) ?? trigger;
    return { value: { user_id: updated.user_id, app_id: updated.app_id, view_id: updated.view_id } };
  }
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function viewExchangeId(body: Record<string, unknown>): string {
  return stringField(body.trigger_id) || stringField(body.interactivity_pointer);
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
