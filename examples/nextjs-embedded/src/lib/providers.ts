export type Provider = {
  name: string;
  slug: string;
  authorizeUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
  scope: string;
  tokenFieldName?: string;
  userNameField: string;
  userEmailField: string;
  userLoginField?: string;
  userAvatarField?: string;
  tokenRequestContentType?: string;
  tokenResponseAccessTokenField?: string;
};

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

export const providers: Record<string, Provider> = {
  github: {
    name: "GitHub",
    slug: "github",
    authorizeUrl: `${APP_URL}/emulate/github/login/oauth/authorize`,
    tokenUrl: `${APP_URL}/emulate/github/login/oauth/access_token`,
    userInfoUrl: `${APP_URL}/emulate/github/user`,
    scope: "user repo",
    userNameField: "name",
    userEmailField: "email",
    userLoginField: "login",
    userAvatarField: "avatar_url",
  },
  google: {
    name: "Google",
    slug: "google",
    authorizeUrl: `${APP_URL}/emulate/google/o/oauth2/v2/auth`,
    tokenUrl: `${APP_URL}/emulate/google/oauth2/token`,
    userInfoUrl: `${APP_URL}/emulate/google/oauth2/v2/userinfo`,
    scope: "openid email profile",
    tokenRequestContentType: "application/x-www-form-urlencoded",
    userNameField: "name",
    userEmailField: "email",
    userAvatarField: "picture",
  },
};

export function getCallbackUrl(provider: string): string {
  return `${APP_URL}/api/auth/callback/${provider}`;
}
