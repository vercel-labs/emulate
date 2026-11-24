import { unsupported } from "./unsupported";

export function request(): never {
  throw unsupported("https.request");
}
