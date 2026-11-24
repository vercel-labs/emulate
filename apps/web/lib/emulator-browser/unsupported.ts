export function unsupported(name: string): Error {
  return new Error(`${name} is not available in the browser playground`);
}
