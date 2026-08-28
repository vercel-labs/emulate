import type { RouteContext } from "@emulators/core";
import { getGitHubStore } from "../store.js";

export function installationTokenRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;

  app.get("/_emulate/installation-tokens", (c) => {
    const now = Date.now();
    const installationTokens = getGitHubStore(store)
      .installationTokenMetadata.all()
      .map((entry) => ({
        app: {
          id: entry.app_id,
          slug: entry.app_slug,
          name: entry.app_name,
        },
        installation: {
          id: entry.installation_id,
        },
        account: {
          id: entry.account_id,
          login: entry.account_login,
          type: entry.account_type,
        },
        permissions: { ...entry.permissions },
        repository_selection: entry.repository_selection,
        repository_ids: [...entry.repository_ids],
        issued_at: entry.issued_at,
        expires_at: entry.expires_at,
        status: now < Date.parse(entry.expires_at) ? "active" : "expired",
      }));

    return c.json({ installation_tokens: installationTokens });
  });
}
