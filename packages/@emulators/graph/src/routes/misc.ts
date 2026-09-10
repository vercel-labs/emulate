import type { AppEnv, Hono } from "@emulators/core";
import { formatInvitation, formatUser, type Fmt } from "../formatters.js";
import { parseJsonBody, str } from "../helpers.js";
import { logEvent, type GStore } from "../store.js";

export function miscRoutes(app: Hono<AppEnv>, gs: GStore, fmt: Fmt): void {
  app.get("/_graph/redeem/:code", (c) => {
    const invitation = gs.invitations
      .all()
      .find((candidate) => candidate.inviteRedeemUrl.endsWith(`/${c.req.param("code")}`));
    if (!invitation) return c.text("Invitation not found", 404);
    return acceptInvitation(invitation.invitation_id, c);
  });

  app.post("/_graph/simulate/accept-invitation", async (c) => {
    const body = await parseJsonBody(c);
    const reference = str(body.invitationId) ?? str(body.email) ?? str(body.userId);
    if (!reference) return c.json({ error: "invitationId, email, or userId is required" }, 400);
    const invitation =
      gs.invitations.findOneBy("invitation_id", reference) ??
      gs.invitations.findOneBy("invited_user_id", reference) ??
      [...gs.invitations.all()]
        .reverse()
        .find((candidate) => candidate.invitedUserEmailAddress === reference.toLowerCase());
    if (!invitation) return c.json({ error: `No invitation found for ${reference}` }, 404);
    return acceptInvitation(invitation.invitation_id, c);
  });

  app.post("/_graph/simulate/sign-in", async (c) => {
    const body = await parseJsonBody(c);
    const reference = str(body.userId) ?? str(body.userPrincipalName) ?? str(body.mail);
    if (!reference) return c.json({ error: "userId, userPrincipalName, or mail is required" }, 400);
    const user =
      gs.users.findOneBy("object_id", reference) ??
      gs.users
        .all()
        .find(
          (candidate) =>
            candidate.userPrincipalName.toLowerCase() === reference.toLowerCase() ||
            candidate.mail?.toLowerCase() === reference.toLowerCase(),
        );
    if (!user) return c.json({ error: `User ${reference} was not found` }, 404);
    if (!user.accountEnabled)
      return c.json({ error: "AADSTS50057: The user account is disabled.", user: formatUser(user) }, 403);
    logEvent(gs, user.tenant_id, "user.signed_in", user.object_id, { userPrincipalName: user.userPrincipalName });
    return c.json({ ok: true, user: formatUser(user) });
  });

  app.get("/_graph/events", (c) => {
    const type = c.req.query("type");
    const tenant = c.req.query("tenant");
    const limit = Math.min(Number(c.req.query("limit") ?? 100), 1000);
    const events = [...gs.events.all()]
      .filter((event) => (!type || event.type === type) && (!tenant || event.tenant_id === tenant))
      .sort((a, b) => b.id - a.id)
      .slice(0, limit);
    return c.json({
      events: events.map((event) => ({
        id: event.id,
        tenant_id: event.tenant_id,
        type: event.type,
        subject: event.subject,
        detail: event.detail,
        created_at: event.created_at,
      })),
    });
  });

  app.delete("/_graph/events", (c) => {
    gs.events.clear();
    return c.json({ ok: true });
  });

  function acceptInvitation(invitationId: string, c: Parameters<Parameters<typeof app.get>[1]>[0]) {
    const invitation = gs.invitations.findOneBy("invitation_id", invitationId)!;
    const user = gs.users.findOneBy("object_id", invitation.invited_user_id);
    gs.invitations.update(invitation.id, { status: "Completed" });
    if (user)
      gs.users.update(user.id, {
        externalUserState: "Accepted",
        externalUserStateChangeDateTime: new Date().toISOString(),
      });
    logEvent(gs, invitation.tenant_id, "invitation.accepted", invitation.invitation_id, {
      email: invitation.invitedUserEmailAddress,
      userId: invitation.invited_user_id,
    });
    return c.json({
      invitation: formatInvitation(fmt, gs.invitations.get(invitation.id)!),
      user: user ? formatUser(gs.users.get(user.id)!) : null,
      redirectUrl: invitation.inviteRedirectUrl,
    });
  }
}
