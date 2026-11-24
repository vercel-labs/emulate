export function join(...parts: string[]): string {
  return parts.join("/").replace(/\/+/g, "/");
}

export function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  return index > 0 ? path.slice(0, index) : ".";
}
