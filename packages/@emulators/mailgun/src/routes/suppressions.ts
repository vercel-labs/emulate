import type { MailgunSuppression, SuppressionKind } from "../entities.js";
import { formatSuppression } from "../formatters.js";
import {
  api,
  badRequest,
  emailValid,
  first,
  notFound,
  pagedItems,
  parseBody,
  parseJson,
  route,
  splitAddresses,
  type ParsedBody,
} from "../helpers.js";
import { findDomain, type MailgunRouteContext } from "../route-utils.js";

interface KindConfig {
  kind: SuppressionKind;
  path: string;
  added: string;
  removed: string;
  cleared: string;
  missing: string;
}

const KINDS: KindConfig[] = [
  {
    kind: "bounce",
    path: "bounces",
    added: "Address has been added to the bounces table",
    removed: "Bounced address has been removed",
    cleared: "Bounced addresses for this domain have been removed",
    missing: "Address not found in bounces table",
  },
  {
    kind: "unsubscribe",
    path: "unsubscribes",
    added: "Address has been added to the unsubscribes table",
    removed: "Unsubscribe event has been removed",
    cleared: "Unsubscribe addresses for this domain have been removed",
    missing: "Address not found in unsubscribers table",
  },
  {
    kind: "complaint",
    path: "complaints",
    added: "Address has been added to the complaints table",
    removed: "Spam complaint has been removed",
    cleared: "Complaint addresses for this domain have been removed",
    missing: "Address not found in complaints table",
  },
  {
    kind: "whitelist",
    path: "whitelists",
    added: "Address/Domain has been added to the whitelists table",
    removed: "Whitelist address/domain has been removed",
    cleared: "Whitelist addresses/domains for this domain have been removed",
    missing: "Address/Domain not found in whitelists table",
  },
];

function entryFromFields(
  kind: SuppressionKind,
  fields: Record<string, unknown>,
): Omit<MailgunSuppression, keyof import("@emulators/core").Entity | "domain"> {
  const rawAddress = String(fields.address ?? fields.domain ?? "")
    .trim()
    .toLowerCase();
  if (!rawAddress)
    throw badRequest(
      kind === "whitelist" ? "'address' or 'domain' parameter is missing" : "'address' parameter is missing",
    );
  if (kind === "whitelist") {
    const isDomain = fields.domain !== undefined || !rawAddress.includes("@");
    return {
      kind,
      address: rawAddress,
      code: null,
      error: null,
      tags: [],
      reason: fields.reason ? String(fields.reason) : null,
      type: isDomain ? "domain" : "address",
    };
  }
  if (!emailValid(rawAddress)) throw badRequest(`'address' parameter is not a valid address: ${rawAddress}`);
  const tagsRaw = fields.tags ?? fields.tag;
  const tags = Array.isArray(tagsRaw)
    ? tagsRaw.map(String)
    : typeof tagsRaw === "string"
      ? tagsRaw
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean)
      : [];
  return {
    kind,
    address: rawAddress,
    code: fields.code !== undefined ? String(fields.code) : kind === "bounce" ? "550" : null,
    error: fields.error !== undefined ? String(fields.error) : null,
    tags: kind === "unsubscribe" ? (tags.length > 0 ? tags : ["*"]) : [],
    reason: null,
    type: "address",
  };
}

function bodyEntries(body: ParsedBody): Array<Record<string, unknown>> {
  const jsonArray = first(body, "__json_array__");
  if (jsonArray) {
    const parsed = parseJson<Array<Record<string, unknown>>>(jsonArray);
    if (!Array.isArray(parsed)) throw badRequest("Request body must be a JSON array");
    return parsed;
  }
  const single: Record<string, unknown> = {};
  for (const [key, values] of Object.entries(body.fields)) single[key] = values.length > 1 ? values : values[0];
  if (Object.keys(single).length === 0) throw badRequest("'address' parameter is missing");
  return [single];
}

export function suppressionRoutes(rc: MailgunRouteContext): void {
  const { app, ms } = rc;

  for (const config of KINDS) {
    const base = `/v3/:domain/${config.path}`;
    const entries = (domain: string) =>
      ms.suppressions.findBy("domain", domain).filter((item) => item.kind === config.kind);

    route(
      app,
      "get",
      base,
      api(
        ms,
        (c) => {
          const domain = findDomain(ms, c.req.param("domain"));
          const term = c.req.query("term")?.toLowerCase();
          const sorted = entries(domain.name)
            .filter((item) => !term || item.address.includes(term))
            .sort((a, b) => a.address.localeCompare(b.address));
          const paged = pagedItems(c, sorted, {
            anchorKey: "address",
            anchor: (item) => item.address,
            defaultLimit: 100,
          });
          return c.json({ items: paged.items.map(formatSuppression), paging: paged.paging });
        },
        "domain",
      ),
    );

    route(
      app,
      "post",
      base,
      api(
        ms,
        async (c) => {
          const domain = findDomain(ms, c.req.param("domain"));
          const body = await parseBody(c);
          const items = bodyEntries(body);
          const created: MailgunSuppression[] = [];
          for (const fields of items) {
            const entry = entryFromFields(config.kind, fields);
            const existing = entries(domain.name).find((item) => item.address === entry.address);
            if (existing) {
              created.push(ms.suppressions.update(existing.id, entry)!);
              continue;
            }
            created.push(ms.suppressions.insert({ domain: domain.name, ...entry }));
          }
          if (items.length > 1)
            return c.json({ message: `${created.length} addresses have been added to the ${config.path} table` });
          const single = created[0];
          if (config.kind === "whitelist")
            return c.json({ message: config.added, type: single.type, value: single.address });
          return c.json({ message: config.added, address: single.address });
        },
        "domain",
      ),
    );

    route(
      app,
      "get",
      `${base}/:address`,
      api(
        ms,
        (c) => {
          const domain = findDomain(ms, c.req.param("domain"));
          const address = decodeURIComponent(c.req.param("address")).toLowerCase();
          const entry = entries(domain.name).find((item) => item.address === address);
          if (!entry) throw notFound(config.missing);
          return c.json(formatSuppression(entry));
        },
        "domain",
      ),
    );

    route(
      app,
      "delete",
      `${base}/:address`,
      api(
        ms,
        (c) => {
          const domain = findDomain(ms, c.req.param("domain"));
          const address = decodeURIComponent(c.req.param("address")).toLowerCase();
          const entry = entries(domain.name).find((item) => item.address === address);
          if (!entry) throw notFound(config.missing);
          ms.suppressions.delete(entry.id);
          if (config.kind === "whitelist") return c.json({ message: config.removed, value: entry.address });
          return c.json({ message: config.removed, address: entry.address });
        },
        "domain",
      ),
    );

    route(
      app,
      "delete",
      base,
      api(
        ms,
        (c) => {
          const domain = findDomain(ms, c.req.param("domain"));
          for (const entry of entries(domain.name)) ms.suppressions.delete(entry.id);
          return c.json({ message: config.cleared });
        },
        "domain",
      ),
    );
  }

  route(
    app,
    "post",
    "/v3/:domain/unsubscribes/import",
    api(
      ms,
      async (c) => {
        const domain = findDomain(ms, c.req.param("domain"));
        const body = await parseBody(c);
        const file = body.files.file?.[0];
        if (!file) throw badRequest("'file' parameter is missing");
        let count = 0;
        for (const line of file.content.toString("utf8").split(/\r?\n/).slice(1)) {
          const [address, tags] = line.split(",").map((item) => item.trim());
          if (!address || !emailValid(address)) continue;
          for (const parsed of splitAddresses(address)) {
            ms.suppressions.insert({
              domain: domain.name,
              kind: "unsubscribe",
              address: parsed.toLowerCase(),
              code: null,
              error: null,
              tags: tags ? [tags] : ["*"],
              reason: null,
              type: "address",
            });
            count++;
          }
        }
        return c.json({ message: `file uploaded successfully (${count} addresses)` });
      },
      "domain",
    ),
  );
}
