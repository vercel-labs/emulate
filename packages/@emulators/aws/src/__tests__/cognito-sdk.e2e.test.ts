import { createHash, createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { serve } from "@emulators/core";
import { createRemoteJWKSet, jwtVerify } from "jose";
import * as idp from "@aws-sdk/client-cognito-identity-provider";
import * as identity from "@aws-sdk/client-cognito-identity";
import { getCognitoStore, seedFromConfig } from "../index.js";
import {
  DEFAULT_CLIENT as ClientId,
  DEFAULT_USER_POOL as UserPoolId,
  DEFAULT_IDENTITY_POOL as IdentityPoolId,
} from "../cognito/helpers.js";
import { createTestApp } from "./helpers.js";

const password = "LocalPass123!";
const callback = "http://localhost:3000/callback";
const provider = `cognito-idp.us-east-1.amazonaws.com/${UserPoolId}`;
let active: ReturnType<typeof createTestApp>;
let base: string;
let sdk: idp.CognitoIdentityProviderClient;
let identities: identity.CognitoIdentityClient;
let close: () => Promise<void>;

beforeAll(async () => {
  const server = serve({ fetch: (request) => active.app.fetch(request), port: 0 });
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});
beforeEach(() => {
  active = createTestApp(base);
  seedFromConfig(active.store, base, {
    cognito: {
      user_pools: [
        {
          id: UserPoolId,
          clients: [
            { client_id: "other-client", redirect_uris: [callback] },
            { client_id: "private-client", client_secret: "client-secret", redirect_uris: [callback] },
          ],
          users: [
            {
              username: "alice",
              password,
              attributes: { email: "alice@example.com", email_verified: "true", name: "Alice" },
            },
            { username: "bob", password },
          ],
        },
      ],
    },
  });
  const config = {
    region: "us-east-1",
    credentials: { accessKeyId: "local-access-key", secretAccessKey: "local-secret" },
    maxAttempts: 1,
  };
  sdk = new idp.CognitoIdentityProviderClient({ ...config, endpoint: `${base}/cognito-idp` });
  identities = new identity.CognitoIdentityClient({ ...config, endpoint: `${base}/cognito-identity` });
});
afterEach(() => {
  sdk.destroy();
  identities.destroy();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
afterAll(async () => {
  await close();
});

async function authenticate(username = "alice", clientId = ClientId, parameters: Record<string, string> = {}) {
  const result = await sdk.send(
    new idp.InitiateAuthCommand({
      ClientId: clientId,
      AuthFlow: "USER_PASSWORD_AUTH",
      AuthParameters: { USERNAME: username, PASSWORD: password, ...parameters },
    }),
  );
  return result.AuthenticationResult!;
}
function form(path: string, fields: Record<string, string>) {
  return active.app.request(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
}
async function codeGrant(fields: Record<string, string> = {}) {
  const response = await form(`/cognito-idp/${UserPoolId}/oauth2/authorize`, {
    client_id: ClientId,
    response_type: "code",
    redirect_uri: callback,
    scope: "openid email profile",
    username: "alice",
    ...fields,
  });
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get("Location")!);
  if (fields.state) expect(location.searchParams.get("state")).toBe(fields.state);
  return location.searchParams.get("code")!;
}

describe("Cognito User Pools with the official AWS SDK", () => {
  it("confirms sign-up, signs tokens, and publishes verifiable discovery and JWKS", async () => {
    const signup = await sdk.send(
      new idp.SignUpCommand({
        ClientId,
        Username: "new-user",
        Password: password,
        UserAttributes: [{ Name: "email", Value: "new@example.com" }],
      }),
    );
    expect(signup).toMatchObject({
      UserConfirmed: false,
      UserSub: expect.any(String),
      $metadata: { httpStatusCode: 200, requestId: expect.any(String) },
    });
    await expect(authenticate("new-user")).rejects.toMatchObject({ name: "UserNotConfirmedException" });
    await expect(
      sdk.send(new idp.ConfirmSignUpCommand({ ClientId, Username: "new-user", ConfirmationCode: "000000" })),
    ).rejects.toMatchObject({ name: "CodeMismatchException" });
    await sdk.send(new idp.ConfirmSignUpCommand({ ClientId, Username: "new-user", ConfirmationCode: "123456" }));
    const tokens = await authenticate("new-user");
    const issuer = `${base}/cognito-idp/${UserPoolId}`;
    const discovery = (await (await fetch(`${issuer}/.well-known/openid-configuration`)).json()) as {
      jwks_uri: string;
    };
    expect(discovery).toMatchObject({
      issuer,
      jwks_uri: `${issuer}/.well-known/jwks.json`,
      authorization_endpoint: `${issuer}/oauth2/authorize`,
    });
    const jwks = createRemoteJWKSet(new URL(discovery.jwks_uri));
    const verified = await jwtVerify(tokens.IdToken!, jwks, { issuer, audience: ClientId });
    expect(verified.payload).toMatchObject({
      sub: signup.UserSub,
      token_use: "id",
      email_verified: true,
      "cognito:username": "new-user",
    });
    const access = await jwtVerify(tokens.AccessToken!, jwks, { issuer });
    expect(access.payload).toMatchObject({ sub: signup.UserSub, token_use: "access", client_id: ClientId });
    expect(await sdk.send(new idp.GetUserCommand({ AccessToken: tokens.AccessToken }))).toMatchObject({
      Username: "new-user",
      UserAttributes: expect.arrayContaining([{ Name: "sub", Value: signup.UserSub }]),
    });
    const response = await active.app.request(`${base}/cognito-idp`, {
      method: "POST",
      headers: { "X-Amz-Target": "AWSCognitoIdentityProviderService.GetUser" },
      body: JSON.stringify({ AccessToken: tokens.AccessToken }),
    });
    expect(response.headers.get("Content-Type")).toBe("application/x-amz-json-1.1");
  });

  it("rejects duplicates, incorrect passwords, ID tokens, and tampered access tokens", async () => {
    await expect(
      sdk.send(new idp.SignUpCommand({ ClientId, Username: "alice", Password: password })),
    ).rejects.toMatchObject({ name: "UsernameExistsException" });
    await expect(authenticate("alice", ClientId, { PASSWORD: "wrong-password" })).rejects.toMatchObject({
      name: "NotAuthorizedException",
    });
    const tokens = await authenticate();
    const [header, body, signature] = tokens.AccessToken!.split(".");
    const forged = `${header}.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), sub: "forged-user" })).toString("base64url")}.${signature}`;
    for (const token of ["unknown", tokens.IdToken, tokens.RefreshToken, forged]) {
      await expect(sdk.send(new idp.GetUserCommand({ AccessToken: token }))).rejects.toMatchObject({
        name: "NotAuthorizedException",
      });
    }
  });

  it("enforces client secret hashes for authentication and refresh", async () => {
    await expect(authenticate("alice", "private-client")).rejects.toMatchObject({ name: "NotAuthorizedException" });
    const hash = createHmac("sha256", "client-secret").update("aliceprivate-client").digest("base64");
    const tokens = await authenticate("alice", "private-client", { SECRET_HASH: hash });
    await expect(
      sdk.send(
        new idp.InitiateAuthCommand({
          ClientId: "other-client",
          AuthFlow: "REFRESH_TOKEN_AUTH",
          AuthParameters: { REFRESH_TOKEN: tokens.RefreshToken! },
        }),
      ),
    ).rejects.toMatchObject({ name: "NotAuthorizedException" });
    const refreshed = await sdk.send(
      new idp.InitiateAuthCommand({
        ClientId: "private-client",
        AuthFlow: "REFRESH_TOKEN_AUTH",
        AuthParameters: { REFRESH_TOKEN: tokens.RefreshToken!, SECRET_HASH: hash },
      }),
    );
    expect(refreshed.AuthenticationResult).toMatchObject({
      AccessToken: expect.any(String),
      IdToken: expect.any(String),
    });
    expect(refreshed.AuthenticationResult).not.toHaveProperty("RefreshToken");
  });

  it("completes an admin-created user's new-password challenge exactly once", async () => {
    const created = await sdk.send(
      new idp.AdminCreateUserCommand({
        UserPoolId,
        Username: "invited",
        TemporaryPassword: password,
        MessageAction: "SUPPRESS",
      }),
    );
    expect(created.User).toMatchObject({
      Username: "invited",
      UserStatus: "FORCE_CHANGE_PASSWORD",
      UserCreateDate: expect.any(Date),
    });
    const challenge = await sdk.send(
      new idp.AdminInitiateAuthCommand({
        UserPoolId,
        ClientId,
        AuthFlow: "ADMIN_USER_PASSWORD_AUTH",
        AuthParameters: { USERNAME: "invited", PASSWORD: password },
      }),
    );
    expect(challenge.ChallengeName).toBe("NEW_PASSWORD_REQUIRED");
    const input = {
      UserPoolId,
      ClientId,
      ChallengeName: "NEW_PASSWORD_REQUIRED" as const,
      Session: challenge.Session,
      ChallengeResponses: { USERNAME: "invited", NEW_PASSWORD: "NewPassword123!" },
    };
    await expect(
      sdk.send(new idp.RespondToAuthChallengeCommand({ ...input, ClientId: "other-client" })),
    ).rejects.toMatchObject({ name: "NotAuthorizedException" });
    const result = await sdk.send(new idp.AdminRespondToAuthChallengeCommand(input));
    expect(result.AuthenticationResult?.AccessToken).toBeTruthy();
    await expect(sdk.send(new idp.RespondToAuthChallengeCommand(input))).rejects.toMatchObject({
      name: "NotAuthorizedException",
    });
    await expect(authenticate("invited")).rejects.toMatchObject({ name: "NotAuthorizedException" });
    expect(await authenticate("invited", ClientId, { PASSWORD: "NewPassword123!" })).toHaveProperty("IdToken");
  });

  it("supports password reset and invalidates old sessions", async () => {
    const tokens = await authenticate();
    await sdk.send(new idp.ForgotPasswordCommand({ ClientId, Username: "alice" }));
    await expect(
      sdk.send(
        new idp.ConfirmForgotPasswordCommand({
          ClientId,
          Username: "alice",
          ConfirmationCode: "wrong",
          Password: "NewPassword123!",
        }),
      ),
    ).rejects.toMatchObject({ name: "CodeMismatchException" });
    await sdk.send(
      new idp.ConfirmForgotPasswordCommand({
        ClientId,
        Username: "alice",
        ConfirmationCode: "123456",
        Password: "NewPassword123!",
      }),
    );
    await expect(sdk.send(new idp.GetUserCommand({ AccessToken: tokens.AccessToken }))).rejects.toMatchObject({
      name: "NotAuthorizedException",
    });
    await expect(authenticate()).rejects.toMatchObject({ name: "NotAuthorizedException" });
    expect(await authenticate("alice", ClientId, { PASSWORD: "NewPassword123!" })).toHaveProperty("AccessToken");
    await expect(
      sdk.send(
        new idp.ConfirmForgotPasswordCommand({
          ClientId,
          Username: "alice",
          ConfirmationCode: "123456",
          Password: "OtherPassword123!",
        }),
      ),
    ).rejects.toMatchObject({ name: "ExpiredCodeException" });
  });

  it("expires confirmation codes and access and refresh tokens", async () => {
    const tokens = await authenticate();
    await sdk.send(new idp.SignUpCommand({ ClientId, Username: "pending", Password: password }));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 3601_000);
    await expect(
      sdk.send(new idp.ConfirmSignUpCommand({ ClientId, Username: "pending", ConfirmationCode: "123456" })),
    ).rejects.toMatchObject({ name: "ExpiredCodeException" });
    await expect(sdk.send(new idp.GetUserCommand({ AccessToken: tokens.AccessToken }))).rejects.toMatchObject({
      name: "NotAuthorizedException",
    });
    vi.setSystemTime(Date.now() + 31 * 86400_000);
    await expect(
      sdk.send(
        new idp.InitiateAuthCommand({
          ClientId,
          AuthFlow: "REFRESH_TOKEN_AUTH",
          AuthParameters: { REFRESH_TOKEN: tokens.RefreshToken! },
        }),
      ),
    ).rejects.toMatchObject({ name: "NotAuthorizedException" });
  });

  it("changes passwords, sets permanent admin passwords, and signs users out", async () => {
    await sdk.send(
      new idp.AdminSetUserPasswordCommand({
        UserPoolId,
        Username: "alice",
        Password: "AdminPassword123!",
        Permanent: true,
      }),
    );
    const tokens = await authenticate("alice", ClientId, { PASSWORD: "AdminPassword123!" });
    await expect(
      sdk.send(
        new idp.ChangePasswordCommand({
          AccessToken: tokens.AccessToken,
          PreviousPassword: password,
          ProposedPassword: "ChangedPassword123!",
        }),
      ),
    ).rejects.toMatchObject({ name: "NotAuthorizedException" });
    await sdk.send(
      new idp.ChangePasswordCommand({
        AccessToken: tokens.AccessToken,
        PreviousPassword: "AdminPassword123!",
        ProposedPassword: "ChangedPassword123!",
      }),
    );
    await expect(authenticate("alice", ClientId, { PASSWORD: "AdminPassword123!" })).rejects.toMatchObject({
      name: "NotAuthorizedException",
    });
    const changed = await authenticate("alice", ClientId, { PASSWORD: "ChangedPassword123!" });
    await sdk.send(new idp.GlobalSignOutCommand({ AccessToken: changed.AccessToken }));
    for (const token of [tokens.AccessToken, changed.AccessToken])
      await expect(sdk.send(new idp.GetUserCommand({ AccessToken: token }))).rejects.toMatchObject({
        name: "NotAuthorizedException",
      });
    await expect(
      sdk.send(
        new idp.InitiateAuthCommand({
          ClientId,
          AuthFlow: "REFRESH_TOKEN_AUTH",
          AuthParameters: { REFRESH_TOKEN: changed.RefreshToken! },
        }),
      ),
    ).rejects.toMatchObject({ name: "NotAuthorizedException" });
  });

  it("resends local codes and keeps invalid sign-ups out of the store", async () => {
    await expect(
      sdk.send(new idp.SignUpCommand({ ClientId, Username: "invalid", Password: "short" })),
    ).rejects.toMatchObject({ name: "InvalidPasswordException" });
    expect(getCognitoStore(active.store).users.all()).toHaveLength(2);
    await sdk.send(new idp.SignUpCommand({ ClientId, Username: "pending", Password: password }));
    const user = getCognitoStore(active.store).users.findOneBy("username", "pending")!;
    getCognitoStore(active.store).users.update(user.id, { code_expires_at: Date.now() - 1 });
    await sdk.send(new idp.ResendConfirmationCodeCommand({ ClientId, Username: "pending" }));
    const inspector = await (await active.app.request(`${base}/_inspector?tab=cognito`)).text();
    expect(inspector).toContain("123456");
    expect(inspector).not.toContain(password);
    await sdk.send(new idp.AdminConfirmSignUpCommand({ UserPoolId, Username: "pending" }));
    expect(await authenticate("pending")).toHaveProperty("AccessToken");
    await expect(
      sdk.send(new idp.ConfirmSignUpCommand({ ClientId, Username: "pending", ConfirmationCode: "123456" })),
    ).rejects.toMatchObject({ name: "NotAuthorizedException" });
  });

  it("isolates pools, paginates users, and revokes disabled and deleted users", async () => {
    seedFromConfig(active.store, base, {
      cognito: {
        user_pools: [
          {
            id: "us-east-1_other",
            clients: [{ client_id: "isolated-client" }],
            users: [{ username: "alice", password: "DifferentPassword!" }],
          },
        ],
      },
    });
    await expect(authenticate("alice", "isolated-client")).rejects.toMatchObject({ name: "NotAuthorizedException" });
    await expect(
      sdk.send(
        new idp.AdminInitiateAuthCommand({
          UserPoolId: "us-east-1_other",
          ClientId,
          AuthFlow: "ADMIN_USER_PASSWORD_AUTH",
          AuthParameters: { USERNAME: "alice", PASSWORD: password },
        }),
      ),
    ).rejects.toMatchObject({ name: "ResourceNotFoundException" });
    const first = await sdk.send(new idp.ListUsersCommand({ UserPoolId, Limit: 1 }));
    expect(first.Users).toHaveLength(1);
    expect(
      (await sdk.send(new idp.ListUsersCommand({ UserPoolId, PaginationToken: first.PaginationToken }))).Users?.[0]
        .Username,
    ).toBe("bob");
    const tokens = await authenticate();
    await sdk.send(new idp.AdminDisableUserCommand({ UserPoolId, Username: "alice" }));
    await expect(authenticate()).rejects.toMatchObject({ name: "NotAuthorizedException" });
    await sdk.send(new idp.AdminEnableUserCommand({ UserPoolId, Username: "alice" }));
    await expect(sdk.send(new idp.GetUserCommand({ AccessToken: tokens.AccessToken }))).rejects.toMatchObject({
      name: "NotAuthorizedException",
    });
    await sdk.send(new idp.AdminDeleteUserCommand({ UserPoolId, Username: "alice" }));
    await expect(sdk.send(new idp.AdminGetUserCommand({ UserPoolId, Username: "alice" }))).rejects.toMatchObject({
      name: "UserNotFoundException",
    });
  });

  it("preserves signing keys and sessions through snapshots and clears them on reset", async () => {
    const tokens = await authenticate();
    const snapshot = JSON.parse(JSON.stringify(active.store.snapshot()));
    expect(JSON.stringify(snapshot)).not.toContain(password);
    active = createTestApp(base);
    active.store.restore(snapshot);
    expect(await sdk.send(new idp.GetUserCommand({ AccessToken: tokens.AccessToken }))).toMatchObject({
      Username: "alice",
    });
    const refreshed = await sdk.send(
      new idp.InitiateAuthCommand({
        ClientId,
        AuthFlow: "REFRESH_TOKEN_AUTH",
        AuthParameters: { REFRESH_TOKEN: tokens.RefreshToken! },
      }),
    );
    expect(refreshed.AuthenticationResult?.AccessToken).toBeTruthy();
    active.store.reset();
    await expect(sdk.send(new idp.GetUserCommand({ AccessToken: tokens.AccessToken }))).rejects.toMatchObject({
      name: "NotAuthorizedException",
    });
  });

  it("returns explicit errors for malformed JSON and unsupported SRP flows", async () => {
    const response = await active.app.request(`${base}/cognito-idp`, {
      method: "POST",
      headers: { "X-Amz-Target": "AWSCognitoIdentityProviderService.SignUp" },
      body: "{",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ __type: "SerializationException" });
    await expect(
      sdk.send(
        new idp.InitiateAuthCommand({
          ClientId,
          AuthFlow: "USER_SRP_AUTH",
          AuthParameters: { USERNAME: "alice", SRP_A: "123" },
        }),
      ),
    ).rejects.toMatchObject({ name: "InvalidParameterException", message: expect.stringContaining("SRP") });
  });
});

describe("Cognito OAuth authorization code flow", () => {
  const path = `/cognito-idp/${UserPoolId}/oauth2/token`;
  it("renders a shared user picker and exchanges a PKCE-bound code with state and nonce", async () => {
    const authorize = `/cognito-idp/${UserPoolId}/oauth2/authorize?${new URLSearchParams({ client_id: ClientId, redirect_uri: callback, response_type: "code" })}`;
    const page = await active.app.request(`${base}${authorize}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Choose a local test user");
    const verifier = "v".repeat(43);
    const code = await codeGrant({
      state: "state-value",
      nonce: "nonce-value",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    });
    const fields = { grant_type: "authorization_code", client_id: ClientId, redirect_uri: callback, code };
    expect((await form(path, fields)).status).toBe(400);
    expect((await form(path, { ...fields, client_id: "other-client", code_verifier: verifier })).status).toBe(400);
    expect(
      (await form(path, { ...fields, redirect_uri: "http://localhost:3000/other", code_verifier: verifier })).status,
    ).toBe(400);
    const exchanged = await form(path, { ...fields, code_verifier: verifier });
    expect(exchanged.status).toBe(200);
    expect(exchanged.headers.get("Cache-Control")).toBe("no-store");
    const tokens = (await exchanged.json()) as { access_token: string; id_token: string; refresh_token: string };
    const jwks = createRemoteJWKSet(new URL(`${base}/cognito-idp/${UserPoolId}/.well-known/jwks.json`));
    expect(
      (await jwtVerify(tokens.id_token, jwks, { issuer: `${base}/cognito-idp/${UserPoolId}`, audience: ClientId }))
        .payload,
    ).toMatchObject({ nonce: "nonce-value" });
    expect((await form(path, { ...fields, code_verifier: verifier })).status).toBe(400);
    const info = await active.app.request(`${base}/cognito-idp/${UserPoolId}/oauth2/userInfo`, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    expect(await info.json()).toMatchObject({ username: "alice", email: "alice@example.com", name: "Alice" });
    expect(
      (await form(path, { grant_type: "refresh_token", client_id: ClientId, refresh_token: tokens.refresh_token }))
        .status,
    ).toBe(200);
    await sdk.send(new idp.RevokeTokenCommand({ ClientId, Token: tokens.refresh_token }));
    expect(
      (await form(path, { grant_type: "refresh_token", client_id: ClientId, refresh_token: tokens.refresh_token }))
        .status,
    ).toBe(400);
  });

  it("validates redirects and confidential clients before issuing tokens", async () => {
    const invalid = await form(`/cognito-idp/${UserPoolId}/oauth2/authorize`, {
      client_id: ClientId,
      response_type: "code",
      redirect_uri: "https://attacker.example/callback",
      username: "alice",
    });
    expect(invalid.status).toBe(400);
    expect(invalid.headers.get("Location")).toBeNull();
    const code = await codeGrant({ client_id: "private-client" });
    const fields = { grant_type: "authorization_code", client_id: "private-client", redirect_uri: callback, code };
    expect((await form(path, fields)).status).toBe(401);
    expect((await form(path, { ...fields, client_secret: "client-secret" })).status).toBe(200);

    const basicCode = await codeGrant({ client_id: "private-client" });
    const basic = await active.app.request(`${base}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from("private-client:client-secret").toString("base64")}`,
      },
      body: new URLSearchParams({ grant_type: "authorization_code", redirect_uri: callback, code: basicCode }),
    });
    expect(basic.status).toBe(200);
  });

  it("expires authorization codes and prevents profile claims without granted scopes", async () => {
    const code = await codeGrant({ scope: "openid" });
    const response = await form(path, {
      grant_type: "authorization_code",
      client_id: ClientId,
      redirect_uri: callback,
      code,
    });
    const tokens = (await response.json()) as { access_token: string };
    const info = await active.app.request(`${base}/cognito-idp/${UserPoolId}/oauth2/userInfo`, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    expect(await info.json()).not.toHaveProperty("email");
    const expired = await codeGrant();
    const record = getCognitoStore(active.store).codes.findOneBy("token", expired)!;
    getCognitoStore(active.store).codes.update(record.id, { expires_at: Date.now() - 1 });
    expect(
      (
        await form(path, {
          grant_type: "authorization_code",
          client_id: ClientId,
          redirect_uri: callback,
          code: expired,
        })
      ).status,
    ).toBe(400);
  });
});

describe("Cognito Identity Pools with the official AWS SDK", () => {
  it("keeps identities stable and issues temporary credentials only for the matching login", async () => {
    const alice = await authenticate();
    const Logins = { [provider]: alice.IdToken! };
    const result = await identities.send(new identity.GetIdCommand({ IdentityPoolId, Logins }));
    expect(result.IdentityId).toMatch(/^us-east-1:[0-9a-f-]{36}$/);
    expect(await identities.send(new identity.GetIdCommand({ IdentityPoolId, Logins }))).toMatchObject({
      IdentityId: result.IdentityId,
    });
    const credentials = await identities.send(
      new identity.GetCredentialsForIdentityCommand({ IdentityId: result.IdentityId, Logins }),
    );
    expect(credentials.Credentials).toMatchObject({
      AccessKeyId: expect.stringMatching(/^ASIA/),
      SecretKey: expect.any(String),
      SessionToken: expect.any(String),
      Expiration: expect.any(Date),
    });
    const bob = await authenticate("bob");
    await expect(
      identities.send(
        new identity.GetCredentialsForIdentityCommand({
          IdentityId: result.IdentityId,
          Logins: { [provider]: bob.IdToken! },
        }),
      ),
    ).rejects.toMatchObject({ name: "NotAuthorizedException" });
    for (const invalid of [alice.AccessToken!, "forged-token"]) {
      await expect(
        identities.send(new identity.GetIdCommand({ IdentityPoolId, Logins: { [provider]: invalid } })),
      ).rejects.toMatchObject({ name: "NotAuthorizedException" });
    }
    const wrongClient = await authenticate("alice", "other-client");
    await expect(
      identities.send(new identity.GetIdCommand({ IdentityPoolId, Logins: { [provider]: wrongClient.IdToken! } })),
    ).rejects.toMatchObject({ name: "NotAuthorizedException" });
  });

  it("permits anonymous identities only for explicitly configured pools", async () => {
    await expect(identities.send(new identity.GetIdCommand({ IdentityPoolId }))).rejects.toMatchObject({
      name: "NotAuthorizedException",
    });
    const poolId = "us-east-1:00000000-0000-4000-8000-000000000002";
    seedFromConfig(active.store, base, {
      cognito: { identity_pools: [{ id: poolId, allow_unauthenticated_identities: true }] },
    });
    const anonymous = await identities.send(new identity.GetIdCommand({ IdentityPoolId: poolId }));
    expect(
      (await identities.send(new identity.GetCredentialsForIdentityCommand({ IdentityId: anonymous.IdentityId })))
        .Credentials?.AccessKeyId,
    ).toMatch(/^ASIA/);
    expect(getCognitoStore(active.store).identities.all()).toHaveLength(1);
  });
});
