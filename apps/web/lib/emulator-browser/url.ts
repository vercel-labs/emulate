export function fileURLToPath(url: string | URL): string {
  return String(url).replace(/^file:\/\//, "");
}
