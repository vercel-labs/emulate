// Initiates the OAuth flow: builds the authorize URL pointing at the embedded
// emulator (same origin) and redirects the browser there.
export default defineEventHandler((event) => {
  const slug = getRouterParam(event, "provider") ?? "";
  const provider = getProviders(event)[slug];
  if (!provider) {
    throw createError({ statusCode: 404, statusMessage: "Unknown provider" });
  }

  const url = new URL(provider.authorizeUrl);
  url.searchParams.set("client_id", "any");
  url.searchParams.set("redirect_uri", getCallbackUrl(event, slug));
  url.searchParams.set("scope", provider.scope);
  url.searchParams.set("state", crypto.randomUUID());
  url.searchParams.set("response_type", "code");

  return sendRedirect(event, url.toString());
});
