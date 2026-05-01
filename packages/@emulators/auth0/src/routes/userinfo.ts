import type { RouteContext } from "@emulators/core";
import { parseScope, userDisplayName } from "../helpers.js";
import { getAuth0Store } from "../store.js";
import { getAccessTokens } from "./token.js";

function unauthorized(): Response {
  return Response.json({ error: "invalid_token", error_description: "The access token is invalid." }, { status: 401 });
}

export function userinfoRoutes({ app, store }: RouteContext): void {
  const auth0 = getAuth0Store(store);

  app.get("/userinfo", (c) => {
    const token = c.get("authToken") ?? "";
    const access = getAccessTokens(store).get(token);
    if (!access || !access.userAuth0Id) return unauthorized();

    const user = auth0.users.findOneBy("auth0_id", access.userAuth0Id);
    if (!user) return unauthorized();
    const scopes = parseScope(access.scope);
    const body: Record<string, unknown> = { sub: user.auth0_id };
    if (scopes.includes("profile")) {
      body.name = userDisplayName(user);
      body.nickname = user.nickname;
      body.picture = user.picture;
      body.locale = user.locale;
    }
    if (scopes.includes("email")) {
      body.email = user.email;
      body.email_verified = user.email_verified;
    }
    if (access.organization) body.org_id = access.organization;
    return c.json(body);
  });
}
