import { unsupported } from "./unsupported";

export function createServer(): never {
  throw unsupported("http.createServer");
}

export function request(): never {
  throw unsupported("http.request");
}
