import type { AppEnv, Hono, RouteContext, ServicePlugin, Store, TokenMap, WebhookDispatcher } from "@emulators/core";
import { getJiraStore } from "./store.js";
import { GATEWAY_HEADER, jiraErrorResponse, JiraError } from "./context.js";
import { seedDefaults } from "./seed.js";
import { platformRoutes } from "./routes/platform.js";
import { projectRoutes } from "./routes/projects.js";
import { issueRoutes } from "./routes/issues.js";
import { searchRoutes } from "./routes/search.js";
import { agileRoutes } from "./routes/agile.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { oauthRoutes } from "./routes/oauth.js";
import { inspectorRoutes } from "./routes/inspector.js";
import { subresourceRoutes } from "./routes/subresources.js";

export { getJiraStore, type JiraStore } from "./store.js";
export * from "./entities.js";
export * from "./seed.js";

export const jiraPlugin: ServicePlugin = {
  name: "jira",
  register(app: Hono<AppEnv>, store: Store, webhooks: WebhookDispatcher, baseUrl: string, tokenMap?: TokenMap): void {
    // api.atlassian.com style gateway: /ex/jira/{cloudId}/rest/... serves the same API as /rest/...
    app.use("/ex/jira/:cloudId/:rest{.*}", async (c) => {
      const cloud = c.req.param("cloudId");
      if (!getJiraStore(store).sites.findOneBy("cloud_id", cloud)) {
        return jiraErrorResponse(c, new JiraError(404, [`Site ${cloud} not found`]));
      }
      const url = new URL(c.req.url);
      const target = new URL(`/${c.req.param("rest")}${url.search}`, url.origin);
      const headers = new Headers(c.req.raw.headers);
      headers.set(GATEWAY_HEADER, cloud);
      const method = c.req.method;
      const body = method === "GET" || method === "HEAD" ? undefined : await c.req.arrayBuffer();
      return app.fetch(new Request(target, { method, headers, body }));
    });

    const ctx: RouteContext = { app, store, webhooks, baseUrl, tokenMap };
    platformRoutes(ctx);
    projectRoutes(ctx);
    searchRoutes(ctx);
    issueRoutes(ctx);
    subresourceRoutes(ctx);
    agileRoutes(ctx);
    webhookRoutes(ctx);
    oauthRoutes(ctx);
    inspectorRoutes(ctx);

    for (const method of ["GET", "POST", "PUT", "DELETE", "PATCH"]) {
      app.on(method, "/rest/:rest{.*}", (c) =>
        jiraErrorResponse(c, new JiraError(404, ["No resource found for this path."])),
      );
    }
  },
  seed(store: Store, baseUrl: string): void {
    seedDefaults(store, baseUrl);
  },
};

export default jiraPlugin;
