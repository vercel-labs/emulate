import type { S1Site } from "../entities.js";
import { formatSite, siteActiveLicenses } from "../formatters.js";
import {
  alreadyExists,
  api,
  bool,
  containsAny,
  dataOf,
  isoOrThrow,
  matchesList,
  num,
  oneOf,
  paginate,
  parseJsonBody,
  queryParams,
  route,
  str,
  strOrNull,
  token,
  validation,
} from "../helpers.js";
import { formatPolicy, sitePolicy, stripPolicyMeta } from "../policy.js";
import { logActivity, logEvent, nextId } from "../store.js";
import {
  defaultGroupOf,
  findAccount,
  findSite,
  parseLicenses,
  requestUser,
  type S1RouteContext,
} from "../route-utils.js";

const SITE_TYPES = ["Paid", "Trial"] as const;
const STATES = ["active", "deleted", "expired"] as const;

export function siteRoutes(rc: S1RouteContext): void {
  const { app, ss, fmt } = rc;

  route(
    app,
    "get",
    "/sites",
    api(ss, (c) => {
      const params = queryParams(c);
      const siteIds = params.list("siteIds") ?? params.list("ids");
      const accountIds = params.list("accountIds") ?? params.list("accountId");
      const states = params.list("states") ?? (params.get("state") ? [params.get("state")!] : undefined);
      const rows = ss.sites
        .all()
        .filter((site) => matchesList(site.s1_id, siteIds))
        .filter((site) => matchesList(site.account_id, accountIds))
        .filter((site) => (states ? matchesList(site.state, states) : site.state !== "deleted"))
        .filter((site) => matchesList(site.name, params.list("name")))
        .filter((site) => containsAny(site.name, params.list("name__contains") ?? params.list("query")))
        .filter((site) => containsAny(site.description, params.list("description__contains")))
        .filter((site) => matchesList(site.siteType, params.list("siteType")))
        .filter((site) => matchesList(site.externalId, params.list("externalId")))
        .filter((site) => (params.bool("isDefault") === undefined ? true : site.isDefault === params.bool("isDefault")))
        .filter((site) => {
          const wanted = params.list("accountName__contains");
          if (!wanted) return true;
          const account = ss.accounts.findOneBy("s1_id", site.account_id);
          return containsAny(account?.name, wanted);
        })
        .filter((site) =>
          params.num("activeLicenses") === undefined
            ? true
            : siteActiveLicenses(ss, site.s1_id) === params.num("activeLicenses"),
        )
        .sort((a, b) => a.id - b.id)
        .map((site) => formatSite(fmt, site));
      const page = paginate(c, rows, {
        sortable: [
          "id",
          "name",
          "createdAt",
          "updatedAt",
          "expiration",
          "siteType",
          "state",
          "activeLicenses",
          "totalLicenses",
          "accountName",
        ],
      });
      const active = ss.sites.all().filter((site) => site.state === "active");
      return c.json({
        data: {
          allSites: {
            activeLicenses: active.reduce((sum, site) => sum + siteActiveLicenses(ss, site.s1_id), 0),
            totalLicenses: active.reduce((sum, site) => sum + (site.unlimitedLicenses ? 0 : site.totalLicenses), 0),
          },
          sites: page.data,
        },
        pagination: page.pagination,
      });
    }),
  );

  route(
    app,
    "post",
    "/sites",
    api(ss, async (c, key) => {
      const data = dataOf(await parseJsonBody(c));
      const name = str(data.name)?.trim();
      if (!name) throw validation("name is required");
      const siteType = oneOf(data.siteType, SITE_TYPES, "siteType");
      if (!siteType) throw validation("siteType is required");
      const account = data.accountId
        ? findAccount(ss, String(data.accountId))
        : ss.accounts.all().find((candidate) => candidate.state === "active");
      if (!account) throw validation("accountId is required");
      if (
        ss.sites
          .findBy("account_id", account.s1_id)
          .some((site) => site.state !== "deleted" && site.name.toLowerCase() === name.toLowerCase())
      )
        throw alreadyExists(`Site name ${name} already exists in account ${account.name}`);
      const unlimitedExpiration = bool(data.unlimitedExpiration) ?? false;
      const expiration = isoOrThrow(data.expiration, "expiration");
      if (!unlimitedExpiration && !expiration)
        throw validation("expiration is required unless unlimitedExpiration is true");
      const unlimitedLicenses = bool(data.unlimitedLicenses) ?? true;
      const totalLicenses = num(data.totalLicenses) ?? 0;
      if (!unlimitedLicenses && totalLicenses <= 0)
        throw validation("totalLicenses must be greater than zero unless unlimitedLicenses is true");
      const creator = requestUser(ss, key.user_id);
      const bundle = parseLicenses(data.licenses, account.licenses).bundles[0]?.name ?? "control";
      const site = ss.sites.insert({
        s1_id: nextId(ss),
        account_id: account.s1_id,
        name,
        siteType,
        description: strOrNull(data.description),
        externalId: strOrNull(data.externalId),
        healthStatus: true,
        unlimitedExpiration,
        unlimitedLicenses,
        totalLicenses,
        isDefault: bool(data.isDefault) ?? false,
        inherits: bool(data.inherits) ?? true,
        expiration: unlimitedExpiration ? null : (expiration ?? null),
        licenses: parseLicenses(data.licenses, account.licenses),
        registrationToken: token(64),
        policy:
          data.policy && typeof data.policy === "object"
            ? stripPolicyMeta(data.policy as Record<string, unknown>)
            : null,
        state: "active",
        sku: bundle,
        suite: bundle === "complete" ? "Complete" : bundle === "control" ? "Control" : "Core",
        creator: creator.fullName,
        creatorId: creator.id,
      });
      defaultGroupOf(ss, site.s1_id);
      logActivity(ss, {
        activityType: 4000,
        primaryDescription: `Site ${site.name} was created in account ${account.name}`,
        accountId: account.s1_id,
        siteId: site.s1_id,
        userId: creator.id,
      });
      logEvent(ss, "site.created", site.s1_id, {
        name: site.name,
        accountId: account.s1_id,
        siteType: site.siteType,
        externalId: site.externalId,
      });
      return c.json({ data: formatSite(fmt, site) });
    }),
  );

  route(
    app,
    "get",
    "/sites/:id",
    api(ss, (c) => c.json({ data: formatSite(fmt, findSite(ss, c.req.param("id"))) })),
  );

  route(
    app,
    "put",
    "/sites/:id",
    api(ss, async (c) => {
      const site = findSite(ss, c.req.param("id"));
      const data = dataOf(await parseJsonBody(c));
      const name = data.name !== undefined ? (str(data.name)?.trim() ?? "") : site.name;
      if (!name) throw validation("name cannot be empty");
      const account = data.accountId ? findAccount(ss, String(data.accountId)) : findAccount(ss, site.account_id);
      if (
        ss.sites
          .findBy("account_id", account.s1_id)
          .some(
            (candidate) =>
              candidate.id !== site.id &&
              candidate.state !== "deleted" &&
              candidate.name.toLowerCase() === name.toLowerCase(),
          )
      )
        throw alreadyExists(`Site name ${name} already exists in account ${account.name}`);
      const unlimitedExpiration = bool(data.unlimitedExpiration) ?? site.unlimitedExpiration;
      const unlimitedLicenses = bool(data.unlimitedLicenses) ?? site.unlimitedLicenses;
      const licenses = parseLicenses(data.licenses, site.licenses);
      const bundle = licenses.bundles[0]?.name ?? site.sku;
      const updates: Partial<S1Site> = {
        name,
        account_id: account.s1_id,
        siteType:
          data.siteType !== undefined ? (oneOf(data.siteType, SITE_TYPES, "siteType") ?? site.siteType) : site.siteType,
        description: data.description !== undefined ? strOrNull(data.description) : site.description,
        externalId: data.externalId !== undefined ? strOrNull(data.externalId) : site.externalId,
        unlimitedExpiration,
        expiration: unlimitedExpiration ? null : (isoOrThrow(data.expiration, "expiration") ?? site.expiration),
        unlimitedLicenses,
        totalLicenses: num(data.totalLicenses) ?? site.totalLicenses,
        isDefault: bool(data.isDefault) ?? site.isDefault,
        inherits: bool(data.inherits) ?? site.inherits,
        licenses,
        sku: bundle,
        suite: bundle === "complete" ? "Complete" : bundle === "control" ? "Control" : "Core",
        state: data.state !== undefined ? (oneOf(data.state, STATES, "state") ?? site.state) : site.state,
      };
      const updated = ss.sites.update(site.id, updates)!;
      logEvent(ss, "site.updated", updated.s1_id, {
        name: updated.name,
        siteType: updated.siteType,
        expiration: updated.expiration,
        externalId: updated.externalId,
      });
      return c.json({ data: formatSite(fmt, updated) });
    }),
  );

  route(
    app,
    "delete",
    "/sites/:id",
    api(ss, (c) => {
      const site = findSite(ss, c.req.param("id"));
      if (site.state === "deleted") throw validation(`Site ${site.name} is already deleted`);
      ss.sites.update(site.id, { state: "deleted" });
      for (const agent of ss.agents.findBy("site_id", site.s1_id))
        if (!agent.isDecommissioned)
          ss.agents.update(agent.id, {
            isDecommissioned: true,
            isActive: false,
            decommissionedAt: new Date().toISOString(),
          });
      logActivity(ss, {
        activityType: 4001,
        primaryDescription: `Site ${site.name} was deleted`,
        accountId: site.account_id,
        siteId: site.s1_id,
      });
      logEvent(ss, "site.deleted", site.s1_id, { name: site.name });
      return c.json({ data: { success: true } });
    }),
  );

  route(
    app,
    "put",
    "/sites/:id/reactivate",
    api(ss, async (c) => {
      const site = findSite(ss, c.req.param("id"));
      const data = dataOf(await parseJsonBody(c));
      const updated = ss.sites.update(site.id, {
        state: "active",
        expiration: isoOrThrow(data.expiration, "expiration") ?? site.expiration,
        unlimitedExpiration: bool(data.unlimitedExpiration) ?? site.unlimitedExpiration,
      })!;
      return c.json({ data: formatSite(fmt, updated) });
    }),
  );

  route(
    app,
    "get",
    "/sites/:id/policy",
    api(ss, (c) => {
      const site = findSite(ss, c.req.param("id"));
      return c.json({ data: formatPolicy(sitePolicy(ss, site.s1_id), site.updated_at) });
    }),
  );

  route(
    app,
    "put",
    "/sites/:id/policy",
    api(ss, async (c, key) => {
      const site = findSite(ss, c.req.param("id"));
      const data = stripPolicyMeta(dataOf(await parseJsonBody(c)));
      if (Object.keys(data).length === 0) throw validation("data must contain at least one policy field");
      const updated = ss.sites.update(site.id, { inherits: false, policy: { ...(site.policy ?? {}), ...data } })!;
      logEvent(ss, "policy.updated", site.s1_id, { level: "site", fields: Object.keys(data) });
      return c.json({
        data: formatPolicy(sitePolicy(ss, updated.s1_id), updated.updated_at, requestUser(ss, key.user_id)),
      });
    }),
  );

  route(
    app,
    "put",
    "/sites/:id/revert-policy",
    api(ss, (c) => {
      const site = findSite(ss, c.req.param("id"));
      const updated = ss.sites.update(site.id, { inherits: true, policy: null })!;
      return c.json({ data: formatPolicy(sitePolicy(ss, updated.s1_id), updated.updated_at) });
    }),
  );
}
