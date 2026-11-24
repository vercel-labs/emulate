import { unsupported } from "./unsupported";

export function isIP(input: string): number {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(input)) return 4;
  if (input.includes(":")) return 6;
  return 0;
}

export function connect(): never {
  throw unsupported("net.connect");
}
