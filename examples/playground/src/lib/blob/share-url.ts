export function sharePathForPathname(pathname: string): string {
  return `/blob/f/${pathname.split("/").map(encodeURIComponent).join("/")}`;
}

/** Rebuilds a blob pathname from the share route's segments, which arrive URL-encoded. */
export function pathnameFromShareSegments(pathname: string[]): string {
  return pathname.map(decodeURIComponent).join("/");
}
