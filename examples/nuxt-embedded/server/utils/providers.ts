import type { H3Event } from "h3";

export type Provider = {
  name: string;
  slug: string;
  authorizeUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
  scope: string;
  userNameField: string;
  userEmailField: string;
  userLoginField?: string;
  userAvatarField?: string;
  tokenRequestContentType?: string;
  tokenResponseAccessTokenField?: string;
};

// The app URL is derived from the incoming request, so OAuth callback URLs
// always match the current origin — even on preview deployments where the URL
// changes with every deploy.
export function getAppUrl(event: H3Event): string {
  return getRequestURL(event, { xForwardedHost: true }).origin;
}

export function getProviders(event: H3Event): Record<string, Provider> {
  const appUrl = getAppUrl(event);
  return {
    github: {
      name: "GitHub",
      slug: "github",
      authorizeUrl: `${appUrl}/emulate/github/login/oauth/authorize`,
      tokenUrl: `${appUrl}/emulate/github/login/oauth/access_token`,
      userInfoUrl: `${appUrl}/emulate/github/user`,
      scope: "user repo",
      userNameField: "name",
      userEmailField: "email",
      userLoginField: "login",
      userAvatarField: "avatar_url",
    },
    google: {
      name: "Google",
      slug: "google",
      authorizeUrl: `${appUrl}/emulate/google/o/oauth2/v2/auth`,
      tokenUrl: `${appUrl}/emulate/google/oauth2/token`,
      userInfoUrl: `${appUrl}/emulate/google/oauth2/v2/userinfo`,
      scope: "openid email profile",
      tokenRequestContentType: "application/x-www-form-urlencoded",
      userNameField: "name",
      userEmailField: "email",
      userAvatarField: "picture",
    },
  };
}

export function getCallbackUrl(event: H3Event, provider: string): string {
  return `${getAppUrl(event)}/api/auth/callback/${provider}`;
}
