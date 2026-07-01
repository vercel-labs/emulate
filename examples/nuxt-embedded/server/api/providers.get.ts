// Exposes just the display fields the sign-in UI needs, keeping the full
// provider config (URLs, scopes) on the server.
export default defineEventHandler((event) => {
  return Object.values(getProviders(event)).map((p) => ({
    name: p.name,
    slug: p.slug,
  }));
});
