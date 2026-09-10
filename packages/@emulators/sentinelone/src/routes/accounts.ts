import type { S1Account } from "../entities.js";
import { formatAccount } from "../formatters.js";
import {
  alreadyExists,
  api,
  bool,
  containsAny,
  dataOf,
  isoOrThrow,
  matchesList,
  oneOf,
  paginate,
  parseJsonBody,
  queryParams,
  route,
  str,
  strOrNull,
  validation,
} from "../helpers.js";
import { accountPolicy, formatPolicy, stripPolicyMeta } from "../policy.js";
import { logActivity, logEvent, nextId } from "../store.js";
import { findAccount, parseLicenses, requestUser, type S1RouteContext } from "../route-utils.js";

const ACCOUNT_TYPES = ["Paid", "Trial"] as const;
const USAGE_TYPES = ["customer", "ir", "mssp"] as const;
const BILLING_MODES = ["subscription", "consumption"] as const;
const STATES = ["active", "deleted", "expired"] as const;

export const DEFAULT_ACCOUNT_LICENSES = {
  bundles: [{ name: "control", surfaces: [{ name: "Total Agents", count: -1 }] }],
  modules: [{ name: "rogues" }],
  settings: [
    { groupName: "malicious_data_retention", setting: "365 Days" },
    { groupName: "remote_shell_availability", setting: "Enabled" },
    { groupName: "marketplace_access_status", setting: "Available" },
    { groupName: "account_level_ranger", setting: "Site" },
  ],
};

export function accountRoutes(rc: S1RouteContext): void {
  const { app, ss, fmt } = rc;

  route(
    app,
    "get",
    "/accounts",
    api(ss, (c) => {
      const params = queryParams(c);
      const ids = params.list("ids") ?? params.list("accountIds");
      const states = params.list("states") ?? (params.get("state") ? [params.get("state")!] : undefined);
      const rows = ss.accounts
        .all()
        .filter((account) => matchesList(account.s1_id, ids))
        .filter((account) => (states ? matchesList(account.state, states) : account.state !== "deleted"))
        .filter((account) => matchesList(account.name, params.list("name")))
        .filter((account) => containsAny(account.name, params.list("name__contains") ?? params.list("query")))
        .filter((account) => matchesList(account.accountType, params.list("accountType")))
        .filter((account) => matchesList(account.usageType, params.list("usageType")))
        .filter((account) => matchesList(account.externalId, params.list("externalId")))
        .filter((account) => (params.get("expiration") ? account.expiration === params.get("expiration") : true))
        .sort((a, b) => a.id - b.id)
        .map((account) => formatAccount(fmt, account));
      return c.json(
        paginate(c, rows, {
          sortable: [
            "id",
            "name",
            "createdAt",
            "updatedAt",
            "expiration",
            "accountType",
            "state",
            "activeAgents",
            "numberOfSites",
          ],
        }),
      );
    }),
  );

  route(
    app,
    "post",
    "/accounts",
    api(ss, async (c, key) => {
      const data = dataOf(await parseJsonBody(c));
      const name = str(data.name)?.trim();
      if (!name) throw validation("name is required");
      if (
        ss.accounts
          .all()
          .some((account) => account.state !== "deleted" && account.name.toLowerCase() === name.toLowerCase())
      )
        throw alreadyExists(`Account name ${name} already exists`);
      const unlimitedExpiration = bool(data.unlimitedExpiration) ?? false;
      const expiration = isoOrThrow(data.expiration, "expiration");
      if (!unlimitedExpiration && !expiration)
        throw validation("expiration is required unless unlimitedExpiration is true");
      const creator = requestUser(ss, key.user_id);
      const account = ss.accounts.insert({
        s1_id: nextId(ss),
        name,
        accountType: oneOf(data.accountType, ACCOUNT_TYPES, "accountType") ?? "Trial",
        usageType: oneOf(data.usageType, USAGE_TYPES, "usageType") ?? "customer",
        externalId: strOrNull(data.externalId),
        billingMode: oneOf(data.billingMode, BILLING_MODES, "billingMode") ?? "subscription",
        expiration: unlimitedExpiration ? null : (expiration ?? null),
        unlimitedExpiration,
        inherits: bool(data.inherits) ?? true,
        licenses: parseLicenses(data.licenses, DEFAULT_ACCOUNT_LICENSES),
        policy:
          data.policy && typeof data.policy === "object"
            ? stripPolicyMeta(data.policy as Record<string, unknown>)
            : null,
        state: "active",
        creator: creator.fullName,
        creatorId: creator.id,
      });
      logActivity(ss, {
        activityType: 5000,
        primaryDescription: `Account ${account.name} was created`,
        accountId: account.s1_id,
        userId: creator.id,
      });
      logEvent(ss, "account.created", account.s1_id, {
        name: account.name,
        accountType: account.accountType,
        usageType: account.usageType,
      });
      return c.json({ data: formatAccount(fmt, account) });
    }),
  );

  route(
    app,
    "get",
    "/accounts/:id",
    api(ss, (c) => c.json({ data: formatAccount(fmt, findAccount(ss, c.req.param("id"))) })),
  );

  route(
    app,
    "put",
    "/accounts/:id",
    api(ss, async (c) => {
      const account = findAccount(ss, c.req.param("id"));
      const data = dataOf(await parseJsonBody(c));
      const name = data.name !== undefined ? (str(data.name)?.trim() ?? "") : account.name;
      if (!name) throw validation("name cannot be empty");
      if (
        name.toLowerCase() !== account.name.toLowerCase() &&
        ss.accounts
          .all()
          .some((candidate) => candidate.state !== "deleted" && candidate.name.toLowerCase() === name.toLowerCase())
      )
        throw alreadyExists(`Account name ${name} already exists`);
      const unlimitedExpiration = bool(data.unlimitedExpiration) ?? account.unlimitedExpiration;
      const updates: Partial<S1Account> = {
        name,
        accountType:
          data.accountType !== undefined
            ? (oneOf(data.accountType, ACCOUNT_TYPES, "accountType") ?? null)
            : account.accountType,
        usageType:
          data.usageType !== undefined ? (oneOf(data.usageType, USAGE_TYPES, "usageType") ?? null) : account.usageType,
        externalId: data.externalId !== undefined ? strOrNull(data.externalId) : account.externalId,
        billingMode:
          data.billingMode !== undefined
            ? (oneOf(data.billingMode, BILLING_MODES, "billingMode") ?? null)
            : account.billingMode,
        unlimitedExpiration,
        expiration: unlimitedExpiration ? null : (isoOrThrow(data.expiration, "expiration") ?? account.expiration),
        inherits: bool(data.inherits) ?? account.inherits,
        licenses: parseLicenses(data.licenses, account.licenses),
        state: data.state !== undefined ? (oneOf(data.state, STATES, "state") ?? account.state) : account.state,
      };
      const updated = ss.accounts.update(account.id, updates)!;
      logEvent(ss, "account.updated", updated.s1_id, {
        name: updated.name,
        accountType: updated.accountType,
        bundles: updated.licenses.bundles.map((bundle) => bundle.name),
      });
      return c.json({ data: formatAccount(fmt, updated) });
    }),
  );

  route(
    app,
    "delete",
    "/accounts/:id",
    api(ss, (c) => {
      const account = findAccount(ss, c.req.param("id"));
      if (ss.sites.findBy("account_id", account.s1_id).some((site) => site.state === "active"))
        throw validation("An account with active sites cannot be deleted");
      ss.accounts.update(account.id, { state: "deleted" });
      logEvent(ss, "account.deleted", account.s1_id, { name: account.name });
      return c.json({ data: { success: true } });
    }),
  );

  route(
    app,
    "get",
    "/accounts/:id/policy",
    api(ss, (c) => {
      const account = findAccount(ss, c.req.param("id"));
      return c.json({ data: formatPolicy(accountPolicy(ss, account.s1_id), account.updated_at) });
    }),
  );

  route(
    app,
    "put",
    "/accounts/:id/policy",
    api(ss, async (c, key) => {
      const account = findAccount(ss, c.req.param("id"));
      const data = stripPolicyMeta(dataOf(await parseJsonBody(c)));
      if (Object.keys(data).length === 0) throw validation("data must contain at least one policy field");
      const updated = ss.accounts.update(account.id, {
        inherits: false,
        policy: { ...(account.policy ?? {}), ...data },
      })!;
      logEvent(ss, "policy.updated", account.s1_id, { level: "account", fields: Object.keys(data) });
      return c.json({
        data: formatPolicy(accountPolicy(ss, updated.s1_id), updated.updated_at, requestUser(ss, key.user_id)),
      });
    }),
  );

  route(
    app,
    "put",
    "/accounts/:id/revert-policy",
    api(ss, (c) => {
      const account = findAccount(ss, c.req.param("id"));
      const updated = ss.accounts.update(account.id, { inherits: true, policy: null })!;
      return c.json({ data: formatPolicy(accountPolicy(ss, updated.s1_id), updated.updated_at) });
    }),
  );
}
