import type { RouteContext } from "@emulators/core";
import {
  ApiError,
  parseJsonBody,
  parsePagination,
  setLinkHeader,
  unauthorized,
} from "@emulators/core";
import { assertAuthenticatedUser, canAccessRepo, notFoundResponse } from "../route-helpers.js";
import { getGitHubStore } from "../store.js";
import type { GitHubStore } from "../store.js";
import type { GitHubRepo, GitHubUser } from "../entities.js";
import { formatOrgBrief, formatRepo, formatUser, formatUserFull } from "../helpers.js";

function listReposForUser(
  gh: GitHubStore,
  user: GitHubUser,
  type: "all" | "owner" | "member"
): GitHubRepo[] {
  const owned = gh.repos.all().filter(
    (r) => r.owner_id === user.id && r.owner_type === "User"
  );
  const member = gh.collaborators
    .findBy("user_id", user.id)
    .map((c) => gh.repos.get(c.repo_id))
    .filter((r): r is GitHubRepo => Boolean(r))
    .filter((r) => !(r.owner_id === user.id && r.owner_type === "User"));

  if (type === "owner") return owned;
  if (type === "member") return member;

  const map = new Map<number, GitHubRepo>();
  for (const r of owned) map.set(r.id, r);
  for (const r of member) map.set(r.id, r);
  return Array.from(map.values());
}

function sortRepos(
  repos: GitHubRepo[],
  sort: "created" | "updated" | "pushed" | "full_name",
  direction: "asc" | "desc"
): GitHubRepo[] {
  const mul = direction === "asc" ? 1 : -1;
  const sorted = [...repos];
  sorted.sort((a, b) => {
    if (sort === "full_name") {
      return a.full_name.localeCompare(b.full_name) * mul;
    }
    const field =
      sort === "created"
        ? "created_at"
        : sort === "updated"
          ? "updated_at"
          : "pushed_at";
    const av = a[field] ?? "";
    const bv = b[field] ?? "";
    if (av < bv) return -1 * mul;
    if (av > bv) return 1 * mul;
    return 0;
  });
  return sorted;
}

function orgsForUser(gh: GitHubStore, userId: number) {
  const memberships = gh.teamMembers.findBy("user_id", userId);
  const orgIds = new Set<number>();
  for (const m of memberships) {
    const team = gh.teams.get(m.team_id);
    if (team) orgIds.add(team.org_id);
  }
  const orgs = [...orgIds]
    .map((id) => gh.orgs.get(id))
    .filter((o): o is NonNullable<typeof o> => Boolean(o));
  orgs.sort((a, b) => a.login.localeCompare(b.login));
  return orgs;
}

export function usersRoutes({ app, store, baseUrl }: RouteContext): void {
  const gh = getGitHubStore(store);

  app.get("/user", (c) => {
    const authUser = c.get("authUser");
    if (!authUser) {
      throw unauthorized();
    }
    const user = gh.users.findOneBy("login", authUser.login);
    if (!user) {
      throw notFoundResponse();
    }
    return c.json(formatUserFull(user, baseUrl));
  });

  app.patch("/user", async (c) => {
    const authUser = c.get("authUser");
    if (!authUser) {
      throw unauthorized();
    }
    const existing = gh.users.findOneBy("login", authUser.login);
    if (!existing) {
      throw notFoundResponse();
    }

    const body = await parseJsonBody(c);
    const patch: Partial<GitHubUser> = {};

    if ("name" in body) {
      if (body.name === null) patch.name = null;
      else if (typeof body.name === "string") patch.name = body.name;
    }
    if ("email" in body) {
      if (body.email === null) patch.email = null;
      else if (typeof body.email === "string") patch.email = body.email;
    }
    if ("blog" in body && typeof body.blog === "string") {
      patch.blog = body.blog;
    }
    if ("twitter_username" in body) {
      if (body.twitter_username === null) patch.twitter_username = null;
      else if (typeof body.twitter_username === "string") {
        patch.twitter_username = body.twitter_username;
      }
    }
    if ("company" in body) {
      if (body.company === null) patch.company = null;
      else if (typeof body.company === "string") patch.company = body.company;
    }
    if ("location" in body) {
      if (body.location === null) patch.location = null;
      else if (typeof body.location === "string") patch.location = body.location;
    }
    if ("hireable" in body) {
      if (body.hireable === null) patch.hireable = null;
      else if (typeof body.hireable === "boolean") patch.hireable = body.hireable;
    }
    if ("bio" in body) {
      if (body.bio === null) patch.bio = null;
      else if (typeof body.bio === "string") patch.bio = body.bio;
    }

    const updated = gh.users.update(existing.id, patch);
    if (!updated) {
      throw notFoundResponse();
    }
    return c.json(formatUserFull(updated, baseUrl));
  });

  app.get("/user/repos", (c) => {
    const authUser = c.get("authUser");
    const user = assertAuthenticatedUser(gh, authUser);

    const typeRaw = (c.req.query("type") ?? "all").toLowerCase();
    if (typeRaw !== "all" && typeRaw !== "owner" && typeRaw !== "member") {
      throw new ApiError(422, "Invalid type parameter");
    }
    const type = typeRaw as "all" | "owner" | "member";

    const sortRaw = (c.req.query("sort") ?? "full_name").toLowerCase();
    if (
      sortRaw !== "created" &&
      sortRaw !== "updated" &&
      sortRaw !== "pushed" &&
      sortRaw !== "full_name"
    ) {
      throw new ApiError(422, "Invalid sort parameter");
    }
    const sort = sortRaw as "created" | "updated" | "pushed" | "full_name";

    const direction =
      (c.req.query("direction")?.toLowerCase() as "asc" | "desc" | undefined) ??
      (sort === "full_name" ? "asc" : "desc");
    if (direction !== "asc" && direction !== "desc") {
      throw new ApiError(422, "Invalid direction parameter");
    }

    const { page, per_page } = parsePagination(c);
    const allRepos = sortRepos(listReposForUser(gh, user, type), sort, direction).filter((r) =>
      canAccessRepo(gh, authUser, r)
    );
    const total = allRepos.length;
    const start = (page - 1) * per_page;
    const items = allRepos.slice(start, start + per_page).map((r) => formatRepo(r, gh, baseUrl));

    setLinkHeader(c, total, page, per_page);
    return c.json(items);
  });

  app.get("/users", (c) => {
    const since = Math.max(0, parseInt(c.req.query("since") ?? "0", 10) || 0);
    const perPage = Math.min(
      100,
      Math.max(1, parseInt(c.req.query("per_page") ?? "30", 10) || 30)
    );

    const ordered = gh.users
      .all()
      .filter((u) => u.id > since)
      .sort((a, b) => a.id - b.id);
    const page = ordered.slice(0, perPage);

    if (page.length === perPage && ordered.length > perPage) {
      const lastId = page[page.length - 1]!.id;
      const nextUrl = new URL(c.req.url);
      nextUrl.searchParams.set("since", String(lastId));
      nextUrl.searchParams.set("per_page", String(perPage));
      c.header("Link", `<${nextUrl.toString()}>; rel="next"`);
    }

    return c.json(page.map((u) => formatUser(u, baseUrl)));
  });

  app.get("/users/:username/repos", (c) => {
    const username = c.req.param("username")!;
    const user = gh.users.findOneBy("login", username);
    if (!user) {
      throw notFoundResponse();
    }

    const typeRaw = (c.req.query("type") ?? "owner").toLowerCase();
    if (typeRaw !== "all" && typeRaw !== "owner" && typeRaw !== "member") {
      throw new ApiError(422, "Invalid type parameter");
    }
    const type = typeRaw as "all" | "owner" | "member";

    const sortRaw = (c.req.query("sort") ?? "full_name").toLowerCase();
    if (
      sortRaw !== "created" &&
      sortRaw !== "updated" &&
      sortRaw !== "pushed" &&
      sortRaw !== "full_name"
    ) {
      throw new ApiError(422, "Invalid sort parameter");
    }
    const sort = sortRaw as "created" | "updated" | "pushed" | "full_name";

    const direction =
      (c.req.query("direction")?.toLowerCase() as "asc" | "desc" | undefined) ??
      (sort === "full_name" ? "asc" : "desc");
    if (direction !== "asc" && direction !== "desc") {
      throw new ApiError(422, "Invalid direction parameter");
    }

    const { page, per_page } = parsePagination(c);
    const allRepos = sortRepos(listReposForUser(gh, user, type), sort, direction);
    const total = allRepos.length;
    const start = (page - 1) * per_page;
    const items = allRepos.slice(start, start + per_page).map((r) => formatRepo(r, gh, baseUrl));

    setLinkHeader(c, total, page, per_page);
    return c.json(items);
  });

  app.get("/users/:username/orgs", (c) => {
    const username = c.req.param("username")!;
    const user = gh.users.findOneBy("login", username);
    if (!user) {
      throw notFoundResponse();
    }

    const orgs = orgsForUser(gh, user.id);
    return c.json(orgs.map((o) => formatOrgBrief(o, baseUrl)));
  });

  app.get("/users/:username/followers", (c) => {
    const username = c.req.param("username")!;
    if (!gh.users.findOneBy("login", username)) {
      throw notFoundResponse();
    }

    const { page, per_page } = parsePagination(c);
    setLinkHeader(c, 0, page, per_page);
    return c.json([]);
  });

  app.get("/users/:username/following", (c) => {
    const username = c.req.param("username")!;
    if (!gh.users.findOneBy("login", username)) {
      throw notFoundResponse();
    }

    const { page, per_page } = parsePagination(c);
    setLinkHeader(c, 0, page, per_page);
    return c.json([]);
  });

  app.get("/users/:username/hovercard", (c) => {
    const username = c.req.param("username")!;
    if (!gh.users.findOneBy("login", username)) {
      throw notFoundResponse();
    }

    return c.json({ contexts: [] });
  });

  app.get("/users/:username", (c) => {
    const username = c.req.param("username")!;
    const user = gh.users.findOneBy("login", username);
    if (!user) {
      throw notFoundResponse();
    }
    return c.json(formatUserFull(user, baseUrl));
  });
}
