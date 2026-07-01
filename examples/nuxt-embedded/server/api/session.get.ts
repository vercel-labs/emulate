// Returns the current session (or null). The session cookie is HTTP-only, so
// the browser can't read it directly — pages fetch it through this endpoint.
export default defineEventHandler((event) => {
  return readSession(event);
});
