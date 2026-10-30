import {
  Kind,
  getNamedType,
  isAbstractType,
  isObjectType,
  valueFromAST,
  type FieldNode,
  type FragmentDefinitionNode,
  type GraphQLObjectType,
  type GraphQLSchema,
  type OperationDefinitionNode,
  type SelectionSetNode,
} from "graphql";
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

export interface QueryCost {
  cost: number;
  nodeCount: number;
}

/**
 * GitHub's primary rate limit cost: each connection costs one request per possible parent
 * (the product of the enclosing connections' `first`/`last`), the sum is divided by 100 and
 * rounded, with a minimum of 1. A mutation request costs 1.
 */
export function queryCost(
  schema: GraphQLSchema,
  operation: OperationDefinitionNode,
  fragments: Record<string, FragmentDefinitionNode>,
  variables: Record<string, unknown>,
): QueryCost {
  let requests = 0;
  let nodeCount = 0;

  const walk = (
    set: SelectionSetNode | undefined,
    types: readonly GraphQLObjectType[],
    multiplier: number,
    nodeMultiplier: number,
    seen: Set<string>,
  ) => {
    for (const selection of set?.selections ?? []) {
      if (selection.kind === Kind.FRAGMENT_SPREAD) {
        const name = selection.name.value;
        const fragment = fragments[name];
        if (!fragment || seen.has(name)) continue;
        walk(
          fragment.selectionSet,
          narrow(schema, types, fragment.typeCondition.name.value),
          multiplier,
          nodeMultiplier,
          new Set([...seen, name]),
        );
        continue;
      }
      if (selection.kind === Kind.INLINE_FRAGMENT) {
        const condition = selection.typeCondition?.name.value;
        walk(
          selection.selectionSet,
          condition ? narrow(schema, types, condition) : types,
          multiplier,
          nodeMultiplier,
          seen,
        );
        continue;
      }
      const type = types.find((t) => t.getFields()[selection.name.value]);
      const field = type?.getFields()[selection.name.value];
      if (!field) continue;
      let childMultiplier = multiplier;
      let childNodeMultiplier = nodeMultiplier;
      if (isConnectionField(field.args)) {
        requests += multiplier;
        const argValue = (name: string) => {
          const node = selection.arguments?.find((a) => a.name.value === name);
          const def = field.args.find((a) => a.name === name)!;
          return node ? valueFromAST(node.value, def.type, variables) : undefined;
        };
        const size = argValue("first") ?? argValue("last");
        const pageSize = typeof size === "number" ? size : 0;
        childMultiplier = multiplier * (typeof size === "number" ? size : MAX_PAGE_SIZE);
        nodeCount += nodeMultiplier * pageSize;
        childNodeMultiplier = nodeMultiplier * Math.max(1, pageSize);
      }
      const named = getNamedType(field.type);
      const childTypes = isObjectType(named) ? [named] : isAbstractType(named) ? schema.getPossibleTypes(named) : [];
      walk(selection.selectionSet, childTypes, childMultiplier, childNodeMultiplier, seen);
    }
  };

  const root = operation.operation === "subscription" ? schema.getSubscriptionType() : schema.getQueryType();
  if (operation.operation === "mutation") return { cost: 1, nodeCount: 0 };
  if (root) walk(operation.selectionSet, [root], 1, 1, new Set());
  return { cost: Math.max(1, Math.round(requests / 100)), nodeCount };
}

function narrow(schema: GraphQLSchema, types: readonly GraphQLObjectType[], condition: string): GraphQLObjectType[] {
  const target = schema.getType(condition);
  if (!target) return [];
  if (isObjectType(target)) return [target];
  if (isAbstractType(target)) return types.filter((t) => schema.isSubType(target, t));
  return [];
}
