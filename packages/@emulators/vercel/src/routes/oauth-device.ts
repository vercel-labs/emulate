import { randomBytes } from "crypto";
import type { Context, RouteContext, Store, TokenMap } from "@emulators/core";
import { escapeHtml, renderCardPage, renderUserButton, bodyStr } from "@emulators/core";
import { getVercelStore } from "../store.js";
import { formatUser } from "../helpers.js";
import type { VercelUser } from "../entities.js";

export const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

type DeviceGrant = {
  userCode: string;
  clientId: string;
  scope: string;
  username: string | null;
  status: "pending" | "approved" | "denied";
  createdAt: number;
  interval: number;
  lastPolledAt: number;
};

const DEVICE_TTL_MS = 15 * 60 * 1000;
const DEVICE_INTERVAL_S = 5;
const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ23456789";
const SERVICE_LABEL = "Vercel";

function getGrantMap(store: Store): Map<string, DeviceGrant> {
  let map = store.getData<Map<string, DeviceGrant>>("vercel.oauth.deviceGrants");
  if (!map) {
    map = new Map();
    store.setData("vercel.oauth.deviceGrants", map);
  }
  return map;
}

function newUserCode(): string {
  const take = (n: number) =>
    Array.from({ length: n }, () => USER_CODE_ALPHABET[randomBytes(1)[0]! % USER_CODE_ALPHABET.length]).join("");
  return `${take(4)}-${take(4)}`;
}

function uniqueUserCode(grants: Map<string, DeviceGrant>): string {
  for (;;) {
    const code = newUserCode();
    if (![...grants.values()].some((grant) => grant.userCode === code)) return code;
  }
}

function expired(grant: DeviceGrant): boolean {
  return Date.now() - grant.createdAt > DEVICE_TTL_MS;
}

async function readBody(c: Context): Promise<Record<string, unknown>> {
  const contentType = c.req.header("Content-Type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      const parsed = await c.req.json();
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  const params = new URLSearchParams(await c.req.text());
  return Object.fromEntries(params);
}

/** The device authorization endpoints and the token exchange's device grant, as RFC 8628 describes them. */
export function deviceRoutes({ app, store, baseUrl }: RouteContext): void {
  const vs = getVercelStore(store);

  app.get("/.well-known/openid-configuration", (c) =>
    c.json({
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/oauth/authorize`,
      token_endpoint: `${baseUrl}/login/oauth/token`,
      userinfo_endpoint: `${baseUrl}/login/oauth/userinfo`,
      device_authorization_endpoint: `${baseUrl}/oauth/device_authorization`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", DEVICE_GRANT_TYPE],
      scopes_supported: ["openid", "email", "profile"],
      token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic", "none"],
      code_challenge_methods_supported: ["S256", "plain"],
    }),
  );

  app.post("/oauth/device_authorization", async (c) => {
    const body = await readBody(c);
    const clientId = typeof body.client_id === "string" ? body.client_id : "";
    const scope = typeof body.scope === "string" && body.scope ? body.scope : "openid";

    if (vs.integrations.all().length > 0) {
      const integration = vs.integrations.findOneBy("client_id", clientId);
      if (!integration)
        return c.json({ error: "invalid_client", error_description: "The client_id passed is incorrect." }, 401);
    }

    const grants = getGrantMap(store);
    const deviceCode = randomBytes(32).toString("base64url");
    const userCode = uniqueUserCode(grants);
    grants.set(deviceCode, {
      userCode,
      clientId,
      scope,
      username: null,
      status: "pending",
      createdAt: Date.now(),
      interval: DEVICE_INTERVAL_S,
      lastPolledAt: 0,
    });

    return c.json({
      device_code: deviceCode,
      user_code: userCode,
      verification_uri: `${baseUrl}/oauth/device`,
      verification_uri_complete: `${baseUrl}/oauth/device?user_code=${encodeURIComponent(userCode)}`,
      expires_in: Math.floor(DEVICE_TTL_MS / 1000),
      interval: DEVICE_INTERVAL_S,
    });
  });

  app.get("/oauth/device", (c) => {
    const userCode = c.req.query("user_code") ?? "";
    const users = vs.users.all();
    const buttons = (code: string) =>
      users
        .map((user) => {
          const u = formatUser(user);
          return renderUserButton({
            letter: (u.username[0] ?? "?").toUpperCase(),
            login: u.username,
            name: u.name ?? undefined,
            email: u.email,
            formAction: "/oauth/device/callback",
            hiddenFields: { username: u.username, user_code: code },
          });
        })
        .join("\n");

    if (!userCode) {
      const body = `
        <form method="get" action="/oauth/device">
          <input type="text" name="user_code" class="checkout-input" placeholder="XXXX-XXXX" autocomplete="one-time-code"/>
          <button type="submit" class="checkout-pay-btn">Continue</button>
        </form>`;
      return c.html(renderCardPage("Connect a device", "Enter the code shown on your device.", body, SERVICE_LABEL));
    }

    const grant = [...getGrantMap(store).values()].find((candidate) => candidate.userCode === userCode);
    if (!grant) {
      return c.html(
        renderCardPage(
          "Code not found",
          `The code '${escapeHtml(userCode)}' is invalid or expired.`,
          "",
          SERVICE_LABEL,
        ),
        400,
      );
    }
    const subtitle = `Approve sign-in for the device showing <strong>${escapeHtml(userCode)}</strong>.`;
    const body = users.length === 0 ? '<p class="empty">No users in the emulator store.</p>' : buttons(userCode);
    return c.html(renderCardPage("Connect a device", subtitle, body, SERVICE_LABEL));
  });

  app.post("/oauth/device/callback", async (c) => {
    const body = await c.req.parseBody();
    const userCode = bodyStr(body.user_code);
    const username = bodyStr(body.username);
    const decision = bodyStr(body.decision);
    const grant = [...getGrantMap(store).values()].find((candidate) => candidate.userCode === userCode);
    if (!grant || expired(grant)) {
      return c.html(
        renderCardPage(
          "Code not found",
          `The code '${escapeHtml(userCode)}' is invalid or expired.`,
          "",
          SERVICE_LABEL,
        ),
        400,
      );
    }
    const user = vs.users.findOneBy("username", username as VercelUser["username"]);
    if (!user) {
      return c.html(
        renderCardPage("User not found", "Choose a user seeded in the emulator store.", "", SERVICE_LABEL),
        400,
      );
    }
    grant.username = decision === "deny" ? grant.username : user.username;
    grant.status = decision === "deny" ? "denied" : "approved";
    return c.html(
      renderCardPage(
        decision === "deny" ? "Request denied" : "Device connected",
        decision === "deny"
          ? "You can close this page."
          : `You can return to the device signed in as ${escapeHtml(user.username)}.`,
        "",
        SERVICE_LABEL,
      ),
    );
  });
}

/** The token endpoint's device grant: pending until a person approves it, then the same token an authorization code makes. */
export function exchangeDeviceGrant(
  c: Context,
  store: Store,
  tokenMap: TokenMap | undefined,
  body: Record<string, unknown>,
): Response {
  const vs = getVercelStore(store);
  const deviceCode = typeof body.device_code === "string" ? body.device_code : "";
  const grants = getGrantMap(store);
  const grant = grants.get(deviceCode);
  const fail = (error: string, description: string, status = 400) =>
    c.json({ error, error_description: description }, status);

  if (!grant) return fail("invalid_grant", "The device code is invalid or expired.");
  const clientId = typeof body.client_id === "string" ? body.client_id : "";
  if (grant.clientId && clientId !== grant.clientId)
    return fail("invalid_grant", "The device code was issued to another client.");
  if (expired(grant)) {
    grants.delete(deviceCode);
    return fail("expired_token", "The device code has expired.");
  }
  if (grant.status === "denied") {
    grants.delete(deviceCode);
    return fail("access_denied", "The user denied the authorization request.");
  }
  if (grant.status === "pending") {
    const now = Date.now();
    if (grant.lastPolledAt !== 0 && now - grant.lastPolledAt < grant.interval * 1000)
      return fail("slow_down", "The client is polling too quickly.", 429);
    grant.lastPolledAt = now;
    return fail("authorization_pending", "The authorization request is still pending.");
  }

  const user = grant.username ? vs.users.findOneBy("username", grant.username as VercelUser["username"]) : undefined;
  if (!user) return fail("invalid_grant", "The user associated with this device code was not found.");
  grants.delete(deviceCode);

  const token = "vercel_" + randomBytes(20).toString("base64url");
  const scopes = grant.scope ? grant.scope.split(/[,\s]+/).filter(Boolean) : [];
  if (tokenMap) tokenMap.set(token, { login: user.username, id: user.id, scopes });
  return c.json({ access_token: token, token_type: "Bearer", scope: grant.scope });
}
