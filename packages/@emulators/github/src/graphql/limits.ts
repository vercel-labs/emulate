import { Kind, type FieldNode, type FragmentDefinitionNode, type SelectionSetNode } from "graphql";
import { GitHubGraphQLError } from "./context.js";

const MAX_PAGE_SIZE = 100;

export function isConnectionField(args: readonly { name: string }[]): boolean {
  const names = new Set(args.map((a) => a.name));
  return names.has("first") && names.has("last");
}

export function paginationError(
  field: string,
  args: { first?: number | null; last?: number | null },
  selectsPage: boolean,
): GitHubGraphQLError | null {
  const { first, last } = args;
  if (typeof first === "number" && typeof last === "number") {
    return new GitHubGraphQLError(
      undefined,
      `Passing both \`first\` and \`last\` to paginate the \`${field}\` connection is not supported.`,
    );
  }
  for (const [name, value] of [
    ["first", first],
    ["last", last],
  ] as const) {
    if (typeof value !== "number") continue;
    if (value < 0) {
      return new GitHubGraphQLError(
        "INVALID_PAGINATION",
        `\`${name}\` on the \`${field}\` connection cannot be less than zero.`,
      );
    }
    if (value > MAX_PAGE_SIZE) {
      return new GitHubGraphQLError(
        "EXCESSIVE_PAGINATION",
        `Requesting ${value} records on the \`${field}\` connection exceeds the \`${name}\` limit of ${MAX_PAGE_SIZE} records.`,
      );
    }
  }
  if (selectsPage && typeof first !== "number" && typeof last !== "number") {
    return new GitHubGraphQLError(
      "MISSING_PAGINATION_BOUNDARIES",
      `You must provide a \`first\` or \`last\` value to properly paginate the \`${field}\` connection.`,
    );
  }
  return null;
}

const PAGE_FIELDS = new Set(["nodes", "edges", "pageInfo"]);

export function selectsPage(
  fieldNodes: readonly FieldNode[],
  fragments: Record<string, FragmentDefinitionNode>,
): boolean {
  const visit = (set: SelectionSetNode | undefined, seen: Set<string>): boolean =>
    (set?.selections ?? []).some((selection) => {
      if (selection.kind === Kind.FIELD) return PAGE_FIELDS.has(selection.name.value);
      if (selection.kind === Kind.INLINE_FRAGMENT) return visit(selection.selectionSet, seen);
      const name = selection.name.value;
      if (seen.has(name)) return false;
      seen.add(name);
      return visit(fragments[name]?.selectionSet, seen);
    });
  return fieldNodes.some((node) => visit(node.selectionSet, new Set()));
}
