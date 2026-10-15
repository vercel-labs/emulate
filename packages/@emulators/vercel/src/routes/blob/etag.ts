// Clients may send x-if-match with or without the surrounding quotes.
export function normalizeEtag(etag: string): string {
  return etag.startsWith('"') ? etag : `"${etag}"`;
}

export function etagMatches(etag: string | undefined, ifMatch: string): boolean {
  return etag !== undefined && etag === normalizeEtag(ifMatch);
}
