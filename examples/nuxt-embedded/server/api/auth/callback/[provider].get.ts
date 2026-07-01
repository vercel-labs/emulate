import type { Session } from "../../../utils/session";

// Handles the OAuth callback: exchanges the authorization code for an access
// token via the embedded emulator, fetches the user profile, stores the
// session in an HTTP-only cookie, and redirects to the dashboard.
export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, "provider") ?? "";
  const provider = getProviders(event)[slug];
  if (!provider) {
    throw createError({ statusCode: 404, statusMessage: "Unknown provider" });
  }

  const code = getQuery(event).code;
  if (typeof code !== "string" || !code) {
    throw createError({ statusCode: 400, statusMessage: "Missing code" });
  }

  const tokenBody: Record<string, string> = {
    code,
    client_id: "any",
    client_secret: "any",
    redirect_uri: getCallbackUrl(event, slug),
  };
  if (slug === "google") {
    tokenBody.grant_type = "authorization_code";
  }

  const tokenRes = await fetch(provider.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": provider.tokenRequestContentType ?? "application/json",
      Accept: "application/json",
    },
    body:
      provider.tokenRequestContentType === "application/x-www-form-urlencoded"
        ? new URLSearchParams(tokenBody).toString()
        : JSON.stringify(tokenBody),
  });

  const tokenData = await tokenRes.json();
  const accessToken: string = tokenData[provider.tokenResponseAccessTokenField ?? "access_token"];

  if (!accessToken) {
    throw createError({
      statusCode: 502,
      statusMessage: `Token exchange failed: ${JSON.stringify(tokenData)}`,
    });
  }

  const userRes = await fetch(provider.userInfoUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const userData = await userRes.json();

  const session: Session = {
    provider: slug,
    accessToken,
    user: {
      name: userData[provider.userNameField] ?? "Unknown",
      email: userData[provider.userEmailField] ?? "",
      login: provider.userLoginField ? userData[provider.userLoginField] : undefined,
      avatar: provider.userAvatarField ? userData[provider.userAvatarField] : undefined,
    },
  };

  writeSession(event, session);
  return sendRedirect(event, "/dashboard");
});
