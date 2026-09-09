import type { D360Reader, D360ReaderGroup } from "../entities.js";
import { formatReader, formatReaderGroup } from "../formatters.js";
import {
  api,
  badRequest,
  bool,
  emailValid,
  envelope,
  guid,
  num,
  obj,
  parseJsonBody,
  route,
  skipTake,
  str,
  strOrNull,
  stringArray,
  type Body,
} from "../helpers.js";
import { logEvent } from "../store.js";
import { findReader, findReaderGroup, type D360RouteContext } from "../route-utils.js";

interface AccessScopeInput {
  access_level: number;
  access_categories: string[] | null;
  access_project_versions: string[] | null;
  access_languages: string[] | null;
}

function parseAccessScope(body: Body, current?: AccessScopeInput): AccessScopeInput {
  const scope = obj(body.access_scope);
  const level = num(scope.access_level) ?? num(body.access_level);
  if (level !== undefined && ![0, 1, 2, 3].includes(level))
    throw badRequest("access_level must be between 0 and 3", "validation_error");
  const listOrNull = (value: unknown, fallback: string[] | null) =>
    value === undefined ? fallback : (stringArray(value) ?? null);
  return {
    access_level: level ?? current?.access_level ?? 0,
    access_categories: listOrNull(scope.categories ?? scope.access_categories, current?.access_categories ?? null),
    access_project_versions: listOrNull(
      scope.project_versions ?? scope.access_project_versions,
      current?.access_project_versions ?? null,
    ),
    access_languages: listOrNull(scope.languages ?? scope.access_languages, current?.access_languages ?? null),
  };
}

export function readerRoutes(rc: D360RouteContext): void {
  const { app, ds, fmt } = rc;

  const listReaders = api(ds, (c) => {
    const search = (c.req.query("search_email") ?? c.req.query("searchEmail") ?? c.req.query("email") ?? "")
      .trim()
      .toLowerCase();
    const { skip, take } = skipTake(c);
    const readers = [...ds.readers.all()]
      .filter((reader) => !search || reader.email.toLowerCase().includes(search))
      .sort((a, b) => a.id - b.id)
      .slice(skip, skip + take);
    return c.json(envelope(readers.map((reader) => formatReader(fmt, reader))));
  });
  route(app, "get", "/v2/Readers", listReaders);
  route(app, "get", "/v2/Readers/", listReaders);

  const groupRoutesFirst = () => {
    route(
      app,
      "get",
      "/v2/Readers/groups",
      api(ds, (c) => {
        const { skip, take } = skipTake(c);
        const groups = [...ds.readerGroups.all()].sort((a, b) => a.id - b.id).slice(skip, skip + take);
        return c.json(envelope(groups.map((group) => formatReaderGroup(fmt, group))));
      }),
    );

    route(
      app,
      "post",
      "/v2/Readers/groups",
      api(ds, async (c) => {
        const body = await parseJsonBody(c);
        const title = str(body.title)?.trim();
        if (!title) throw badRequest("title is required", "validation_error");
        if (ds.readerGroups.all().some((group) => group.title.toLowerCase() === title.toLowerCase()))
          throw badRequest("A reader group with this title already exists", "duplicate_group");
        const readerIds = stringArray(body.associated_readers) ?? stringArray(body.reader_ids) ?? [];
        for (const readerId of readerIds) findReader(ds, readerId);
        const group = ds.readerGroups.insert({
          d360_id: str(body.id) ?? guid(),
          title,
          description: str(body.description) ?? "",
          reader_ids: readerIds,
          ...parseAccessScope(body),
        });
        logEvent(ds, "reader_group.created", group.d360_id, { title: group.title });
        return c.json(envelope(formatReaderGroup(fmt, group)));
      }),
    );

    route(
      app,
      "get",
      "/v2/Readers/groups/:id",
      api(ds, (c) => c.json(envelope(formatReaderGroup(fmt, findReaderGroup(ds, c.req.param("id")))))),
    );

    route(
      app,
      "put",
      "/v2/Readers/groups/:id",
      api(ds, async (c) => {
        const group = findReaderGroup(ds, c.req.param("id"));
        const body = await parseJsonBody(c);
        const title = body.title !== undefined ? (str(body.title)?.trim() ?? "") : group.title;
        if (!title) throw badRequest("title cannot be empty", "validation_error");
        const readerIds = stringArray(body.associated_readers) ?? stringArray(body.reader_ids);
        if (readerIds) for (const readerId of readerIds) findReader(ds, readerId);
        const updates: Partial<D360ReaderGroup> = {
          title,
          description: body.description !== undefined ? (str(body.description) ?? "") : group.description,
          reader_ids: readerIds ?? group.reader_ids,
          ...parseAccessScope(body, group),
        };
        const updated = ds.readerGroups.update(group.id, updates)!;
        logEvent(ds, "reader_group.updated", updated.d360_id, { title: updated.title });
        return c.json(envelope(formatReaderGroup(fmt, updated)));
      }),
    );

    route(
      app,
      "delete",
      "/v2/Readers/groups/:id",
      api(ds, (c) => {
        const group = findReaderGroup(ds, c.req.param("id"));
        ds.readerGroups.delete(group.id);
        logEvent(ds, "reader_group.deleted", group.d360_id, { title: group.title });
        return c.json(envelope({ id: group.d360_id }));
      }),
    );
  };
  groupRoutesFirst();

  route(
    app,
    "post",
    "/v2/Readers",
    api(ds, async (c) => {
      const body = await parseJsonBody(c);
      const email = (str(body.email_id) ?? str(body.email))?.trim().toLowerCase();
      if (!email) throw badRequest("email_id is required", "validation_error");
      if (!emailValid(email)) throw badRequest("email_id is not a valid email address", "validation_error");
      if (ds.readers.findOneBy("email", email))
        throw badRequest(`A reader with the email ${email} already exists`, "duplicate_reader");
      const groupIds = stringArray(body.associated_reader_groups) ?? [];
      const groups = groupIds.map((groupId) => findReaderGroup(ds, groupId));
      const owner = ds.teamAccounts.all().find((account) => account.portal_role === "owner");
      const reader = ds.readers.insert({
        d360_id: str(body.id) ?? guid(),
        first_name: str(body.first_name) ?? "",
        last_name: str(body.last_name) ?? "",
        email,
        is_sso_user: bool(body.is_sso_user) ?? false,
        sso_id: strOrNull(body.sso_id),
        invited_by: strOrNull(body.invited_by) ?? owner?.email ?? null,
        ...parseAccessScope(body),
        status: 0,
        last_login_at: null,
      });
      for (const group of groups)
        ds.readerGroups.update(group.id, { reader_ids: [...group.reader_ids, reader.d360_id] });
      logEvent(ds, "reader.created", reader.d360_id, {
        email: reader.email,
        groups: groups.map((group) => group.title),
        invitation_email: bool(body.skip_sso_invitation_email) === true ? "skipped" : "sent",
      });
      return c.json(envelope(formatReader(fmt, reader)));
    }),
  );

  route(
    app,
    "get",
    "/v2/Readers/:id",
    api(ds, (c) => c.json(envelope(formatReader(fmt, findReader(ds, c.req.param("id")))))),
  );

  route(
    app,
    "put",
    "/v2/Readers/:id",
    api(ds, async (c) => {
      const reader = findReader(ds, c.req.param("id"));
      const body = await parseJsonBody(c);
      const email =
        body.email_id !== undefined || body.email !== undefined
          ? (str(body.email_id) ?? str(body.email))?.trim().toLowerCase()
          : undefined;
      if (email !== undefined) {
        if (!email || !emailValid(email)) throw badRequest("email_id is not a valid email address", "validation_error");
        const clash = ds.readers.findOneBy("email", email);
        if (clash && clash.id !== reader.id)
          throw badRequest(`A reader with the email ${email} already exists`, "duplicate_reader");
      }
      const updates: Partial<D360Reader> = {
        first_name: body.first_name !== undefined ? (str(body.first_name) ?? "") : reader.first_name,
        last_name: body.last_name !== undefined ? (str(body.last_name) ?? "") : reader.last_name,
        email: email ?? reader.email,
        is_sso_user: bool(body.is_sso_user) ?? reader.is_sso_user,
        sso_id: body.sso_id !== undefined ? strOrNull(body.sso_id) : reader.sso_id,
        ...parseAccessScope(body, reader),
      };
      const updated = ds.readers.update(reader.id, updates)!;
      const groupIds = stringArray(body.associated_reader_groups);
      if (groupIds) {
        const groups = groupIds.map((groupId) => findReaderGroup(ds, groupId));
        for (const group of ds.readerGroups.all()) {
          const member = groups.some((candidate) => candidate.id === group.id);
          const has = group.reader_ids.includes(updated.d360_id);
          if (member && !has) ds.readerGroups.update(group.id, { reader_ids: [...group.reader_ids, updated.d360_id] });
          if (!member && has)
            ds.readerGroups.update(group.id, { reader_ids: group.reader_ids.filter((id) => id !== updated.d360_id) });
        }
      }
      logEvent(ds, "reader.updated", updated.d360_id, { email: updated.email });
      return c.json(envelope(formatReader(fmt, updated)));
    }),
  );

  route(
    app,
    "delete",
    "/v2/Readers/:id",
    api(ds, (c) => {
      const reader = findReader(ds, c.req.param("id"));
      for (const group of ds.readerGroups.all()) {
        if (group.reader_ids.includes(reader.d360_id))
          ds.readerGroups.update(group.id, { reader_ids: group.reader_ids.filter((id) => id !== reader.d360_id) });
      }
      ds.readers.delete(reader.id);
      logEvent(ds, "reader.deleted", reader.d360_id, { email: reader.email });
      return c.json(envelope({ reader_id: reader.d360_id }));
    }),
  );
}
