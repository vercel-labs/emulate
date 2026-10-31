import { parseJsonBody } from "@emulators/core";

type Context = Parameters<typeof parseJsonBody>[0];

/** Routes whose request body GitHub documents as optional treat an empty body as `{}`; invalid JSON is still a 400. */
export async function parseOptionalJsonBody(c: Context): Promise<Record<string, unknown>> {
  if (!(await c.req.raw.clone().text()).trim()) return {};
  return parseJsonBody(c);
}
