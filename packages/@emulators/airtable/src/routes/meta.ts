import type { RouteContext } from "@emulators/core";
import { getAirtableStore } from "../store.js";
import { airtableNotFound } from "../helpers.js";
import { resolveBase, tableFields } from "../schema.js";

export function metaRoutes({ app, store }: RouteContext): void {
  const s = () => getAirtableStore(store);

  // GET /v0/meta/whoami — the token's identity. Scopes are included so the agent2
  // gateway's identity probe can read them.
  app.get("/v0/meta/whoami", (c) => {
    const user = s().users.all()[0];
    if (!user) return c.json({ id: "usrEmulatorDefault", scopes: [] });
    return c.json({ id: user.user_id, email: user.email, scopes: user.scopes });
  });

  // GET /v0/meta/bases — bases the token can access.
  app.get("/v0/meta/bases", (c) => {
    const bases = s()
      .bases.all()
      .map((b) => ({ id: b.base_id, name: b.name, permissionLevel: b.permission_level }));
    return c.json({ bases });
  });

  // GET /v0/meta/bases/:baseId/tables — the base schema (tables, fields, views).
  app.get("/v0/meta/bases/:baseId/tables", (c) => {
    const baseId = c.req.param("baseId");
    if (!resolveBase(store, baseId)) return airtableNotFound(c);

    const tables = s()
      .tables.findBy("base_id", baseId)
      .map((t) => ({
        id: t.table_id,
        name: t.name,
        primaryFieldId: t.primary_field_id,
        description: t.description ?? undefined,
        fields: tableFields(store, t.table_id).map((f) => ({
          id: f.field_id,
          name: f.name,
          type: f.type,
          options: f.options ?? undefined,
        })),
        views: s()
          .views.findBy("table_id", t.table_id)
          .map((v) => ({ id: v.view_id, name: v.name, type: v.type })),
      }));

    return c.json({ tables });
  });
}
