export interface OAuthProvider {
  slug: string;
  name: string;
  icon?: "github" | "google" | "vercel";
  authorizePath: string;
  tokenPath: string;
  userinfoPath?: string;
  scope: string;
  tokenForm: boolean;
  extraParams?: Record<string, string>;
  nameField: string;
  emailField: string;
  loginField?: string;
}

export const oauthProviders: OAuthProvider[] = [
  {
    slug: "github",
    name: "GitHub",
    icon: "github",
    authorizePath: "/login/oauth/authorize",
    tokenPath: "/login/oauth/access_token",
    userinfoPath: "/user",
    scope: "user repo",
    tokenForm: false,
    nameField: "name",
    emailField: "email",
    loginField: "login",
  },
  {
    slug: "google",
    name: "Google",
    icon: "google",
    authorizePath: "/o/oauth2/v2/auth",
    tokenPath: "/oauth2/token",
    userinfoPath: "/oauth2/v2/userinfo",
    scope: "openid email profile",
    tokenForm: true,
    nameField: "name",
    emailField: "email",
  },
  {
    slug: "vercel",
    name: "Vercel",
    icon: "vercel",
    authorizePath: "/oauth/authorize",
    tokenPath: "/login/oauth/token",
    userinfoPath: "/login/oauth/userinfo",
    scope: "",
    tokenForm: false,
    nameField: "name",
    emailField: "email",
    loginField: "preferred_username",
  },
  {
    slug: "microsoft",
    name: "Microsoft",
    authorizePath: "/oauth2/v2.0/authorize",
    tokenPath: "/oauth2/v2.0/token",
    userinfoPath: "/oidc/userinfo",
    scope: "openid email profile",
    tokenForm: true,
    extraParams: { response_mode: "query" },
    nameField: "name",
    emailField: "email",
  },
  {
    slug: "okta",
    name: "Okta",
    authorizePath: "/oauth2/v1/authorize",
    tokenPath: "/oauth2/v1/token",
    userinfoPath: "/oauth2/v1/userinfo",
    scope: "openid email profile",
    tokenForm: true,
    extraParams: { response_mode: "query" },
    nameField: "name",
    emailField: "email",
  },
  {
    slug: "clerk",
    name: "Clerk",
    authorizePath: "/oauth/authorize",
    tokenPath: "/oauth/token",
    userinfoPath: "/oauth/userinfo",
    scope: "openid profile email",
    tokenForm: true,
    nameField: "name",
    emailField: "email",
  },
  {
    slug: "apple",
    name: "Apple",
    authorizePath: "/auth/authorize",
    tokenPath: "/auth/token",
    scope: "openid email name",
    tokenForm: true,
    extraParams: { response_mode: "query" },
    nameField: "name",
    emailField: "email",
  },
];

/** Client id and secret the emulator registers for each provider in the playground seeds. */
export function clientCredentials(slug: string) {
  return { client_id: `emu_${slug}_client_id`, client_secret: `emu_${slug}_client_secret` };
}
