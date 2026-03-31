import { parsePagination, setLinkHeader, type RouteContext } from "@emulators/core";
import { DEFAULT_AUDIENCE, generateOktaId, normalizeAuthServerStatus } from "../helpers.js";
import {
  authorizationServerResponse,
  findAuthorizationServerByRef,
  oktaError,
  readJsonObject,
  requireManagementAuth,
} from "../route-helpers.js";
import { getOktaStore } from "../store.js";

function normalizeServerId(name: string): string {
  const compact = name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  if (compact.length > 0) return compact;
  return generateOktaId("as");
}

export function authorizationServerRoutes({ app, store, baseUrl, tokenMap }: RouteContext): void {
  const oktaStore = getOktaStore(store);

  app.get("/api/v1/authorizationServers", (c) => {
    const auth = requireManagementAuth(c, tokenMap);
    if (auth instanceof Response) return auth;

    const servers = oktaStore.authorizationServers.all();
    const { page, per_page } = parsePagination(c);
    const total = servers.length;
    const start = (page - 1) * per_page;
    const paged = servers.slice(start, start + per_page);
    setLinkHeader(c, total, page, per_page);
    c.header("X-Total-Count", String(total));

    return c.json(paged.map((server) => authorizationServerResponse(baseUrl, server)));
  });

  app.post("/api/v1/authorizationServers", async (c) => {
    const auth = requireManagementAuth(c, tokenMap);
    if (auth instanceof Response) return auth;

    const body = await readJsonObject(c);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return oktaError(c, 400, "E0000001", "name is required");

    const serverId = typeof body.id === "string" ? body.id : normalizeServerId(name);
    if (oktaStore.authorizationServers.findOneBy("server_id", serverId)) {
      return oktaError(c, 400, "E0000001", `Authorization server '${serverId}' already exists`);
    }

    const audiences = Array.isArray(body.audiences)
      ? body.audiences.filter((entry): entry is string => typeof entry === "string")
      : [DEFAULT_AUDIENCE];

    const created = oktaStore.authorizationServers.insert({
      server_id: serverId,
      name,
      description: typeof body.description === "string" ? body.description : "",
      audiences: audiences.length > 0 ? audiences : [DEFAULT_AUDIENCE],
      status: normalizeAuthServerStatus(typeof body.status === "string" ? body.status : undefined, "ACTIVE"),
    });

    return c.json(authorizationServerResponse(baseUrl, created), 201);
  });

  app.post("/api/v1/authorizationServers/:authServerId/lifecycle/activate", (c) => {
    const auth = requireManagementAuth(c, tokenMap);
    if (auth instanceof Response) return auth;

    const server = findAuthorizationServerByRef(oktaStore, c.req.param("authServerId"));
    if (!server) return oktaError(c, 404, "E0000007", "Not found: authorization server");
    const updated = oktaStore.authorizationServers.update(server.id, { status: "ACTIVE" });
    return c.json(authorizationServerResponse(baseUrl, updated ?? server));
  });

  app.post("/api/v1/authorizationServers/:authServerId/lifecycle/deactivate", (c) => {
    const auth = requireManagementAuth(c, tokenMap);
    if (auth instanceof Response) return auth;

    const server = findAuthorizationServerByRef(oktaStore, c.req.param("authServerId"));
    if (!server) return oktaError(c, 404, "E0000007", "Not found: authorization server");
    const updated = oktaStore.authorizationServers.update(server.id, { status: "INACTIVE" });
    return c.json(authorizationServerResponse(baseUrl, updated ?? server));
  });

  app.get("/api/v1/authorizationServers/:authServerId", (c) => {
    const auth = requireManagementAuth(c, tokenMap);
    if (auth instanceof Response) return auth;

    const server = findAuthorizationServerByRef(oktaStore, c.req.param("authServerId"));
    if (!server) return oktaError(c, 404, "E0000007", "Not found: authorization server");
    return c.json(authorizationServerResponse(baseUrl, server));
  });

  app.put("/api/v1/authorizationServers/:authServerId", async (c) => {
    const auth = requireManagementAuth(c, tokenMap);
    if (auth instanceof Response) return auth;

    const server = findAuthorizationServerByRef(oktaStore, c.req.param("authServerId"));
    if (!server) return oktaError(c, 404, "E0000007", "Not found: authorization server");

    const body = await readJsonObject(c);
    const audiences = Array.isArray(body.audiences)
      ? body.audiences.filter((entry): entry is string => typeof entry === "string")
      : server.audiences;

    const updated = oktaStore.authorizationServers.update(server.id, {
      name: typeof body.name === "string" ? body.name : server.name,
      description: typeof body.description === "string" ? body.description : server.description,
      audiences: audiences.length > 0 ? audiences : server.audiences,
      status: normalizeAuthServerStatus(typeof body.status === "string" ? body.status : undefined, server.status),
    });
    return c.json(authorizationServerResponse(baseUrl, updated ?? server));
  });

  app.delete("/api/v1/authorizationServers/:authServerId", (c) => {
    const auth = requireManagementAuth(c, tokenMap);
    if (auth instanceof Response) return auth;

    const server = findAuthorizationServerByRef(oktaStore, c.req.param("authServerId"));
    if (!server) return oktaError(c, 404, "E0000007", "Not found: authorization server");

    for (const client of oktaStore.oauthClients.findBy("auth_server_id", server.server_id)) {
      oktaStore.oauthClients.delete(client.id);
    }
    oktaStore.authorizationServers.delete(server.id);
    return new Response(null, { status: 204 });
  });
}
