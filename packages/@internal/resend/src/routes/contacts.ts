import type { RouteContext } from "@internal/core";
import { parseJsonBody, requireAuth } from "@internal/core";
import { getResendStore } from "../store.js";
import { resendError, parseResendPagination, applyResendPagination } from "../helpers.js";
import type { ResendContact } from "../entities.js";

function formatContact(contact: ResendContact) {
  return {
    object: "contact" as const,
    id: String(contact.id),
    email: contact.email,
    first_name: contact.first_name,
    last_name: contact.last_name,
    unsubscribed: contact.unsubscribed,
    properties: contact.properties,
    created_at: contact.created_at,
    updated_at: contact.updated_at,
  };
}

function isEmail(value: string): boolean {
  return value.includes("@");
}

function findContact(rs: ReturnType<typeof getResendStore>, idOrEmail: string): ResendContact | undefined {
  if (isEmail(idOrEmail)) {
    return rs.contacts.findOneBy("email", idOrEmail);
  }
  const id = parseInt(idOrEmail, 10);
  if (isNaN(id)) return undefined;
  return rs.contacts.get(id);
}

export function contactRoutes({ app, store }: RouteContext): void {
  const rs = getResendStore(store);

  // Create contact
  app.post("/contacts", requireAuth(), async (c) => {
    const body = await parseJsonBody(c);

    const email = body.email;
    if (typeof email !== "string" || !email) {
      return resendError(c, 422, "validation_error", "Missing required field: email");
    }

    const contact = rs.contacts.insert({
      email,
      first_name: typeof body.first_name === "string" ? body.first_name : null,
      last_name: typeof body.last_name === "string" ? body.last_name : null,
      unsubscribed: typeof body.unsubscribed === "boolean" ? body.unsubscribed : false,
      properties: body.properties && typeof body.properties === "object" && !Array.isArray(body.properties)
        ? (body.properties as Record<string, unknown>)
        : null,
    });

    return c.json(formatContact(contact));
  });

  // List contacts
  app.get("/contacts", requireAuth(), (c) => {
    const pagination = parseResendPagination(c);
    const allContacts = rs.contacts.all();
    const { data, has_more } = applyResendPagination(allContacts, pagination);

    return c.json({
      object: "list",
      has_more,
      data: data.map(formatContact),
    });
  });

  // Get contact by ID or email
  app.get("/contacts/:id_or_email", requireAuth(), (c) => {
    const idOrEmail = c.req.param("id_or_email");
    const contact = findContact(rs, idOrEmail);
    if (!contact) {
      return resendError(c, 404, "not_found", "Contact not found");
    }
    return c.json(formatContact(contact));
  });

  // Update contact
  app.patch("/contacts/:id_or_email", requireAuth(), async (c) => {
    const idOrEmail = c.req.param("id_or_email");
    const contact = findContact(rs, idOrEmail);
    if (!contact) {
      return resendError(c, 404, "not_found", "Contact not found");
    }

    const body = await parseJsonBody(c);
    const updates: Partial<ResendContact> = {};

    if (typeof body.first_name === "string") {
      updates.first_name = body.first_name;
    }
    if (typeof body.last_name === "string") {
      updates.last_name = body.last_name;
    }
    if (typeof body.unsubscribed === "boolean") {
      updates.unsubscribed = body.unsubscribed;
    }
    if (body.properties && typeof body.properties === "object" && !Array.isArray(body.properties)) {
      updates.properties = body.properties as Record<string, unknown>;
    }

    const updated = rs.contacts.update(contact.id, updates);
    if (!updated) {
      return resendError(c, 404, "not_found", "Contact not found");
    }

    return c.json(formatContact(updated));
  });

  // Delete contact
  app.delete("/contacts/:id_or_email", requireAuth(), (c) => {
    const idOrEmail = c.req.param("id_or_email");
    const contact = findContact(rs, idOrEmail);
    if (!contact) {
      return resendError(c, 404, "not_found", "Contact not found");
    }

    rs.contacts.delete(contact.id);

    return c.json({
      object: "contact",
      contact: String(contact.id),
      deleted: true,
    });
  });
}
