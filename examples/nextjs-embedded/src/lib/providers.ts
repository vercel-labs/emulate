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

function getAppUrl(): string {
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return process.env.APP_URL ?? "http://localhost:3000";
}

export function getProviders(): Record<string, Provider> {
  const appUrl = getAppUrl();
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

export function getCallbackUrl(provider: string): string {
  return `${getAppUrl()}/api/auth/callback/${provider}`;
}
