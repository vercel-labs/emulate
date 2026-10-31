import type { AppEnv, Hono, MiddlewareHandler, Store } from "@emulators/core";
import { googleApiError } from "./helpers.js";
import { getAccessTokens } from "./oauth-tokens.js";
import { getGoogleStore } from "./store.js";

const googleScopes = (...names: string[]) => names.map((name) => `https://www.googleapis.com/auth/${name}`);
const mail = "https://mail.google.com/";
const gmailRead = [mail, ...googleScopes("gmail.readonly", "gmail.modify", "gmail.metadata")];
const gmailBody = [mail, ...googleScopes("gmail.readonly", "gmail.modify")];
const gmailModify = [mail, ...googleScopes("gmail.modify")];
const gmailDraftRead = [mail, ...googleScopes("gmail.readonly", "gmail.modify", "gmail.compose")];
const gmailCompose = [mail, ...googleScopes("gmail.modify", "gmail.compose")];
const gmailInsert = [mail, ...googleScopes("gmail.modify", "gmail.insert")];
const gmailLabels = [mail, ...googleScopes("gmail.modify", "gmail.labels")];
const gmailSettingsRead = [mail, ...googleScopes("gmail.readonly", "gmail.modify", "gmail.settings.basic")];
const driveRead = googleScopes("drive", "drive.readonly", "drive.file", "drive.metadata", "drive.metadata.readonly");
const driveContent = googleScopes("drive", "drive.readonly", "drive.file");
const calendarRead = googleScopes(
  "calendar",
  "calendar.readonly",
  "calendar.events",
  "calendar.events.readonly",
  "calendar.events.owned",
  "calendar.events.owned.readonly",
  "calendar.events.public.readonly",
  "calendar.app.created",
);
const calendarWrite = googleScopes("calendar", "calendar.events", "calendar.events.owned", "calendar.app.created");

// OAuth scope alternatives for the supported methods. Upload aliases share the same requirements.
const routeScopes: Record<string, string[]> = {
  "GET /oauth2/v2/userinfo": ["openid", "email", "profile", ...googleScopes("userinfo.email", "userinfo.profile")],
  "GET /drive/v3/files": driveRead,
  "GET /drive/v3/files/:fileId": driveRead,
  "POST /drive/v3/files": googleScopes("drive", "drive.file"),
  "PATCH /drive/v3/files/:fileId": googleScopes("drive", "drive.file", "drive.metadata"),
  "PUT /drive/v3/files/:fileId": googleScopes("drive", "drive.file", "drive.metadata"),
  "GET /calendar/v3/users/:userId/calendarList": googleScopes(
    "calendar",
    "calendar.readonly",
    "calendar.calendarlist",
    "calendar.calendarlist.readonly",
  ),
  "GET /calendar/v3/calendars/:calendarId/events": calendarRead,
  "POST /calendar/v3/calendars/:calendarId/events": calendarWrite,
  "DELETE /calendar/v3/calendars/:calendarId/events/:eventId": calendarWrite,
  "POST /calendar/v3/freeBusy": googleScopes(
    "calendar",
    "calendar.readonly",
    "calendar.freebusy",
    "calendar.events.freebusy",
  ),
  "GET /gmail/v1/users/:userId/messages": gmailRead,
  "GET /gmail/v1/users/:userId/messages/:id": gmailRead,
  "GET /gmail/v1/users/:userId/messages/:messageId/attachments/:id": gmailBody,
  "POST /gmail/v1/users/:userId/messages": gmailInsert,
  "POST /gmail/v1/users/:userId/messages/import": gmailInsert,
  "POST /gmail/v1/users/:userId/messages/send": [mail, ...googleScopes("gmail.modify", "gmail.compose", "gmail.send")],
  "POST /gmail/v1/users/:userId/messages/batchModify": gmailModify,
  "POST /gmail/v1/users/:userId/messages/batchDelete": [mail],
  "POST /gmail/v1/users/:userId/messages/:id/modify": gmailModify,
  "POST /gmail/v1/users/:userId/messages/:id/trash": gmailModify,
  "POST /gmail/v1/users/:userId/messages/:id/untrash": gmailModify,
  "DELETE /gmail/v1/users/:userId/messages/:id": [mail],
  "GET /gmail/v1/users/:userId/threads": gmailRead,
  "GET /gmail/v1/users/:userId/threads/:id": gmailRead,
  "POST /gmail/v1/users/:userId/threads/:id/modify": gmailModify,
  "POST /gmail/v1/users/:userId/threads/:id/trash": gmailModify,
  "POST /gmail/v1/users/:userId/threads/:id/untrash": gmailModify,
  "DELETE /gmail/v1/users/:userId/threads/:id": [mail],
  "GET /gmail/v1/users/:userId/drafts": gmailDraftRead,
  "GET /gmail/v1/users/:userId/drafts/:id": gmailDraftRead,
  "POST /gmail/v1/users/:userId/drafts": gmailCompose,
  "PUT /gmail/v1/users/:userId/drafts/:id": gmailCompose,
  "DELETE /gmail/v1/users/:userId/drafts/:id": gmailCompose,
  "POST /gmail/v1/users/:userId/drafts/send": gmailCompose,
  "GET /gmail/v1/users/:userId/labels": [...gmailRead, ...googleScopes("gmail.labels")],
  "GET /gmail/v1/users/:userId/labels/:id": [...gmailRead, ...googleScopes("gmail.labels")],
  "POST /gmail/v1/users/:userId/labels": gmailLabels,
  "PUT /gmail/v1/users/:userId/labels/:id": gmailLabels,
  "PATCH /gmail/v1/users/:userId/labels/:id": gmailLabels,
  "DELETE /gmail/v1/users/:userId/labels/:id": gmailLabels,
  "GET /gmail/v1/users/:userId/history": gmailRead,
  "POST /gmail/v1/users/:userId/watch": gmailRead,
  "POST /gmail/v1/users/:userId/stop": gmailRead,
  "GET /gmail/v1/users/:userId/settings/filters": gmailSettingsRead,
  "POST /gmail/v1/users/:userId/settings/filters": googleScopes("gmail.settings.basic"),
  "DELETE /gmail/v1/users/:userId/settings/filters/:id": googleScopes("gmail.settings.basic"),
  "GET /gmail/v1/users/:userId/settings/forwardingAddresses": gmailSettingsRead,
  "GET /gmail/v1/users/:userId/settings/sendAs": gmailSettingsRead,
};

export function googleAuthMiddleware(app: Hono<AppEnv>, store: Store): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (store.getData<boolean>("google.strict_scopes") !== true) return next();
    const route = app.matchedRoute(c.req.method, c.req.path);
    if (!route) return next();
    const path = route.path.replace(/^\/upload\//, "/");
    if (!/^\/(gmail\/v1|drive\/v3|calendar\/v3)\//.test(path) && path !== "/oauth2/v2/userinfo") {
      return next();
    }

    const token = c.req.header("Authorization")?.match(/^Bearer\s+(\S+)\s*$/i)?.[1];
    const record = token ? getAccessTokens(store).get(token) : undefined;
    const user = record && getGoogleStore(store).users.findOneBy("email", record.email);
    if (!token || !record || record.expiresAt <= Date.now() || !user) {
      return googleApiError(c, 401, "Request had invalid authentication credentials.", "authError", "UNAUTHENTICATED");
    }

    let required = routeScopes[`${route.method} ${path}`] ?? [];
    if (route.method === "GET" && path === "/drive/v3/files/:fileId" && c.req.query("alt") === "media") {
      required = driveContent;
    }
    if (
      /\/gmail\/v1\/users\/:userId\/(messages|threads)/.test(path) &&
      (c.req.query("q") ||
        (route.method === "GET" &&
          /\/:id$/.test(path) &&
          !["metadata", "minimal"].includes(c.req.query("format") ?? "full")))
    ) {
      required = required.filter((scope) => !scope.endsWith("/gmail.metadata"));
    }
    if (!required.some((scope) => record.scopes.includes(scope))) {
      return googleApiError(
        c,
        403,
        "Request had insufficient authentication scopes.",
        "insufficientPermissions",
        "PERMISSION_DENIED",
      );
    }

    c.set("authToken", token);
    c.set("authScopes", record.scopes);
    c.set("authUser", { login: user.email, id: user.id, scopes: record.scopes });
    await next();
  };
}
