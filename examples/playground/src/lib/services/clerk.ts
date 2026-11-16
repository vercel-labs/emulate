import type { ConsoleService } from "./types";

const bearer = { Authorization: "Bearer {{token}}" };
const bearerJson = { "Content-Type": "application/json", ...bearer };
const form = { "Content-Type": "application/x-www-form-urlencoded" };

/** Backend API and OAuth endpoints of the Clerk emulator, with every operation the emulator serves. */
export const clerk: ConsoleService = {
  name: "clerk",
  label: "Clerk",
  description: "Backend API for users, organizations, memberships, invitations, and sessions, plus OAuth and JWKS.",
  variables: [
    {
      name: "token",
      label: "Access token",
      hint: "Sign in at /oauth with Clerk and this fills in by itself, or copy the access token from that dashboard.",
    },
    {
      name: "code",
      label: "Authorization code",
      hint: "Start sign-in at /oauth with Clerk and copy the code value from the callback URL. Codes are single use and expire after 10 minutes.",
    },
    {
      name: "redirect_uri",
      label: "Redirect URI",
      hint: "http://localhost:<port>/oauth/api/auth/callback/clerk, using the port the playground runs on.",
    },
    {
      name: "new_user_id",
      label: "New user id",
      hint: "Filled in when you run Create user. You can also paste an id.",
    },
    {
      name: "email_id",
      label: "Email address id",
      hint: "Filled in when you run Add email address. You can also paste an id.",
    },
    {
      name: "new_org_id",
      label: "New organization id",
      hint: "Filled in when you run Create organization. You can also paste an id.",
    },
    {
      name: "invitation_id",
      label: "Invitation id",
      hint: "Filled in when you run Create invitation. You can also paste an id. The invitation must still be pending to be revoked.",
    },
    {
      name: "session_id",
      label: "Session id",
      hint: "Filled in when you run Create session. You can also paste an id.",
    },
  ],
  groups: [
    {
      title: "Keys and discovery",
      presets: [
        {
          label: "Show discovery document",
          description: "Returns the OpenID configuration with this emulator's endpoint URLs.",
          method: "GET",
          path: "/.well-known/openid-configuration",
        },
        {
          label: "Get signing keys",
          description: "Returns the public JWKS that verifies the JWTs this emulator issues.",
          method: "GET",
          path: "/v1/jwks",
        },
      ],
    },
    {
      title: "OAuth",
      presets: [
        {
          label: "Exchange code for token",
          description:
            "Trades an authorization code for an access token and id token, and keeps the access token for the presets below. Get a fresh code from sign-in first, because codes are single use.",
          method: "POST",
          path: "/oauth/token",
          headers: form,
          body: "grant_type=authorization_code&code={{code}}&redirect_uri={{redirect_uri}}&client_id=emu_clerk_client_id&client_secret=emu_clerk_client_secret",
          captures: { token: "access_token" },
        },
        {
          label: "Get user info",
          description:
            "Returns the profile of the user behind the access token. Needs a token from sign-in or the exchange above.",
          method: "GET",
          path: "/oauth/userinfo",
          headers: bearer,
        },
      ],
    },
    {
      title: "Users",
      presets: [
        {
          label: "Create user",
          description: "Creates a user with a generated id, which Delete user removes at the end of this group.",
          method: "POST",
          path: "/v1/users",
          headers: bearerJson,
          body: JSON.stringify(
            { first_name: "Linus", last_name: "Torvalds", email_address: ["linus@example.com"] },
            null,
            2,
          ),
          captures: { new_user_id: "id" },
        },
        {
          label: "List users",
          description: "Lists users, newest first, with their email addresses.",
          method: "GET",
          path: "/v1/users",
          headers: bearer,
        },
        {
          label: "Count users",
          description: "Returns how many users the emulator holds.",
          method: "GET",
          path: "/v1/users/count",
          headers: bearer,
        },
        {
          label: "Get user",
          description: "Returns the seeded user Ada Lovelace.",
          method: "GET",
          path: "/v1/users/user_playground_ada",
          headers: bearer,
        },
        {
          label: "Update user",
          description: "Changes the name of the seeded user Ada Lovelace.",
          method: "PATCH",
          path: "/v1/users/user_playground_ada",
          headers: bearerJson,
          body: JSON.stringify({ first_name: "Ada", last_name: "Lovelace" }, null, 2),
        },
        {
          label: "Update user metadata",
          description: "Merges public metadata into Ada Lovelace. Existing keys stay unless you overwrite them.",
          method: "PATCH",
          path: "/v1/users/user_playground_ada/metadata",
          headers: bearerJson,
          body: JSON.stringify({ public_metadata: { plan: "pro" } }, null, 2),
        },
        {
          label: "Verify user password",
          description: "Checks a password against the one seeded for Ada Lovelace and returns verified true or false.",
          method: "POST",
          path: "/v1/users/user_playground_ada/verify_password",
          headers: bearerJson,
          body: JSON.stringify({ password: "clerk_test_password" }, null, 2),
        },
        {
          label: "Ban user",
          description: "Bans the seeded user Grace Hopper. Run Unban user next to restore her.",
          method: "POST",
          path: "/v1/users/user_playground_grace/ban",
          headers: bearer,
        },
        {
          label: "Unban user",
          description: "Lifts the ban on Grace Hopper.",
          method: "POST",
          path: "/v1/users/user_playground_grace/unban",
          headers: bearer,
        },
        {
          label: "Lock user",
          description: "Locks the seeded user Grace Hopper. Run Unlock user next to restore her.",
          method: "POST",
          path: "/v1/users/user_playground_grace/lock",
          headers: bearer,
        },
        {
          label: "Unlock user",
          description: "Unlocks Grace Hopper.",
          method: "POST",
          path: "/v1/users/user_playground_grace/unlock",
          headers: bearer,
        },
        {
          label: "Delete user",
          description:
            "Deletes the user from Create user with its emails, memberships, and sessions. Run Create user first.",
          method: "DELETE",
          path: "/v1/users/{{new_user_id}}",
          headers: bearer,
        },
      ],
    },
    {
      title: "Email addresses",
      presets: [
        {
          label: "Add email address",
          description: "Adds a second email address to Ada Lovelace. The next three presets use its id.",
          method: "POST",
          path: "/v1/email_addresses",
          headers: bearerJson,
          body: JSON.stringify(
            { user_id: "user_playground_ada", email_address: "ada.work@example.com", verified: true },
            null,
            2,
          ),
          captures: { email_id: "id" },
        },
        {
          label: "Get email address",
          description: "Returns one email address. Run Add email address first to get its id.",
          method: "GET",
          path: "/v1/email_addresses/{{email_id}}",
          headers: bearer,
        },
        {
          label: "Update email address",
          description: "Marks an email address as verified. Run Add email address first.",
          method: "PATCH",
          path: "/v1/email_addresses/{{email_id}}",
          headers: bearerJson,
          body: JSON.stringify({ verified: true }, null, 2),
        },
        {
          label: "Delete email address",
          description: "Deletes an email address. Run Add email address first.",
          method: "DELETE",
          path: "/v1/email_addresses/{{email_id}}",
          headers: bearer,
        },
      ],
    },
    {
      title: "Organizations",
      presets: [
        {
          label: "Create organization",
          description:
            "Creates an organization with a generated id, which Delete organization removes at the end of this group.",
          method: "POST",
          path: "/v1/organizations",
          headers: bearerJson,
          body: JSON.stringify({ name: "Globex", slug: "globex" }, null, 2),
          captures: { new_org_id: "id" },
        },
        {
          label: "List organizations",
          description: "Lists organizations, newest first.",
          method: "GET",
          path: "/v1/organizations",
          headers: bearer,
        },
        {
          label: "Get organization",
          description: "Returns the seeded Acme organization. Its slug, acme, works in this path too.",
          method: "GET",
          path: "/v1/organizations/org_playground_acme",
          headers: bearer,
        },
        {
          label: "Update organization",
          description: "Sets the name and membership limit of Acme.",
          method: "PATCH",
          path: "/v1/organizations/org_playground_acme",
          headers: bearerJson,
          body: JSON.stringify({ name: "Acme", max_allowed_memberships: 50 }, null, 2),
        },
        {
          label: "Update organization metadata",
          description: "Merges public metadata into Acme.",
          method: "PATCH",
          path: "/v1/organizations/org_playground_acme/metadata",
          headers: bearerJson,
          body: JSON.stringify({ public_metadata: { plan: "enterprise" } }, null, 2),
        },
        {
          label: "Delete organization",
          description:
            "Deletes the organization from Create organization with its memberships and invitations. Run Create organization first.",
          method: "DELETE",
          path: "/v1/organizations/{{new_org_id}}",
          headers: bearer,
        },
      ],
    },
    {
      title: "Memberships",
      presets: [
        {
          label: "Add member",
          description:
            "Adds Grace Hopper to Acme as a member. Run Remove member last, since adding her again fails while she is a member.",
          method: "POST",
          path: "/v1/organizations/org_playground_acme/memberships",
          headers: bearerJson,
          body: JSON.stringify({ user_id: "user_playground_grace", role: "org:member" }, null, 2),
        },
        {
          label: "List members",
          description: "Lists the members of Acme with their roles. Run Add member first to see Grace Hopper.",
          method: "GET",
          path: "/v1/organizations/org_playground_acme/memberships",
          headers: bearer,
        },
        {
          label: "Update member role",
          description: "Changes Grace Hopper's role in Acme to admin. Run Add member first.",
          method: "PATCH",
          path: "/v1/organizations/org_playground_acme/memberships/user_playground_grace",
          headers: bearerJson,
          body: JSON.stringify({ role: "org:admin" }, null, 2),
        },
        {
          label: "Update member metadata",
          description: "Merges public metadata into Grace Hopper's membership. Run Add member first.",
          method: "PATCH",
          path: "/v1/organizations/org_playground_acme/memberships/user_playground_grace/metadata",
          headers: bearerJson,
          body: JSON.stringify({ public_metadata: { title: "Compiler lead" } }, null, 2),
        },
        {
          label: "Remove member",
          description: "Removes Grace Hopper from Acme. Run Add member first.",
          method: "DELETE",
          path: "/v1/organizations/org_playground_acme/memberships/user_playground_grace",
          headers: bearer,
        },
      ],
    },
    {
      title: "Invitations",
      presets: [
        {
          label: "Create invitation",
          description: "Invites new.hire@example.com to Acme. Get and revoke invitation use its id.",
          method: "POST",
          path: "/v1/organizations/org_playground_acme/invitations",
          headers: bearerJson,
          body: JSON.stringify({ email_address: "new.hire@example.com", role: "org:member" }, null, 2),
          captures: { invitation_id: "id" },
        },
        {
          label: "Create invitations in bulk",
          description: "Invites two addresses to Acme in one request.",
          method: "POST",
          path: "/v1/organizations/org_playground_acme/invitations/bulk",
          headers: bearerJson,
          body: JSON.stringify(
            { email_addresses: ["ops@example.com", "sales@example.com"], role: "org:member" },
            null,
            2,
          ),
        },
        {
          label: "List invitations",
          description: "Lists the pending invitations of Acme.",
          method: "GET",
          path: "/v1/organizations/org_playground_acme/invitations?status=pending",
          headers: bearer,
        },
        {
          label: "Get invitation",
          description: "Returns one invitation. Run Create invitation first.",
          method: "GET",
          path: "/v1/organizations/org_playground_acme/invitations/{{invitation_id}}",
          headers: bearer,
        },
        {
          label: "Revoke invitation",
          description:
            "Revokes the invitation from Create invitation. Run it last, because only pending invitations can be revoked.",
          method: "POST",
          path: "/v1/organizations/org_playground_acme/invitations/{{invitation_id}}/revoke",
          headers: bearer,
        },
      ],
    },
    {
      title: "Sessions",
      presets: [
        {
          label: "Create session",
          description: "Starts a session for Ada Lovelace. The session presets below use its id.",
          method: "POST",
          path: "/v1/sessions",
          headers: bearerJson,
          body: JSON.stringify({ user_id: "user_playground_ada" }, null, 2),
          captures: { session_id: "id" },
        },
        {
          label: "List sessions",
          description: "Lists sessions, filtered here to Ada Lovelace.",
          method: "GET",
          path: "/v1/sessions?user_id=user_playground_ada",
          headers: bearer,
        },
        {
          label: "Get session",
          description: "Returns one session. Run Create session first.",
          method: "GET",
          path: "/v1/sessions/{{session_id}}",
          headers: bearer,
        },
        {
          label: "Create session token",
          description:
            "Issues a JWT for an active session, including Acme's role when the user belongs to it. Run Create session first.",
          method: "POST",
          path: "/v1/sessions/{{session_id}}/tokens",
          headers: bearer,
        },
        {
          label: "Create token from template",
          description:
            "Issues a JWT for an active session with a template name. This emulator ignores the template name.",
          method: "POST",
          path: "/v1/sessions/{{session_id}}/tokens/default",
          headers: bearer,
        },
        {
          label: "Revoke session",
          description: "Revokes the session from Create session, so its tokens stop working. Run it last.",
          method: "POST",
          path: "/v1/sessions/{{session_id}}/revoke",
          headers: bearer,
        },
      ],
    },
  ],
};
