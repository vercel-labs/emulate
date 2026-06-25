import type { WebhookDispatcher } from "@emulators/core";

export type ClerkWebhookEventType =
  | "user.created"
  | "user.updated"
  | "user.deleted"
  | "organization.created"
  | "organization.updated"
  | "organization.deleted"
  | "org_membership.created"
  | "org_membership.updated"
  | "org_membership.deleted"
  | "org_invitation.created"
  | "org_invitation.accepted"
  | "org_invitation.revoked"
  | "org_domain.created"
  | "org_domain.updated"
  | "org_domain.deleted";

export function dispatchClerkEvent(
  webhooks: WebhookDispatcher,
  type: ClerkWebhookEventType,
  data: Record<string, unknown>,
): void {
  webhooks.dispatch(type, undefined, { type, data }, "clerk").catch(() => {});
}
