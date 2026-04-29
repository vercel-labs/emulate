import { escapeAttr, renderCardPage, renderErrorPage, renderUserButton } from "@emulators/core";
import type { Context } from "hono";
import type { AppEnv } from "@emulators/core";
import type { Auth0Application, Auth0Organization, Auth0User } from "../entities.js";
import { userDisplayName } from "../helpers.js";

const SERVICE_LABEL = "Auth0";

export interface LoginPageOptions {
  users: Auth0User[];
  application: Auth0Application | null;
  organization: Auth0Organization | null;
  hiddenFields: Record<string, string>;
}

export function renderLogin(c: Context<AppEnv>, options: LoginPageOptions): Response {
  const subtitle = options.application
    ? `Sign in to <strong>${options.application.name}</strong> with your Auth0 account.`
    : "Choose a seeded user to continue.";
  const buttons = options.users
    .map((user) =>
      renderUserButton({
        letter: (user.email[0] ?? "?").toUpperCase(),
        login: user.email,
        name: userDisplayName(user),
        email: options.organization ? options.organization.display_name : user.email,
        formAction: "/u/login/callback",
        hiddenFields: {
          ...options.hiddenFields,
          user_ref: user.auth0_id,
        },
      }),
    )
    .join("\n");

  return c.html(
    renderCardPage(
      "Sign in with Auth0",
      subtitle,
      options.users.length > 0 ? buttons : '<p class="empty">No users in the emulator store.</p>',
      SERVICE_LABEL,
    ),
  );
}

export function renderConsent(
  c: Context<AppEnv>,
  applicationName: string,
  hiddenFields: Record<string, string>,
): Response {
  const fields = Object.entries(hiddenFields)
    .map(([name, value]) => `<input type="hidden" name="${escapeAttr(name)}" value="${escapeAttr(value)}" />`)
    .join("\n");
  const content = `
    <form method="post" action="/u/consent/callback" class="stack">
      ${fields}
      <p class="muted">${applicationName} is requesting access to the selected Auth0 tenant.</p>
      <button type="submit" class="button button-primary">Continue</button>
    </form>
  `;
  return c.html(
    renderCardPage("Authorize application", "Review the request before continuing.", content, SERVICE_LABEL),
  );
}

export function renderAuth0Error(c: Context<AppEnv>, title: string, message: string, status = 400): Response {
  return c.html(renderErrorPage(title, message, SERVICE_LABEL), status as 400);
}
