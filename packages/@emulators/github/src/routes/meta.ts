import type { RouteContext } from "@emulators/core";

export function rootDocument(baseUrl: string) {
  return {
    current_user_url: `${baseUrl}/user`,
    current_user_authorizations_html_url: `${baseUrl}/settings/connections/applications{/client_id}`,
    authorizations_url: `${baseUrl}/authorizations`,
    code_search_url: `${baseUrl}/search/code?q={query}{&page,per_page,sort,order}`,
    commit_search_url: `${baseUrl}/search/commits?q={query}{&page,per_page,sort,order}`,
    emails_url: `${baseUrl}/user/emails`,
    emojis_url: `${baseUrl}/emojis`,
    events_url: `${baseUrl}/events`,
    feeds_url: `${baseUrl}/feeds`,
    followers_url: `${baseUrl}/user/followers`,
    following_url: `${baseUrl}/user/following{/target}`,
    gists_url: `${baseUrl}/gists{/gist_id}`,
    hub_url: `${baseUrl}/hub`,
    issue_search_url: `${baseUrl}/search/issues?q={query}{&page,per_page,sort,order}`,
    issues_url: `${baseUrl}/issues`,
    keys_url: `${baseUrl}/user/keys`,
    label_search_url: `${baseUrl}/search/labels?q={query}&repository_id={repository_id}{&page,per_page}`,
    notifications_url: `${baseUrl}/notifications`,
    organization_url: `${baseUrl}/orgs/{org}`,
    organization_repositories_url: `${baseUrl}/orgs/{org}/repos{?type,page,per_page,sort}`,
    organization_teams_url: `${baseUrl}/orgs/{org}/teams`,
    public_gists_url: `${baseUrl}/gists/public`,
    rate_limit_url: `${baseUrl}/rate_limit`,
    repository_url: `${baseUrl}/repos/{owner}/{repo}`,
    repository_search_url: `${baseUrl}/search/repositories?q={query}{&page,per_page,sort,order}`,
    current_user_repositories_url: `${baseUrl}/user/repos{?type,page,per_page,sort}`,
    starred_url: `${baseUrl}/user/starred{/owner}{/repo}`,
    starred_gists_url: `${baseUrl}/gists/starred`,
    topic_search_url: `${baseUrl}/search/topics?q={query}{&page,per_page}`,
    user_url: `${baseUrl}/users/{user}`,
    user_organizations_url: `${baseUrl}/user/orgs`,
    user_repositories_url: `${baseUrl}/users/{user}/repos{?type,page,per_page,sort}`,
    user_search_url: `${baseUrl}/search/users?q={query}{&page,per_page,sort,order}`,
  };
}

export function metaRoutes({ app, baseUrl }: RouteContext): void {
  app.get("/", (c) => c.json(rootDocument(baseUrl)));

  app.get("/meta", (c) => {
    return c.json({
      verifiable_password_authentication: true,
      ssh_key_fingerprints: {
        SHA256_RSA: "placeholder",
        SHA256_DSA: "placeholder",
        SHA256_ECDSA: "placeholder",
        SHA256_ED25519: "placeholder",
      },
      ssh_keys: ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPlaceholder"],
      hooks: ["127.0.0.1/32"],
      web: ["127.0.0.1/32"],
      api: ["127.0.0.1/32"],
      git: ["127.0.0.1/32"],
      github_enterprise_importer: ["127.0.0.1/32"],
      packages: ["127.0.0.1/32"],
      pages: ["127.0.0.1/32"],
      importer: ["127.0.0.1/32"],
      actions: ["127.0.0.1/32"],
      actions_macos: ["127.0.0.1/32"],
      dependabot: ["127.0.0.1/32"],
      copilot: ["127.0.0.1/32"],
      domains: {
        website: ["localhost"],
        codespaces: ["localhost"],
        copilot: ["localhost"],
        packages: ["localhost"],
        actions: ["localhost"],
        artifact_attestations: { trust_domain: "localhost" },
      },
    });
  });

  app.get("/octocat", (c) => {
    const say = c.req.query("s") ?? "emulate says hello!";
    const art = `
               MMM.           .MMM
               MMMMMMMMMMMMMMMMMMM
               MMMMMMMMMMMMMMMMMMM      ____________________________
              MMMMMMMMMMMMMMMMMMMMM    |                            |
             MMMMMMMMMMMMMMMMMMMMMMM   | ${say.padEnd(26)} |
            MMMMMMMMMMMMMMMMMMMMMMMM   |_   ________________________|
            MMMM::- -:::::::- -::MMMM    |/
             MM~:~ 00~:::::~ 00~:~MM
              .. .. :~M]:[~:M. . ..
            .MM.     ~MM. MM~     .MM.
           MMMM.    ~MM:~MM~    .MMMM
          MMMMMM. ~MMMMMMMM~ .MMMMMM
         MMMMMMMMMMMMMMMMMMMMMMMMMMMM
           .MMMMMMMMMMMMMMMMMMMMMM.
             MMMMMMMMMMMMMMMMMM
              ;MMMMMMMMMMMMMMM;
                :MMMMMMMMMMMM:
                .MMMMMMMMMMM.
                 MMMMMMMMMMM
                  MMMMMMMMM
                   MMMMMMM
                    MMMMM
                     MMM
                      M
`;
    c.header("Content-Type", "application/octocat-stream");
    return c.text(art.trim());
  });

  app.get("/emojis", (c) => {
    return c.json({
      "+1": `${baseUrl}/emojis/+1.png`,
      "-1": `${baseUrl}/emojis/-1.png`,
      "100": `${baseUrl}/emojis/100.png`,
      tada: `${baseUrl}/emojis/tada.png`,
      rocket: `${baseUrl}/emojis/rocket.png`,
      heart: `${baseUrl}/emojis/heart.png`,
      eyes: `${baseUrl}/emojis/eyes.png`,
      thinking: `${baseUrl}/emojis/thinking.png`,
      thumbsup: `${baseUrl}/emojis/thumbsup.png`,
      thumbsdown: `${baseUrl}/emojis/thumbsdown.png`,
    });
  });

  app.get("/zen", (c) => {
    const phrases = [
      "Non-blocking is better than blocking.",
      "Design for failure.",
      "Half measures are as bad as nothing at all.",
      "Encourage flow.",
      "Anything added dilutes everything else.",
      "Approachable is better than simple.",
      "Mind your words, they are important.",
      "Speak like a human.",
      "It's not fully shipped until it's fast.",
      "Responsive is better than fast.",
      "Keep it logically awesome.",
      "Favor focus over features.",
      "Avoid administrative distraction.",
    ];
    return c.text(phrases[Math.floor(Math.random() * phrases.length)]);
  });

  app.get("/versions", (c) => {
    return c.json(["2022-11-28", "2022-08-09"]);
  });
}
