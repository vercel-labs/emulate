import type { RouteContext, AuthUser } from "@emulators/core";
import { ApiError, parseJsonBody, parsePagination, setLinkHeader } from "@emulators/core";
import { SshPublicKey } from "@peculiar/ssh";
import { createHash } from "node:crypto";
import { assertAuthenticatedUser, notFoundResponse } from "../route-helpers.js";
import { getGitHubStore, type GitHubStore } from "../store.js";
import type { GitHubSshSigningKey } from "../entities.js";

function getUser(gh: GitHubStore, authUser: AuthUser | undefined) {
  if (authUser?.installation) throw new ApiError(403, "Resource not accessible by integration");
  return assertAuthenticatedUser(gh, authUser);
}

function formatKey(key: GitHubSshSigningKey) {
  const { id, key: publicKey, title, created_at } = key;
  return { id, key: publicKey, title, created_at };
}

export function sshSigningKeysRoutes({ app, store }: RouteContext): void {
  const gh = getGitHubStore(store);
  const list = (userId: number) => gh.sshSigningKeys.findBy("user_id", userId).map(formatKey);

  app.get("/user/ssh_signing_keys", (c) => {
    const user = getUser(gh, c.get("authUser"));
    const { page, per_page } = parsePagination(c);
    const keys = list(user.id);
    setLinkHeader(c, keys.length, page, per_page);
    return c.json(keys.slice((page - 1) * per_page, page * per_page));
  });

  app.get("/users/:username/ssh_signing_keys", (c) => {
    const user = gh.users.findOneBy("login", c.req.param("username"));
    if (!user) throw notFoundResponse();
    const { page, per_page } = parsePagination(c);
    const keys = list(user.id);
    setLinkHeader(c, keys.length, page, per_page);
    return c.json(keys.slice((page - 1) * per_page, page * per_page));
  });

  app.post("/user/ssh_signing_keys", async (c) => {
    const user = getUser(gh, c.get("authUser"));
    const body = await parseJsonBody(c);
    if (typeof body.key !== "string" || (body.title !== undefined && typeof body.title !== "string")) {
      throw new ApiError(422, "Invalid SSH signing key input");
    }
    let publicKey: SshPublicKey;
    try {
      if (/[\r\n]/.test(body.key.trim())) throw new Error("Expected one public key");
      publicKey = await SshPublicKey.fromSSH(body.key);
    } catch {
      throw new ApiError(422, "Invalid SSH signing public key");
    }
    const blob = publicKey.getBlob().keyData;
    const fingerprint = createHash("sha256").update(blob).digest("base64");
    if (gh.sshSigningKeys.findOneBy("fingerprint", fingerprint)) {
      throw new ApiError(422, "SSH signing key already exists");
    }
    const record = gh.sshSigningKeys.insert({
      user_id: user.id,
      fingerprint,
      key: `${publicKey.keyType} ${Buffer.from(blob).toString("base64")}`,
      title: body.title ?? "",
    });
    c.header("Location", `/user/ssh_signing_keys/${record.id}`);
    return c.json(formatKey(record), 201);
  });

  app.get("/user/ssh_signing_keys/:ssh_signing_key_id", (c) => {
    const user = getUser(gh, c.get("authUser"));
    const key = gh.sshSigningKeys.get(Number(c.req.param("ssh_signing_key_id")));
    if (!key || key.user_id !== user.id) throw notFoundResponse();
    return c.json(formatKey(key));
  });

  app.delete("/user/ssh_signing_keys/:ssh_signing_key_id", (c) => {
    const user = getUser(gh, c.get("authUser"));
    const key = gh.sshSigningKeys.get(Number(c.req.param("ssh_signing_key_id")));
    if (!key || key.user_id !== user.id) throw notFoundResponse();
    gh.sshSigningKeys.delete(key.id);
    return c.body(null, 204);
  });
}
