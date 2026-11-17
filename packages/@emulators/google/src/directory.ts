import { createHash, randomInt } from "node:crypto";
import type { Context, Store } from "@emulators/core";
import type { GoogleGroup, GoogleGroupMember, GoogleUser } from "./entities.js";
import { getGoogleStore, type GoogleStore } from "./store.js";

const CUSTOMER_ID_KEY = "google.directory.customerId";

export function getCustomerId(store: Store): string {
  let customerId = store.getData<string>(CUSTOMER_ID_KEY);
  if (!customerId) {
    customerId = `C0${randomBase36(7)}`;
    store.setData(CUSTOMER_ID_KEY, customerId);
  }
  return customerId;
}

export function setCustomerId(store: Store, customerId: string): void {
  store.setData(CUSTOMER_ID_KEY, customerId);
}

function randomBase36(length: number): string {
  let out = "";
  while (out.length < length) out += randomInt(0, 36).toString(36);
  return out;
}

// The formats of Google's identifiers, as real API responses show them (none is documented):
// - user IDs: 21 digits starting with 1 ("104065793340555884068"; the OpenID Connect page's `sub` example,
//   "110169484474386276334"), the same value as the ID token's `sub`;
// - group IDs: 15 characters, `0` then lowercase letters and digits ("017dp8vu2zdcnpe", "01baon6m2gef3w5");
// - customer IDs: `C0` then 7 lowercase letters and digits ("C02f0zfqw", "C03puekhd").
export function generateDirectoryUserId(): string {
  let id = "1";
  while (id.length < 21) id += String(randomInt(0, 10));
  return id;
}

export function generateGroupId(): string {
  return `0${randomBase36(14)}`;
}

/** The test domain alias Google gives every address of a domain with Gmail (`<local>@<domain>.test-google-a.com`),
 * listed in `nonEditableAliases` (real responses show it). */
export function testDomainAlias(email: string): string {
  const [local, domain] = email.split("@");
  return `${local}@${domain}.test-google-a.com`;
}

export function emailDomain(email: string): string {
  return email.split("@")[1]?.toLowerCase() ?? "";
}

/** The account's users: those of a hosted domain. Consumer accounts (`gmail.com`) belong to no account. */
export function directoryUsers(gs: GoogleStore): GoogleUser[] {
  return gs.users.all().filter((user) => user.hd);
}

export function findUserByKey(gs: GoogleStore, key: string): GoogleUser | undefined {
  const lowered = key.toLowerCase();
  return directoryUsers(gs).find((user) => user.uid === key || user.email.toLowerCase() === lowered);
}

export function findGroupByKey(gs: GoogleStore, key: string): GoogleGroup | undefined {
  const lowered = key.toLowerCase();
  return gs.groups.all().find((group) => group.google_id === key || group.email.toLowerCase() === lowered);
}

export function findMember(gs: GoogleStore, group: GoogleGroup, key: string): GoogleGroupMember | undefined {
  const lowered = key.toLowerCase();
  return gs.groupMembers
    .findBy("group_google_id", group.google_id)
    .find((member) => member.member_id === key || member.email.toLowerCase() === lowered);
}

// Etags are two base64url parts joined by a slash, in quotes ("BvGfkzKoKVD0NM7VdXdzkXDD-nHLkyMjheL_9Z5X0H0/
// oMJEIb2O8LE-zfPM0TV_9m3WkMA" in a real response).
function etagOf(resource: Record<string, unknown>): string {
  const hash = createHash("sha256").update(JSON.stringify(resource)).digest("base64url");
  return `"${hash.slice(0, 43)}/${hash.slice(8, 35)}"`;
}

export function userResource(store: Store, user: GoogleUser): Record<string, unknown> {
  const suspended = user.suspended === true;
  const resource: Record<string, unknown> = {
    kind: "admin#directory#user",
    id: user.uid,
    primaryEmail: user.email,
    name: {
      givenName: user.given_name,
      familyName: user.family_name,
      fullName: [user.given_name, user.family_name].filter(Boolean).join(" ") || user.name,
    },
    isAdmin: user.is_admin === true,
    isDelegatedAdmin: false,
    // A user who never signed in shows the epoch, as real responses do.
    lastLoginTime: user.last_login_time ?? "1970-01-01T00:00:00.000Z",
    creationTime: user.creation_time ?? new Date(user.created_at).toISOString(),
    agreedToTerms: Boolean(user.last_login_time),
    suspended,
    // "ADMIN" for a suspension by an administrator, as the users guide's sample shows it
    // (https://developers.google.com/workspace/admin/directory/v1/guides/manage-users).
    ...(suspended ? { suspensionReason: "ADMIN" } : {}),
    archived: false,
    changePasswordAtNextLogin: user.change_password_at_next_login === true,
    ipWhitelisted: false,
    emails: [{ address: user.email, primary: true }, { address: testDomainAlias(user.email) }],
    nonEditableAliases: [testDomainAlias(user.email)],
    customerId: getCustomerId(store),
    orgUnitPath: user.org_unit_path ?? "/",
    isMailboxSetup: true,
    includeInGlobalAddressList: user.include_in_global_address_list ?? true,
    isEnrolledIn2Sv: false,
    isEnforcedIn2Sv: false,
  };
  return { ...resource, etag: etagOf(resource) };
}

export function groupResource(gs: GoogleStore, group: GoogleGroup): Record<string, unknown> {
  const resource: Record<string, unknown> = {
    kind: "admin#directory#group",
    id: group.google_id,
    email: group.email,
    name: group.name,
    directMembersCount: String(gs.groupMembers.findBy("group_google_id", group.google_id).length),
    description: group.description,
    adminCreated: group.admin_created,
    nonEditableAliases: [testDomainAlias(group.email)],
  };
  return { ...resource, etag: etagOf(resource) };
}

export function memberResource(member: GoogleGroupMember): Record<string, unknown> {
  const resource: Record<string, unknown> = {
    kind: "admin#directory#member",
    id: member.member_id,
    email: member.email,
    role: member.role,
    type: member.type,
    status: "ACTIVE",
  };
  return { ...resource, etag: etagOf(resource) };
}

/** Whether `group` is `ancestor` or contains it, directly or through nested groups. */
export function groupContains(gs: GoogleStore, group: GoogleGroup, ancestor: GoogleGroup): boolean {
  const seen = new Set<string>();
  const pending = [group.google_id];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current === ancestor.google_id) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const member of gs.groupMembers.findBy("group_google_id", current)) {
      if (member.type === "GROUP") pending.push(member.member_id);
    }
  }
  return false;
}

/** Removes every membership of a deleted user or group, and a deleted group's own members. */
export function removeMemberships(store: Store, memberId: string): void {
  const gs = getGoogleStore(store);
  for (const member of gs.groupMembers.findBy("member_id", memberId)) gs.groupMembers.delete(member.id);
  for (const member of gs.groupMembers.findBy("group_google_id", memberId)) gs.groupMembers.delete(member.id);
}

type FieldTree = Map<string, FieldTree | null>;

/**
 * Parses a partial response selector (`fields=nextPageToken,users(primaryEmail,name/givenName)`), as documented in
 * https://developers.google.com/workspace/admin/directory/v1/guides/performance#partial-response.
 */
export function parseFieldSelector(selector: string): FieldTree | null {
  let i = 0;
  function parseList(): FieldTree {
    const tree: FieldTree = new Map();
    while (i < selector.length && selector[i] !== ")") {
      const start = i;
      while (i < selector.length && !",()".includes(selector[i])) i++;
      const path = selector.slice(start, i).trim().split("/").filter(Boolean);
      let sub: FieldTree | null = null;
      if (selector[i] === "(") {
        i++;
        sub = parseList();
        i++;
      }
      if (path.length > 0) mergePath(tree, path, sub);
      if (selector[i] === ",") i++;
    }
    return tree;
  }
  function mergePath(tree: FieldTree, path: string[], leaf: FieldTree | null): void {
    const [head, ...rest] = path;
    if (head === "*") return;
    if (rest.length === 0) {
      const existing = tree.get(head);
      tree.set(
        head,
        existing === undefined ? leaf : existing === null || leaf === null ? null : mergeTrees(existing, leaf),
      );
      return;
    }
    let child = tree.get(head);
    if (child === null) return;
    if (child === undefined) {
      child = new Map();
      tree.set(head, child);
    }
    mergePath(child, rest, leaf);
  }
  function mergeTrees(a: FieldTree, b: FieldTree): FieldTree {
    for (const [key, value] of b) {
      const existing = a.get(key);
      a.set(
        key,
        existing === undefined ? value : existing === null || value === null ? null : mergeTrees(existing, value),
      );
    }
    return a;
  }
  const trimmed = selector.trim();
  if (trimmed === "" || trimmed === "*") return null;
  return parseList();
}

export function selectFields(value: unknown, tree: FieldTree | null): unknown {
  if (tree === null) return value;
  if (Array.isArray(value)) return value.map((item) => selectFields(item, tree));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, sub] of tree) {
    if (key in (value as Record<string, unknown>)) {
      out[key] = selectFields((value as Record<string, unknown>)[key], sub);
    }
  }
  return out;
}

const CREDENTIALS_HELP =
  "Expected OAuth 2 access token, login cookie or other valid authentication credential. See https://developers.google.com/identity/sign-in/web/devconsole-project.";

/**
 * The Directory API's 401, as admin.googleapis.com answers it (captured 2026-11-12 with no `Authorization` header,
 * and with an unknown bearer token): "Login Required." with reason `required` when no credential is sent, "Invalid
 * Credentials" with reason `authError` otherwise. Google adds a `google.rpc.ErrorInfo` detail naming its internal
 * method to the first; the emulator leaves it out.
 */
export function directoryAuthError(c: Context): Response {
  const missing = !c.req.header("Authorization");
  return c.json(
    {
      error: {
        code: 401,
        message: `${missing ? "Request is missing required authentication credential" : "Request had invalid authentication credentials"}. ${CREDENTIALS_HELP}`,
        errors: [
          {
            message: missing ? "Login Required." : "Invalid Credentials",
            domain: "global",
            reason: missing ? "required" : "authError",
            location: "Authorization",
            locationType: "header",
          },
        ],
        status: "UNAUTHENTICATED",
      },
    },
    401,
  );
}
