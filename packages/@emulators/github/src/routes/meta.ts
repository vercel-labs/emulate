import type { RouteContext } from "@emulators/core";

export function metaRoutes({ app, baseUrl }: RouteContext): void {
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
      "tada": `${baseUrl}/emojis/tada.png`,
      "rocket": `${baseUrl}/emojis/rocket.png`,
      "heart": `${baseUrl}/emojis/heart.png`,
      "eyes": `${baseUrl}/emojis/eyes.png`,
      "thinking": `${baseUrl}/emojis/thinking.png`,
      "thumbsup": `${baseUrl}/emojis/thumbsup.png`,
      "thumbsdown": `${baseUrl}/emojis/thumbsdown.png`,
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
