import { ApiError, parseJsonBody } from "@emulators/core";

type Context = Parameters<typeof parseJsonBody>[0];

/** Routes whose request body GitHub documents as optional treat an empty body as `{}`; invalid JSON is still a 400. */
export async function parseOptionalJsonBody(c: Context): Promise<Record<string, unknown>> {
  if (!(await c.req.raw.clone().text()).trim()) return {};
  return parseJsonBody(c);
}

export function enumValidationError(value: unknown, allowed: readonly string[]): ApiError {
  const shown = typeof value === "string" ? value : JSON.stringify(value);
  return new ApiError(
    422,
    `Invalid request.\n\n${shown} is not a member of ${JSON.stringify(allowed).replace(/,/g, ", ")}.`,
  );
}
