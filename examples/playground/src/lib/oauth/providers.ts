import { origin } from "@/lib/origin";

export type Provider = {
  name: string;
  slug: string;
  authorizeUrl: string;
  tokenUrl: string;
  userInfoUrl?: string;
  clientId: string;
  clientSecret: string;
  scope: string;
  userNameField: string;
  userEmailField: string;
  userLoginField?: string;
  userAvatarField?: string;
  tokenRequestContentType?: string;
  tokenResponseAccessTokenField?: string;
};

export function getProviders(): Record<string, Provider> {
  const appUrl = origin;
  return {
    github: {
      name: "GitHub",
      slug: "github",
      authorizeUrl: `${appUrl}/emulate/github/login/oauth/authorize`,
      tokenUrl: `${appUrl}/emulate/github/login/oauth/access_token`,
      userInfoUrl: `${appUrl}/emulate/github/user`,
      clientId: "emu_github_client_id",
      clientSecret: "emu_github_client_secret",
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
      clientId: "emu_google_client_id",
      clientSecret: "emu_google_client_secret",
      scope: "openid email profile",
      tokenRequestContentType: "application/x-www-form-urlencoded",
      userNameField: "name",
      userEmailField: "email",
      userAvatarField: "picture",
    },
    vercel: {
      name: "Vercel",
      slug: "vercel",
      authorizeUrl: `${appUrl}/emulate/vercel/oauth/authorize`,
      tokenUrl: `${appUrl}/emulate/vercel/login/oauth/token`,
      userInfoUrl: `${appUrl}/emulate/vercel/login/oauth/userinfo`,
      clientId: "emu_vercel_client_id",
      clientSecret: "emu_vercel_client_secret",
      scope: "",
      userNameField: "name",
      userEmailField: "email",
      userLoginField: "preferred_username",
      userAvatarField: "picture",
    },
    microsoft: {
      name: "Microsoft",
      slug: "microsoft",
      authorizeUrl: `${appUrl}/emulate/microsoft/oauth2/v2.0/authorize`,
      tokenUrl: `${appUrl}/emulate/microsoft/oauth2/v2.0/token`,
      userInfoUrl: `${appUrl}/emulate/microsoft/oidc/userinfo`,
      clientId: "emu_microsoft_client_id",
      clientSecret: "emu_microsoft_client_secret",
      scope: "openid email profile",
      tokenRequestContentType: "application/x-www-form-urlencoded",
      userNameField: "name",
      userEmailField: "email",
    },
    okta: {
      name: "Okta",
      slug: "okta",
      authorizeUrl: `${appUrl}/emulate/okta/oauth2/v1/authorize`,
      tokenUrl: `${appUrl}/emulate/okta/oauth2/v1/token`,
      userInfoUrl: `${appUrl}/emulate/okta/oauth2/v1/userinfo`,
      clientId: "emu_okta_client_id",
      clientSecret: "emu_okta_client_secret",
      scope: "openid email profile",
      tokenRequestContentType: "application/x-www-form-urlencoded",
      userNameField: "name",
      userEmailField: "email",
    },
    clerk: {
      name: "Clerk",
      slug: "clerk",
      authorizeUrl: `${appUrl}/emulate/clerk/oauth/authorize`,
      tokenUrl: `${appUrl}/emulate/clerk/oauth/token`,
      userInfoUrl: `${appUrl}/emulate/clerk/oauth/userinfo`,
      clientId: "emu_clerk_client_id",
      clientSecret: "emu_clerk_client_secret",
      scope: "openid profile email",
      tokenRequestContentType: "application/x-www-form-urlencoded",
      userNameField: "name",
      userEmailField: "email",
      userAvatarField: "picture",
    },
    apple: {
      name: "Apple",
      slug: "apple",
      authorizeUrl: `${appUrl}/emulate/apple/auth/authorize`,
      tokenUrl: `${appUrl}/emulate/apple/auth/token`,
      clientId: "emu_apple_client_id",
      clientSecret: "emu_apple_client_secret",
      scope: "openid name email",
      tokenRequestContentType: "application/x-www-form-urlencoded",
      userNameField: "name",
      userEmailField: "email",
    },
  };
}

/** Returns the provider for a route slug, or undefined when the slug is not a configured provider. */
export function getProvider(slug: string): Provider | undefined {
  const providers = getProviders();
  return Object.hasOwn(providers, slug) ? providers[slug] : undefined;
}

export function getCallbackUrl(provider: string): string {
  return `${origin}/oauth/api/auth/callback/${provider}`;
}
