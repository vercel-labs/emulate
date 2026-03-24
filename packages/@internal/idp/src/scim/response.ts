import type { ScimListResponse, ScimErrorResponse } from "./types.js";
import { SCIM_LIST_RESPONSE_SCHEMA, SCIM_ERROR_SCHEMA } from "./constants.js";

export function scimListResponse<T>(
  resources: T[],
  totalResults: number,
  startIndex: number,
  itemsPerPage: number,
): ScimListResponse<T> {
  return {
    schemas: [SCIM_LIST_RESPONSE_SCHEMA],
    totalResults,
    startIndex,
    itemsPerPage,
    Resources: resources,
  };
}

export function scimError(status: number, detail: string, scimType?: string): ScimErrorResponse {
  return {
    schemas: [SCIM_ERROR_SCHEMA],
    status: String(status),
    ...(scimType ? { scimType } : {}),
    detail,
  };
}

export function paginate<T>(items: T[], startIndex: number, count: number): { page: T[]; total: number } {
  const start = Math.max(0, startIndex - 1); // SCIM is 1-based
  const page = items.slice(start, start + count);
  return { page, total: items.length };
}
