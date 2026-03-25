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
    label: "Google OAuth 2.0 / OpenID Connect + Gmail, Calendar, and Drive emulator",
    endpoints:
      "OAuth authorize, token exchange, userinfo, OIDC discovery, token revocation, Gmail messages/drafts/threads/labels/history/settings, Calendar lists/events/freebusy, Drive files/uploads",
  },
  slack: {
    label: "Slack API emulator",
    endpoints: "auth, chat, conversations, users, reactions, team, OAuth, incoming webhooks",
  },
  apple: {
    label: "Apple Sign In / OAuth emulator",
    endpoints: "OAuth authorize, token exchange, JWKS",
  },
  aws: {
    label: "AWS cloud service emulator",
    endpoints: "S3 (buckets, objects), SQS (queues, messages), IAM (users, roles, access keys), STS (assume role, caller identity)",
  },
  microsoft: {
    label: "Microsoft Entra ID OAuth 2.0 / OpenID Connect emulator",
    endpoints: "OAuth authorize, token exchange, userinfo, OIDC discovery, Graph /me, logout, token revocation",
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
