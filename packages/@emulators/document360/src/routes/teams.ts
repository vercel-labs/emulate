import type { D360TeamAccount, D360TeamGroup, PortalRole } from "../entities.js";
import { formatTeamAccount, formatTeamGroup } from "../formatters.js";
import {
  api,
  badRequest,
  bool,
  emailValid,
  envelope,
  guid,
  notFound,
  nowIso,
  num,
  parseJsonBody,
  route,
  skipTake,
  str,
  strOrNull,
  stringArray,
} from "../helpers.js";
import { logEvent } from "../store.js";
import { findTeamAccount, findTeamGroup, type D360RouteContext } from "../route-utils.js";

const PORTAL_ROLES: PortalRole[] = ["owner", "admin", "editor", "draft_writer", "reader"];

export function parsePortalRole(value: unknown, fallback: PortalRole): PortalRole {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "number" || /^\d+$/.test(String(value))) {
    const role = PORTAL_ROLES[Number(value)];
    if (!role) throw badRequest("portal_role must be between 0 (owner) and 4 (reader)", "validation_error");
    return role;
  }
  const normalized = String(value)
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (!PORTAL_ROLES.includes(normalized as PortalRole))
    throw badRequest(`portal_role must be one of ${PORTAL_ROLES.join(", ")}`, "validation_error");
  return normalized as PortalRole;
}

export function teamRoutes(rc: D360RouteContext): void {
  const { app, ds, fmt } = rc;

  route(
    app,
    "get",
    "/v2/Teams",
    api(ds, (c) => {
      const { skip, take } = skipTake(c);
      const accounts = [...ds.teamAccounts.all()].sort((a, b) => a.id - b.id).slice(skip, skip + take);
      return c.json(envelope(accounts.map(formatTeamAccount)));
    }),
  );

  route(
    app,
    "get",
    "/v2/Teams/groups",
    api(ds, (c) =>
      c.json(
        envelope([...ds.teamGroups.all()].sort((a, b) => a.id - b.id).map((group) => formatTeamGroup(fmt, group))),
      ),
    ),
  );

  route(
    app,
    "post",
    "/v2/Teams/groups",
    api(ds, async (c) => {
      const body = await parseJsonBody(c);
      const title = str(body.title)?.trim();
      if (!title) throw badRequest("title is required", "validation_error");
      const accountIds = stringArray(body.associated_team_accounts) ?? stringArray(body.user_ids) ?? [];
      const resolved = accountIds.map((id) => findTeamAccount(ds, id).d360_id);
      const group = ds.teamGroups.insert({
        d360_id: str(body.id) ?? guid(),
        title,
        description: str(body.description) ?? "",
        account_ids: resolved,
        portal_role: parsePortalRole(body.portal_role, "editor"),
      });
      logEvent(ds, "team_group.created", group.d360_id, { title: group.title });
      return c.json(envelope(formatTeamGroup(fmt, group)));
    }),
  );

  route(
    app,
    "get",
    "/v2/Teams/groups/:id",
    api(ds, (c) => c.json(envelope(formatTeamGroup(fmt, findTeamGroup(ds, c.req.param("id")))))),
  );

  route(
    app,
    "put",
    "/v2/Teams/groups/:id",
    api(ds, async (c) => {
      const group = findTeamGroup(ds, c.req.param("id"));
      const body = await parseJsonBody(c);
      const title = body.title !== undefined ? (str(body.title)?.trim() ?? "") : group.title;
      if (!title) throw badRequest("title cannot be empty", "validation_error");
      const accountIds = stringArray(body.associated_team_accounts) ?? stringArray(body.user_ids);
      const updates: Partial<D360TeamGroup> = {
        title,
        description: body.description !== undefined ? (str(body.description) ?? "") : group.description,
        account_ids: accountIds ? accountIds.map((id) => findTeamAccount(ds, id).d360_id) : group.account_ids,
        portal_role: parsePortalRole(body.portal_role, group.portal_role),
      };
      const updated = ds.teamGroups.update(group.id, updates)!;
      return c.json(envelope(formatTeamGroup(fmt, updated)));
    }),
  );

  route(
    app,
    "delete",
    "/v2/Teams/groups/:id",
    api(ds, (c) => {
      const group = findTeamGroup(ds, c.req.param("id"));
      ds.teamGroups.delete(group.id);
      logEvent(ds, "team_group.deleted", group.d360_id, { title: group.title });
      return c.json(envelope({ id: group.d360_id }));
    }),
  );

  route(
    app,
    "post",
    "/v2/Teams",
    api(ds, async (c) => {
      const body = await parseJsonBody(c);
      const email = (str(body.email_id) ?? str(body.email))?.trim().toLowerCase();
      if (!email) throw badRequest("email_id is required", "validation_error");
      if (!emailValid(email)) throw badRequest("email_id is not a valid email address", "validation_error");
      if (ds.teamAccounts.findOneBy("email", email))
        throw badRequest(`A team account with the email ${email} already exists`, "duplicate_team_account");
      const groupIds = stringArray(body.associated_team_groups) ?? [];
      const groups = groupIds.map((id) => findTeamGroup(ds, id));
      const account = ds.teamAccounts.insert({
        d360_id: str(body.id) ?? guid(),
        email,
        first_name: str(body.first_name) ?? "",
        last_name: str(body.last_name) ?? "",
        portal_role: parsePortalRole(body.portal_role ?? body.user_role, "editor"),
        is_sso_user: bool(body.is_sso_user) ?? false,
        sso_id: strOrNull(body.sso_id),
        profile_logo_url: null,
        last_login_at: null,
        invited_at: nowIso(),
        accepted: false,
      });
      for (const group of groups)
        ds.teamGroups.update(group.id, { account_ids: [...group.account_ids, account.d360_id] });
      logEvent(ds, "team_account.created", account.d360_id, { email: account.email, portal_role: account.portal_role });
      return c.json(envelope(formatTeamAccount(account)));
    }),
  );

  route(
    app,
    "get",
    "/v2/Teams/:id",
    api(ds, (c) => c.json(envelope(formatTeamAccount(findTeamAccount(ds, c.req.param("id")))))),
  );

  route(
    app,
    "put",
    "/v2/Teams/:id",
    api(ds, async (c) => {
      const account = findTeamAccount(ds, c.req.param("id"));
      const body = await parseJsonBody(c);
      const role = parsePortalRole(body.portal_role ?? body.user_role, account.portal_role);
      if (
        account.portal_role === "owner" &&
        role !== "owner" &&
        ds.teamAccounts.all().filter((candidate) => candidate.portal_role === "owner").length === 1
      ) {
        throw badRequest("The last owner cannot be demoted", "last_owner");
      }
      const updates: Partial<D360TeamAccount> = {
        first_name: body.first_name !== undefined ? (str(body.first_name) ?? "") : account.first_name,
        last_name: body.last_name !== undefined ? (str(body.last_name) ?? "") : account.last_name,
        portal_role: role,
        is_sso_user: bool(body.is_sso_user) ?? account.is_sso_user,
        sso_id: body.sso_id !== undefined ? strOrNull(body.sso_id) : account.sso_id,
        profile_logo_url:
          body.profile_logo_url !== undefined ? strOrNull(body.profile_logo_url) : account.profile_logo_url,
      };
      const updated = ds.teamAccounts.update(account.id, updates)!;
      const groupIds = stringArray(body.associated_team_groups);
      if (groupIds) {
        const groups = groupIds.map((id) => findTeamGroup(ds, id));
        for (const group of ds.teamGroups.all()) {
          const member = groups.some((candidate) => candidate.id === group.id);
          const has = group.account_ids.includes(updated.d360_id);
          if (member && !has) ds.teamGroups.update(group.id, { account_ids: [...group.account_ids, updated.d360_id] });
          if (!member && has)
            ds.teamGroups.update(group.id, { account_ids: group.account_ids.filter((id) => id !== updated.d360_id) });
        }
      }
      logEvent(ds, "team_account.updated", updated.d360_id, { email: updated.email, portal_role: updated.portal_role });
      return c.json(envelope(formatTeamAccount(updated)));
    }),
  );

  route(
    app,
    "delete",
    "/v2/Teams/:id",
    api(ds, (c) => {
      const account = findTeamAccount(ds, c.req.param("id"));
      if (
        account.portal_role === "owner" &&
        ds.teamAccounts.all().filter((candidate) => candidate.portal_role === "owner").length === 1
      ) {
        throw badRequest("The last owner cannot be removed", "last_owner");
      }
      for (const group of ds.teamGroups.all()) {
        if (group.account_ids.includes(account.d360_id))
          ds.teamGroups.update(group.id, { account_ids: group.account_ids.filter((id) => id !== account.d360_id) });
      }
      ds.teamAccounts.delete(account.id);
      logEvent(ds, "team_account.deleted", account.d360_id, { email: account.email });
      return c.json(envelope({ user_id: account.d360_id }));
    }),
  );

  route(
    app,
    "get",
    "/v2/Teams/:id/articles",
    api(ds, (c) => {
      const account = findTeamAccount(ds, c.req.param("id"));
      const articles = ds.articles
        .all()
        .filter((article) => !article.deleted && article.authors.includes(account.d360_id));
      if (articles.length === 0 && num(c.req.query("strict")) === 1)
        throw notFound("No articles found for this team account", "not_found");
      return c.json(
        envelope(
          articles.map((article) => ({
            id: article.d360_id,
            title: article.title,
            language_code: article.language_code,
            project_version_id: article.project_version_id,
          })),
        ),
      );
    }),
  );
}
