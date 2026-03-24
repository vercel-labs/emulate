const SERVICE_DESCRIPTIONS: Record<string, { label: string; endpoints: string }> = {
  vercel: {
    label: "Vercel REST API emulator",
    endpoints: "projects, deployments, domains, env vars, users, teams, file uploads, protection bypass",
  },
  github: {
    label: "GitHub REST API emulator",
    endpoints: "users, repos, issues, PRs, comments, reviews, labels, milestones, branches, git data, orgs, teams, releases, webhooks, search, actions, checks, rate limit",
  },
  google: {
    label: "Google OAuth 2.0 / OpenID Connect emulator",
    endpoints: "OAuth authorize, token exchange, userinfo, OIDC discovery, token revocation",
  },
  idp: {
    label: "Enterprise Identity Provider (OIDC / OAuth 2.0) emulator",
    endpoints: "OIDC discovery, authorize, token, userinfo, JWKS, revoke, logout, SAML metadata, SAML SSO, debug",
  },
};

export function listCommand(): void {
  console.log("\nAvailable services:\n");
  for (const [name, info] of Object.entries(SERVICE_DESCRIPTIONS)) {
    console.log(`  ${name.padEnd(10)}${info.label}`);
    console.log(`            Endpoints: ${info.endpoints}`);
    console.log();
  }
}
