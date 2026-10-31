import {
  createHmac,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { constantTimeSecretEqual, type Context, type Store } from "@emulators/core";
import { SignJWT, jwtVerify } from "jose";
import { getCognitoStore, type CognitoClient, type CognitoSession, type CognitoUser } from "./store.js";

export const DEFAULT_USER_POOL = "us-east-1_emulate";
export const DEFAULT_CLIENT = "emulateclient";
export const DEFAULT_IDENTITY_POOL = "us-east-1:00000000-0000-4000-8000-000000000001";

export class CognitoError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export function fail(code: string, message: string): never {
  throw new CognitoError(code, message);
}
export function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("InvalidParameterException", "Expected an object.");
  return value as Record<string, unknown>;
}
export function required(value: unknown, name: string): string {
  const result = str(value);
  if (!result) fail("InvalidParameterException", `${name} is required.`);
  return result;
}
export function attributes(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!Array.isArray(value)) fail("InvalidParameterException", "Attributes must be an array.");
  return Object.fromEntries(
    value.map((item) => {
      const attribute = object(item);
      const name = required(attribute.Name, "Attribute name");
      if (name === "sub") fail("InvalidParameterException", "sub is read-only.");
      if (typeof attribute.Value !== "string") fail("InvalidParameterException", "Attribute values must be strings.");
      return [name, attribute.Value];
    }),
  );
}
export function userAttributes(user: CognitoUser) {
  return Object.entries({ ...user.attributes, sub: user.sub }).map(([Name, Value]) => ({ Name, Value }));
}
export function userResponse(user: CognitoUser) {
  return {
    Username: user.username,
    Attributes: userAttributes(user),
    UserStatus: user.status,
    Enabled: user.enabled,
    UserCreateDate: Date.parse(user.created_at) / 1000,
    UserLastModifiedDate: Date.parse(user.updated_at) / 1000,
  };
}
export function passwordHash(password: string): string {
  if (password.length < 8) fail("InvalidPasswordException", "Password must contain at least 8 characters.");
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 32).toString("hex")}`;
}
export function matchesPassword(password: string, hash: string): boolean {
  const [salt, digest] = hash.split(":");
  if (!salt || !digest || !password) return false;
  const expected = Buffer.from(digest, "hex");
  const actual = scryptSync(password, salt, 32);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
export function findUser(store: Store, poolId: string, username: string) {
  return getCognitoStore(store)
    .users.findBy("pool_id", poolId)
    .find((user) => user.username === username);
}
export function getUser(store: Store, poolId: string, username: string) {
  return findUser(store, poolId, username) ?? fail("UserNotFoundException", "User does not exist.");
}
export function getPool(store: Store, poolId: string) {
  return (
    getCognitoStore(store).pools.findOneBy("pool_id", poolId) ??
    fail("ResourceNotFoundException", "User pool does not exist.")
  );
}
export function getClient(store: Store, clientId: string) {
  return (
    getCognitoStore(store).clients.findOneBy("client_id", clientId) ??
    fail("ResourceNotFoundException", "App client does not exist.")
  );
}
export function checkSecretHash(client: CognitoClient, username: string, provided: unknown) {
  if (!client.client_secret) return;
  const expected = createHmac("sha256", client.client_secret)
    .update(username + client.client_id)
    .digest("base64");
  if (!constantTimeSecretEqual(str(provided), expected))
    fail("NotAuthorizedException", "Unable to verify secret hash for client.");
}
export function checkUser(user: CognitoUser) {
  if (!user.enabled) fail("NotAuthorizedException", "User is disabled.");
  if (user.status !== "CONFIRMED") fail("UserNotConfirmedException", "User is not confirmed.");
}
export function revokeSessions(store: Store, user: CognitoUser) {
  const cs = getCognitoStore(store);
  for (const collection of [cs.sessions, cs.challenges, cs.codes]) {
    for (const record of collection.all()) {
      if (record.pool_id === user.pool_id && record.username === user.username) collection.delete(record.id);
    }
  }
}
export function setCode(store: Store, user: CognitoUser, kind: "signup" | "reset") {
  getCognitoStore(store).users.update(user.id, {
    confirmation_code: getPool(store, user.pool_id).confirmation_code,
    code_expires_at: Date.now() + 10 * 60_000,
    code_kind: kind,
  });
  return {
    CodeDeliveryDetails: {
      DeliveryMedium: "EMAIL",
      AttributeName: "email",
      Destination: user.attributes.email ?? user.username,
    },
  };
}
export function checkCode(user: CognitoUser, code: unknown, kind: "signup" | "reset") {
  if (
    !user.confirmation_code ||
    user.code_kind !== kind ||
    !user.code_expires_at ||
    user.code_expires_at <= Date.now()
  ) {
    fail("ExpiredCodeException", "Confirmation code has expired.");
  }
  if (!constantTimeSecretEqual(str(code), user.confirmation_code))
    fail("CodeMismatchException", "Invalid verification code.");
}

export function issuer(baseUrl: string, poolId: string) {
  return `${baseUrl}/cognito-idp/${poolId}`;
}
type SigningKey = { private_key: string; kid: string; jwk: Record<string, unknown> };
export function signingKey(store: Store, poolId: string): SigningKey {
  const name = `aws.cognito.signing.${poolId}`;
  let key = store.getData<SigningKey>(name);
  if (!key) {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const kid = randomUUID();
    key = {
      private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      kid,
      jwk: { ...publicKey.export({ format: "jwk" }), kid, use: "sig", alg: "RS256" },
    };
    store.setData(name, key);
  }
  return key;
}

export async function issueTokens(
  store: Store,
  baseUrl: string,
  client: CognitoClient,
  user: CognitoUser,
  options: { session?: CognitoSession; scope?: string; nonce?: string } = {},
) {
  checkUser(user);
  const cs = getCognitoStore(store);
  const session =
    options.session ??
    cs.sessions.insert({
      session_id: randomUUID(),
      refresh_token: randomBytes(48).toString("base64url"),
      pool_id: user.pool_id,
      client_id: client.client_id,
      username: user.username,
      scope: options.scope ?? "aws.cognito.signin.user.admin",
      auth_time: Math.floor(Date.now() / 1000),
      expires_at: Date.now() + 30 * 86400_000,
    });
  const key = signingKey(store, user.pool_id);
  const privateKey = createPrivateKey(key.private_key);
  const common = { auth_time: session.auth_time, origin_jti: session.session_id };
  const sign = (claims: Record<string, unknown>) =>
    new SignJWT({ ...common, ...claims })
      .setProtectedHeader({ alg: "RS256", kid: key.kid })
      .setIssuer(issuer(baseUrl, user.pool_id))
      .setSubject(user.sub)
      .setIssuedAt()
      .setExpirationTime("1h")
      .setJti(randomUUID())
      .sign(privateKey);
  const allowed = new Set([
    "email",
    "email_verified",
    "name",
    "given_name",
    "family_name",
    "picture",
    "phone_number",
    "phone_number_verified",
    "preferred_username",
  ]);
  const claims = Object.fromEntries(
    Object.entries(user.attributes)
      .filter(([name]) => allowed.has(name) || name.startsWith("custom:"))
      .map(([name, value]) => [name, name.endsWith("_verified") ? value === "true" : value]),
  );
  return {
    AccessToken: await sign({
      token_use: "access",
      client_id: client.client_id,
      username: user.username,
      scope: session.scope,
    }),
    IdToken: await sign({
      ...claims,
      token_use: "id",
      aud: client.client_id,
      "cognito:username": user.username,
      ...(options.nonce ? { nonce: options.nonce } : {}),
    }),
    ...(!options.session ? { RefreshToken: session.refresh_token } : {}),
    ExpiresIn: 3600,
    TokenType: "Bearer",
  };
}
export function refreshSession(store: Store, client: CognitoClient, token: string) {
  const session = getCognitoStore(store).sessions.findOneBy("refresh_token", token);
  if (
    !session ||
    session.client_id !== client.client_id ||
    session.pool_id !== client.pool_id ||
    session.expires_at <= Date.now()
  ) {
    fail("NotAuthorizedException", "Invalid refresh token.");
  }
  checkUser(getUser(store, session.pool_id, session.username));
  return session;
}
export async function verifyToken(store: Store, baseUrl: string, token: string, use: "access" | "id", poolId?: string) {
  const cs = getCognitoStore(store);
  for (const pool of poolId ? [getPool(store, poolId)] : cs.pools.all()) {
    try {
      const key = signingKey(store, pool.pool_id);
      const { payload } = await jwtVerify(token, createPublicKey(key.private_key), {
        algorithms: ["RS256"],
        issuer: issuer(baseUrl, pool.pool_id),
      });
      if (payload.token_use !== use) continue;
      const session = cs.sessions.findOneBy("session_id", str(payload.origin_jti));
      if (!session || session.pool_id !== pool.pool_id || session.expires_at <= Date.now()) continue;
      if ((use === "id" ? payload.aud : payload.client_id) !== session.client_id) continue;
      const user = getUser(store, pool.pool_id, session.username);
      if (user.sub !== payload.sub) continue;
      checkUser(user);
      return { user, session, payload };
    } catch {
      /* Try the next pool's signing key. */
    }
  }
  return fail("NotAuthorizedException", "Invalid or expired token.");
}
export function jsonResponse(c: Context, data: unknown, status: 200 | 400 = 200) {
  c.header("Content-Type", "application/x-amz-json-1.1");
  c.header("x-amzn-requestid", randomUUID());
  return c.json(data, status);
}
export function errorResponse(c: Context, error: unknown) {
  if (!(error instanceof CognitoError)) throw error;
  c.header("x-amzn-errortype", error.code);
  return jsonResponse(c, { __type: error.code, message: error.message }, 400);
}
