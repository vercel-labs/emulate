import { randomBytes } from "crypto";
import type { RouteContext, AuthApp } from "@emulators/core";
import { getGitHubStore } from "../store.js";
import { generateNodeId } from "../helpers.js";

export function appsRoutes({ app, store, baseUrl, tokenMap }: RouteContext): void {
  const gh = getGitHubStore(store);

  function requireApp(c: any): AuthApp | null {
    const authApp = c.get("authApp") as AuthApp | undefined;
    if (!authApp) {
      c.status(401);
      return null;
    }
    return authApp;
  }

  app.get("/app", (c) => {
    const authApp = requireApp(c);
    if (!authApp) {
      return c.json(
        {
          message: "A JSON web token could not be decoded",
          documentation_url: "https://docs.github.com/rest",
        },
        401,
      );
    }

    const ghApp = gh.apps.all().find((a) => a.app_id === authApp.appId);
    if (!ghApp) {
      return c.json({ message: "Not Found" }, 404);
    }

    const installations = gh.appInstallations.findBy("app_id", ghApp.app_id);

    return c.json({
      id: ghApp.app_id,
      slug: ghApp.slug,
      node_id: generateNodeId("App", ghApp.app_id),
      name: ghApp.name,
      description: ghApp.description,
      external_url: `${baseUrl}/apps/${ghApp.slug}`,
      html_url: `${baseUrl}/apps/${ghApp.slug}`,
      created_at: ghApp.created_at,
      updated_at: ghApp.updated_at,
      permissions: ghApp.permissions,
      events: ghApp.events,
      installations_count: installations.length,
      owner: null,
    });
  });

  app.get("/app/installations", (c) => {
    const authApp = requireApp(c);
    if (!authApp) {
      return c.json(
        {
          message: "A JSON web token could not be decoded",
          documentation_url: "https://docs.github.com/rest",
        },
        401,
      );
    }

    const installations = gh.appInstallations.findBy("app_id", authApp.appId);
    const ghApp = gh.apps.all().find((a) => a.app_id === authApp.appId);

    return c.json(installations.map((inst) => formatInstallation(inst, ghApp, baseUrl)));
  });

  app.get("/app/installations/:installation_id", (c) => {
    const authApp = requireApp(c);
    if (!authApp) {
      return c.json(
        {
          message: "A JSON web token could not be decoded",
          documentation_url: "https://docs.github.com/rest",
        },
        401,
      );
    }

    const installationId = parseInt(c.req.param("installation_id"), 10);
    const inst = gh.appInstallations
      .all()
      .find((i) => i.installation_id === installationId && i.app_id === authApp.appId);

    if (!inst) {
      return c.json({ message: "Not Found", documentation_url: "https://docs.github.com/rest" }, 404);
    }

    const ghApp = gh.apps.all().find((a) => a.app_id === authApp.appId);
    return c.json(formatInstallation(inst, ghApp, baseUrl));
  });

  app.post("/app/installations/:installation_id/access_tokens", async (c) => {
    const authApp = requireApp(c);
    if (!authApp) {
      return c.json(
        {
          message: "A JSON web token could not be decoded",
          documentation_url: "https://docs.github.com/rest",
        },
        401,
      );
    }

    const installationId = parseInt(c.req.param("installation_id"), 10);
    const inst = gh.appInstallations
      .all()
      .find((i) => i.installation_id === installationId && i.app_id === authApp.appId);

    if (!inst) {
      return c.json({ message: "Not Found", documentation_url: "https://docs.github.com/rest" }, 404);
    }

    let requestedPermissions = inst.permissions;
    let requestedRepoIds = inst.repository_ids;
    let tokenRepositorySelection = inst.repository_selection;

    try {
      const body = (await c.req.json()) as Record<string, unknown>;
      if (body.permissions && typeof body.permissions === "object") {
        const requested = body.permissions as Record<string, unknown>;
        requestedPermissions = Object.fromEntries(
          Object.entries(requested).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
        );
      }

      if (body.repositories !== undefined && body.repository_ids !== undefined) {
        return c.json({ message: "Only one of repositories or repository_ids may be specified." }, 422);
      }

      if (body.repositories !== undefined) {
        if (
          !Array.isArray(body.repositories) ||
          body.repositories.length > 500 ||
          body.repositories.some((name) => typeof name !== "string")
        ) {
          return c.json({ message: "The repositories field must contain up to 500 repository names." }, 422);
        }

        const accountRepos = gh.repos
          .all()
          .filter((repo) => repo.owner_id === inst.account_id && repo.owner_type === inst.account_type);
        const resolvedIds: number[] = [];
        for (const name of body.repositories as string[]) {
          const repo = accountRepos.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
          if (!repo) {
            return c.json({ message: "The repositories requested are not accessible to this installation." }, 422);
          }
          resolvedIds.push(repo.id);
        }
        requestedRepoIds = [...new Set(resolvedIds)];
        tokenRepositorySelection = "selected";
      }

      if (body.repository_ids !== undefined) {
        if (
          !Array.isArray(body.repository_ids) ||
          body.repository_ids.length > 500 ||
          body.repository_ids.some((id) => typeof id !== "number")
        ) {
          return c.json({ message: "The repository_ids field must contain up to 500 repository IDs." }, 422);
        }
        requestedRepoIds = [...new Set(body.repository_ids as number[])];
        tokenRepositorySelection = "selected";
      }
    } catch {
      // No body or invalid JSON, use installation defaults
    }

    const permissionRank = (permission: string | undefined) =>
      permission === "write" ? 2 : permission === "read" ? 1 : 0;
    const invalidPermission = Object.entries(requestedPermissions).some(
      ([name, permission]) =>
        permissionRank(permission) === 0 || permissionRank(permission) > permissionRank(inst.permissions[name]),
    );
    if (invalidPermission) {
      return c.json({ message: "The permissions requested are not granted to this installation." }, 422);
    }

    const unavailableRepo = requestedRepoIds.some((id) => {
      const repo = gh.repos.get(id);
      if (!repo || repo.owner_id !== inst.account_id || repo.owner_type !== inst.account_type) return true;
      return inst.repository_selection === "selected" && !inst.repository_ids.includes(id);
    });
    if (unavailableRepo) {
      return c.json({ message: "The repositories requested are not accessible to this installation." }, 422);
    }

    const token = "ghs_" + randomBytes(20).toString("base64url");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    if (tokenMap) {
      tokenMap.set(token, {
        login: inst.account_login,
        id: inst.account_id,
        scopes: Object.entries(requestedPermissions).map(([k, v]) => `${k}:${v}`),
        installation: {
          installationId: inst.installation_id,
          appId: inst.app_id,
          accountId: inst.account_id,
          accountType: inst.account_type,
          permissions: requestedPermissions,
          repositoryIds: requestedRepoIds,
          repositorySelection: tokenRepositorySelection,
        },
      });
    }

    const repos = requestedRepoIds
      .map((id) => gh.repos.get(id))
      .filter(Boolean)
      .map((r) => ({
        id: r!.id,
        node_id: r!.node_id,
        name: r!.name,
        full_name: r!.full_name,
        private: r!.private,
      }));

    return c.json(
      {
        token,
        expires_at: expiresAt,
        permissions: requestedPermissions,
        repository_selection: tokenRepositorySelection,
        ...(tokenRepositorySelection === "selected" ? { repositories: repos } : {}),
      },
      201,
    );
  });

  app.get("/repos/:owner/:repo/installation", (c) => {
    const owner = c.req.param("owner");
    const repoName = c.req.param("repo");
    const fullName = `${owner}/${repoName}`;
    const repo = gh.repos.findOneBy("full_name", fullName);
    if (!repo) {
      return c.json({ message: "Not Found", documentation_url: "https://docs.github.com/rest" }, 404);
    }

    for (const inst of gh.appInstallations.all()) {
      if (
        inst.repository_selection === "all" &&
        inst.account_id === repo.owner_id &&
        inst.account_type === repo.owner_type
      ) {
        const ghApp = gh.apps.all().find((a) => a.app_id === inst.app_id);
        return c.json(formatInstallation(inst, ghApp, baseUrl));
      }
      if (inst.repository_selection === "selected" && inst.repository_ids.includes(repo.id)) {
        const ghApp = gh.apps.all().find((a) => a.app_id === inst.app_id);
        return c.json(formatInstallation(inst, ghApp, baseUrl));
      }
    }

    return c.json({ message: "Not Found", documentation_url: "https://docs.github.com/rest" }, 404);
  });

  app.get("/orgs/:org/installation", (c) => {
    const orgLogin = c.req.param("org");
    const org = gh.orgs.findOneBy("login", orgLogin);
    if (!org) {
      return c.json({ message: "Not Found", documentation_url: "https://docs.github.com/rest" }, 404);
    }

    const inst = gh.appInstallations.all().find((i) => i.account_id === org.id && i.account_type === "Organization");
    if (!inst) {
      return c.json({ message: "Not Found", documentation_url: "https://docs.github.com/rest" }, 404);
    }

    const ghApp = gh.apps.all().find((a) => a.app_id === inst.app_id);
    return c.json(formatInstallation(inst, ghApp, baseUrl));
  });

  app.get("/users/:username/installation", (c) => {
    const username = c.req.param("username");
    const user = gh.users.findOneBy("login", username);
    if (!user) {
      return c.json({ message: "Not Found", documentation_url: "https://docs.github.com/rest" }, 404);
    }

    const inst = gh.appInstallations.all().find((i) => i.account_id === user.id && i.account_type === "User");
    if (!inst) {
      return c.json({ message: "Not Found", documentation_url: "https://docs.github.com/rest" }, 404);
    }

    const ghApp = gh.apps.all().find((a) => a.app_id === inst.app_id);
    return c.json(formatInstallation(inst, ghApp, baseUrl));
  });

  function formatInstallation(inst: any, ghApp: any, baseUrl: string) {
    const account = inst.account_type === "Organization" ? gh.orgs.get(inst.account_id) : gh.users.get(inst.account_id);

    return {
      id: inst.installation_id,
      account: account
        ? {
            login: account.login,
            id: account.id,
            node_id: account.node_id,
            type: inst.account_type,
            avatar_url: `${baseUrl}/avatars/u/${account.login}`,
            url: `${baseUrl}/${inst.account_type === "Organization" ? "orgs" : "users"}/${account.login}`,
          }
        : null,
      repository_selection: inst.repository_selection,
      access_tokens_url: `${baseUrl}/app/installations/${inst.installation_id}/access_tokens`,
      repositories_url: `${baseUrl}/installation/repositories`,
      html_url: `${baseUrl}/settings/installations/${inst.installation_id}`,
      app_id: inst.app_id,
      app_slug: ghApp?.slug ?? null,
      target_type: inst.account_type,
      permissions: inst.permissions,
      events: inst.events,
      created_at: inst.created_at,
      updated_at: inst.updated_at,
      single_file_name: null,
      has_multiple_single_files: false,
      single_file_paths: [],
      suspended_by: null,
      suspended_at: inst.suspended_at,
    };
  }
}
