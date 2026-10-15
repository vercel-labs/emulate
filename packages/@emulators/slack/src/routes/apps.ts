import { constantTimeSecretEqual, type RouteContext } from "@emulators/core";
import { dispatchSlackEvent } from "../events.js";
import { parseSlackBody, slackError, slackOk } from "../helpers.js";
import { getSlackStore } from "../store.js";
import { isSlackTokenRevoked, revokeSlackTokens, slackRequestToken } from "../tokens.js";

export function appsRoutes({ app, store, webhooks, tokenMap }: RouteContext): void {
  app.post("/api/apps.uninstall", async (c) => {
    const body = await parseSlackBody(c);
    const headerToken = slackRequestToken(c);
    const token = headerToken ?? (typeof body.token === "string" ? body.token.trim() : "");
    if (!token) return slackError(c, "not_authed");
    if (isSlackTokenRevoked(store, token)) return slackError(c, "token_revoked");

    const ss = getSlackStore(store);
    const tokenRecord = ss.tokens.findOneBy("token", token);
    const authUser = headerToken ? c.get("authUser") : tokenMap?.get(token);
    if (!tokenRecord && !authUser) return slackError(c, "invalid_auth");

    const clientId = typeof body.client_id === "string" ? body.client_id : "";
    const clientSecret = typeof body.client_secret === "string" ? body.client_secret : "";
    const oauthApp = ss.oauthApps.findOneBy("client_id", clientId);
    if (
      !clientId ||
      (!oauthApp && (ss.oauthApps.all().length > 0 || !ss.installations.findOneBy("client_id", clientId)))
    ) {
      return slackError(c, "invalid_client_id");
    }
    if (oauthApp && !constantTimeSecretEqual(clientSecret, oauthApp.client_secret))
      return slackError(c, "bad_client_secret");

    const user = tokenRecord
      ? ss.users.findOneBy("user_id", tokenRecord.user_id)
      : ss.users.all().find((user) => user.user_id === authUser?.login || user.name === authUser?.login);
    const teamId = tokenRecord?.team_id ?? user?.team_id ?? ss.teams.all()[0]?.team_id;
    const installation = ss.installations.findBy("client_id", clientId).find((item) => item.team_id === teamId);
    const tokenInstallation = tokenRecord?.installation_id
      ? ss.installations.findOneBy("installation_id", tokenRecord.installation_id)
      : undefined;
    const tokenAppId = tokenRecord?.app_id ?? tokenInstallation?.app_id;
    if (
      !installation ||
      (tokenAppId && tokenAppId !== installation.app_id) ||
      (tokenRecord?.client_id && tokenRecord.client_id !== clientId)
    ) {
      return slackError(c, "client_id_token_mismatch");
    }
    if (tokenRecord?.token_type === "bot") return slackError(c, "no_permission");

    const tokens = ss.tokens
      .findBy("team_id", installation.team_id)
      .filter(
        (item) =>
          item.installation_id === installation.installation_id ||
          item.app_id === installation.app_id ||
          item.client_id === installation.client_id,
      );
    const revokedUsers = {
      oauth: [...new Set(tokens.filter((item) => item.token_type === "user").map((item) => item.user_id))],
      bot: [
        ...new Set(tokens.filter((item) => item.token_type === "bot").map((item) => item.bot_user_id ?? item.user_id)),
      ],
    };
    revokeSlackTokens(store, tokens, tokenMap);
    ss.installations.delete(installation.id);

    // Capture the recipient before removing its installation. Credentials are
    // already invalid when either callback reaches the application.
    const dispatch = async (event: Record<string, unknown>) => {
      await dispatchSlackEvent(store, webhooks, installation.team_id, event, installation);
    };
    await dispatch({ type: "app_uninstalled" });
    await dispatch({ type: "tokens_revoked", tokens: revokedUsers });
    return slackOk(c, {});
  });
}
