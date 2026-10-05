import { isDeepStrictEqual } from "node:util";

export interface KnownGap<Observation> {
  id: string;
  reason: string;
  source: string;
  current: Observation;
}

export async function checkContract<Observation>(
  observe: () => Promise<Observation>,
  expected: Observation,
  gap?: KnownGap<Observation>,
): Promise<"contract-pass" | "known-gap"> {
  const actual = await observe();
  if (isDeepStrictEqual(actual, expected)) {
    if (gap) throw new Error(`${gap.id}: unexpected success; remove the known-gap designation`);
    return "contract-pass";
  }
  if (gap && isDeepStrictEqual(actual, gap.current)) return "known-gap";
  throw new Error(
    `${gap?.id ?? "contract"}: unexpected mismatch\nExpected: ${JSON.stringify(expected)}\nActual: ${JSON.stringify(actual)}`,
  );
}

export function localOnlyFetch(origin: string, transport: typeof fetch): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== origin || url.username || url.password) {
      throw new Error(`Blob contract blocked non-local fetch: ${url.origin}`);
    }
    const response = await transport(input, { ...init, redirect: "manual" });
    if (response.status >= 300 && response.status < 400 && response.status !== 304) {
      throw new Error("Blob contract blocked redirect; no redirect was followed");
    }
    return response;
  };
}
