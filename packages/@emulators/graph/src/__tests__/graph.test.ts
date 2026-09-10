import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_ADMIN_USER_ID,
  DEFAULT_ANALYST_USER_ID,
  DEFAULT_CLIENT_ID,
  DEFAULT_DISABLED_USER_ID,
  DEFAULT_GUEST_USER_ID,
  DEFAULT_SECOND_TENANT_ID,
  DEFAULT_TENANT_ID,
  getGStore,
  ROLE_TEMPLATES,
} from "../index.js";
import { accessToken, api, createGraphTestApp, graphTestBaseUrl, requestToken, type GraphTestApp } from "./helpers.js";

const SELECT =
  "id,displayName,mail,userPrincipalName,givenName,surname,jobTitle,mobilePhone,officeLocation,preferredLanguage,businessPhones,accountEnabled";

describe("Microsoft Graph plugin", () => {
  let ctx: GraphTestApp;
  let token: string;

  beforeEach(async () => {
    ctx = createGraphTestApp();
    token = await accessToken(ctx.app);
  });

  describe("authentication", () => {
    it("issues tenant-scoped client_credentials tokens and rejects bad requests", async () => {
      const response = await requestToken(ctx.app);
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ token_type: "Bearer", expires_in: 3600 });
      const payload = JSON.parse(Buffer.from(response.body.access_token.split(".")[1], "base64url").toString());
      expect(payload).toMatchObject({
        aud: "https://graph.microsoft.com",
        tid: DEFAULT_TENANT_ID,
        appid: DEFAULT_CLIENT_ID,
      });
      expect(payload.roles).toContain("User.ReadWrite.All");
      expect((await requestToken(ctx.app, DEFAULT_TENANT_ID, DEFAULT_CLIENT_ID, "nope")).status).toBe(401);
      expect((await requestToken(ctx.app, "00000000-0000-4000-8000-00000000dead")).body.error_description).toContain(
        "AADSTS90002",
      );
      const byDomain = await requestToken(ctx.app, "contoso.onmicrosoft.com");
      expect(byDomain.status).toBe(200);
    });

    it("rejects API calls without a valid bearer token", async () => {
      const missing = await api(ctx.app, "GET", "/users");
      expect(missing.status).toBe(401);
      expect(missing.body.error.code).toBe("InvalidAuthenticationToken");
      expect((await api(ctx.app, "GET", "/users", undefined, "bad")).status).toBe(401);
    });

    it("returns Authorization_RequestDenied when the app lacks a permission", async () => {
      const limited = createGraphTestApp({
        apps: [{ client_id: "reader", client_secret: "s", permissions: ["User.Read.All"] }],
      });
      const readerToken = await accessToken(limited.app, DEFAULT_TENANT_ID, "reader", "s");
      expect((await api(limited.app, "GET", "/users", undefined, readerToken)).status).toBe(200);
      const denied = await api(limited.app, "GET", "/roleManagement/directory/roleAssignments", undefined, readerToken);
      expect(denied.status).toBe(403);
      expect(denied.body.error).toMatchObject({
        code: "Authorization_RequestDenied",
        message: "Insufficient privileges to complete the operation.",
      });
      expect(
        (await api(limited.app, "PATCH", `/users/${DEFAULT_ADMIN_USER_ID}`, { accountEnabled: false }, readerToken))
          .status,
      ).toBe(403);
    });
  });

  describe("users (CyberHub flow)", () => {
    it("filters users by mail with the odata-query `in` syntax and selects fields", async () => {
      const filter = "mail in ('alex.wilber@contoso.example','nora.analyst@soc.example','missing@example.com')";
      const response = await api(
        ctx.app,
        "GET",
        `/users?${new URLSearchParams({ $filter: filter, $select: SELECT }).toString()}`,
        undefined,
        token,
      );
      expect(response.status).toBe(200);
      expect(response.body["@odata.context"]).toBe(`${graphTestBaseUrl}/v1.0/$metadata#users`);
      expect(response.body.value.map((user: any) => user.mail).sort()).toEqual([
        "alex.wilber@contoso.example",
        "nora.analyst@soc.example",
      ]);
      expect(Object.keys(response.body.value[0]).sort()).toEqual(SELECT.split(",").sort());
      expect(response.body.value.find((user: any) => user.id === DEFAULT_GUEST_USER_ID)).toMatchObject({
        accountEnabled: true,
        displayName: "Nora Analyst",
      });
      const disabled = await api(
        ctx.app,
        "GET",
        `/users?${new URLSearchParams({ $filter: "accountEnabled eq false" }).toString()}`,
        undefined,
        token,
      );
      expect(disabled.body.value.map((user: any) => user.id)).toEqual([DEFAULT_DISABLED_USER_ID]);
      const guests = await api(
        ctx.app,
        "GET",
        `/users?${new URLSearchParams({ $filter: "userType eq 'Guest' and startsWith(mail, 'nora')" }).toString()}`,
        undefined,
        token,
      );
      expect(guests.body.value).toHaveLength(1);
      const counted = await api(
        ctx.app,
        "GET",
        `/users?${new URLSearchParams({ $count: "true", $top: "2", $orderby: "displayName" }).toString()}`,
        undefined,
        token,
        { ConsistencyLevel: "eventual" },
      );
      expect(counted.body["@odata.count"]).toBe(6);
      expect(counted.body.value).toHaveLength(2);
      expect(counted.body["@odata.nextLink"]).toContain("%24skiptoken=");
      const next = await api(
        ctx.app,
        "GET",
        counted.body["@odata.nextLink"].replace(`${graphTestBaseUrl}/v1.0`, ""),
        undefined,
        token,
      );
      expect(next.body.value).toHaveLength(2);
      expect(
        (
          await api(
            ctx.app,
            "GET",
            `/users?${new URLSearchParams({ $filter: "mail eq" }).toString()}`,
            undefined,
            token,
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await api(
            ctx.app,
            "GET",
            `/users?${new URLSearchParams({ $search: '"displayName:Adele"' }).toString()}`,
            undefined,
            token,
            { ConsistencyLevel: "eventual" },
          )
        ).body.value,
      ).toHaveLength(1);
    });

    it("scopes users to the token tenant and reads by id or UPN", async () => {
      const fabrikam = await accessToken(ctx.app, DEFAULT_SECOND_TENANT_ID);
      const users = await api(ctx.app, "GET", "/users", undefined, fabrikam);
      expect(users.body.value.map((user: any) => user.userPrincipalName)).toEqual(["megan.bowen@fabrikam.example"]);
      expect((await api(ctx.app, "GET", `/users/${DEFAULT_ADMIN_USER_ID}`, undefined, fabrikam)).status).toBe(404);
      const byUpn = await api(
        ctx.app,
        "GET",
        `/users/${encodeURIComponent("adele.vance@contoso.example")}?$select=id,mail`,
        undefined,
        token,
      );
      expect(byUpn.body).toEqual({
        "@odata.context": `${graphTestBaseUrl}/v1.0/$metadata#users/$entity`,
        id: DEFAULT_ADMIN_USER_ID,
        mail: "adele.vance@contoso.example",
      });
      const missing = await api(ctx.app, "GET", "/users/00000000-0000-0000-0000-000000000000", undefined, token);
      expect(missing.status).toBe(404);
      expect(missing.body.error.code).toBe("Request_ResourceNotFound");
    });

    it("suspends, reactivates, updates, creates, and deletes users", async () => {
      const suspended = await api(
        ctx.app,
        "PATCH",
        `/users/${DEFAULT_GUEST_USER_ID}`,
        { accountEnabled: false },
        token,
      );
      expect(suspended.status).toBe(204);
      expect((await api(ctx.app, "GET", `/users/${DEFAULT_GUEST_USER_ID}`, undefined, token)).body.accountEnabled).toBe(
        false,
      );
      expect(
        (
          await api(
            ctx.app,
            "PATCH",
            `/users/${DEFAULT_GUEST_USER_ID}`,
            { accountEnabled: true, jobTitle: "Lead" },
            token,
          )
        ).status,
      ).toBe(204);
      expect((await api(ctx.app, "GET", `/users/${DEFAULT_GUEST_USER_ID}`, undefined, token)).body).toMatchObject({
        accountEnabled: true,
        jobTitle: "Lead",
      });
      expect((await api(ctx.app, "PATCH", `/users/${DEFAULT_GUEST_USER_ID}`, {}, token)).status).toBe(400);
      expect((await api(ctx.app, "PATCH", `/users/${DEFAULT_GUEST_USER_ID}`, { nope: 1 }, token)).status).toBe(400);
      const created = await api(
        ctx.app,
        "POST",
        "/users",
        {
          accountEnabled: true,
          displayName: "New Hire",
          mailNickname: "new.hire",
          userPrincipalName: "new.hire@contoso.example",
          passwordProfile: { forceChangePasswordNextSignIn: true, password: "Sup3rSecret!" },
        },
        token,
      );
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({
        displayName: "New Hire",
        userPrincipalName: "new.hire@contoso.example",
        userType: "Member",
      });
      expect(
        (
          await api(
            ctx.app,
            "POST",
            "/users",
            {
              accountEnabled: true,
              displayName: "Dup",
              mailNickname: "dup",
              userPrincipalName: "new.hire@contoso.example",
              passwordProfile: { password: "x" },
            },
            token,
          )
        ).status,
      ).toBe(400);
      expect((await api(ctx.app, "POST", "/users", { displayName: "No UPN" }, token)).status).toBe(400);
      expect((await api(ctx.app, "DELETE", `/users/${created.body.id}`, undefined, token)).status).toBe(204);
      expect((await api(ctx.app, "GET", `/users/${created.body.id}`, undefined, token)).status).toBe(404);
      expect(
        (await api(ctx.app, "GET", "/directory/deletedItems/microsoft.graph.user", undefined, token)).body.value.map(
          (user: any) => user.id,
        ),
      ).toEqual([created.body.id]);
      expect((await api(ctx.app, "POST", `/directory/deletedItems/${created.body.id}/restore`, {}, token)).status).toBe(
        200,
      );
    });
  });

  describe("invitations and role assignments", () => {
    it("invites guests, exposes redeem links, and marks acceptance", async () => {
      const invited = await api(
        ctx.app,
        "POST",
        "/invitations",
        {
          invitedUserDisplayName: "Sam Soc",
          invitedUserEmailAddress: "Sam.Soc@soc.example",
          inviteRedirectUrl: "https://security.microsoft.com",
          sendInvitationMessage: false,
        },
        token,
      );
      expect(invited.status).toBe(201);
      expect(invited.body).toMatchObject({
        invitedUserEmailAddress: "sam.soc@soc.example",
        invitedUserType: "Guest",
        status: "PendingAcceptance",
        sendInvitationMessage: false,
        inviteRedirectUrl: "https://security.microsoft.com",
      });
      expect(invited.body.invitedUser.userPrincipalName).toBe("sam.soc_soc.example#EXT#@contoso.onmicrosoft.com");
      const user = await api(ctx.app, "GET", `/users/${invited.body.invitedUser.id}`, undefined, token);
      expect(user.body).toMatchObject({
        mail: "sam.soc@soc.example",
        userType: "Guest",
        externalUserState: "PendingAcceptance",
        accountEnabled: true,
        displayName: "Sam Soc",
      });
      const again = await api(
        ctx.app,
        "POST",
        "/invitations",
        {
          invitedUserEmailAddress: "sam.soc@soc.example",
          inviteRedirectUrl: "https://security.microsoft.com",
          sendInvitationMessage: true,
          resetRedemption: true,
        },
        token,
      );
      expect(again.body.invitedUser.id).toBe(invited.body.invitedUser.id);
      expect(
        (
          await api(
            ctx.app,
            "POST",
            "/invitations",
            { invitedUserEmailAddress: "not-an-email", inviteRedirectUrl: "https://x" },
            token,
          )
        ).status,
      ).toBe(400);
      const redeemed = await ctx.app.request(invited.body.inviteRedeemUrl);
      expect(redeemed.status).toBe(200);
      expect(
        (await api(ctx.app, "GET", `/users/${invited.body.invitedUser.id}`, undefined, token)).body.externalUserState,
      ).toBe("Accepted");
      const accepted = await ctx.app.request(`${graphTestBaseUrl}/_graph/simulate/accept-invitation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "pending.analyst@soc.example" }),
      });
      expect(accepted.status).toBe(200);
    });

    it("lists, creates, rejects duplicates, and deletes directory role assignments", async () => {
      const assignments = await api(ctx.app, "GET", "/roleManagement/directory/roleAssignments", undefined, token);
      expect(assignments.status).toBe(200);
      const analystRoles = assignments.body.value
        .filter((assignment: any) => assignment.principalId === DEFAULT_ANALYST_USER_ID)
        .map((assignment: any) => assignment.roleDefinitionId)
        .sort();
      expect(analystRoles).toEqual(
        [ROLE_TEMPLATES.securityAdministrator, ROLE_TEMPLATES.privilegedAuthenticationAdministrator].sort(),
      );
      expect(assignments.body.value[0]).toMatchObject({ directoryScopeId: "/" });
      const created = await api(
        ctx.app,
        "POST",
        "/roleManagement/directory/roleAssignments",
        {
          principalId: DEFAULT_GUEST_USER_ID,
          roleDefinitionId: ROLE_TEMPLATES.privilegedAuthenticationAdministrator,
          directoryScopeId: "/",
        },
        token,
      );
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({
        principalId: DEFAULT_GUEST_USER_ID,
        roleDefinitionId: ROLE_TEMPLATES.privilegedAuthenticationAdministrator,
        directoryScopeId: "/",
      });
      const duplicate = await api(
        ctx.app,
        "POST",
        "/roleManagement/directory/roleAssignments",
        {
          principalId: DEFAULT_GUEST_USER_ID,
          roleDefinitionId: ROLE_TEMPLATES.privilegedAuthenticationAdministrator,
          directoryScopeId: "/",
        },
        token,
      );
      expect(duplicate.status).toBe(400);
      expect(duplicate.body.error.message).toContain("conflicting object");
      expect(
        (
          await api(
            ctx.app,
            "POST",
            "/roleManagement/directory/roleAssignments",
            {
              principalId: "00000000-0000-0000-0000-000000000000",
              roleDefinitionId: ROLE_TEMPLATES.securityReader,
              directoryScopeId: "/",
            },
            token,
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await api(
            ctx.app,
            "POST",
            "/roleManagement/directory/roleAssignments",
            { principalId: DEFAULT_GUEST_USER_ID, roleDefinitionId: "not-a-role", directoryScopeId: "/" },
            token,
          )
        ).status,
      ).toBe(404);
      const filtered = await api(
        ctx.app,
        "GET",
        `/roleManagement/directory/roleAssignments?${new URLSearchParams({ $filter: `principalId eq '${DEFAULT_GUEST_USER_ID}'` }).toString()}`,
        undefined,
        token,
      );
      expect(filtered.body.value).toHaveLength(2);
      expect(
        (await api(ctx.app, "DELETE", `/roleManagement/directory/roleAssignments/${created.body.id}`, undefined, token))
          .status,
      ).toBe(204);
      expect(
        (await api(ctx.app, "GET", `/roleManagement/directory/roleAssignments/${created.body.id}`, undefined, token))
          .status,
      ).toBe(404);
      const definitions = await api(ctx.app, "GET", "/roleManagement/directory/roleDefinitions", undefined, token);
      expect(definitions.body.value.map((role: any) => role.displayName)).toContain("Security Administrator");
      expect(
        (
          await api(ctx.app, "GET", `/directoryRoles/${ROLE_TEMPLATES.securityAdministrator}/members`, undefined, token)
        ).body.value
          .map((user: any) => user.id)
          .sort(),
      ).toEqual([DEFAULT_ANALYST_USER_ID, DEFAULT_GUEST_USER_ID].sort());
      expect(
        (
          await api(ctx.app, "GET", `/users/${DEFAULT_ANALYST_USER_ID}/transitiveMemberOf`, undefined, token)
        ).body.value.some((entry: any) => entry["@odata.type"] === "#microsoft.graph.directoryRole"),
      ).toBe(true);
    });
  });

  describe("$batch", () => {
    it("executes mixed batches the way updateDefenderRoles does", async () => {
      const lookup = `/users?${new URLSearchParams({ $filter: "mail in ('adele.vance@contoso.example','ghost@example.com')", $select: SELECT }).toString()}`;
      const response = await api(
        ctx.app,
        "POST",
        "/$batch",
        {
          requests: [
            { id: "0", method: "GET", url: lookup, headers: {}, body: {} },
            {
              id: "suspend",
              method: "PATCH",
              url: `/users/${DEFAULT_GUEST_USER_ID}`,
              headers: { "Content-Type": "application/json" },
              body: { accountEnabled: false },
            },
            {
              id: "invite",
              method: "POST",
              url: "/invitations",
              headers: { "Content-Type": "application/json" },
              body: {
                invitedUserDisplayName: "Batch Guest",
                invitedUserEmailAddress: "batch.guest@soc.example",
                inviteRedirectUrl: "https://security.microsoft.com",
                sendInvitationMessage: false,
              },
            },
            {
              id: "role",
              method: "POST",
              url: "/roleManagement/directory/roleAssignments",
              headers: { "Content-Type": "application/json" },
              body: {
                principalId: DEFAULT_ADMIN_USER_ID,
                roleDefinitionId: ROLE_TEMPLATES.securityAdministrator,
                directoryScopeId: "/",
              },
            },
            {
              id: "dup",
              method: "POST",
              url: "/roleManagement/directory/roleAssignments",
              headers: { "Content-Type": "application/json" },
              body: {
                principalId: DEFAULT_ANALYST_USER_ID,
                roleDefinitionId: ROLE_TEMPLATES.securityAdministrator,
                directoryScopeId: "/",
              },
            },
            { id: "missing", method: "GET", url: "/users/00000000-0000-0000-0000-000000000000", headers: {}, body: {} },
          ],
        },
        token,
      );
      expect(response.status).toBe(200);
      const byId = Object.fromEntries(response.body.responses.map((entry: any) => [entry.id, entry]));
      expect(byId["0"].status).toBe(200);
      expect(byId["0"].body.value.map((user: any) => user.mail)).toEqual(["adele.vance@contoso.example"]);
      expect(byId.suspend.status).toBe(204);
      expect(byId.invite.status).toBe(201);
      expect(byId.invite.body.invitedUser.userPrincipalName).toContain("#EXT#");
      expect(byId.role.status).toBe(201);
      expect(byId.dup.status).toBe(400);
      expect(byId.dup.body.error.message).toContain("conflicting object");
      expect(byId.missing.status).toBe(404);
      expect(byId.missing.body.error.code).toBe("Request_ResourceNotFound");
      expect((await api(ctx.app, "GET", `/users/${DEFAULT_GUEST_USER_ID}`, undefined, token)).body.accountEnabled).toBe(
        false,
      );
      const tooMany = await api(
        ctx.app,
        "POST",
        "/$batch",
        { requests: Array.from({ length: 21 }, (_, index) => ({ id: String(index), method: "GET", url: "/users" })) },
        token,
      );
      expect(tooMany.status).toBe(400);
      const dependent = await api(
        ctx.app,
        "POST",
        "/$batch",
        {
          requests: [
            { id: "a", method: "GET", url: "/users/nope" },
            { id: "b", method: "GET", url: "/users", dependsOn: ["a"] },
          ],
        },
        token,
      );
      expect(dependent.body.responses[1].status).toBe(424);
    });
  });

  describe("groups, organization, events, inspector, seeds", () => {
    it("manages groups and members", async () => {
      const groups = await api(ctx.app, "GET", "/groups", undefined, token);
      const team = groups.body.value.find((group: any) => group.displayName === "Security Team");
      expect(team).toBeTruthy();
      expect(
        (
          await api(
            ctx.app,
            "POST",
            `/groups/${team.id}/members/$ref`,
            { "@odata.id": `${graphTestBaseUrl}/v1.0/directoryObjects/${DEFAULT_ANALYST_USER_ID}` },
            token,
          )
        ).status,
      ).toBe(204);
      expect(
        (
          await api(
            ctx.app,
            "POST",
            `/groups/${team.id}/members/$ref`,
            { "@odata.id": `${graphTestBaseUrl}/v1.0/directoryObjects/${DEFAULT_ANALYST_USER_ID}` },
            token,
          )
        ).status,
      ).toBe(400);
      expect(
        (await api(ctx.app, "GET", `/groups/${team.id}/members`, undefined, token)).body.value.map(
          (user: any) => user.id,
        ),
      ).toEqual([DEFAULT_ANALYST_USER_ID]);
      expect(
        (await api(ctx.app, "GET", `/users/${DEFAULT_ANALYST_USER_ID}/memberOf`, undefined, token)).body.value[0]
          .displayName,
      ).toBe("Security Team");
      expect(
        (await api(ctx.app, "DELETE", `/groups/${team.id}/members/${DEFAULT_ANALYST_USER_ID}/$ref`, undefined, token))
          .status,
      ).toBe(204);
      const created = await api(
        ctx.app,
        "POST",
        "/groups",
        { displayName: "Ops", mailNickname: "ops", mailEnabled: false, securityEnabled: true },
        token,
      );
      expect(created.status).toBe(201);
      expect((await api(ctx.app, "DELETE", `/groups/${created.body.id}`, undefined, token)).status).toBe(204);
    });

    it("exposes the organization, rejects /me for app tokens, and serves events and the inspector", async () => {
      const organization = await api(ctx.app, "GET", "/organization", undefined, token);
      expect(organization.body.value[0]).toMatchObject({ id: DEFAULT_TENANT_ID, displayName: "Contoso" });
      expect((await api(ctx.app, "GET", "/me", undefined, token)).status).toBe(400);
      expect((await api(ctx.app, "GET", "/servicePrincipals", undefined, token)).body.value[0].appId).toBe(
        DEFAULT_CLIENT_ID,
      );
      const beta = await ctx.app.request(`${graphTestBaseUrl}/beta/users?$top=1`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(beta.status).toBe(200);
      const events = (await (
        await ctx.app.request(`${graphTestBaseUrl}/_graph/events?type=token.issued`)
      ).json()) as any;
      expect(events.events.length).toBeGreaterThan(0);
      for (const tab of ["users", "roles", "invitations", "groups", "tenants", "events", "auth"]) {
        const page = await ctx.app.request(`${graphTestBaseUrl}/?tab=${tab}`);
        expect(page.status).toBe(200);
        expect(await page.text()).toContain("Microsoft Graph");
      }
      expect((await ctx.app.request(`${graphTestBaseUrl}/_graph/events`, { method: "DELETE" })).status).toBe(200);
    });

    it("seeds custom tenants with role names and stable ids", async () => {
      const custom = createGraphTestApp(
        {
          apps: [{ client_id: "212aa55e-c1f9-430c-aa36-4dcda6ae8c36", client_secret: "secret" }],
          tenants: [
            {
              id: "11111111-1111-4111-8111-111111111111",
              displayName: "Customer A",
              domain: "customera.onmicrosoft.com",
              users: [
                {
                  id: "20000000-0000-4000-8000-000000000001",
                  displayName: "Analyst One",
                  mail: "analyst.one@soc.example",
                  userType: "Guest",
                  roles: ["194ae4cb-b126-40b2-bd5b-6091b380977d", "Privileged Authentication Administrator"],
                },
              ],
            },
          ],
        },
        false,
      );
      expect(getGStore(custom.store).roleDefinitions.count()).toBeGreaterThan(5);
      const customToken = await accessToken(
        custom.app,
        "11111111-1111-4111-8111-111111111111",
        "212aa55e-c1f9-430c-aa36-4dcda6ae8c36",
        "secret",
      );
      const users = await api(
        custom.app,
        "GET",
        `/users?${new URLSearchParams({ $filter: "mail in ('analyst.one@soc.example')" }).toString()}`,
        undefined,
        customToken,
      );
      expect(users.body.value[0]).toMatchObject({
        id: "20000000-0000-4000-8000-000000000001",
        userType: "Guest",
        accountEnabled: true,
      });
      const assignments = await api(
        custom.app,
        "GET",
        "/roleManagement/directory/roleAssignments",
        undefined,
        customToken,
      );
      expect(assignments.body.value.map((assignment: any) => assignment.roleDefinitionId).sort()).toEqual(
        [ROLE_TEMPLATES.securityAdministrator, ROLE_TEMPLATES.privilegedAuthenticationAdministrator].sort(),
      );
    });
  });
});
