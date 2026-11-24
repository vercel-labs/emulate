import { NextResponse } from "next/server";
import { getProvider, getCallbackUrl } from "@/lib/oauth/providers";
import { SESSION_COOKIE, encodeSession, type Session } from "@/lib/oauth/session";

/** Reads the claims of an id_token without verifying it. Used for providers with no userinfo endpoint. */
function decodeIdTokenClaims(idToken: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(idToken.split(".")[1], "base64url").toString("utf-8"));
}

export async function GET(request: Request, { params }: { params: Promise<{ provider: string }> }) {
  const { provider: slug } = await params;
  const provider = getProvider(slug);
  if (!provider) {
    return new Response("Unknown provider", { status: 404 });
  }

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  if (!code) {
    return new Response("Missing code", { status: 400 });
  }

  const tokenBody: Record<string, string> = {
    grant_type: "authorization_code",
    code,
    client_id: provider.clientId,
    client_secret: provider.clientSecret,
    redirect_uri: getCallbackUrl(slug),
  };

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

  if (!accessToken || (!provider.userInfoUrl && !tokenData.id_token)) {
    return new Response(`Token exchange failed: ${JSON.stringify(tokenData)}`, { status: 502 });
  }

  const userData = provider.userInfoUrl
    ? await (
        await fetch(provider.userInfoUrl, {
          headers: { Authorization: `Bearer ${accessToken}` },
        })
      ).json()
    : decodeIdTokenClaims(tokenData.id_token);

  const session: Session = {
    provider: slug,
    accessToken,
    user: {
      name: userData[provider.userNameField] ?? userData[provider.userEmailField] ?? "Unknown",
      email: userData[provider.userEmailField] ?? "",
      login: provider.userLoginField ? userData[provider.userLoginField] : undefined,
      avatar: provider.userAvatarField ? userData[provider.userAvatarField] : undefined,
    },
  };

  const response = NextResponse.redirect(new URL("/oauth/dashboard", request.url));
  response.cookies.set(SESSION_COOKIE, encodeSession(session), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60,
  });
  return response;
}
