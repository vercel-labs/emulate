import type { RouteContext, AuthUser } from "@emulators/core";
import { ApiError, parseJsonBody, parsePagination, setLinkHeader } from "@emulators/core";
import { readKey, enums, type PublicKey, type Subkey } from "openpgp";
import { assertAuthenticatedUser, notFoundResponse } from "../route-helpers.js";
import { getGitHubStore, type GitHubStore } from "../store.js";
import type { GitHubGpgKey } from "../entities.js";

function getUser(gh: GitHubStore, authUser: AuthUser | undefined) {
  if (authUser?.installation) throw new ApiError(403, "Resource not accessible by integration");
  return assertAuthenticatedUser(gh, authUser);
}

function formatKey(key: GitHubGpgKey) {
  const { user_id: _userId, fingerprint: _fingerprint, updated_at: _updatedAt, ...record } = key;
  return record;
}

async function describeKey(key: PublicKey | Subkey) {
  const signatures = "users" in key ? key.users.flatMap((user) => user.selfCertifications) : key.bindingSignatures;
  const flags = signatures.reduce((value, signature) => value | (signature.keyFlags?.[0] ?? 0), 0);
  const expires = await key.getExpirationTime();
  return {
    key_id: key.getKeyID().toHex().toUpperCase(),
    public_key: Buffer.from(key.keyPacket.write()).toString("base64"),
    can_sign: Boolean(flags & enums.keyFlags.signData),
    can_encrypt_comms: Boolean(flags & enums.keyFlags.encryptCommunication),
    can_encrypt_storage: Boolean(flags & enums.keyFlags.encryptStorage),
    can_certify: Boolean(flags & enums.keyFlags.certifyKeys),
    created_at: key.getCreationTime().toISOString(),
    expires_at: expires instanceof Date ? expires.toISOString() : null,
    revoked:
      "users" in key ? await key.isRevoked() : await key.isRevoked(key.bindingSignatures[0]!, key.mainKey.keyPacket),
  };
}

export function gpgKeysRoutes({ app, store }: RouteContext): void {
  const gh = getGitHubStore(store);
  const list = (userId: number) => gh.gpgKeys.findBy("user_id", userId).map(formatKey);

  app.get("/user/gpg_keys", (c) => {
    const user = getUser(gh, c.get("authUser"));
    const { page, per_page } = parsePagination(c);
    const keys = list(user.id);
    setLinkHeader(c, keys.length, page, per_page);
    return c.json(keys.slice((page - 1) * per_page, page * per_page));
  });

  app.get("/users/:username/gpg_keys", (c) => {
    const user = gh.users.findOneBy("login", c.req.param("username"));
    if (!user) throw notFoundResponse();
    const { page, per_page } = parsePagination(c);
    const keys = list(user.id);
    setLinkHeader(c, keys.length, page, per_page);
    return c.json(keys.slice((page - 1) * per_page, page * per_page));
  });

  app.post("/user/gpg_keys", async (c) => {
    const user = getUser(gh, c.get("authUser"));
    const body = await parseJsonBody(c);
    if (typeof body.armored_public_key !== "string" || (body.name !== undefined && typeof body.name !== "string")) {
      throw new ApiError(422, "Invalid GPG key input");
    }
    let key: PublicKey;
    try {
      key = await readKey({ armoredKey: body.armored_public_key });
      if (key.isPrivate()) throw new Error("Expected a public key");
      await key.verifyPrimaryKey();
    } catch {
      throw new ApiError(422, "Invalid GPG public key");
    }
    const fingerprint = key.getFingerprint();
    if (gh.gpgKeys.findOneBy("fingerprint", fingerprint)) {
      throw new ApiError(422, "GPG key already exists");
    }
    const emails = key.users.flatMap((userKey) =>
      userKey.userID?.email
        ? [
            {
              email: userKey.userID.email,
              verified: userKey.userID.email === user.email,
            },
          ]
        : [],
    );
    const details = await describeKey(key);
    const subkeys = await Promise.all(key.subkeys.map(describeKey));
    const record = gh.gpgKeys.insert({
      ...details,
      user_id: user.id,
      fingerprint,
      name: typeof body.name === "string" ? body.name : null,
      primary_key_id: null,
      raw_key: key.armor(),
      emails,
      subkeys,
    });
    c.header("Location", `/user/gpg_keys/${record.id}`);
    return c.json(formatKey(record), 201);
  });

  app.get("/user/gpg_keys/:gpg_key_id", (c) => {
    const user = getUser(gh, c.get("authUser"));
    const key = gh.gpgKeys.get(Number(c.req.param("gpg_key_id")));
    if (!key || key.user_id !== user.id) throw notFoundResponse();
    return c.json(formatKey(key));
  });

  app.delete("/user/gpg_keys/:gpg_key_id", (c) => {
    const user = getUser(gh, c.get("authUser"));
    const key = gh.gpgKeys.get(Number(c.req.param("gpg_key_id")));
    if (!key || key.user_id !== user.id) throw notFoundResponse();
    gh.gpgKeys.delete(key.id);
    return c.body(null, 204);
  });
}
