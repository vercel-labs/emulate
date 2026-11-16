import type { ConsoleService, ConsoleVariable } from "./types";

const FORM = { "Content-Type": "application/x-www-form-urlencoded" };
const BEARER = { Authorization: "Bearer {{token}}" };
const TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad";
const REDIRECT_URI = "redirect_uri=https://playground.emulate.local/oauth/api/auth/callback/microsoft";

const variables: ConsoleVariable[] = [
  {
    name: "token",
    label: "Access token",
    hint: "Any value works: the emulator treats an unknown bearer token as its default user. Exchange authorization code replaces it with a real token.",
  },
  {
    name: "code",
    label: "Authorization code",
    hint: "Filled in when you run Approve sign-in. The code is single use and expires after 10 minutes.",
  },
  {
    name: "refresh_token",
    label: "Refresh token",
    hint: "Filled in when you run Exchange authorization code or Refresh access token. You can also paste one; each refresh returns a new one.",
  },
  {
    name: "user_id",
    label: "User ID",
    hint: "Filled in when you run Get Graph profile. You can also paste an id.",
  },
];

/** Entra ID sign-in and Microsoft Graph, served by the Microsoft emulator. */
export const microsoft: ConsoleService = {
  name: "microsoft",
  label: "Microsoft",
  description: "Entra ID sign-in, token endpoints, and Microsoft Graph profile lookups.",
  variables,
  groups: [
    {
      title: "Discovery and keys",
      presets: [
        {
          label: "Get discovery document",
          description:
            "Returns the OpenID configuration for the default tenant, with every endpoint URL. Needs no sign-in.",
          method: "GET",
          path: "/.well-known/openid-configuration",
        },
        {
          label: "Get common discovery document",
          description: "Returns the OpenID configuration for the common tenant alias. Needs no sign-in.",
          method: "GET",
          path: "/common/v2.0/.well-known/openid-configuration",
        },
        {
          label: "Get tenant discovery document",
          description: "Returns the OpenID configuration for one tenant ID. Needs no sign-in.",
          method: "GET",
          path: `/${TENANT}/v2.0/.well-known/openid-configuration`,
        },
        {
          label: "Get signing keys",
          description:
            "Returns the RS256 public key (kid emulate-microsoft-1) that verifies id_token signatures. Needs no sign-in.",
          method: "GET",
          path: "/discovery/v2.0/keys",
        },
      ],
    },
    {
      title: "Tokens",
      presets: [
        {
          label: "Approve sign-in",
          description:
            "Stands in for picking a user on the consent page. Approves the sign-in as testuser@outlook.com and keeps the code it returns.",
          method: "POST",
          path: "/oauth2/v2.0/authorize/callback",
          headers: FORM,
          body: `email=testuser@outlook.com&${REDIRECT_URI}&scope=openid+profile+email+offline_access+User.Read&state=playground&nonce=&client_id=emu_microsoft_client_id&response_mode=query&code_challenge=&code_challenge_method=`,
          captures: { code: "@location.code" },
        },
        {
          label: "Exchange authorization code",
          description:
            "Trades the code from Approve sign-in for access, refresh, and id tokens. The code is single use and expires after 10 minutes.",
          method: "POST",
          path: "/oauth2/v2.0/token",
          headers: FORM,
          body: `grant_type=authorization_code&client_id=emu_microsoft_client_id&client_secret=emu_microsoft_client_secret&code={{code}}&${REDIRECT_URI}`,
          captures: { token: "access_token", refresh_token: "refresh_token" },
        },
        {
          label: "Refresh access token",
          description:
            "Trades a refresh token for a new access token and a new refresh token. Run Exchange authorization code first; the old refresh token stops working after this call.",
          method: "POST",
          path: "/oauth2/v2.0/token",
          headers: FORM,
          body: "grant_type=refresh_token&client_id=emu_microsoft_client_id&client_secret=emu_microsoft_client_secret&refresh_token={{refresh_token}}",
          captures: { token: "access_token", refresh_token: "refresh_token" },
        },
        {
          label: "Exchange client credentials",
          description:
            "Gets an app-only access token for the registered client, with no user attached. Needs no sign-in.",
          method: "POST",
          path: "/oauth2/v2.0/token",
          headers: FORM,
          body: "grant_type=client_credentials&client_id=emu_microsoft_client_id&client_secret=emu_microsoft_client_secret&scope=https://graph.microsoft.com/.default",
        },
      ],
    },
    {
      title: "User info",
      presets: [
        {
          label: "Get OIDC user info",
          description:
            "Returns the signed-in user's OpenID claims such as sub, email, and name. Run Exchange authorization code first to read the approved user.",
          method: "GET",
          path: "/oidc/userinfo",
          headers: BEARER,
        },
      ],
    },
    {
      title: "Microsoft Graph",
      presets: [
        {
          label: "Get Graph profile",
          description:
            "Returns the signed-in user's Graph profile, including the id that Get user by ID needs. Run Exchange authorization code first to read the approved user.",
          method: "GET",
          path: "/v1.0/me",
          headers: BEARER,
          captures: { user_id: "id" },
        },
        {
          label: "Get user by ID",
          description:
            "Looks up a user by object ID. Uses user_id, which Get Graph profile fills in, so run that first.",
          method: "GET",
          path: "/v1.0/users/{{user_id}}",
          headers: BEARER,
        },
      ],
    },
    {
      title: "Sign out",
      presets: [
        {
          label: "Log out",
          description:
            "Ends the session and returns the logged-out message. It does not revoke tokens; use Revoke access token for that.",
          method: "GET",
          path: "/oauth2/v2.0/logout",
        },
        {
          label: "Revoke access token",
          description:
            "Revokes the access token, so later userinfo and Graph calls return 401. Keep it last, because it ends the token for the rest of this list.",
          method: "POST",
          path: "/oauth2/v2.0/revoke",
          headers: FORM,
          body: "token={{token}}",
        },
      ],
    },
  ],
};
