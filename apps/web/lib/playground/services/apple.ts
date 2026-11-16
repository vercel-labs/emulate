import type { ConsoleService, ConsoleVariable } from "./types";

const FORM_HEADERS = { "Content-Type": "application/x-www-form-urlencoded" };
const CLIENT = "client_id=emu_apple_client_id&client_secret=emu_apple_client_secret";
const REDIRECT_URI = "redirect_uri=https://playground.emulate.local/oauth/api/auth/callback/apple";

const variables: ConsoleVariable[] = [
  {
    name: "code",
    label: "Authorization code",
    hint: "Filled in when you run Approve sign-in. A code works once and expires after five minutes.",
  },
  {
    name: "refresh_token",
    label: "Refresh token",
    hint: "Filled in when you run Exchange authorization code. You can also paste one.",
  },
  {
    name: "token",
    label: "Access token",
    hint: "Any value works: the emulator treats an unknown bearer token as its default user. Exchange authorization code replaces it with a real token.",
  },
];

export const apple: ConsoleService = {
  name: "apple",
  label: "Apple",
  description: "Sign in with Apple: discovery, public keys, token exchange, refresh, and revocation.",
  variables,
  groups: [
    {
      title: "Discovery and keys",
      presets: [
        {
          label: "Get discovery document",
          description: "Returns the OIDC metadata with every endpoint URL. No input needed.",
          method: "GET",
          path: "/.well-known/openid-configuration",
        },
        {
          label: "Get public keys",
          description: "Returns the RSA key (kid emulate-apple-1) that signs id_tokens. No input needed.",
          method: "GET",
          path: "/auth/keys",
        },
      ],
    },
    {
      title: "Tokens",
      presets: [
        {
          label: "Approve sign-in",
          description:
            "Stands in for picking a user on the Apple authorize page. Approves the sign-in as testuser@icloud.com and keeps the code it returns.",
          method: "POST",
          path: "/auth/authorize/callback",
          headers: FORM_HEADERS,
          body: `email=testuser@icloud.com&${REDIRECT_URI}&scope=openid+email+name&state=playground&nonce=&client_id=emu_apple_client_id&response_mode=query`,
          captures: { code: "@location.code" },
        },
        {
          label: "Exchange authorization code",
          description:
            "Trades the code from Approve sign-in for an access token, refresh token, and id_token. The access token replaces the Access token value.",
          method: "POST",
          path: "/auth/token",
          headers: FORM_HEADERS,
          body: `grant_type=authorization_code&code={{code}}&${REDIRECT_URI}&${CLIENT}`,
          captures: { refresh_token: "refresh_token", token: "access_token" },
        },
        {
          label: "Refresh access token",
          description:
            "Gets a new access token and id_token from a refresh token. The refresh token comes from the response of Exchange authorization code.",
          method: "POST",
          path: "/auth/token",
          headers: FORM_HEADERS,
          body: `grant_type=refresh_token&refresh_token={{refresh_token}}&${CLIENT}`,
          captures: { token: "access_token" },
        },
      ],
    },
    {
      title: "Revocation",
      presets: [
        {
          label: "Revoke access token",
          description:
            "Removes an access token so it stops working, and returns an empty 200. The token comes from Exchange authorization code or Refresh access token.",
          method: "POST",
          path: "/auth/revoke",
          headers: FORM_HEADERS,
          body: `token={{token}}&${CLIENT}`,
        },
      ],
    },
  ],
};
