import type { ConsoleService } from "./types";

const FORM_HEADERS = { "Content-Type": "application/x-www-form-urlencoded" };
const CLIENT = "client_id=emu_apple_client_id&client_secret=emu_apple_client_secret";

export const apple: ConsoleService = {
  name: "apple",
  label: "Apple",
  description: "Sign in with Apple: discovery, public keys, token exchange, refresh, and revocation.",
  variables: [
    {
      name: "code",
      label: "Authorization code",
      hint: "Copy the code parameter from the redirect after you pick a user on the Apple authorize page. A code works once and expires after five minutes.",
    },
    {
      name: "redirect_uri",
      label: "Redirect URI",
      hint: "The redirect URI you authorized with, shaped http://localhost:<port>/oauth/api/auth/callback/apple.",
    },
    {
      name: "refresh_token",
      label: "Refresh token",
      hint: "Filled in when you run Exchange authorization code. You can also paste one.",
    },
    {
      name: "token",
      label: "Access token",
      hint: "Sign in at /oauth with Apple and this fills in by itself, or copy the access token from that dashboard. It also fills in when you run Exchange authorization code or Refresh access token, and you can paste one.",
    },
  ],
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
          label: "Exchange authorization code",
          description:
            "Trades a one-time code for an access token, refresh token, and id_token. The code comes from the redirect after the authorize page, and the redirect_uri must match it.",
          method: "POST",
          path: "/auth/token",
          headers: FORM_HEADERS,
          body: `grant_type=authorization_code&code={{code}}&redirect_uri={{redirect_uri}}&${CLIENT}`,
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
            "Removes an access token so it stops working, and returns an empty 200. The token comes from the sign-in at /oauth or from an exchange response.",
          method: "POST",
          path: "/auth/revoke",
          headers: FORM_HEADERS,
          body: `token={{token}}&${CLIENT}`,
        },
      ],
    },
  ],
};
