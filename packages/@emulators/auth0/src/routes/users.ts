import type { RouteContext } from "@emulators/core";
import type { Auth0User } from "../entities.js";
import {
  buildLogEvent,
  DEFAULT_CONNECTION,
  generateAuth0UserId,
  hashPassword,
  isStrongPassword,
  isValidEmail,
  userResponse,
} from "../helpers.js";
import {
  AUTH0_ERRORS,
  managementApiError,
  findUserById,
  readJsonObject,
  requireManagementToken,
} from "../route-helpers.js";
import { getAuth0Store } from "../store.js";

export function userRoutes({ app, store, baseUrl, tokenMap, webhooks }: RouteContext): void {
  const auth0Store = getAuth0Store(store);

  // Create user
  app.post("/api/v2/users", async (c) => {
    const auth = requireManagementToken(c, tokenMap);
    if (auth instanceof Response) return auth;

    const body = await readJsonObject(c);
    const email = typeof body.email === "string" ? body.email.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const connection = typeof body.connection === "string" ? body.connection : DEFAULT_CONNECTION;
    const verifyEmail = body.verify_email !== false;
    const userId = typeof body.user_id === "string" ? body.user_id : undefined;

    if (!email) {
      return managementApiError(c, 400, "Payload validation error: 'email' is required.");
    }

    if (!isValidEmail(email)) {
      await webhooks.dispatch(
        "fs",
        undefined,
        buildLogEvent("fs", {
          user_name: email,
          description: AUTH0_ERRORS.INVALID_EMAIL + email,
          connection,
        }),
        "auth0",
      );
      return managementApiError(c, 400, AUTH0_ERRORS.INVALID_EMAIL + email);
    }

    if (!password) {
      return managementApiError(c, 400, "Payload validation error: 'password' is required.");
    }

    if (!isStrongPassword(password)) {
      await webhooks.dispatch(
        "fs",
        undefined,
        buildLogEvent("fs", {
          user_name: email,
          description: AUTH0_ERRORS.WEAK_PASSWORD,
          connection,
        }),
        "auth0",
      );
      return managementApiError(c, 400, AUTH0_ERRORS.WEAK_PASSWORD);
    }

    const existingConn = auth0Store.connections.findOneBy("name", connection);
    if (!existingConn) {
      return managementApiError(c, 400, `Connection '${connection}' does not exist.`);
    }

    const existingUser = auth0Store.users.findBy("email", email).find((u) => u.connection === connection);
    if (existingUser) {
      await webhooks.dispatch(
        "fs",
        undefined,
        buildLogEvent("fs", {
          user_name: email,
          description: AUTH0_ERRORS.USER_EXISTS,
          connection,
        }),
        "auth0",
      );
      return managementApiError(c, 409, AUTH0_ERRORS.USER_EXISTS);
    }

    const auth0UserId = userId ? `auth0|${userId}` : generateAuth0UserId();
    const appMetadata = (body.app_metadata && typeof body.app_metadata === "object" ? body.app_metadata : {}) as Record<
      string,
      unknown
    >;
    const userMetadata = (
      body.user_metadata && typeof body.user_metadata === "object" ? body.user_metadata : {}
    ) as Record<string, unknown>;

    const nickname = email.split("@")[0] ?? "";

    // Find the client name from the management token's login (client_id)
    const clientId = auth.login;
    const client = auth0Store.oauthClients.findOneBy("client_id", clientId);
    const clientName = client?.name ?? clientId;

    const created = auth0Store.users.insert({
      user_id: auth0UserId,
      email,
      email_verified: !verifyEmail,
      password_hash: hashPassword(password),
      connection,
      blocked: false,
      app_metadata: appMetadata,
      user_metadata: userMetadata,
      given_name: "",
      family_name: "",
      name: email,
      nickname,
      picture: `https://s.gravatar.com/avatar/${auth0UserId}?s=480&r=pg&d=https%3A%2F%2Fcdn.auth0.com%2Favatars%2F${nickname.slice(0, 2)}.png`,
    });

    await webhooks.dispatch(
      "ss",
      undefined,
      buildLogEvent("ss", {
        user_id: auth0UserId,
        user_name: email,
        client_id: clientId,
        client_name: clientName,
        connection,
        description: "Successful signup",
        strategy: "auth0",
        strategy_type: "database",
      }),
      "auth0",
    );

    return c.json(userResponse(created), 201);
  });

  // Get user by ID
  app.get("/api/v2/users/:userId{.+}", (c) => {
    const auth = requireManagementToken(c, tokenMap);
    if (auth instanceof Response) return auth;

    const user = findUserById(auth0Store, c.req.param("userId"));
    if (!user) return managementApiError(c, 404, AUTH0_ERRORS.USER_NOT_FOUND);
    return c.json(userResponse(user));
  });

  // List users by email
  app.get("/api/v2/users-by-email", (c) => {
    const auth = requireManagementToken(c, tokenMap);
    if (auth instanceof Response) return auth;

    const email = c.req.query("email") ?? "";
    if (!email) {
      return c.json([]);
    }

    const users = auth0Store.users.findBy("email", email);
    return c.json(users.map(userResponse));
  });

  // Update user (PATCH)
  app.patch("/api/v2/users/:userId{.+}", async (c) => {
    const auth = requireManagementToken(c, tokenMap);
    if (auth instanceof Response) return auth;

    const user = findUserById(auth0Store, c.req.param("userId"));
    if (!user) return managementApiError(c, 404, AUTH0_ERRORS.USER_NOT_FOUND);

    const body = await readJsonObject(c);
    const updates: Partial<Auth0User> = {};
    let passwordChanged = false;

    if (typeof body.email_verified === "boolean") {
      updates.email_verified = body.email_verified;
    }
    if (typeof body.blocked === "boolean") {
      updates.blocked = body.blocked;
    }
    if (typeof body.email === "string") {
      updates.email = body.email.trim();
    }
    if (typeof body.given_name === "string") {
      updates.given_name = body.given_name;
    }
    if (typeof body.family_name === "string") {
      updates.family_name = body.family_name;
    }
    if (typeof body.name === "string") {
      updates.name = body.name;
    }
    if (typeof body.nickname === "string") {
      updates.nickname = body.nickname;
    }
    if (typeof body.picture === "string") {
      updates.picture = body.picture;
    }
    if (body.app_metadata && typeof body.app_metadata === "object") {
      updates.app_metadata = { ...user.app_metadata, ...(body.app_metadata as Record<string, unknown>) };
    }
    if (body.user_metadata && typeof body.user_metadata === "object") {
      updates.user_metadata = { ...user.user_metadata, ...(body.user_metadata as Record<string, unknown>) };
    }
    if (typeof body.password === "string") {
      if (!isStrongPassword(body.password)) {
        return managementApiError(c, 400, AUTH0_ERRORS.WEAK_PASSWORD);
      }
      updates.password_hash = hashPassword(body.password);
      passwordChanged = true;
    }

    const updated = auth0Store.users.update(user.id, updates);

    if (passwordChanged) {
      await webhooks.dispatch(
        "scp",
        undefined,
        buildLogEvent("scp", {
          user_id: user.user_id,
          user_name: user.email,
          description: "Successful change password request",
          connection: user.connection,
          strategy: "auth0",
          strategy_type: "database",
        }),
        "auth0",
      );
    }

    return c.json(userResponse(updated ?? user));
  });
}
