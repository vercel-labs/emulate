import {
  GraphQLScalarType,
  Kind,
  type GraphQLSchema,
  type ValueNode,
  type ObjectValueNode,
  type ListValueNode,
} from "graphql";

function parseLiteral(ast: ValueNode): unknown {
  switch (ast.kind) {
    case Kind.STRING:
    case Kind.BOOLEAN:
      return ast.value;
    case Kind.INT:
    case Kind.FLOAT:
      return Number(ast.value);
    case Kind.NULL:
      return null;
    case Kind.LIST:
      return (ast as ListValueNode).values.map(parseLiteral);
    case Kind.OBJECT: {
      const value = Object.create(null) as Record<string, unknown>;
      for (const field of (ast as ObjectValueNode).fields) {
        value[field.name.value] = parseLiteral(field.value);
      }
      return value;
    }
    default:
      return null;
  }
}

/**
 * Wire implementations onto the bare `JSONObject` scalar produced by `buildSchema`.
 * Production Linear uses JSONObject for activity content, plan, and signalMetadata.
 *
 * Mutates the existing type in place so field references stay valid (no duplicate
 * type names in the schema).
 */
export function withJSONObjectScalar(schema: GraphQLSchema): GraphQLSchema {
  const type = schema.getType("JSONObject");
  if (!(type instanceof GraphQLScalarType)) {
    throw new Error("Expected JSONObject scalar in Linear GraphQL schema");
  }

  // GraphQLScalarType methods from SDL throw until configured; overwrite in place.
  const scalar = type as GraphQLScalarType & {
    serialize: (value: unknown) => unknown;
    parseValue: (value: unknown) => unknown;
    parseLiteral: (ast: ValueNode) => unknown;
  };
  scalar.serialize = (value: unknown) => value;
  scalar.parseValue = (value: unknown) => value;
  scalar.parseLiteral = (ast: ValueNode) => parseLiteral(ast);
  return schema;
}
