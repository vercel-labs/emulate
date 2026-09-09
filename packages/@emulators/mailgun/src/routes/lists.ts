import type { MailgunList, MailgunMember } from "../entities.js";
import { formatList, formatMember } from "../formatters.js";
import {
  api,
  badRequest,
  emailValid,
  first,
  limitParam,
  notFound,
  pagedItems,
  parseBody,
  parseJson,
  route,
  skipParam,
  yesNo,
} from "../helpers.js";
import { token } from "../ids.js";
import { findList, type MailgunRouteContext } from "../route-utils.js";

const ACCESS_LEVELS = new Set(["readonly", "members", "everyone"]);
const REPLY_PREFERENCES = new Set(["list", "sender"]);

export function listRoutes(rc: MailgunRouteContext): void {
  const { app, ms, fmt } = rc;
  const sortedLists = () => [...ms.lists.all()].sort((a, b) => a.address.localeCompare(b.address));
  const membersOf = (list: MailgunList) =>
    [...ms.members.findBy("list_address", list.address)].sort((a, b) => a.address.localeCompare(b.address));

  route(
    app,
    "get",
    "/v3/lists/pages",
    api(ms, (c) => {
      const paged = pagedItems(c, sortedLists(), {
        anchorKey: "address",
        anchor: (list) => list.address,
        defaultLimit: 100,
      });
      return c.json({ items: paged.items.map((list) => formatList(fmt, list)), paging: paged.paging });
    }),
  );

  route(
    app,
    "get",
    "/v3/lists",
    api(ms, (c) => {
      const address = c.req.query("address")?.toLowerCase();
      let lists = sortedLists();
      if (address) lists = lists.filter((list) => list.address === address);
      const limit = limitParam(c, 100);
      const skip = skipParam(c);
      return c.json({
        items: lists.slice(skip, skip + limit).map((list) => formatList(fmt, list)),
        total_count: lists.length,
      });
    }),
  );

  route(
    app,
    "post",
    "/v3/lists",
    api(ms, async (c) => {
      const body = await parseBody(c);
      const address = first(body, "address")?.trim().toLowerCase();
      if (!address) throw badRequest("'address' parameter is missing");
      if (!emailValid(address)) throw badRequest("'address' parameter is not a valid address");
      if (ms.lists.findOneBy("address", address)) throw badRequest("Mailing list address already exists");
      const accessLevel = first(body, "access_level") ?? "readonly";
      if (!ACCESS_LEVELS.has(accessLevel))
        throw badRequest("'access_level' parameter must be one of readonly, members, everyone");
      const replyPreference = first(body, "reply_preference") ?? "list";
      if (!REPLY_PREFERENCES.has(replyPreference))
        throw badRequest("'reply_preference' parameter must be one of list, sender");
      const list = ms.lists.insert({
        address,
        name: first(body, "name") ?? "",
        description: first(body, "description") ?? "",
        access_level: accessLevel as MailgunList["access_level"],
        reply_preference: replyPreference as MailgunList["reply_preference"],
      });
      return c.json({ list: formatList(fmt, list), message: "Mailing list has been created" });
    }),
  );

  route(
    app,
    "get",
    "/v3/lists/:address",
    api(ms, (c) => c.json({ list: formatList(fmt, findList(ms, c.req.param("address"))) })),
  );

  route(
    app,
    "put",
    "/v3/lists/:address",
    api(ms, async (c) => {
      const list = findList(ms, c.req.param("address"));
      const body = await parseBody(c);
      const newAddress = first(body, "address")?.trim().toLowerCase();
      if (newAddress && newAddress !== list.address) {
        if (!emailValid(newAddress)) throw badRequest("'address' parameter is not a valid address");
        if (ms.lists.findOneBy("address", newAddress)) throw badRequest("Mailing list address already exists");
        for (const member of ms.members.findBy("list_address", list.address))
          ms.members.update(member.id, { list_address: newAddress });
      }
      const accessLevel = first(body, "access_level");
      if (accessLevel !== undefined && !ACCESS_LEVELS.has(accessLevel))
        throw badRequest("'access_level' parameter must be one of readonly, members, everyone");
      const replyPreference = first(body, "reply_preference");
      if (replyPreference !== undefined && !REPLY_PREFERENCES.has(replyPreference))
        throw badRequest("'reply_preference' parameter must be one of list, sender");
      const updated = ms.lists.update(list.id, {
        address: newAddress ?? list.address,
        name: first(body, "name") ?? list.name,
        description: first(body, "description") ?? list.description,
        access_level: (accessLevel as MailgunList["access_level"]) ?? list.access_level,
        reply_preference: (replyPreference as MailgunList["reply_preference"]) ?? list.reply_preference,
      })!;
      return c.json({ list: formatList(fmt, updated), message: "Mailing list has been updated" });
    }),
  );

  route(
    app,
    "delete",
    "/v3/lists/:address",
    api(ms, (c) => {
      const list = findList(ms, c.req.param("address"));
      for (const member of ms.members.findBy("list_address", list.address)) ms.members.delete(member.id);
      ms.lists.delete(list.id);
      return c.json({ address: list.address, message: "Mailing list has been removed" });
    }),
  );

  route(
    app,
    "post",
    "/v3/lists/:address/validate",
    api(ms, (c) => {
      const list = findList(ms, c.req.param("address"));
      return c.json({ id: token(24), message: "The validation job was submitted.", list: { address: list.address } });
    }),
  );

  route(
    app,
    "get",
    "/v3/lists/:address/validate",
    api(ms, (c) => {
      const list = findList(ms, c.req.param("address"));
      const members = membersOf(list);
      return c.json({
        id: token(24),
        status: "uploaded",
        quantity: members.length,
        records_processed: members.length,
        created_at: list.created_at,
        summary: {
          result: { deliverable: members.length, undeliverable: 0, do_not_send: 0, catch_all: 0, unknown: 0 },
          risk: { high: 0, medium: 0, low: members.length, unknown: 0 },
        },
        download_url: { csv: "", json: "" },
      });
    }),
  );

  route(
    app,
    "delete",
    "/v3/lists/:address/validate",
    api(ms, (c) => {
      findList(ms, c.req.param("address"));
      return c.json({ message: "Validation job canceled." });
    }),
  );

  route(
    app,
    "get",
    "/v3/lists/:address/members/pages",
    api(ms, (c) => {
      const list = findList(ms, c.req.param("address"));
      const subscribed = c.req.query("subscribed");
      let members = membersOf(list);
      if (subscribed !== undefined && subscribed !== "")
        members = members.filter((member) => member.subscribed === yesNo(subscribed, true));
      const paged = pagedItems(c, members, {
        anchorKey: "address",
        anchor: (member) => member.address,
        defaultLimit: 100,
      });
      return c.json({ items: paged.items.map(formatMember), paging: paged.paging });
    }),
  );

  route(
    app,
    "get",
    "/v3/lists/:address/members",
    api(ms, (c) => {
      const list = findList(ms, c.req.param("address"));
      const subscribed = c.req.query("subscribed");
      let members = membersOf(list);
      if (subscribed !== undefined && subscribed !== "")
        members = members.filter((member) => member.subscribed === yesNo(subscribed, true));
      const limit = limitParam(c, 100);
      const skip = skipParam(c);
      return c.json({ items: members.slice(skip, skip + limit).map(formatMember), total_count: members.length });
    }),
  );

  function memberOf(list: MailgunList, rawAddress: string): MailgunMember | undefined {
    const address = decodeURIComponent(rawAddress).toLowerCase();
    return ms.members.findBy("list_address", list.address).find((member) => member.address === address);
  }

  route(
    app,
    "get",
    "/v3/lists/:address/members/:member",
    api(ms, (c) => {
      const list = findList(ms, c.req.param("address"));
      const member = memberOf(list, c.req.param("member"));
      if (!member) throw notFound("Member not found");
      return c.json({ member: formatMember(member) });
    }),
  );

  route(
    app,
    "post",
    "/v3/lists/:address/members",
    api(ms, async (c) => {
      const list = findList(ms, c.req.param("address"));
      const body = await parseBody(c);
      const address = first(body, "address")?.trim().toLowerCase();
      if (!address) throw badRequest("'address' parameter is missing");
      if (!emailValid(address)) throw badRequest("'address' parameter is not a valid address");
      const upsert = yesNo(first(body, "upsert"), false);
      const existing = ms.members.findBy("list_address", list.address).find((member) => member.address === address);
      if (existing && !upsert) throw badRequest("Address already exists");
      const varsRaw = first(body, "vars");
      const vars = varsRaw ? parseJson<Record<string, unknown>>(varsRaw) : undefined;
      if (varsRaw && vars === undefined) throw badRequest("'vars' parameter is not a valid JSON");
      const data = {
        name: first(body, "name") ?? existing?.name ?? "",
        subscribed: yesNo(first(body, "subscribed"), existing?.subscribed ?? true),
        vars: vars ?? existing?.vars ?? {},
      };
      const member = existing
        ? ms.members.update(existing.id, data)!
        : ms.members.insert({ list_address: list.address, address, ...data });
      return c.json({ member: formatMember(member), message: "Mailing list member has been created" });
    }),
  );

  route(
    app,
    "post",
    "/v3/lists/:address/members.json",
    api(ms, async (c) => {
      const list = findList(ms, c.req.param("address"));
      const body = await parseBody(c);
      const raw = first(body, "members");
      const items = raw ? parseJson<Array<Record<string, unknown> | string>>(raw) : undefined;
      if (!Array.isArray(items)) throw badRequest("'members' parameter is not a valid JSON array");
      if (items.length > 1000) throw badRequest("Maximum of 1000 members per request");
      const upsert = yesNo(first(body, "upsert"), false);
      for (const item of items) {
        const fields = typeof item === "string" ? { address: item } : item;
        const address = String(fields.address ?? "")
          .trim()
          .toLowerCase();
        if (!address || !emailValid(address)) continue;
        const existing = ms.members.findBy("list_address", list.address).find((member) => member.address === address);
        const subscribedValue = fields.subscribed;
        const data = {
          name: fields.name !== undefined ? String(fields.name) : (existing?.name ?? ""),
          subscribed:
            typeof subscribedValue === "boolean"
              ? subscribedValue
              : yesNo(
                  subscribedValue !== undefined ? String(subscribedValue) : undefined,
                  existing?.subscribed ?? true,
                ),
          vars:
            fields.vars && typeof fields.vars === "object"
              ? (fields.vars as Record<string, unknown>)
              : (existing?.vars ?? {}),
        };
        if (existing) {
          if (upsert) ms.members.update(existing.id, data);
          continue;
        }
        ms.members.insert({ list_address: list.address, address, ...data });
      }
      return c.json({
        list: formatList(fmt, ms.lists.get(list.id)!),
        message: "Mailing list has been updated",
        "task-id": token(24),
      });
    }),
  );

  route(
    app,
    "put",
    "/v3/lists/:address/members/:member",
    api(ms, async (c) => {
      const list = findList(ms, c.req.param("address"));
      const member = memberOf(list, c.req.param("member"));
      if (!member) throw notFound("Member not found");
      const body = await parseBody(c);
      const newAddress = first(body, "address")?.trim().toLowerCase();
      if (newAddress && newAddress !== member.address) {
        if (!emailValid(newAddress)) throw badRequest("'address' parameter is not a valid address");
        if (ms.members.findBy("list_address", list.address).some((candidate) => candidate.address === newAddress))
          throw badRequest("Address already exists");
      }
      const varsRaw = first(body, "vars");
      const vars = varsRaw ? parseJson<Record<string, unknown>>(varsRaw) : undefined;
      if (varsRaw && vars === undefined) throw badRequest("'vars' parameter is not a valid JSON");
      const updated = ms.members.update(member.id, {
        address: newAddress ?? member.address,
        name: first(body, "name") ?? member.name,
        subscribed: yesNo(first(body, "subscribed"), member.subscribed),
        vars: vars ?? member.vars,
      })!;
      return c.json({ member: formatMember(updated), message: "Mailing list member has been updated" });
    }),
  );

  route(
    app,
    "delete",
    "/v3/lists/:address/members/:member",
    api(ms, (c) => {
      const list = findList(ms, c.req.param("address"));
      const member = memberOf(list, c.req.param("member"));
      if (!member) throw notFound("Member not found");
      ms.members.delete(member.id);
      return c.json({ member: { address: member.address }, message: "Mailing list member has been deleted" });
    }),
  );
}
