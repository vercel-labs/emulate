const PREFIX = "emulate.playground.";

/** Keeps what a flow needs for when the browser comes back from an emulator's page. */
export function remember(key: string, value: unknown): void {
  window.sessionStorage.setItem(PREFIX + key, JSON.stringify(value));
}

/** Takes back what a flow remembered, once. Null when nothing was kept. */
export function recall<T>(key: string): T | null {
  const saved = window.sessionStorage.getItem(PREFIX + key);
  window.sessionStorage.removeItem(PREFIX + key);
  return saved === null ? null : (JSON.parse(saved) as T);
}

/** Reads the query an emulator sent the browser back with and clears it from the address bar, so a reload starts fresh. */
export function takeReturnQuery(): URLSearchParams {
  const query = new URLSearchParams(window.location.search);
  if (window.location.search) window.history.replaceState(null, "", window.location.pathname);
  return query;
}

/** The address of the page a flow lives on, without a query: where an emulator sends the browser back to. */
export function flowUrl(): string {
  return `${window.location.origin}${window.location.pathname}`;
}
