import { randomBytes, randomUUID } from "node:crypto";
import type { RouteContext } from "@emulators/core";
import { getCognitoStore, type CognitoIdentityPool } from "../cognito/store.js";
import {
  CognitoError,
  errorResponse,
  fail,
  jsonResponse,
  object,
  required,
  str,
  verifyToken,
} from "../cognito/helpers.js";

export function cognitoIdentityRoutes({ app, store, baseUrl }: RouteContext) {
  const cs = () => getCognitoStore(store);
  async function principal(pool: CognitoIdentityPool, logins: unknown) {
    const entries = Object.entries(logins === undefined ? {} : object(logins));
    if (entries.length === 0) {
      if (!pool.allow_unauthenticated_identities)
        fail("NotAuthorizedException", "Unauthenticated access is not supported for this identity pool.");
      return undefined;
    }
    if (entries.length !== 1) fail("InvalidParameterException", "Only one Cognito User Pool login is simulated.");
    const [provider, token] = entries[0];
    const configured = pool.providers.filter(
      (item) => provider === `cognito-idp.${item.user_pool_id.split("_")[0]}.amazonaws.com/${item.user_pool_id}`,
    );
    if (configured.length === 0)
      fail("NotAuthorizedException", "Login provider is not configured for this identity pool.");
    const { user, session } = await verifyToken(store, baseUrl, str(token), "id", configured[0].user_pool_id);
    if (!configured.some((item) => session.client_id === item.client_id))
      fail("NotAuthorizedException", "Token audience does not match the configured app client.");
    return `${provider}:${user.sub}`;
  }
  for (const path of ["/cognito-identity", "/cognito-identity/"])
    app.post(path, async (c) => {
      try {
        const body = object(await c.req.json());
        const target = c.req.header("X-Amz-Target") ?? "";
        if (
          target !== "AWSCognitoIdentityService.GetId" &&
          target !== "AWSCognitoIdentityService.GetCredentialsForIdentity"
        ) {
          fail("UnknownOperationException", "Only GetId and GetCredentialsForIdentity are simulated.");
        }
        if (target.endsWith(".GetId")) {
          const pool = cs().identityPools.findOneBy("pool_id", required(body.IdentityPoolId, "IdentityPoolId"));
          if (!pool) fail("ResourceNotFoundException", "Identity pool does not exist.");
          const login = await principal(pool, body.Logins);
          const existing = login
            ? cs()
                .identities.findBy("pool_id", pool.pool_id)
                .find((identity) => identity.principal === login)
            : undefined;
          const identity =
            existing ??
            cs().identities.insert({
              pool_id: pool.pool_id,
              identity_id: `${pool.pool_id.split(":")[0]}:${randomUUID()}`,
              principal: login,
            });
          return jsonResponse(c, { IdentityId: identity.identity_id });
        }
        const identity = cs().identities.findOneBy("identity_id", required(body.IdentityId, "IdentityId"));
        if (!identity) fail("ResourceNotFoundException", "Identity does not exist.");
        const pool = cs().identityPools.findOneBy("pool_id", identity.pool_id);
        if (!pool) fail("ResourceNotFoundException", "Identity pool does not exist.");
        const login = await principal(pool, body.Logins);
        if (login !== identity.principal) fail("NotAuthorizedException", "Login does not match this identity.");
        if (body.CustomRoleArn) fail("InvalidParameterException", "Role selection is not simulated.");
        return jsonResponse(c, {
          IdentityId: identity.identity_id,
          Credentials: {
            AccessKeyId: `ASIA${randomBytes(8).toString("hex").toUpperCase()}`,
            SecretKey: randomBytes(30).toString("base64"),
            SessionToken: randomBytes(64).toString("base64"),
            Expiration: Math.floor(Date.now() / 1000) + 3600,
          },
        });
      } catch (error) {
        if (error instanceof SyntaxError)
          return errorResponse(c, new CognitoError("SerializationException", "Invalid JSON request body."));
        return errorResponse(c, error);
      }
    });
}
