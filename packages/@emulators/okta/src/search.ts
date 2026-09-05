import type { OktaGroup } from "./entities.js";

/**
 * A minimal evaluator for the SCIM-style expressions Okta accepts in the
 * `search` and `filter` query parameters of the groups list endpoint:
 *
 *   profile.name eq "Everyone"
 *   profile.name sw "app_" and type eq "OKTA_GROUP"
 *
 * Supported attributes: id, type, profile.name, profile.description, created,
 * lastUpdated, lastMembershipUpdated. Supported operators: eq, ne, sw, co, pr.
 * Clauses combine with `and` only, which is what group lookups by name use.
 * Anything else is rejected so a client sees Okta's E0000031 instead of an
 * unfiltered page that looks like a match.
 */

export class InvalidSearchError extends Error {}

type Clause = { attribute: string; operator: "eq" | "ne" | "sw" | "co" | "pr"; value: string | null };

const ATTRIBUTES = new Set([
  "id",
  "type",
  "profile.name",
  "profile.description",
  "created",
  "lastupdated",
  "lastmembershipupdated",
]);

const CLAUSE = /^\s*([A-Za-z.]+)\s+(eq|ne|sw|co|pr)(?:\s+"((?:[^"\\]|\\.)*)")?\s*$/i;

function splitAnd(expression: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < expression.length; i += 1) {
    const ch = expression[i]!;
    if (ch === '"' && expression[i - 1] !== "\\") quoted = !quoted;
    if (!quoted && /\s/.test(ch) && expression.slice(i).match(/^\s+and\s+/i)) {
      parts.push(current);
      current = "";
      i += expression.slice(i).match(/^\s+and\s+/i)![0].length - 1;
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

export function parseGroupSearch(expression: string): Clause[] {
  return splitAnd(expression).map((raw) => {
    const match = raw.match(CLAUSE);
    if (!match) throw new InvalidSearchError(`Invalid search expression: ${raw.trim()}`);
    const attribute = match[1]!.toLowerCase();
    const operator = match[2]!.toLowerCase() as Clause["operator"];
    const value = match[3] === undefined ? null : match[3].replace(/\\(.)/g, "$1");
    if (!ATTRIBUTES.has(attribute)) throw new InvalidSearchError(`Unsupported search attribute: ${match[1]}`);
    if (operator === "pr" && value !== null) throw new InvalidSearchError("pr takes no value");
    if (operator !== "pr" && value === null) throw new InvalidSearchError(`${operator} needs a quoted value`);
    return { attribute, operator, value };
  });
}

function groupAttribute(group: OktaGroup, attribute: string): string | null {
  switch (attribute) {
    case "id":
      return group.okta_id;
    case "type":
      return group.type;
    case "profile.name":
      return group.name;
    case "profile.description":
      return group.description;
    case "created":
      return group.created_at;
    case "lastupdated":
    case "lastmembershipupdated":
      return group.updated_at;
    default:
      return null;
  }
}

function matches(group: OktaGroup, clause: Clause): boolean {
  const actual = groupAttribute(group, clause.attribute);
  if (clause.operator === "pr") return actual !== null && actual !== "";
  if (actual === null) return clause.operator === "ne";
  const lhs = actual.toLowerCase();
  const rhs = clause.value!.toLowerCase();
  switch (clause.operator) {
    case "eq":
      return lhs === rhs;
    case "ne":
      return lhs !== rhs;
    case "sw":
      return lhs.startsWith(rhs);
    case "co":
      return lhs.includes(rhs);
  }
}

export function filterGroups(groups: OktaGroup[], expression: string): OktaGroup[] {
  const clauses = parseGroupSearch(expression);
  return groups.filter((group) => clauses.every((clause) => matches(group, clause)));
}
