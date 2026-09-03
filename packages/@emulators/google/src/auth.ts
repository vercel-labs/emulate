import type { Context, MiddlewareHandler, Store } from "@emulators/core";
import { googleApiError } from "./helpers.js";

const ACCESS_TOKENS_KEY = "google.oauth.accessTokens";

const DRIVE = "https://www.googleapis.com/auth/drive";
const DRIVE_FILE = "https://www.googleapis.com/auth/drive.file";
const DRIVE_METADATA = "https://www.googleapis.com/auth/drive.metadata";
const DRIVE_METADATA_READONLY = "https://www.googleapis.com/auth/drive.metadata.readonly";
const DRIVE_READONLY = "https://www.googleapis.com/auth/drive.readonly";

const GMAIL = "https://mail.google.com/";
const GMAIL_COMPOSE = "https://www.googleapis.com/auth/gmail.compose";
const GMAIL_INSERT = "https://www.googleapis.com/auth/gmail.insert";
const GMAIL_LABELS = "https://www.googleapis.com/auth/gmail.labels";
const GMAIL_METADATA = "https://www.googleapis.com/auth/gmail.metadata";
const GMAIL_MODIFY = "https://www.googleapis.com/auth/gmail.modify";
const GMAIL_READONLY = "https://www.googleapis.com/auth/gmail.readonly";
const GMAIL_SEND = "https://www.googleapis.com/auth/gmail.send";
const GMAIL_SETTINGS_BASIC = "https://www.googleapis.com/auth/gmail.settings.basic";
const GMAIL_SETTINGS_SHARING = "https://www.googleapis.com/auth/gmail.settings.sharing";

const CALENDAR = "https://www.googleapis.com/auth/calendar";
const CALENDAR_READONLY = "https://www.googleapis.com/auth/calendar.readonly";
const CALENDAR_LIST = "https://www.googleapis.com/auth/calendar.calendarlist";
const CALENDAR_LIST_READONLY = "https://www.googleapis.com/auth/calendar.calendarlist.readonly";
const CALENDAR_EVENTS = "https://www.googleapis.com/auth/calendar.events";
const CALENDAR_EVENTS_READONLY = "https://www.googleapis.com/auth/calendar.events.readonly";
const CALENDAR_EVENTS_OWNED = "https://www.googleapis.com/auth/calendar.events.owned";
const CALENDAR_EVENTS_OWNED_READONLY = "https://www.googleapis.com/auth/calendar.events.owned.readonly";
const CALENDAR_FREEBUSY = "https://www.googleapis.com/auth/calendar.events.freebusy";

export interface GoogleAccessTokenRecord {
  email: string;
  userId: number;
  scopes: string[];
  clientId: string;
  expiresAt: number;
  revoked: boolean;
}

export function getGoogleAccessTokens(store: Store): Map<string, GoogleAccessTokenRecord> {
  let tokens = store.getData<Map<string, GoogleAccessTokenRecord>>(ACCESS_TOKENS_KEY);
  if (!tokens) {
    tokens = new Map();
    store.setData(ACCESS_TOKENS_KEY, tokens);
  }
  return tokens;
}

export function registerGoogleAccessToken(
  store: Store,
  token: string,
  record: Omit<GoogleAccessTokenRecord, "revoked">,
): void {
  getGoogleAccessTokens(store).set(token, { ...record, revoked: false });
}

export function revokeGoogleAccessToken(store: Store, token: string): boolean {
  const tokens = getGoogleAccessTokens(store);
  const record = tokens.get(token);
  if (!record) return false;
  tokens.set(token, { ...record, revoked: true });
  return true;
}

export function googleStrictAuth(store: Store): MiddlewareHandler {
  return async (c, next) => {
    const requiredScopes = requiredScopesForRequest(c);
    if (!requiredScopes || store.getData<boolean>("google.strict_scopes") !== true) {
      await next();
      return;
    }

    const token = bearerToken(c);
    const record = token ? getGoogleAccessTokens(store).get(token) : undefined;
    if (!record || record.revoked || record.expiresAt <= Date.now()) {
      return googleApiError(c, 401, "Request had invalid authentication credentials.", "authError", "UNAUTHENTICATED");
    }

    c.set("authToken", token);
    c.set("authScopes", record.scopes);
    c.set("authUser", { login: record.email, id: record.userId, scopes: record.scopes });

    if (requiredScopes.length > 0 && !record.scopes.some((scope) => requiredScopes.includes(scope))) {
      return googleApiError(
        c,
        403,
        "Request had insufficient authentication scopes.",
        "insufficientPermissions",
        "PERMISSION_DENIED",
      );
    }

    await next();
  };
}

export function driveScopes(c: Context): string[] {
  if (c.req.method === "GET") {
    return [DRIVE, DRIVE_FILE, DRIVE_READONLY, DRIVE_METADATA, DRIVE_METADATA_READONLY];
  }
  if (c.req.method === "PATCH" || c.req.method === "PUT") {
    return [DRIVE, DRIVE_FILE, DRIVE_METADATA];
  }
  return [DRIVE, DRIVE_FILE];
}

export function gmailScopes(c: Context): string[] {
  const path = new URL(c.req.url).pathname;
  const method = c.req.method;

  if (path.includes("/settings/filters")) return [GMAIL, GMAIL_SETTINGS_BASIC];
  if (path.includes("/settings/forwardingAddresses") || path.includes("/settings/sendAs")) {
    return [GMAIL, GMAIL_SETTINGS_BASIC, GMAIL_SETTINGS_SHARING];
  }
  if (path.endsWith("/send") || path.includes("/messages/send")) {
    return [GMAIL, GMAIL_MODIFY, GMAIL_COMPOSE, GMAIL_SEND];
  }
  if (path.includes("/drafts")) {
    return method === "GET"
      ? [GMAIL, GMAIL_MODIFY, GMAIL_COMPOSE, GMAIL_READONLY]
      : [GMAIL, GMAIL_MODIFY, GMAIL_COMPOSE];
  }
  if (path.includes("/labels")) {
    return method === "GET"
      ? [GMAIL, GMAIL_MODIFY, GMAIL_READONLY, GMAIL_METADATA, GMAIL_LABELS]
      : [GMAIL, GMAIL_MODIFY, GMAIL_LABELS];
  }
  if (path.includes("/messages/import") || path.includes("/messages/batchDelete")) {
    return [GMAIL, GMAIL_INSERT];
  }
  if (method === "GET") return [GMAIL, GMAIL_MODIFY, GMAIL_READONLY, GMAIL_METADATA];
  return [GMAIL, GMAIL_MODIFY];
}

export function calendarScopes(c: Context): string[] {
  const path = new URL(c.req.url).pathname;
  if (path.includes("/calendarList")) {
    return [CALENDAR, CALENDAR_READONLY, CALENDAR_LIST, CALENDAR_LIST_READONLY];
  }
  if (path.endsWith("/freeBusy")) return [CALENDAR, CALENDAR_READONLY, CALENDAR_FREEBUSY];
  if (c.req.method === "GET") {
    return [
      CALENDAR,
      CALENDAR_READONLY,
      CALENDAR_EVENTS,
      CALENDAR_EVENTS_READONLY,
      CALENDAR_EVENTS_OWNED,
      CALENDAR_EVENTS_OWNED_READONLY,
    ];
  }
  return [CALENDAR, CALENDAR_EVENTS, CALENDAR_EVENTS_OWNED];
}

export function userinfoScopes(): string[] {
  return [
    "openid",
    "email",
    "profile",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
  ];
}

function requiredScopesForRequest(c: Context): string[] | undefined {
  const path = new URL(c.req.url).pathname;
  if (path === "/oauth2/v2/userinfo") return userinfoScopes();
  if (path.startsWith("/gmail/") || path.startsWith("/upload/gmail/")) return gmailScopes(c);
  if (path.startsWith("/calendar/")) return calendarScopes(c);
  if (path.startsWith("/drive/") || path.startsWith("/upload/drive/")) return driveScopes(c);
  return undefined;
}

function bearerToken(c: Context): string | undefined {
  const match = /^Bearer\s+(\S+)$/i.exec(c.req.header("Authorization") ?? "");
  return match?.[1];
}
