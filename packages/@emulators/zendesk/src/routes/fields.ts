import type { FieldOption, FieldType, ZendeskCustomField, ZendeskTicketField } from "../entities.js";
import {
  formatBrand,
  formatCustomField,
  formatCustomStatus,
  formatTicketField,
  formatTicketForm,
} from "../formatters.js";
import {
  api,
  bool,
  list,
  num,
  obj,
  parseJsonBody,
  recordInvalid,
  recordNotFound,
  requireAgent,
  route,
  str,
  strOrNull,
  zendeskList,
} from "../helpers.js";
import { nextId } from "../ids.js";
import { isCustomFieldType } from "../ticket-service.js";
import { idParam, liveOrganizations, liveTickets, liveUsers, type ZendeskRouteContext } from "../route-utils.js";

const CUSTOM_TICKET_FIELD_TYPES = new Set<string>([
  "text",
  "textarea",
  "checkbox",
  "date",
  "integer",
  "decimal",
  "regexp",
  "tagger",
  "multiselect",
  "lookup",
  "partialcreditcard",
]);

export function parseFieldOptions(
  zs: ZendeskRouteContext["zs"],
  value: unknown,
  existing: FieldOption[] = [],
): FieldOption[] {
  return list(value)
    .map(obj)
    .filter((option) => option.name !== undefined)
    .map((option) => {
      const name = String(option.name);
      const optionValue = str(option.value) ?? name.toLowerCase().replace(/[^a-z0-9]+/g, "_");
      const previous = existing.find(
        (candidate) => (option.id !== undefined && candidate.id === num(option.id)) || candidate.value === optionValue,
      );
      return {
        id: previous?.id ?? nextId(zs, "custom_field_options"),
        name,
        raw_name: name,
        value: optionValue,
        default: bool(option.default) ?? false,
      };
    });
}

export function fieldRoutes(rc: ZendeskRouteContext): void {
  const { app, zs, fmt } = rc;

  route(
    app,
    "get",
    "/api/v2/ticket_fields",
    api(zs, (c) => {
      const localeFilter = c.req.query("locale");
      void localeFilter;
      return zendeskList(
        c,
        [...zs.ticketFields.all()].sort((a, b) => a.position - b.position || a.id - b.id),
        "ticket_fields",
        (field) => formatTicketField(fmt, field),
      );
    }),
  );

  route(
    app,
    "get",
    "/api/v2/ticket_fields/count",
    api(zs, (c) => c.json({ count: { value: zs.ticketFields.count(), refreshed_at: new Date().toISOString() } })),
  );

  route(
    app,
    "post",
    "/api/v2/ticket_fields",
    api(zs, async (c, auth) => {
      requireAgent(auth);
      const body = await parseJsonBody(c);
      const input = obj(body.ticket_field);
      const type = str(input.type) ?? "";
      if (!CUSTOM_TICKET_FIELD_TYPES.has(type))
        throw recordInvalid({ type: `Type: ${type} is not a valid custom field type` });
      const title = str(input.title)?.trim();
      if (!title) throw recordInvalid({ title: "Title: cannot be blank" });
      const options = parseFieldOptions(zs, input.custom_field_options);
      if ((type === "tagger" || type === "multiselect") && options.length === 0) {
        throw recordInvalid({ custom_field_options: "Custom field options: cannot be blank for dropdown fields" });
      }
      const field = zs.ticketFields.insert({
        zd_id: nextId(zs, "ticket_fields"),
        type: type as FieldType,
        title,
        description: str(input.description) ?? "",
        position: num(input.position) ?? zs.ticketFields.count() + 1,
        active: bool(input.active) ?? true,
        required: bool(input.required) ?? false,
        required_in_portal: bool(input.required_in_portal) ?? false,
        visible_in_portal: bool(input.visible_in_portal) ?? false,
        editable_in_portal: bool(input.editable_in_portal) ?? false,
        collapsed_for_agents: bool(input.collapsed_for_agents) ?? false,
        title_in_portal: str(input.title_in_portal) ?? title,
        agent_description: strOrNull(input.agent_description),
        tag: strOrNull(input.tag),
        regexp_for_validation: strOrNull(input.regexp_for_validation),
        removable: true,
        custom_field_options: options,
        system_field_options: [],
      });
      for (const ticket of zs.tickets.all()) {
        zs.tickets.update(ticket.id, { custom_fields: [...ticket.custom_fields, { id: field.zd_id, value: null }] });
      }
      return c.json({ ticket_field: formatTicketField(fmt, field) }, 201);
    }),
  );

  route(
    app,
    "get",
    "/api/v2/ticket_fields/:id",
    api(zs, (c) => {
      const field = zs.ticketFields.findOneBy("zd_id", idParam(c.req.param("id")));
      if (!field) throw recordNotFound();
      return c.json({ ticket_field: formatTicketField(fmt, field) });
    }),
  );

  route(
    app,
    "put",
    "/api/v2/ticket_fields/:id",
    api(zs, async (c, auth) => {
      requireAgent(auth);
      const field = zs.ticketFields.findOneBy("zd_id", idParam(c.req.param("id")));
      if (!field) throw recordNotFound();
      const body = await parseJsonBody(c);
      const input = obj(body.ticket_field);
      const updates: Partial<ZendeskTicketField> = {};
      if (input.title !== undefined) updates.title = str(input.title) ?? field.title;
      if (input.description !== undefined) updates.description = str(input.description) ?? "";
      if (input.position !== undefined) updates.position = num(input.position) ?? field.position;
      if (input.active !== undefined) updates.active = bool(input.active) ?? field.active;
      if (input.required !== undefined) updates.required = bool(input.required) ?? field.required;
      if (input.required_in_portal !== undefined)
        updates.required_in_portal = bool(input.required_in_portal) ?? field.required_in_portal;
      if (input.visible_in_portal !== undefined)
        updates.visible_in_portal = bool(input.visible_in_portal) ?? field.visible_in_portal;
      if (input.editable_in_portal !== undefined)
        updates.editable_in_portal = bool(input.editable_in_portal) ?? field.editable_in_portal;
      if (input.title_in_portal !== undefined)
        updates.title_in_portal = str(input.title_in_portal) ?? field.title_in_portal;
      if (input.agent_description !== undefined) updates.agent_description = strOrNull(input.agent_description);
      if (input.tag !== undefined) updates.tag = strOrNull(input.tag);
      if (input.regexp_for_validation !== undefined)
        updates.regexp_for_validation = strOrNull(input.regexp_for_validation);
      if (input.custom_field_options !== undefined)
        updates.custom_field_options = parseFieldOptions(zs, input.custom_field_options, field.custom_field_options);
      const updated = zs.ticketFields.update(field.id, updates)!;
      return c.json({ ticket_field: formatTicketField(fmt, updated) });
    }),
  );

  route(
    app,
    "delete",
    "/api/v2/ticket_fields/:id",
    api(zs, (c, auth) => {
      requireAgent(auth);
      const field = zs.ticketFields.findOneBy("zd_id", idParam(c.req.param("id")));
      if (!field) throw recordNotFound();
      if (!field.removable || !isCustomFieldType(field.type))
        throw recordInvalid({ base: "System fields cannot be deleted" });
      zs.ticketFields.delete(field.id);
      for (const ticket of zs.tickets.all()) {
        zs.tickets.update(ticket.id, {
          custom_fields: ticket.custom_fields.filter((value) => value.id !== field.zd_id),
        });
      }
      return c.body(null, 204);
    }),
  );

  route(
    app,
    "get",
    "/api/v2/ticket_fields/:id/options",
    api(zs, (c) => {
      const field = zs.ticketFields.findOneBy("zd_id", idParam(c.req.param("id")));
      if (!field) throw recordNotFound();
      return c.json({
        custom_field_options: field.custom_field_options,
        count: field.custom_field_options.length,
        next_page: null,
        previous_page: null,
      });
    }),
  );

  route(
    app,
    "post",
    "/api/v2/ticket_fields/:id/options",
    api(zs, async (c, auth) => {
      requireAgent(auth);
      const field = zs.ticketFields.findOneBy("zd_id", idParam(c.req.param("id")));
      if (!field) throw recordNotFound();
      const body = await parseJsonBody(c);
      const [option] = parseFieldOptions(zs, [body.custom_field_option], field.custom_field_options);
      if (!option) throw recordInvalid({ name: "Name: cannot be blank" });
      const options = field.custom_field_options.some((candidate) => candidate.id === option.id)
        ? field.custom_field_options.map((candidate) => (candidate.id === option.id ? option : candidate))
        : [...field.custom_field_options, option];
      zs.ticketFields.update(field.id, { custom_field_options: options });
      return c.json({ custom_field_option: option }, 201);
    }),
  );

  const customFieldRoutes = (kind: "user" | "organization") => {
    const path = `/api/v2/${kind}_fields`;
    const key = `${kind}_fields`;
    const single = `${kind}_field`;
    const liveFields = () =>
      [...zs.customFields.findBy("kind", kind)].sort((a, b) => a.position - b.position || a.id - b.id);

    route(
      app,
      "get",
      path,
      api(zs, (c) => zendeskList(c, liveFields(), key, (field) => formatCustomField(fmt, field))),
    );

    route(
      app,
      "post",
      path,
      api(zs, async (c, auth) => {
        requireAgent(auth);
        const body = await parseJsonBody(c);
        const input = obj(body[single]);
        const title = str(input.title)?.trim();
        if (!title) throw recordInvalid({ title: "Title: cannot be blank" });
        const fieldKey = str(input.key) ?? title.toLowerCase().replace(/[^a-z0-9]+/g, "_");
        if (liveFields().some((field) => field.key === fieldKey))
          throw recordInvalid({ key: "Key: has already been taken" });
        const type = str(input.type) ?? "text";
        const field = zs.customFields.insert({
          zd_id: nextId(zs, `${kind}_fields`),
          kind,
          key: fieldKey,
          type,
          title,
          description: str(input.description) ?? "",
          position: num(input.position) ?? liveFields().length + 1,
          active: bool(input.active) ?? true,
          custom_field_options: parseFieldOptions(zs, input.custom_field_options),
        });
        return c.json({ [single]: formatCustomField(fmt, field) }, 201);
      }),
    );

    route(
      app,
      "get",
      `${path}/:id`,
      api(zs, (c) => {
        const field = findCustomField(zs, kind, c.req.param("id"));
        return c.json({ [single]: formatCustomField(fmt, field) });
      }),
    );

    route(
      app,
      "put",
      `${path}/:id`,
      api(zs, async (c, auth) => {
        requireAgent(auth);
        const field = findCustomField(zs, kind, c.req.param("id"));
        const body = await parseJsonBody(c);
        const input = obj(body[single]);
        const updates: Partial<ZendeskCustomField> = {};
        if (input.title !== undefined) updates.title = str(input.title) ?? field.title;
        if (input.description !== undefined) updates.description = str(input.description) ?? "";
        if (input.position !== undefined) updates.position = num(input.position) ?? field.position;
        if (input.active !== undefined) updates.active = bool(input.active) ?? field.active;
        if (input.custom_field_options !== undefined)
          updates.custom_field_options = parseFieldOptions(zs, input.custom_field_options, field.custom_field_options);
        const updated = zs.customFields.update(field.id, updates)!;
        return c.json({ [single]: formatCustomField(fmt, updated) });
      }),
    );

    route(
      app,
      "delete",
      `${path}/:id`,
      api(zs, (c, auth) => {
        requireAgent(auth);
        const field = findCustomField(zs, kind, c.req.param("id"));
        zs.customFields.delete(field.id);
        return c.body(null, 204);
      }),
    );
  };

  customFieldRoutes("user");
  customFieldRoutes("organization");

  route(
    app,
    "get",
    "/api/v2/tags",
    api(zs, (c, auth) => {
      requireAgent(auth);
      const counts = new Map<string, number>();
      const bump = (tags: string[]) => {
        for (const tag of tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
      };
      for (const ticket of liveTickets(zs)) bump(ticket.tags);
      for (const user of liveUsers(zs)) bump(user.tags);
      for (const organization of liveOrganizations(zs)) bump(organization.tags);
      const tags = [...counts.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
      return c.json({ tags, count: tags.length, next_page: null, previous_page: null });
    }),
  );

  route(
    app,
    "get",
    "/api/v2/autocomplete/tags",
    api(zs, (c, auth) => {
      requireAgent(auth);
      const name = (c.req.query("name") ?? "").toLowerCase();
      const tags = new Set<string>();
      for (const ticket of liveTickets(zs)) for (const tag of ticket.tags) if (tag.startsWith(name)) tags.add(tag);
      for (const user of liveUsers(zs)) for (const tag of user.tags) if (tag.startsWith(name)) tags.add(tag);
      for (const organization of liveOrganizations(zs))
        for (const tag of organization.tags) if (tag.startsWith(name)) tags.add(tag);
      return c.json({ tags: [...tags].sort() });
    }),
  );

  route(
    app,
    "get",
    "/api/v2/custom_statuses",
    api(zs, (c) => {
      const category = c.req.query("status_categories");
      const active = c.req.query("active");
      let statuses = zs.customStatuses.all();
      if (category) statuses = statuses.filter((status) => category.split(",").includes(status.status_category));
      if (active !== undefined) statuses = statuses.filter((status) => String(status.active) === active);
      return c.json({ custom_statuses: statuses.map(formatCustomStatus) });
    }),
  );

  route(
    app,
    "get",
    "/api/v2/custom_statuses/:id",
    api(zs, (c) => {
      const status = zs.customStatuses.findOneBy("zd_id", idParam(c.req.param("id")));
      if (!status) throw recordNotFound();
      return c.json({ custom_status: formatCustomStatus(status) });
    }),
  );

  route(
    app,
    "post",
    "/api/v2/custom_statuses",
    api(zs, async (c, auth) => {
      requireAgent(auth);
      const body = await parseJsonBody(c);
      const input = obj(body.custom_status);
      const category = str(input.status_category);
      if (category !== "open" && category !== "pending" && category !== "hold" && category !== "solved") {
        throw recordInvalid({ status_category: "Status category: must be open, pending, hold or solved" });
      }
      const label = str(input.agent_label)?.trim();
      if (!label) throw recordInvalid({ agent_label: "Agent label: cannot be blank" });
      const status = zs.customStatuses.insert({
        zd_id: nextId(zs, "custom_statuses"),
        status_category: category,
        agent_label: label,
        end_user_label: str(input.end_user_label) ?? label,
        description: str(input.description) ?? "",
        end_user_description: str(input.end_user_description) ?? "",
        active: bool(input.active) ?? true,
        default: false,
      });
      return c.json({ custom_status: formatCustomStatus(status) }, 201);
    }),
  );

  route(
    app,
    "get",
    "/api/v2/ticket_forms",
    api(zs, (c) => c.json({ ticket_forms: zs.ticketForms.all().map((form) => formatTicketForm(fmt, form)) })),
  );

  route(
    app,
    "get",
    "/api/v2/ticket_forms/:id",
    api(zs, (c) => {
      const form = zs.ticketForms.findOneBy("zd_id", idParam(c.req.param("id")));
      if (!form) throw recordNotFound();
      return c.json({ ticket_form: formatTicketForm(fmt, form) });
    }),
  );

  route(
    app,
    "get",
    "/api/v2/brands",
    api(zs, (c) => zendeskList(c, zs.brands.all(), "brands", (brand) => formatBrand(fmt, brand))),
  );

  route(
    app,
    "get",
    "/api/v2/brands/:id",
    api(zs, (c) => {
      const brand = zs.brands.findOneBy("zd_id", idParam(c.req.param("id")));
      if (!brand) throw recordNotFound();
      return c.json({ brand: formatBrand(fmt, brand) });
    }),
  );
}

function findCustomField(
  zs: ZendeskRouteContext["zs"],
  kind: "user" | "organization",
  rawId: string,
): ZendeskCustomField {
  const cleaned = rawId.replace(/\.json$/, "");
  const numeric = Number(cleaned);
  const field = Number.isFinite(numeric)
    ? zs.customFields.findBy("kind", kind).find((candidate) => candidate.zd_id === numeric)
    : zs.customFields.findBy("kind", kind).find((candidate) => candidate.key === cleaned);
  if (!field) throw recordNotFound();
  return field;
}
