import type { Context } from "@emulators/core";
import type { AuthUser } from "@emulators/core";
import type { ContentfulStatusCode } from "@emulators/core";
import type { RouteContext } from "@emulators/core";
import { getVercelStore, type VercelStore } from "../store.js";
import type { VercelIntegrationConfiguration, VercelTeam, VercelUser } from "../entities.js";

function vercelErr(c: Context, status: ContentfulStatusCode, code: string, message: string) {
  return c.json({ error: { code, message } }, status);
}

function formatConfiguration(config: VercelIntegrationConfiguration) {
  return {
    id: config.uid,
    integrationId: config.integrationId,
    ownerId: config.ownerId,
    userId: config.userId,
    teamId: config.teamId,
    projectSelection: config.projectSelection,
    projects: config.projects,
    scopes: config.scopes,
    slug: config.slug,
    type: config.type,
    status: config.status,
    source: config.source,
    installationType: config.installationType,
    canConfigureOpenTelemetry: config.canConfigureOpenTelemetry,
    externalId: config.externalId,
    createdAt: new Date(config.created_at).getTime(),
    updatedAt: new Date(config.updated_at).getTime(),
    completedAt: config.completedAt,
    disabledAt: config.disabledAt,
    disabledReason: config.disabledReason,
    deletedAt: config.deletedAt,
    deleteRequestedAt: config.deleteRequestedAt,
    customerDeleteRequestedAt: config.customerDeleteRequestedAt,
  };
}

function resolveTeamOwnerId(c: Context, vs: VercelStore, auth: AuthUser): string | Response {
  const teamId = c.req.query("teamId");
  if (teamId) {
    const team = vs.teams.findOneBy("uid", teamId as VercelTeam["uid"]);
    if (!team) return vercelErr(c, 403, "forbidden", "Not authorized");
    return team.uid;
  }

  const slug = c.req.query("slug");
  if (slug) {
    const team = vs.teams.findOneBy("slug", slug as VercelTeam["slug"]);
    if (!team) return vercelErr(c, 403, "forbidden", "Not authorized");
    return team.uid;
  }

  const user = vs.users.findOneBy("username", auth.login as VercelUser["username"]);
  if (!user) {
    return vercelErr(c, 403, "forbidden", "Not authorized");
  }
  if (!user.defaultTeamId) {
    return vercelErr(
      c,
      401,
      "missing_team_param",
      "You must supply a `teamId` query parameter or set your default team with `PATCH /user { defaultTeamId: string }`.",
    );
  }

  const team = vs.teams.findOneBy("uid", user.defaultTeamId as VercelTeam["uid"]);
  if (!team) return vercelErr(c, 403, "forbidden", "Not authorized");
  return team.uid;
}

export function integrationsRoutes({ app, store }: RouteContext): void {
  const vs = getVercelStore(store);

  app.get("/v1/integrations/configuration/:id", (c) => {
    const auth = c.get("authUser");
    if (!auth) {
      return vercelErr(c, 401, "not_authenticated", "Authentication required");
    }

    const ownerId = resolveTeamOwnerId(c, vs, auth);
    if (typeof ownerId !== "string") return ownerId;

    const configId = c.req.param("id");
    const config = vs.integrationConfigurations.findOneBy("uid", configId);
    if (!config || config.ownerId !== ownerId) {
      return vercelErr(c, 404, "not_found", "The configuration was not found");
    }

    return c.json(formatConfiguration(config));
  });

  app.delete("/v1/integrations/configuration/:id", (c) => {
    const auth = c.get("authUser");
    if (!auth) {
      return vercelErr(c, 401, "not_authenticated", "Authentication required");
    }

    const ownerId = resolveTeamOwnerId(c, vs, auth);
    if (typeof ownerId !== "string") return ownerId;

    const configId = c.req.param("id");
    const config = vs.integrationConfigurations.findOneBy("uid", configId);
    if (!config || config.ownerId !== ownerId) {
      return vercelErr(c, 404, "not_found", "The configuration was not found");
    }

    vs.integrationConfigurations.delete(config.id);

    return c.body(null, 204);
  });
}
