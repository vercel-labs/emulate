import type { Context, Store } from "@emulators/core";
import { getLinearStore } from "./store.js";
import { resolveUser } from "./index.js";

export function currentUser(store: Store, c: Context) {
  const ls = getLinearStore(store);
  const authUser = c.get("authUser");
  if (authUser) {
    const byLogin = resolveUser(store, authUser.login);
    if (byLogin) return byLogin;
  }

  const token = c.get("authToken");
  if (token) {
    const record = ls.tokens.findOneBy("token", token);
    if (record?.user_id) {
      const user = ls.users.findOneBy("linear_id", record.user_id);
      if (user) return user;
    }
  }

  return (
    ls.users.all().find((user) => user.admin && !user.app) ??
    ls.users.all().find((user) => !user.app) ??
    ls.users.all()[0]
  );
}

export function tokenScopes(store: Store, c: Context): string[] {
  const token = c.get("authToken");
  if (token) {
    const record = getLinearStore(store).tokens.findOneBy("token", token);
    if (record && record.type !== "oauth_refresh" && !record.revoked) return record.scopes;
  }
  return c.get("authScopes") ?? [];
}

export function requireLinearScopes(store: Store, c: Context, scopes: string[]): void {
  const strict = store.getData<boolean>("linear.strict_scopes") ?? false;
  if (!strict || scopes.length === 0) return;
  const provided = new Set(tokenScopes(store, c));
  if (provided.has("admin") || provided.has("write")) return;
  const missing = scopes.filter((scope) => !provided.has(scope));
  if (missing.length === 0) return;
  throw new Error(`Missing required Linear scope: ${missing.join(", ")}`);
}
