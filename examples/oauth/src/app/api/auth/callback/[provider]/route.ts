import { NextResponse } from "next/server";
import { providers, getCallbackUrl } from "@/lib/providers";
import { encodeSession, type Session } from "@/lib/session";

export async function GET(request: Request, { params }: { params: Promise<{ provider: string }> }) {
  const { provider: slug } = await params;
  const provider = providers[slug];
  if (!provider) {
    return new Response("Unknown provider", { status: 404 });
  }

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  if (!code) {
    return new Response("Missing code", { status: 400 });
  }

  const tokenBody: Record<string, string> = {
    code,
    client_id: provider.clientId,
    client_secret: provider.clientSecret,
    redirect_uri: getCallbackUrl(slug),
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
    return new Response(`Token exchange failed: ${JSON.stringify(tokenData)}`, { status: 502 });
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

  const response = NextResponse.redirect(new URL("/dashboard", request.url));
  response.cookies.set("session", encodeSession(session), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60,
  });
  return response;
}
