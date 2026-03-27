import type { RouteContext } from "@emulators/core";
import { getResendStore } from "../store.js";
import { generateUuid, resendError, resendList, parseResendBody } from "../helpers.js";

export function contactRoutes(ctx: RouteContext): void {
  const { app, store, webhooks } = ctx;
  const rs = () => getResendStore(store);

  // Audiences
  app.post("/audiences", async (c) => {
    const body = await parseResendBody(c);
    const name = body.name as string | undefined;

    if (!name) return resendError(c, 422, "validation_error", "Missing required field: name");

    const uuid = generateUuid();
    const audience = rs().audiences.insert({ uuid, name });

    return c.json({
      id: audience.uuid,
      object: "audience",
      name: audience.name,
      created_at: audience.created_at,
    }, 200);
  });

  app.get("/audiences", (c) => {
    const allAudiences = rs().audiences.all();
    return c.json(resendList(allAudiences.map((a) => ({
      id: a.uuid,
      object: "audience",
      name: a.name,
      created_at: a.created_at,
    }))));
  });

  app.delete("/audiences/:id", (c) => {
    const id = c.req.param("id");
    const audience = rs().audiences.findOneBy("uuid", id);
    if (!audience) return resendError(c, 404, "not_found", "Audience not found");

    rs().audiences.delete(audience.id);

    return c.json({ object: "audience", id: audience.uuid, deleted: true });
  });

  // Contacts
  app.post("/audiences/:audience_id/contacts", async (c) => {
    const audienceId = c.req.param("audience_id");
    const audience = rs().audiences.findOneBy("uuid", audienceId);
    if (!audience) return resendError(c, 404, "not_found", "Audience not found");

    const body = await parseResendBody(c);
    const email = body.email as string | undefined;

    if (!email) return resendError(c, 422, "validation_error", "Missing required field: email");

    const uuid = generateUuid();
    const contact = rs().contacts.insert({
      uuid,
      audience_id: audienceId,
      email,
      first_name: (body.first_name as string) ?? null,
      last_name: (body.last_name as string) ?? null,
      unsubscribed: (body.unsubscribed as boolean) ?? false,
    });

    await webhooks.dispatch("contact.created", undefined, { type: "contact.created", data: { id: uuid, email, audience_id: audienceId } }, "resend");

    return c.json({
      id: contact.uuid,
      object: "contact",
      email: contact.email,
    }, 200);
  });

  app.get("/audiences/:audience_id/contacts", (c) => {
    const audienceId = c.req.param("audience_id");
    const audience = rs().audiences.findOneBy("uuid", audienceId);
    if (!audience) return resendError(c, 404, "not_found", "Audience not found");

    const contacts = rs().contacts.findBy("audience_id", audienceId);
    return c.json(resendList(contacts.map((ct) => ({
      id: ct.uuid,
      object: "contact",
      email: ct.email,
      first_name: ct.first_name,
      last_name: ct.last_name,
      unsubscribed: ct.unsubscribed,
      created_at: ct.created_at,
    }))));
  });

  app.delete("/audiences/:audience_id/contacts/:id", async (c) => {
    const audienceId = c.req.param("audience_id");
    const contactId = c.req.param("id");

    const contact = rs().contacts.findOneBy("uuid", contactId);
    if (!contact || contact.audience_id !== audienceId) {
      return resendError(c, 404, "not_found", "Contact not found");
    }

    rs().contacts.delete(contact.id);

    await webhooks.dispatch("contact.deleted", undefined, { type: "contact.deleted", data: { id: contact.uuid, email: contact.email, audience_id: audienceId } }, "resend");

    return c.json({ object: "contact", id: contact.uuid, deleted: true });
  });
}
