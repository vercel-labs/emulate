import type { ConsoleService } from "./types";

const AUTH = { Authorization: "Bearer {{token}}" };
const JSON_AUTH = { ...AUTH, "Content-Type": "application/json" };
const FORM = { "Content-Type": "application/x-www-form-urlencoded" };

export const okta: ConsoleService = {
  name: "okta",
  label: "Okta",
  description:
    "OAuth and OIDC sign-in, plus the Okta management API for users, groups, apps, and authorization servers.",
  variables: [
    {
      name: "token",
      label: "Access token",
      hint: "Any value works: the emulator treats an unknown bearer token as its default user. Exchange authorization code replaces it with a real token.",
    },
    {
      name: "code",
      label: "Authorization code",
      hint: "Filled in when you run Approve sign-in. Codes work once and expire after 10 minutes.",
    },
    {
      name: "refresh_token",
      label: "Refresh token",
      hint: "Filled in when you run Exchange authorization code. You can also paste a refresh token.",
    },
    {
      name: "group_id",
      label: "Group id",
      hint: "Filled in when you run Create group. You can also paste a group id.",
    },
    {
      name: "app_id",
      label: "App id",
      hint: "Filled in when you run Create app. You can also paste an app id.",
    },
  ],
  groups: [
    {
      title: "Discovery and keys",
      presets: [
        {
          label: "Get org discovery",
          description: "Returns the OIDC metadata for the org authorization server, with every endpoint URL.",
          method: "GET",
          path: "/.well-known/openid-configuration",
        },
        {
          label: "Get org signing keys",
          description: "Returns the org server's JSON Web Key Set, which verifies its id tokens.",
          method: "GET",
          path: "/oauth2/v1/keys",
        },
        {
          label: "Get default discovery",
          description: "Returns the OIDC metadata for the default authorization server.",
          method: "GET",
          path: "/oauth2/default/.well-known/openid-configuration",
        },
        {
          label: "Get default signing keys",
          description: "Returns the default authorization server's JSON Web Key Set.",
          method: "GET",
          path: "/oauth2/default/v1/keys",
        },
      ],
    },
    {
      title: "Tokens",
      presets: [
        {
          label: "Approve sign-in",
          description:
            "Stands in for picking a user on the consent page: it posts the consent form for testuser@okta.local, and the redirect's code fills in the code variable.",
          method: "POST",
          path: "/oauth2/v1/authorize/callback",
          headers: FORM,
          body: "user_ref=testuser@okta.local&redirect_uri=https%3A%2F%2Fplayground.emulate.local%2Foauth%2Fapi%2Fauth%2Fcallback%2Fokta&scope=openid%20profile%20email&state=playground&client_id=emu_okta_client_id&response_mode=query",
          captures: { code: "@location.code" },
        },
        {
          label: "Exchange authorization code",
          description:
            "Trades the code from Approve sign-in for an access token and refresh token. Run Approve sign-in first.",
          method: "POST",
          path: "/oauth2/v1/token",
          headers: FORM,
          body: "grant_type=authorization_code&code={{code}}&redirect_uri=https%3A%2F%2Fplayground.emulate.local%2Foauth%2Fapi%2Fauth%2Fcallback%2Fokta&client_id=emu_okta_client_id&client_secret=emu_okta_client_secret",
          captures: { token: "access_token", refresh_token: "refresh_token" },
        },
        {
          label: "Refresh access token",
          description:
            "Trades the refresh token for a new access token and refresh token; the old refresh token stops working. Run Exchange authorization code first.",
          method: "POST",
          path: "/oauth2/v1/token",
          headers: FORM,
          body: "grant_type=refresh_token&refresh_token={{refresh_token}}&client_id=emu_okta_client_id&client_secret=emu_okta_client_secret",
          captures: { token: "access_token", refresh_token: "refresh_token" },
        },
        {
          label: "Get client token",
          description:
            "Gets a client-credentials token from the default server, where the playground client is registered; it is not a user token.",
          method: "POST",
          path: "/oauth2/default/v1/token",
          headers: FORM,
          body: "grant_type=client_credentials&client_id=emu_okta_client_id&client_secret=emu_okta_client_secret",
        },
        {
          label: "Introspect access token",
          description: "Checks whether the access token is active and returns its subject, scope, and expiry.",
          method: "POST",
          path: "/oauth2/v1/introspect",
          headers: FORM,
          body: "token={{token}}&client_id=emu_okta_client_id&client_secret=emu_okta_client_secret",
        },
        {
          label: "Get user info",
          description: "Returns the signed-in user's profile claims for the access token.",
          method: "GET",
          path: "/oauth2/v1/userinfo",
          headers: AUTH,
        },
      ],
    },
    {
      title: "Users",
      presets: [
        {
          label: "Create user",
          description:
            "Creates console.user@okta.local as a staged user; the lifecycle presets below act on it and Delete user removes it.",
          method: "POST",
          path: "/api/v1/users?activate=false",
          headers: JSON_AUTH,
          body: JSON.stringify(
            {
              profile: {
                login: "console.user@okta.local",
                email: "console.user@okta.local",
                firstName: "Console",
                lastName: "User",
              },
            },
            null,
            2,
          ),
        },
        {
          label: "List users",
          description: "Lists every user in the emulator, starting with the default user testuser@okta.local.",
          method: "GET",
          path: "/api/v1/users",
          headers: AUTH,
        },
        {
          label: "Get default user",
          description: "Gets testuser@okta.local, the default user; Okta accepts a login in place of the user id.",
          method: "GET",
          path: "/api/v1/users/testuser@okta.local",
          headers: AUTH,
        },
        {
          label: "Get current user",
          description: "Returns the user that the access token belongs to.",
          method: "GET",
          path: "/api/v1/users/me",
          headers: AUTH,
        },
        {
          label: "List user groups",
          description: "Lists the groups the default user belongs to.",
          method: "GET",
          path: "/api/v1/users/testuser@okta.local/groups",
          headers: AUTH,
        },
        {
          label: "Replace user",
          description: "Replaces the profile fields of the console user; run Create user first.",
          method: "PUT",
          path: "/api/v1/users/console.user@okta.local",
          headers: JSON_AUTH,
          body: JSON.stringify(
            {
              profile: {
                login: "console.user@okta.local",
                email: "console.user@okta.local",
                firstName: "Console",
                lastName: "Tester",
              },
            },
            null,
            2,
          ),
        },
        {
          label: "Update user",
          description: "Changes only the display name of the console user.",
          method: "POST",
          path: "/api/v1/users/console.user@okta.local",
          headers: JSON_AUTH,
          body: JSON.stringify({ profile: { displayName: "Console Tester" } }, null, 2),
        },
      ],
    },
    {
      title: "User lifecycle",
      presets: [
        {
          label: "Activate user",
          description: "Moves the staged console user to ACTIVE so it can sign in.",
          method: "POST",
          path: "/api/v1/users/console.user@okta.local/lifecycle/activate",
          headers: AUTH,
        },
        {
          label: "Suspend user",
          description: "Suspends the console user; a suspended user cannot sign in.",
          method: "POST",
          path: "/api/v1/users/console.user@okta.local/lifecycle/suspend",
          headers: AUTH,
        },
        {
          label: "Unsuspend user",
          description: "Returns the suspended console user to ACTIVE.",
          method: "POST",
          path: "/api/v1/users/console.user@okta.local/lifecycle/unsuspend",
          headers: AUTH,
        },
        {
          label: "Clear user sessions",
          description: "Revokes the OAuth tokens issued to the console user; the default user is not affected.",
          method: "DELETE",
          path: "/api/v1/users/console.user@okta.local/sessions?oauthTokens=true",
          headers: AUTH,
        },
        {
          label: "Reactivate user",
          description: "Moves the console user to PROVISIONED, the state Okta uses after reactivation.",
          method: "POST",
          path: "/api/v1/users/console.user@okta.local/lifecycle/reactivate",
          headers: AUTH,
        },
        {
          label: "Deactivate user",
          description: "Deactivates the console user, which moves it to DEPROVISIONED.",
          method: "POST",
          path: "/api/v1/users/console.user@okta.local/lifecycle/deactivate",
          headers: AUTH,
        },
        {
          label: "Delete user",
          description:
            "Removes the console user. Run Deactivate user first, because on an active user this call only deactivates it.",
          method: "DELETE",
          path: "/api/v1/users/console.user@okta.local",
          headers: AUTH,
        },
      ],
    },
    {
      title: "Groups",
      presets: [
        {
          label: "Create group",
          description: "Creates the Console group that the group presets below use; its id is captured for them.",
          method: "POST",
          path: "/api/v1/groups",
          headers: JSON_AUTH,
          body: JSON.stringify(
            { profile: { name: "Console group", description: "Made from the playground console" } },
            null,
            2,
          ),
          captures: { group_id: "id" },
        },
        {
          label: "List groups",
          description: "Lists groups whose name or description contains console.",
          method: "GET",
          path: "/api/v1/groups?q=console",
          headers: AUTH,
        },
        {
          label: "Get group",
          description: "Returns the group with the captured group id.",
          method: "GET",
          path: "/api/v1/groups/{{group_id}}",
          headers: AUTH,
        },
        {
          label: "Update group",
          description: "Changes the description of the group.",
          method: "PUT",
          path: "/api/v1/groups/{{group_id}}",
          headers: JSON_AUTH,
          body: JSON.stringify(
            { profile: { name: "Console group", description: "Updated from the playground console" } },
            null,
            2,
          ),
        },
        {
          label: "List group members",
          description: "Lists the users in the group.",
          method: "GET",
          path: "/api/v1/groups/{{group_id}}/users",
          headers: AUTH,
        },
        {
          label: "Add user to group",
          description: "Adds the default user testuser@okta.local to the group; the response is 204 with no body.",
          method: "PUT",
          path: "/api/v1/groups/{{group_id}}/users/testuser@okta.local",
          headers: AUTH,
        },
        {
          label: "Remove user from group",
          description: "Removes the default user from the group; run Add user to group first to see it take effect.",
          method: "DELETE",
          path: "/api/v1/groups/{{group_id}}/users/testuser@okta.local",
          headers: AUTH,
        },
        {
          label: "Delete group",
          description: "Deletes the group and its memberships.",
          method: "DELETE",
          path: "/api/v1/groups/{{group_id}}",
          headers: AUTH,
        },
      ],
    },
    {
      title: "Apps",
      presets: [
        {
          label: "Create app",
          description: "Creates the Console app that the app presets below use; its id is captured for them.",
          method: "POST",
          path: "/api/v1/apps",
          headers: JSON_AUTH,
          body: JSON.stringify({ name: "console_app", label: "Console app", signOnMode: "OPENID_CONNECT" }, null, 2),
          captures: { app_id: "id" },
        },
        {
          label: "List apps",
          description: "Lists apps whose name or label contains console.",
          method: "GET",
          path: "/api/v1/apps?q=console",
          headers: AUTH,
        },
        {
          label: "Get app",
          description: "Returns the app with the captured app id.",
          method: "GET",
          path: "/api/v1/apps/{{app_id}}",
          headers: AUTH,
        },
        {
          label: "Update app",
          description: "Changes the label of the app.",
          method: "PUT",
          path: "/api/v1/apps/{{app_id}}",
          headers: JSON_AUTH,
          body: JSON.stringify({ label: "Console app (updated)" }, null, 2),
        },
        {
          label: "List app users",
          description: "Lists the users assigned to the app.",
          method: "GET",
          path: "/api/v1/apps/{{app_id}}/users",
          headers: AUTH,
        },
        {
          label: "Assign user to app",
          description: "Assigns the default user testuser@okta.local to the app; the response is 204 with no body.",
          method: "PUT",
          path: "/api/v1/apps/{{app_id}}/users/testuser@okta.local",
          headers: AUTH,
        },
        {
          label: "Unassign user from app",
          description: "Removes the default user's assignment from the app.",
          method: "DELETE",
          path: "/api/v1/apps/{{app_id}}/users/testuser@okta.local",
          headers: AUTH,
        },
      ],
    },
    {
      title: "App lifecycle",
      presets: [
        {
          label: "Activate app",
          description: "Sets the app to ACTIVE.",
          method: "POST",
          path: "/api/v1/apps/{{app_id}}/lifecycle/activate",
          headers: AUTH,
        },
        {
          label: "Deactivate app",
          description: "Sets the app to INACTIVE; Okta only deletes inactive apps.",
          method: "POST",
          path: "/api/v1/apps/{{app_id}}/lifecycle/deactivate",
          headers: AUTH,
        },
        {
          label: "Delete app",
          description: "Deletes the app and its assignments. Run Deactivate app first, or the call answers 400.",
          method: "DELETE",
          path: "/api/v1/apps/{{app_id}}",
          headers: AUTH,
        },
      ],
    },
    {
      title: "Authorization servers",
      presets: [
        {
          label: "Create authorization server",
          description:
            "Creates the custom server console-auth; Okta derives the id from the name. Delete authorization server removes it at the end.",
          method: "POST",
          path: "/api/v1/authorizationServers",
          headers: JSON_AUTH,
          body: JSON.stringify(
            { name: "Console auth", description: "Made from the playground console", audiences: ["api://console"] },
            null,
            2,
          ),
        },
        {
          label: "Get custom discovery",
          description: "Returns the OIDC metadata for console-auth; run Create authorization server first.",
          method: "GET",
          path: "/oauth2/console-auth/.well-known/openid-configuration",
        },
        {
          label: "Get custom signing keys",
          description: "Returns the signing keys of console-auth.",
          method: "GET",
          path: "/oauth2/console-auth/v1/keys",
        },
        {
          label: "List authorization servers",
          description: "Lists every authorization server, including the default one.",
          method: "GET",
          path: "/api/v1/authorizationServers",
          headers: AUTH,
        },
        {
          label: "Get authorization server",
          description: "Returns the console-auth server.",
          method: "GET",
          path: "/api/v1/authorizationServers/console-auth",
          headers: AUTH,
        },
        {
          label: "Update authorization server",
          description: "Changes the description and audiences of console-auth.",
          method: "PUT",
          path: "/api/v1/authorizationServers/console-auth",
          headers: JSON_AUTH,
          body: JSON.stringify(
            { description: "Updated from the playground console", audiences: ["api://console"] },
            null,
            2,
          ),
        },
        {
          label: "Deactivate authorization server",
          description: "Sets console-auth to INACTIVE.",
          method: "POST",
          path: "/api/v1/authorizationServers/console-auth/lifecycle/deactivate",
          headers: AUTH,
        },
        {
          label: "Activate authorization server",
          description: "Sets console-auth back to ACTIVE.",
          method: "POST",
          path: "/api/v1/authorizationServers/console-auth/lifecycle/activate",
          headers: AUTH,
        },
        {
          label: "Delete authorization server",
          description: "Deletes console-auth and the clients registered on it.",
          method: "DELETE",
          path: "/api/v1/authorizationServers/console-auth",
          headers: AUTH,
        },
      ],
    },
    {
      title: "Sign out",
      presets: [
        {
          label: "Revoke access token",
          description:
            "Revokes the access token from Exchange authorization code: Get user info answers 401 and Introspect access token reports it inactive. The management presets still answer, because the emulator treats an unknown bearer token as its default user.",
          method: "POST",
          path: "/oauth2/v1/revoke",
          headers: FORM,
          body: "token={{token}}&client_id=emu_okta_client_id&client_secret=emu_okta_client_secret",
        },
        {
          label: "Log out",
          description: "Ends the Okta session and answers with plain text, because no post-logout redirect is given.",
          method: "GET",
          path: "/oauth2/v1/logout",
        },
      ],
    },
  ],
};
