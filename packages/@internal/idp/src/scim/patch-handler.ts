import type { ScimPatchOp } from "./types.js";

export function applyPatchOps(
  resource: Record<string, unknown>,
  operations: ScimPatchOp[],
): Record<string, unknown> {
  let result = structuredClone(resource);

  for (const op of operations) {
    switch (op.op) {
      case "add":
        result = applyAdd(result, op.path, op.value);
        break;
      case "replace":
        result = applyReplace(result, op.path, op.value);
        break;
      case "remove":
        if (!op.path) throw new Error("remove requires a path");
        result = applyRemove(result, op.path);
        break;
      default:
        throw new Error(`Unsupported SCIM PATCH op: ${(op as any).op}`);
    }
  }

  return result;
}

function applyAdd(
  resource: Record<string, unknown>,
  path: string | undefined,
  value: unknown,
): Record<string, unknown> {
  if (!path) {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return { ...resource, ...(value as Record<string, unknown>) };
    }
    return resource;
  }

  const { target, key, parent } = resolvePatchPath(resource, path);

  if (Array.isArray(target) && Array.isArray(value)) {
    target.push(...value);
  } else if (parent && key) {
    (parent as Record<string, unknown>)[key] = value;
  }

  return resource;
}

function applyReplace(
  resource: Record<string, unknown>,
  path: string | undefined,
  value: unknown,
): Record<string, unknown> {
  if (!path) {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return { ...resource, ...(value as Record<string, unknown>) };
    }
    return resource;
  }

  const { parent, key } = resolvePatchPath(resource, path);
  if (parent && key) {
    (parent as Record<string, unknown>)[key] = value;
  }

  return resource;
}

function applyRemove(
  resource: Record<string, unknown>,
  path: string,
): Record<string, unknown> {
  // Check for value filter: e.g., members[value eq "1"]
  const bracketMatch = path.match(/^([^[]+)\[(.+)\]$/);
  if (bracketMatch) {
    const [, arrayPath, filterExpr] = bracketMatch;
    const { target, parent, key } = resolvePatchPath(resource, arrayPath);
    if (Array.isArray(target)) {
      const filterMatch = filterExpr.match(/^(\w+)\s+eq\s+"([^"]+)"$/);
      if (filterMatch) {
        const [, filterAttr, filterVal] = filterMatch;
        const filtered = target.filter(
          (item: Record<string, unknown>) =>
            String(item[filterAttr]).toLowerCase() !== filterVal.toLowerCase(),
        );
        if (parent && key) {
          (parent as Record<string, unknown>)[key] = filtered;
        }
      }
    }
    return resource;
  }

  const { parent, key } = resolvePatchPath(resource, path);
  if (parent && key) {
    delete (parent as Record<string, unknown>)[key];
  }

  return resource;
}

/** Known SCIM URN prefixes for extension schemas */
const KNOWN_URN_PREFIXES = [
  "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User",
] as const;

function resolvePatchPath(
  resource: Record<string, unknown>,
  path: string,
): { target: unknown; parent: unknown; key: string } {
  // Handle URN-prefixed paths: urn:...:User:attrName
  for (const urn of KNOWN_URN_PREFIXES) {
    if (path.startsWith(urn + ":")) {
      const attrName = path.slice(urn.length + 1);
      const schemaObj = resource[urn];
      if (typeof schemaObj === "object" && schemaObj !== null) {
        return {
          target: (schemaObj as Record<string, unknown>)[attrName],
          parent: schemaObj,
          key: attrName,
        };
      }
      resource[urn] = {};
      return { target: undefined, parent: resource[urn], key: attrName };
    }
  }

  // Handle dot-paths: name.givenName
  const parts = path.split(".");
  let current: unknown = resource;
  let parent: unknown = null;
  const key = parts[parts.length - 1];

  for (let i = 0; i < parts.length - 1; i++) {
    if (current == null || typeof current !== "object") {
      return { target: undefined, parent: null, key };
    }
    current = (current as Record<string, unknown>)[parts[i]];
  }

  parent = current;
  const target =
    current != null && typeof current === "object"
      ? (current as Record<string, unknown>)[key]
      : undefined;

  return { target, parent, key };
}
