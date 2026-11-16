import { unsupported } from "./unsupported";

export async function lookup(): Promise<never> {
  throw unsupported("dns.lookup");
}
