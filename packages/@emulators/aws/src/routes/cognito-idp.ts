import { randomBytes, randomUUID } from "node:crypto";
import type { RouteContext } from "@emulators/core";
import { getCognitoStore, type CognitoUser } from "../cognito/store.js";
import {
  CognitoError,
  attributes,
  checkCode,
  checkSecretHash,
  checkUser,
  errorResponse,
  fail,
  findUser,
  getClient,
  getPool,
  getUser,
  issueTokens,
  jsonResponse,
  matchesPassword,
  object,
  passwordHash,
  refreshSession,
  required,
  revokeSessions,
  setCode,
  str,
  userAttributes,
  userResponse,
  verifyToken,
} from "../cognito/helpers.js";

export function cognitoIdpRoutes({ app, store, baseUrl }: RouteContext) {
  const cs = () => getCognitoStore(store);
  const clearCode = { confirmation_code: undefined, code_expires_at: undefined, code_kind: undefined };
  const confirm = (user: CognitoUser, verifyEmail = false) =>
    cs().users.update(user.id, {
      ...clearCode,
      status: "CONFIRMED",
      attributes: { ...user.attributes, ...(verifyEmail && user.attributes.email ? { email_verified: "true" } : {}) },
    })!;

  for (const path of ["/cognito-idp", "/cognito-idp/"])
    app.post(path, async (c) => {
      try {
        const body = object(await c.req.json());
        const target = c.req.header("X-Amz-Target") ?? "";
        const prefix = "AWSCognitoIdentityProviderService.";
        if (!target.startsWith(prefix)) fail("UnknownOperationException", "Unknown Cognito operation.");
        return jsonResponse(c, await dispatch(target.slice(prefix.length), body));
      } catch (error) {
        if (error instanceof SyntaxError)
          return errorResponse(c, new CognitoError("SerializationException", "Invalid JSON request body."));
        return errorResponse(c, error);
      }
    });

  async function dispatch(action: string, body: Record<string, unknown>): Promise<unknown> {
    if (action.startsWith("Admin") || action === "ListUsers") {
      const poolId = required(body.UserPoolId, "UserPoolId");
      getPool(store, poolId);
      if (action === "ListUsers") {
        if (body.Filter) fail("InvalidParameterException", "ListUsers filters are not simulated.");
        const offset = body.PaginationToken === undefined ? 0 : Number(body.PaginationToken);
        const limit = body.Limit === undefined ? 60 : Number(body.Limit);
        if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 60)
          fail("InvalidParameterException", "Invalid pagination parameters.");
        const users = cs().users.findBy("pool_id", poolId);
        return {
          Users: users.slice(offset, offset + limit).map(userResponse),
          ...(offset + limit < users.length ? { PaginationToken: String(offset + limit) } : {}),
        };
      }
      if (action === "AdminInitiateAuth") {
        const client = getClient(store, required(body.ClientId, "ClientId"));
        if (client.pool_id !== poolId)
          fail("ResourceNotFoundException", "App client does not belong to this user pool.");
        return authenticate(body, true);
      }
      if (action === "AdminRespondToAuthChallenge") {
        const client = getClient(store, required(body.ClientId, "ClientId"));
        if (client.pool_id !== poolId)
          fail("ResourceNotFoundException", "App client does not belong to this user pool.");
        return respondToChallenge(body);
      }
      if (action === "AdminCreateUser") {
        const username = required(body.Username, "Username");
        if (findUser(store, poolId, username)) fail("UsernameExistsException", "User already exists.");
        const password = required(body.TemporaryPassword, "TemporaryPassword");
        const user = cs().users.insert({
          pool_id: poolId,
          username,
          sub: randomUUID(),
          password_hash: passwordHash(password),
          attributes: attributes(body.UserAttributes),
          status: "FORCE_CHANGE_PASSWORD",
          enabled: true,
        });
        return { User: userResponse(user) };
      }
      const user = getUser(store, poolId, required(body.Username, "Username"));
      switch (action) {
        case "AdminGetUser": {
          const { Attributes, ...rest } = userResponse(user);
          return { ...rest, UserAttributes: Attributes };
        }
        case "AdminConfirmSignUp":
          confirm(user);
          return {};
        case "AdminSetUserPassword": {
          const hash = passwordHash(required(body.Password, "Password"));
          if (body.Permanent !== undefined && typeof body.Permanent !== "boolean")
            fail("InvalidParameterException", "Permanent must be a boolean.");
          revokeSessions(store, user);
          cs().users.update(user.id, {
            ...clearCode,
            password_hash: hash,
            status: body.Permanent ? "CONFIRMED" : "FORCE_CHANGE_PASSWORD",
          });
          return {};
        }
        case "AdminDisableUser":
          revokeSessions(store, user);
          cs().users.update(user.id, { enabled: false });
          return {};
        case "AdminEnableUser":
          cs().users.update(user.id, { enabled: true });
          return {};
        case "AdminDeleteUser":
          revokeSessions(store, user);

          cs().users.delete(user.id);
          return {};
        default:
          return fail("UnknownOperationException", `Operation ${action} is not simulated.`);
      }
    }

    if (action === "InitiateAuth") return authenticate(body);
    if (action === "RespondToAuthChallenge") return respondToChallenge(body);

    if (action === "GetUser" || action === "ChangePassword" || action === "GlobalSignOut") {
      const { user, session } = await verifyToken(store, baseUrl, required(body.AccessToken, "AccessToken"), "access");
      if (!session.scope.split(" ").includes("aws.cognito.signin.user.admin"))
        fail("NotAuthorizedException", "Access token does not have the required scope.");
      if (action === "GetUser") return { Username: user.username, UserAttributes: userAttributes(user) };
      if (action === "ChangePassword") {
        if (!matchesPassword(str(body.PreviousPassword), user.password_hash))
          fail("NotAuthorizedException", "Incorrect username or password.");
        cs().users.update(user.id, {
          password_hash: passwordHash(required(body.ProposedPassword, "ProposedPassword")),
        });
      } else revokeSessions(store, user);
      return {};
    }

    const client = getClient(store, required(body.ClientId, "ClientId"));
    if (action === "RevokeToken") {
      if (client.client_secret && body.ClientSecret !== client.client_secret)
        fail("NotAuthorizedException", "Invalid client secret.");
      const session = refreshSession(store, client, required(body.Token, "Token"));
      cs().sessions.delete(session.id);
      return {};
    }
    const username = required(body.Username, "Username");
    checkSecretHash(client, username, body.SecretHash);
    if (action === "SignUp") {
      if (findUser(store, client.pool_id, username)) fail("UsernameExistsException", "User already exists.");
      const attrs = attributes(body.UserAttributes);
      const user = cs().users.insert({
        pool_id: client.pool_id,
        username,
        sub: randomUUID(),
        password_hash: passwordHash(required(body.Password, "Password")),
        attributes: { ...attrs, ...(attrs.email ? { email_verified: "false" } : {}) },
        status: "UNCONFIRMED",
        enabled: true,
      });
      return { UserConfirmed: false, UserSub: user.sub, ...setCode(store, user, "signup") };
    }
    const user = getUser(store, client.pool_id, username);
    switch (action) {
      case "ConfirmSignUp":
        if (user.status !== "UNCONFIRMED") fail("NotAuthorizedException", "User is already confirmed.");
        checkCode(user, body.ConfirmationCode, "signup");
        confirm(user, true);
        return {};
      case "ResendConfirmationCode":
        if (user.status !== "UNCONFIRMED") fail("InvalidParameterException", "User is already confirmed.");
        return setCode(store, user, "signup");
      case "ForgotPassword":
        checkUser(user);
        return setCode(store, user, "reset");
      case "ConfirmForgotPassword":
        checkUser(user);
        checkCode(user, body.ConfirmationCode, "reset");
        cs().users.update(user.id, { ...clearCode, password_hash: passwordHash(required(body.Password, "Password")) });
        revokeSessions(store, user);
        return {};
      default:
        return fail("UnknownOperationException", `Operation ${action} is not simulated.`);
    }
  }

  async function respondToChallenge(body: Record<string, unknown>) {
    const client = getClient(store, required(body.ClientId, "ClientId"));
    if (body.ChallengeName !== "NEW_PASSWORD_REQUIRED")
      fail("InvalidParameterException", "Only NEW_PASSWORD_REQUIRED is simulated.");
    const challenge = cs().challenges.findOneBy("token", required(body.Session, "Session"));
    if (
      !challenge ||
      challenge.client_id !== client.client_id ||
      challenge.pool_id !== client.pool_id ||
      challenge.expires_at <= Date.now()
    )
      fail("NotAuthorizedException", "Invalid challenge session.");
    const response = object(body.ChallengeResponses);
    if (response.USERNAME !== challenge.username) fail("NotAuthorizedException", "Challenge username does not match.");
    checkSecretHash(client, challenge.username, response.SECRET_HASH);
    const user = getUser(store, client.pool_id, challenge.username);
    if (!user.enabled || user.status !== "FORCE_CHANGE_PASSWORD")
      fail("NotAuthorizedException", "Challenge is no longer valid.");
    const hash = passwordHash(required(response.NEW_PASSWORD, "NEW_PASSWORD"));
    cs().challenges.delete(challenge.id);
    const updated = cs().users.update(user.id, { password_hash: hash, status: "CONFIRMED" })!;
    return { AuthenticationResult: await issueTokens(store, baseUrl, client, updated) };
  }

  async function authenticate(body: Record<string, unknown>, admin = false) {
    const client = getClient(store, required(body.ClientId, "ClientId"));
    const params = object(body.AuthParameters);
    if (body.AuthFlow === "REFRESH_TOKEN_AUTH" || body.AuthFlow === "REFRESH_TOKEN") {
      const session = refreshSession(store, client, required(params.REFRESH_TOKEN, "REFRESH_TOKEN"));
      checkSecretHash(client, session.username, params.SECRET_HASH);
      return {
        AuthenticationResult: await issueTokens(
          store,
          baseUrl,
          client,
          getUser(store, client.pool_id, session.username),
          { session },
        ),
      };
    }
    if (body.AuthFlow !== "USER_PASSWORD_AUTH" && !(admin && body.AuthFlow === "ADMIN_USER_PASSWORD_AUTH")) {
      fail(
        "InvalidParameterException",
        "Supported flows are USER_PASSWORD_AUTH, ADMIN_USER_PASSWORD_AUTH, and REFRESH_TOKEN_AUTH. SRP and MFA are not simulated.",
      );
    }
    const username = required(params.USERNAME, "USERNAME");
    checkSecretHash(client, username, params.SECRET_HASH);
    const user = findUser(store, client.pool_id, username);
    if (!user || !user.enabled || !matchesPassword(str(params.PASSWORD), user.password_hash))
      fail("NotAuthorizedException", "Incorrect username or password.");
    if (user.status === "FORCE_CHANGE_PASSWORD") {
      const challenge = cs().challenges.insert({
        token: randomBytes(32).toString("base64url"),
        pool_id: client.pool_id,
        client_id: client.client_id,
        username,
        expires_at: Date.now() + 3 * 60_000,
      });
      return {
        ChallengeName: "NEW_PASSWORD_REQUIRED",
        Session: challenge.token,
        ChallengeParameters: {
          USER_ID_FOR_SRP: username,
          userAttributes: JSON.stringify(user.attributes),
          requiredAttributes: "[]",
        },
      };
    }
    return { AuthenticationResult: await issueTokens(store, baseUrl, client, user) };
  }
}
