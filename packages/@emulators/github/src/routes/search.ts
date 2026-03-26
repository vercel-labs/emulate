import type { RouteContext, AuthUser } from "@emulators/core";
import { ApiError, parsePagination, setLinkHeader } from "@emulators/core";
import { getGitHubStore } from "../store.js";
import type { GitHubStore } from "../store.js";
import type {
  GitHubBlob,
  GitHubCommit,
  GitHubIssue,
  GitHubOrg,
  GitHubPullRequest,
  GitHubRepo,
  GitHubUser,
} from "../entities.js";
import {
  formatIssue,
  formatOrgBrief,
  formatPullRequest,
  formatRepo,
  formatUser,
  lookupRepo,
} from "../helpers.js";
import { canAccessRepo } from "../route-helpers.js";

/** Parsed GitHub-style search query (q parameter). */
export interface ParsedSearchQuery {
  text: string;
  qualifiers: Map<string, string[]>;
  negations: Map<string, string[]>;
  ranges: Map<string, Array<{ op: string; value: number | string }>>;
}

function tokenizeSearchQuery(q: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  let buf = "";
  let quote: '"' | "'" | null = null;
  while (i < q.length) {
    const c = q[i]!;
    if (quote) {
      if (c === quote) {
        quote = null;
        i++;
        continue;
      }
      buf += c;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      i++;
      continue;
    }
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      if (buf.length) {
        tokens.push(buf);
        buf = "";
      }
      i++;
      continue;
    }
    buf += c;
    i++;
  }
  if (buf.length) tokens.push(buf);
  return tokens;
}

function parseRangeToken(
  raw: string
): { op: string; value: number | string } | null {
  const range = /^(\d+)\.\.(\d+)$/.exec(raw);
  if (range) {
    return { op: "..", value: `${range[1]}..${range[2]}` };
  }
  const cmp = /^(>=|<=|>|<)(\d+)$/.exec(raw);
  if (cmp) {
    return { op: cmp[1]!, value: parseInt(cmp[2]!, 10) };
  }
  if (/^\d+$/.test(raw)) {
    return { op: "=", value: parseInt(raw, 10) };
  }
  return null;
}

/**
 * Splits `q` into free text vs qualifiers, handles `-qualifier:value` negation,
 * and numeric ranges (`stars:>10`, `stars:10..50`).
 */
export function parseSearchQuery(q: string): ParsedSearchQuery {
  const qualifiers = new Map<string, string[]>();
  const negations = new Map<string, string[]>();
  const ranges = new Map<string, Array<{ op: string; value: number | string }>>();
  const textParts: string[] = [];

  for (const rawTok of tokenizeSearchQuery(q.trim())) {
    let neg = false;
    let tok = rawTok;
    if (tok.startsWith("-") && tok.includes(":") && tok.length > 1) {
      neg = true;
      tok = tok.slice(1);
    }

    const colon = tok.indexOf(":");
    if (colon <= 0) {
      textParts.push(rawTok);
      continue;
    }

    const key = tok.slice(0, colon).toLowerCase();
    const rawVal = tok.slice(colon + 1);
    if (!rawVal.length) {
      textParts.push(rawTok);
      continue;
    }

    const rangePred = parseRangeToken(rawVal);
    const isRangeKey =
      key === "stars" ||
      key === "forks" ||
      key === "repos" ||
      key === "followers" ||
      key === "comments" ||
      key === "size";

    if (rangePred && (rangePred.op !== "=" || isRangeKey)) {
      if (neg) {
        if (!negations.has(key)) negations.set(key, []);
        negations.get(key)!.push(rawVal);
      } else {
        if (!ranges.has(key)) ranges.set(key, []);
        ranges.get(key)!.push(rangePred);
      }
      continue;
    }

    if (neg) {
      if (!negations.has(key)) negations.set(key, []);
      negations.get(key)!.push(rawVal);
    } else {
      if (!qualifiers.has(key)) qualifiers.set(key, []);
      qualifiers.get(key)!.push(rawVal);
    }
  }

  return {
    text: textParts.join(" ").trim(),
    qualifiers,
    negations,
    ranges,
  };
}

function textMatches(haystack: string, needle: string): boolean {
  if (!needle.trim()) return true;
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

function repoVisibleForSearch(repo: GitHubRepo, gh: GitHubStore, authUser: AuthUser | undefined): boolean {
  return canAccessRepo(gh, authUser, repo);
}

function ownerLogin(gh: GitHubStore, repo: GitHubRepo): string {
  if (repo.owner_type === "User") {
    return gh.users.get(repo.owner_id)?.login ?? "";
  }
  return gh.orgs.get(repo.owner_id)?.login ?? "";
}

function matchesNumericPredicate(
  actual: number,
  preds: Array<{ op: string; value: number | string }>,
  equalsFromQualifiers: string[]
): boolean {
  for (const e of equalsFromQualifiers) {
    if (/^\d+$/.test(e) && actual !== parseInt(e, 10)) return false;
  }
  for (const p of preds) {
    if (p.op === "..") {
      const m = /^(\d+)\.\.(\d+)$/.exec(String(p.value));
      if (m) {
        const lo = parseInt(m[1]!, 10);
        const hi = parseInt(m[2]!, 10);
        if (actual < lo || actual > hi) return false;
      }
    } else if (p.op === ">") {
      if (!(actual > Number(p.value))) return false;
    } else if (p.op === "<") {
      if (!(actual < Number(p.value))) return false;
    } else if (p.op === ">=") {
      if (!(actual >= Number(p.value))) return false;
    } else if (p.op === "<=") {
      if (!(actual <= Number(p.value))) return false;
    } else if (p.op === "=") {
      if (actual !== Number(p.value)) return false;
    }
  }
  return true;
}

function filterRepos(
  gh: GitHubStore,
  repos: GitHubRepo[],
  parsed: ParsedSearchQuery,
  authUser: AuthUser | undefined
): GitHubRepo[] {
  const qUser = parsed.qualifiers.get("user")?.[0];
  const qOrg = parsed.qualifiers.get("org")?.[0];
  const negUser = parsed.negations.get("user") ?? [];
  const negOrg = parsed.negations.get("org") ?? [];

  const inScopes = parsed.qualifiers.get("in") ?? [];
  const negIn = parsed.negations.get("in") ?? [];

  return repos.filter((repo) => {
    if (!repoVisibleForSearch(repo, gh, authUser)) return false;

    const ologin = ownerLogin(gh, repo);
    if (qUser && ologin.toLowerCase() !== qUser.toLowerCase()) return false;
    if (qOrg && ologin.toLowerCase() !== qOrg.toLowerCase()) return false;
    if (repo.owner_type === "User" && negUser.some((n) => ologin.toLowerCase() === n.toLowerCase())) {
      return false;
    }
    if (repo.owner_type === "Organization" && negOrg.some((n) => ologin.toLowerCase() === n.toLowerCase())) {
      return false;
    }

    for (const lang of parsed.qualifiers.get("language") ?? []) {
      if (!repo.language || repo.language.toLowerCase() !== lang.toLowerCase()) return false;
    }
    for (const lang of parsed.negations.get("language") ?? []) {
      if (repo.language && repo.language.toLowerCase() === lang.toLowerCase()) return false;
    }

    for (const topic of parsed.qualifiers.get("topic") ?? []) {
      if (!repo.topics.some((t) => t.toLowerCase() === topic.toLowerCase())) return false;
    }
    for (const topic of parsed.negations.get("topic") ?? []) {
      if (repo.topics.some((t) => t.toLowerCase() === topic.toLowerCase())) return false;
    }

    const starRanges = parsed.ranges.get("stars") ?? [];
    const starEq = parsed.qualifiers.get("stars") ?? [];
    if (!matchesNumericPredicate(repo.stargazers_count, starRanges, starEq)) return false;
    for (const nv of parsed.negations.get("stars") ?? []) {
      const r = parseRangeToken(nv);
      if (r) {
        if (matchesNumericPredicate(repo.stargazers_count, [r], [])) return false;
      } else if (/^\d+$/.test(nv) && repo.stargazers_count === parseInt(nv, 10)) {
        return false;
      }
    }

    const forkRanges = parsed.ranges.get("forks") ?? [];
    const forkEq = parsed.qualifiers.get("forks") ?? [];
    if (!matchesNumericPredicate(repo.forks_count, forkRanges, forkEq)) return false;
    const negForkVals = parsed.negations.get("forks") ?? [];
    if (negForkVals.length) {
      const negPreds = negForkVals.flatMap((s) => {
        const r = parseRangeToken(s);
        return r ? [r] : [];
      });
      const negEq = negForkVals.filter((s) => /^\d+$/.test(s));
      if (matchesNumericPredicate(repo.forks_count, negPreds, negEq)) return false;
    }

    for (const a of parsed.qualifiers.get("archived") ?? []) {
      const want = a === "true";
      if (repo.archived !== want) return false;
    }
    for (const a of parsed.negations.get("archived") ?? []) {
      const want = a === "true";
      if (repo.archived === want) return false;
    }

    const isVals = parsed.qualifiers.get("is") ?? [];
    for (const is of isVals) {
      if (is === "public" && repo.private) return false;
      if (is === "private" && !repo.private) return false;
    }
    for (const is of parsed.negations.get("is") ?? []) {
      if (is === "public" && !repo.private) return false;
      if (is === "private" && repo.private) return false;
    }

    for (const f of parsed.qualifiers.get("fork") ?? []) {
      const v = f.toLowerCase();
      if (v === "true" && !repo.fork) return false;
      if (v === "false" && repo.fork) return false;
      if (v === "only" && !repo.fork) return false;
    }
    for (const f of parsed.negations.get("fork") ?? []) {
      const v = f.toLowerCase();
      if (v === "true" && repo.fork) return false;
      if (v === "false" && !repo.fork) return false;
      if (v === "only" && repo.fork) return false;
    }

    const searchIn =
      inScopes.length > 0
        ? inScopes.map((s) => s.toLowerCase())
        : ["name", "description", "topics"];

    const text = parsed.text;
    if (text.length) {
      const nameMatch = textMatches(repo.name, text);
      const fullMatch = textMatches(repo.full_name, text);
      const descMatch = repo.description ? textMatches(repo.description, text) : false;
      const topicsMatch = repo.topics.some((t) => textMatches(t, text));

      let ok = false;
      if (searchIn.includes("name") && (nameMatch || fullMatch)) ok = true;
      if (searchIn.includes("description") && descMatch) ok = true;
      if (searchIn.includes("topics") && topicsMatch) ok = true;
      if (!ok) return false;
    }

    for (const n of negIn) {
      const scope = n.toLowerCase();
      if (scope === "name" && (textMatches(repo.name, parsed.text) || textMatches(repo.full_name, parsed.text))) {
        return false;
      }
      if (scope === "description" && repo.description && textMatches(repo.description, parsed.text)) {
        return false;
      }
      if (scope === "topics" && repo.topics.some((t) => textMatches(t, parsed.text))) {
        return false;
      }
    }

    return true;
  });
}

function repoRelevance(repo: GitHubRepo, parsed: ParsedSearchQuery): number {
  const t = parsed.text.trim().toLowerCase();
  if (!t) return 1;
  let score = 0;
  if (repo.name.toLowerCase().includes(t)) score += 5;
  if (repo.full_name.toLowerCase().includes(t)) score += 4;
  if (repo.description?.toLowerCase().includes(t)) score += 2;
  if (repo.topics.some((x) => x.toLowerCase().includes(t))) score += 1;
  return score;
}

function resolveRepoQualifier(gh: GitHubStore, spec: string): GitHubRepo | null {
  const trimmed = spec.trim();
  if (!trimmed.includes("/")) return null;
  return lookupRepo(gh, trimmed.split("/")[0]!, trimmed.split("/")[1]!) ?? null;
}

function issuePrMatchesFilters(
  gh: GitHubStore,
  parsed: ParsedSearchQuery,
  repo: GitHubRepo,
  issue: GitHubIssue | null,
  pr: GitHubPullRequest | null
): boolean {
  const repoSpecs = parsed.qualifiers.get("repo") ?? [];
  for (const rs of repoSpecs) {
    const r = resolveRepoQualifier(gh, rs);
    if (!r || r.id !== repo.id) return false;
  }
  for (const rs of parsed.negations.get("repo") ?? []) {
    const r = resolveRepoQualifier(gh, rs);
    if (r && r.id === repo.id) return false;
  }

  const isVals = [...(parsed.qualifiers.get("is") ?? []), ...(parsed.qualifiers.get("type") ?? [])].map((x) =>
    x.toLowerCase()
  );
  const negIs = [...(parsed.negations.get("is") ?? []), ...(parsed.negations.get("type") ?? [])].map((x) =>
    x.toLowerCase()
  );

  const isPr = pr !== null || issue?.is_pull_request === true;

  if (isVals.includes("issue") && isPr) return false;
  if (isVals.includes("pr") && !isPr) return false;

  if (negIs.includes("issue") && !isPr) return false;
  if (negIs.includes("pr") && isPr) return false;

  const stateVals = parsed.qualifiers.get("state") ?? [];
  for (const s of stateVals) {
    const sl = s.toLowerCase();
    if (isPr && pr) {
      if (sl === "open" && pr.state !== "open") return false;
      if (sl === "closed" && pr.state !== "closed") return false;
    } else if (issue) {
      if (sl === "open" && issue.state !== "open") return false;
      if (sl === "closed" && issue.state !== "closed") return false;
    }
  }

  for (const iv of isVals) {
    if (iv === "open") {
      if (isPr && pr && pr.state !== "open") return false;
      if (!isPr && issue && issue.state !== "open") return false;
    }
    if (iv === "closed") {
      if (isPr && pr && pr.state !== "closed") return false;
      if (!isPr && issue && issue.state !== "closed") return false;
    }
    if (iv === "merged") {
      if (!isPr || !pr || !pr.merged) return false;
    }
    if (iv === "draft") {
      if (!isPr || !pr || !pr.draft) return false;
    }
  }

  for (const iv of negIs) {
    if (iv === "open") {
      if (isPr && pr && pr.state === "open") return false;
      if (!isPr && issue && issue.state === "open") return false;
    }
    if (iv === "closed") {
      if (isPr && pr && pr.state === "closed") return false;
      if (!isPr && issue && issue.state === "closed") return false;
    }
    if (iv === "merged") {
      if (isPr && pr && pr.merged) return false;
    }
    if (iv === "draft") {
      if (isPr && pr && pr.draft) return false;
    }
  }

  const authors = parsed.qualifiers.get("author") ?? [];
  for (const a of authors) {
    const u = gh.users.findOneBy("login", a);
    const uid = u?.id;
    if (isPr && pr) {
      if (!uid || pr.user_id !== uid) return false;
    } else if (issue) {
      if (!uid || issue.user_id !== uid) return false;
    }
  }
  for (const a of parsed.negations.get("author") ?? []) {
    const u = gh.users.findOneBy("login", a);
    const uid = u?.id;
    if (isPr && pr && uid !== undefined && pr.user_id === uid) return false;
    if (!isPr && issue && uid !== undefined && issue.user_id === uid) return false;
  }

  const assignees = parsed.qualifiers.get("assignee") ?? [];
  for (const a of assignees) {
    const u = gh.users.findOneBy("login", a);
    const uid = u?.id;
    if (!uid) return false;
    const ids = isPr && pr ? pr.assignee_ids : issue?.assignee_ids ?? [];
    if (!ids.includes(uid)) return false;
  }
  for (const a of parsed.negations.get("assignee") ?? []) {
    const u = gh.users.findOneBy("login", a);
    const uid = u?.id;
    if (uid === undefined) continue;
    const ids = isPr && pr ? pr.assignee_ids : issue?.assignee_ids ?? [];
    if (ids.includes(uid)) return false;
  }

  const labels = parsed.qualifiers.get("label") ?? [];
  for (const lb of labels) {
    const labelIds = isPr && pr ? pr.label_ids : issue?.label_ids ?? [];
    const names = labelIds
      .map((id) => gh.labels.get(id))
      .filter(Boolean)
      .map((l) => l!.name.toLowerCase());
    if (!names.includes(lb.toLowerCase())) return false;
  }
  for (const lb of parsed.negations.get("label") ?? []) {
    const labelIds = isPr && pr ? pr.label_ids : issue?.label_ids ?? [];
    const names = labelIds
      .map((id) => gh.labels.get(id))
      .filter(Boolean)
      .map((l) => l!.name.toLowerCase());
    if (names.includes(lb.toLowerCase())) return false;
  }

  const milestones = parsed.qualifiers.get("milestone") ?? [];
  for (const ms of milestones) {
    const mid = isPr && pr ? pr.milestone_id : issue?.milestone_id;
    const m = mid ? gh.milestones.get(mid) : null;
    if (!m || m.title.toLowerCase() !== ms.toLowerCase()) return false;
  }
  for (const ms of parsed.negations.get("milestone") ?? []) {
    const mid = isPr && pr ? pr.milestone_id : issue?.milestone_id;
    const m = mid ? gh.milestones.get(mid) : null;
    if (m && m.title.toLowerCase() === ms.toLowerCase()) return false;
  }

  const commentRanges = parsed.ranges.get("comments") ?? [];
  const commentEq = parsed.qualifiers.get("comments") ?? [];
  const n = isPr && pr ? pr.comments : issue?.comments ?? 0;
  if (!matchesNumericPredicate(n, commentRanges, commentEq)) return false;
  for (const nv of parsed.negations.get("comments") ?? []) {
    const r = parseRangeToken(nv);
    if (r) {
      if (matchesNumericPredicate(n, [r], [])) return false;
    } else if (/^\d+$/.test(nv) && n === parseInt(nv, 10)) return false;
  }

  const text = parsed.text.trim();
  if (text.length) {
    const title = isPr && pr ? pr.title : issue?.title ?? "";
    const body = isPr && pr ? pr.body ?? "" : issue?.body ?? "";
    if (!textMatches(title, text) && !textMatches(body, text)) return false;
  }

  return true;
}

function userMatchesSearch(gh: GitHubStore, u: GitHubUser, parsed: ParsedSearchQuery): boolean {
  const types = parsed.qualifiers.get("type") ?? [];
  if (types.length && !types.map((t) => t.toLowerCase()).includes("user")) return false;
  for (const t of parsed.negations.get("type") ?? []) {
    if (t.toLowerCase() === "user") return false;
  }

  const inScopes = parsed.qualifiers.get("in") ?? [];
  const searchIn = inScopes.length > 0 ? inScopes.map((s) => s.toLowerCase()) : ["login", "email", "fullname"];

  const text = parsed.text.trim();
  if (text.length) {
    let ok = false;
    if (searchIn.includes("login") && textMatches(u.login, text)) ok = true;
    if (searchIn.includes("email") && u.email && textMatches(u.email, text)) ok = true;
    if (searchIn.includes("fullname") && u.name && textMatches(u.name, text)) ok = true;
    if (!ok) return false;
  }

  const rpred = parsed.ranges.get("repos") ?? [];
  const req = parsed.qualifiers.get("repos") ?? [];
  if (!matchesNumericPredicate(u.public_repos, rpred, req)) return false;
  for (const nv of parsed.negations.get("repos") ?? []) {
    const r = parseRangeToken(nv);
    if (r) {
      if (matchesNumericPredicate(u.public_repos, [r], [])) return false;
    } else if (/^\d+$/.test(nv) && u.public_repos === parseInt(nv, 10)) return false;
  }

  const fpred = parsed.ranges.get("followers") ?? [];
  const feq = parsed.qualifiers.get("followers") ?? [];
  if (!matchesNumericPredicate(u.followers, fpred, feq)) return false;
  for (const nv of parsed.negations.get("followers") ?? []) {
    const r = parseRangeToken(nv);
    if (r) {
      if (matchesNumericPredicate(u.followers, [r], [])) return false;
    } else if (/^\d+$/.test(nv) && u.followers === parseInt(nv, 10)) return false;
  }

  return true;
}

function orgMatchesSearch(gh: GitHubStore, o: GitHubOrg, parsed: ParsedSearchQuery): boolean {
  void gh;
  const types = parsed.qualifiers.get("type") ?? [];
  if (types.length && !types.map((t) => t.toLowerCase()).includes("org")) return false;
  for (const t of parsed.negations.get("type") ?? []) {
    if (t.toLowerCase() === "org") return false;
  }

  const inScopes = parsed.qualifiers.get("in") ?? [];
  const searchIn = inScopes.length > 0 ? inScopes.map((s) => s.toLowerCase()) : ["login", "email", "fullname"];

  const text = parsed.text.trim();
  if (text.length) {
    let ok = false;
    if (searchIn.includes("login") && textMatches(o.login, text)) ok = true;
    if (searchIn.includes("email") && o.email && textMatches(o.email, text)) ok = true;
    if (searchIn.includes("fullname") && o.name && textMatches(o.name, text)) ok = true;
    if (!ok) return false;
  }

  const rpred = parsed.ranges.get("repos") ?? [];
  const req = parsed.qualifiers.get("repos") ?? [];
  if (!matchesNumericPredicate(o.public_repos, rpred, req)) return false;
  for (const nv of parsed.negations.get("repos") ?? []) {
    const r = parseRangeToken(nv);
    if (r) {
      if (matchesNumericPredicate(o.public_repos, [r], [])) return false;
    } else if (/^\d+$/.test(nv) && o.public_repos === parseInt(nv, 10)) return false;
  }

  const fpred = parsed.ranges.get("followers") ?? [];
  const feq = parsed.qualifiers.get("followers") ?? [];
  if (!matchesNumericPredicate(o.followers, fpred, feq)) return false;
  for (const nv of parsed.negations.get("followers") ?? []) {
    const r = parseRangeToken(nv);
    if (r) {
      if (matchesNumericPredicate(o.followers, [r], [])) return false;
    } else if (/^\d+$/.test(nv) && o.followers === parseInt(nv, 10)) return false;
  }

  return true;
}

function blobText(blob: GitHubBlob): string {
  if (blob.encoding === "base64") {
    try {
      return Buffer.from(blob.content, "base64").toString("utf8");
    } catch {
      return "";
    }
  }
  return blob.content;
}

function buildBlobPathIndex(gh: GitHubStore): Map<string, string> {
  const byRepo = new Map<number, Map<string, string>>();
  for (const tree of gh.trees.all()) {
    let map = byRepo.get(tree.repo_id);
    if (!map) {
      map = new Map();
      byRepo.set(tree.repo_id, map);
    }
    for (const e of tree.tree) {
      if (e.type === "blob") {
        if (!map.has(e.sha)) map.set(e.sha, e.path);
      }
    }
  }
  const key = (repoId: number, sha: string) => `${repoId}:${sha}`;
  const flat = new Map<string, string>();
  for (const [repoId, m] of byRepo) {
    for (const [sha, path] of m) {
      flat.set(key(repoId, sha), path);
    }
  }
  return flat;
}

function formatSearchCommit(gh: GitHubStore, commit: GitHubCommit, repo: GitHubRepo, baseUrl: string) {
  const repoUrl = `${baseUrl}/repos/${repo.full_name}`;
  return {
    sha: commit.sha,
    node_id: commit.node_id,
    url: `${repoUrl}/commits/${commit.sha}`,
    html_url: `${baseUrl}/${repo.full_name}/commit/${commit.sha}`,
    comments_url: `${repoUrl}/comments/${commit.sha}`,
    repository: formatRepo(repo, gh, baseUrl),
    commit: {
      url: `${repoUrl}/git/commits/${commit.sha}`,
      author: {
        name: commit.author_name,
        email: commit.author_email,
        date: commit.author_date,
      },
      committer: {
        name: commit.committer_name,
        email: commit.committer_email,
        date: commit.committer_date,
      },
      message: commit.message,
    },
    author: null as null,
    committer: null as null,
    parents: commit.parent_shas.map((sha) => ({
      sha,
      url: `${repoUrl}/commits/${sha}`,
    })),
  };
}

function loginMatchesCommitAuthor(gh: GitHubStore, login: string, commit: GitHubCommit, role: "author" | "committer"): boolean {
  const u = gh.users.findOneBy("login", login);
  const email = (role === "author" ? commit.author_email : commit.committer_email).toLowerCase();
  if (u) {
    if (u.email && u.email.toLowerCase() === email) return true;
    if (commit.user_id != null && commit.user_id === u.id) return true;
  }
  const expect = `${login.toLowerCase()}@users.noreply.github.com`;
  return email === expect || email.startsWith(`${login.toLowerCase()}+`);
}

export function searchRoutes({ app, store, baseUrl }: RouteContext): void {
  const gh = getGitHubStore(store);

  app.get("/search/repositories", (c) => {
    const q = c.req.query("q");
    if (q === undefined || q.trim() === "") {
      throw new ApiError(422, "Validation Failed");
    }
    const parsed = parseSearchQuery(q);
    const { page, per_page } = parsePagination(c);
    const sortRaw = (c.req.query("sort") ?? "best-match").toLowerCase();
    const order = (c.req.query("order") ?? "desc").toLowerCase() === "asc" ? "asc" : "desc";
    const authUser = c.get("authUser");

    let list = gh.repos.all().filter((r) => repoVisibleForSearch(r, gh, authUser));
    list = filterRepos(gh, list, parsed, authUser);

    if (sortRaw === "stars") {
      list.sort((a, b) =>
        order === "desc"
          ? b.stargazers_count - a.stargazers_count
          : a.stargazers_count - b.stargazers_count
      );
    } else if (sortRaw === "forks") {
      list.sort((a, b) =>
        order === "desc" ? b.forks_count - a.forks_count : a.forks_count - b.forks_count
      );
    } else if (sortRaw === "updated") {
      list.sort((a, b) =>
        order === "desc" ? b.updated_at.localeCompare(a.updated_at) : a.updated_at.localeCompare(b.updated_at)
      );
    } else {
      list.sort((a, b) => repoRelevance(b, parsed) - repoRelevance(a, parsed));
    }

    const total = list.length;
    const slice = list.slice((page - 1) * per_page, (page - 1) * per_page + per_page);
    setLinkHeader(c, total, page, per_page);
    return c.json({
      total_count: total,
      incomplete_results: false,
      items: slice.map((r) => formatRepo(r, gh, baseUrl)),
    });
  });

  app.get("/search/issues", (c) => {
    const q = c.req.query("q");
    if (q === undefined || q.trim() === "") {
      throw new ApiError(422, "Validation Failed");
    }
    const parsed = parseSearchQuery(q);
    const { page, per_page } = parsePagination(c);
    const sortRaw = (c.req.query("sort") ?? "best-match").toLowerCase();
    const order = (c.req.query("order") ?? "desc").toLowerCase() === "asc" ? "asc" : "desc";

    const authUser = c.get("authUser");
    type Hit = { kind: "issue"; issue: GitHubIssue } | { kind: "pr"; pr: GitHubPullRequest };
    const hits: Hit[] = [];

    for (const issue of gh.issues.all()) {
      const repo = gh.repos.get(issue.repo_id);
      if (!repo) continue;
      if (!repoVisibleForSearch(repo, gh, authUser)) continue;
      if (issue.is_pull_request) {
        const pr = gh.pullRequests
          .findBy("repo_id", issue.repo_id)
          .find((p) => p.number === issue.number);
        if (!pr) continue;
        if (!issuePrMatchesFilters(gh, parsed, repo, issue, pr)) continue;
        hits.push({ kind: "pr", pr });
      } else {
        if (!issuePrMatchesFilters(gh, parsed, repo, issue, null)) continue;
        hits.push({ kind: "issue", issue });
      }
    }

    function relevance(h: Hit): number {
      const title =
        h.kind === "issue" ? h.issue.title : h.pr.title;
      const body = h.kind === "issue" ? h.issue.body ?? "" : h.pr.body ?? "";
      const t = parsed.text.trim().toLowerCase();
      if (!t) return 1;
      let s = 0;
      if (title.toLowerCase().includes(t)) s += 3;
      if (body.toLowerCase().includes(t)) s += 1;
      return s;
    }

    let sorted = [...hits];
    if (sortRaw === "created") {
      sorted.sort((a, b) => {
        const ca = a.kind === "issue" ? a.issue.created_at : a.pr.created_at;
        const cb = b.kind === "issue" ? b.issue.created_at : b.pr.created_at;
        const cmp = ca.localeCompare(cb);
        return order === "desc" ? -cmp : cmp;
      });
    } else if (sortRaw === "updated") {
      sorted.sort((a, b) => {
        const ca = a.kind === "issue" ? a.issue.updated_at : a.pr.updated_at;
        const cb = b.kind === "issue" ? b.issue.updated_at : b.pr.updated_at;
        const cmp = ca.localeCompare(cb);
        return order === "desc" ? -cmp : cmp;
      });
    } else if (sortRaw === "comments") {
      sorted.sort((a, b) => {
        const ca = a.kind === "issue" ? a.issue.comments : a.pr.comments;
        const cb = b.kind === "issue" ? b.issue.comments : b.pr.comments;
        return order === "desc" ? cb - ca : ca - cb;
      });
    } else {
      sorted.sort((a, b) => relevance(b) - relevance(a));
    }

    const total = sorted.length;
    const slice = sorted.slice((page - 1) * per_page, (page - 1) * per_page + per_page);
    setLinkHeader(c, total, page, per_page);

    const items = slice.map((h) => {
      if (h.kind === "issue") {
        return formatIssue(h.issue, gh, baseUrl);
      }
      return formatPullRequest(h.pr, gh, baseUrl);
    });

    return c.json({
      total_count: total,
      incomplete_results: false,
      items: items.filter(Boolean),
    });
  });

  app.get("/search/users", (c) => {
    const q = c.req.query("q");
    if (q === undefined || q.trim() === "") {
      throw new ApiError(422, "Validation Failed");
    }
    const parsed = parseSearchQuery(q);
    const { page, per_page } = parsePagination(c);
    const sortRaw = (c.req.query("sort") ?? "best-match").toLowerCase();
    const order = (c.req.query("order") ?? "desc").toLowerCase() === "asc" ? "asc" : "desc";

    type UHit = { kind: "user"; u: GitHubUser } | { kind: "org"; o: GitHubOrg };
    const hits: UHit[] = [];

    const typeFilters = parsed.qualifiers.get("type")?.map((t) => t.toLowerCase()) ?? [];

    if (!typeFilters.length || typeFilters.includes("user")) {
      for (const u of gh.users.all()) {
        if (u.type === "Organization") continue;
        if (userMatchesSearch(gh, u, parsed)) hits.push({ kind: "user", u });
      }
    }
    if (!typeFilters.length || typeFilters.includes("org")) {
      for (const o of gh.orgs.all()) {
        if (orgMatchesSearch(gh, o, parsed)) hits.push({ kind: "org", o });
      }
    }

    function rel(h: UHit): number {
      const text = parsed.text.trim().toLowerCase();
      if (!text) return 1;
      if (h.kind === "user") {
        let s = 0;
        if (h.u.login.toLowerCase().includes(text)) s += 3;
        if (h.u.name?.toLowerCase().includes(text)) s += 1;
        return s;
      }
      let s = 0;
      if (h.o.login.toLowerCase().includes(text)) s += 3;
      if (h.o.name?.toLowerCase().includes(text)) s += 1;
      return s;
    }

    let list = [...hits];
    if (sortRaw === "followers") {
      list.sort((a, b) => {
        const fa = a.kind === "user" ? a.u.followers : a.o.followers;
        const fb = b.kind === "user" ? b.u.followers : b.o.followers;
        return order === "desc" ? fb - fa : fa - fb;
      });
    } else if (sortRaw === "repositories") {
      list.sort((a, b) => {
        const ra = a.kind === "user" ? a.u.public_repos : a.o.public_repos;
        const rb = b.kind === "user" ? b.u.public_repos : b.o.public_repos;
        return order === "desc" ? rb - ra : ra - rb;
      });
    } else if (sortRaw === "joined") {
      list.sort((a, b) => {
        const ca = a.kind === "user" ? a.u.created_at : a.o.created_at;
        const cb = b.kind === "user" ? b.u.created_at : b.o.created_at;
        const cmp = ca.localeCompare(cb);
        return order === "desc" ? -cmp : cmp;
      });
    } else {
      list.sort((a, b) => rel(b) - rel(a));
    }

    const total = list.length;
    const slice = list.slice((page - 1) * per_page, (page - 1) * per_page + per_page);
    setLinkHeader(c, total, page, per_page);

    const items = slice.map((h) =>
      h.kind === "user" ? formatUser(h.u, baseUrl) : formatOrgBrief(h.o, baseUrl)
    );

    return c.json({
      total_count: total,
      incomplete_results: false,
      items,
    });
  });

  app.get("/search/code", (c) => {
    const q = c.req.query("q") ?? "";
    const parsed = parseSearchQuery(q);
    const { page, per_page } = parsePagination(c);
    const authUser = c.get("authUser");
    const blobs = gh.blobs.all();
    if (blobs.length === 0) {
      setLinkHeader(c, 0, 1, per_page);
      return c.json({
        total_count: 0,
        incomplete_results: false,
        items: [],
      });
    }

    const pathIdx = buildBlobPathIndex(gh);
    const text = parsed.text.trim();
    const repoSpecs = parsed.qualifiers.get("repo") ?? [];
    const langs = parsed.qualifiers.get("language") ?? [];
    const paths = parsed.qualifiers.get("path") ?? [];
    const filenames = parsed.qualifiers.get("filename") ?? [];
    const inScopes = (parsed.qualifiers.get("in") ?? []).map((x) => x.toLowerCase());

    const matches: Array<{
      name: string;
      path: string;
      sha: string;
      score: number;
      repo: GitHubRepo;
    }> = [];

    for (const blob of blobs) {
      const repo = gh.repos.get(blob.repo_id);
      if (!repo) continue;
      if (!repoVisibleForSearch(repo, gh, authUser)) continue;
      if (repoSpecs.length) {
        const ok = repoSpecs.some((rs) => {
          const r = resolveRepoQualifier(gh, rs);
          return r && r.id === repo.id;
        });
        if (!ok) continue;
      }
      if (langs.length) {
        const lang = repo.language;
        if (!lang || !langs.some((l) => l.toLowerCase() === lang.toLowerCase())) continue;
      }

      const path = pathIdx.get(`${blob.repo_id}:${blob.sha}`) ?? `unknown/${blob.sha.slice(0, 7)}`;
      const base = path.split("/").pop() ?? path;
      if (paths.length && !paths.some((p) => path.toLowerCase().includes(p.toLowerCase()))) continue;
      if (filenames.length && !filenames.some((p) => base.toLowerCase().includes(p.toLowerCase()))) continue;

      const content = blobText(blob);
      if (text.length) {
        const inFile = content.toLowerCase().includes(text.toLowerCase());
        const inPath = path.toLowerCase().includes(text.toLowerCase());
        let hit = false;
        if (!inScopes.length) hit = inFile || inPath;
        else {
          if (inScopes.includes("file") && inFile) hit = true;
          if (inScopes.includes("path") && inPath) hit = true;
        }
        if (!hit) continue;
      }

      matches.push({
        name: path.split("/").pop() ?? blob.sha,
        path,
        sha: blob.sha,
        score: text.length ? (content.toLowerCase().includes(text.toLowerCase()) ? 2 : 1) : 1,
        repo,
      });
    }

    matches.sort((a, b) => b.score - a.score);
    const total = matches.length;
    const slice = matches.slice((page - 1) * per_page, (page - 1) * per_page + per_page);
    setLinkHeader(c, total, page, per_page);

    const items = slice.map((m) => {
      const repoUrl = `${baseUrl}/repos/${m.repo.full_name}`;
      return {
        name: m.name,
        path: m.path,
        sha: m.sha,
        url: `${repoUrl}/contents/${m.path}?ref=HEAD`,
        git_url: `${repoUrl}/git/blobs/${m.sha}`,
        html_url: `${baseUrl}/${m.repo.full_name}/blob/HEAD/${m.path}`,
        repository: formatRepo(m.repo, gh, baseUrl),
        score: 1,
      };
    });

    return c.json({
      total_count: total,
      incomplete_results: false,
      items,
    });
  });

  app.get("/search/commits", (c) => {
    const q = c.req.query("q");
    if (q === undefined || q.trim() === "") {
      throw new ApiError(422, "Validation Failed");
    }
    const parsed = parseSearchQuery(q);
    const { page, per_page } = parsePagination(c);
    const sortRaw = (c.req.query("sort") ?? "best-match").toLowerCase();
    const order = (c.req.query("order") ?? "desc").toLowerCase() === "asc" ? "asc" : "desc";

    const authUser = c.get("authUser");
    const repoSpecs = parsed.qualifiers.get("repo") ?? [];
    const authors = parsed.qualifiers.get("author") ?? [];
    const committers = parsed.qualifiers.get("committer") ?? [];
    const mergeVals = parsed.qualifiers.get("merge") ?? [];

    let list: GitHubCommit[] = [];
    for (const commit of gh.commits.all()) {
      const repo = gh.repos.get(commit.repo_id);
      if (!repo) continue;
      if (!repoVisibleForSearch(repo, gh, authUser)) continue;
      if (repoSpecs.length) {
        const ok = repoSpecs.some((rs) => {
          const r = resolveRepoQualifier(gh, rs);
          return r && r.id === repo.id;
        });
        if (!ok) continue;
      }
      if (authors.length) {
        const ok = authors.some((a) => loginMatchesCommitAuthor(gh, a, commit, "author"));
        if (!ok) continue;
      }
      if (committers.length) {
        const ok = committers.some((a) => loginMatchesCommitAuthor(gh, a, commit, "committer"));
        if (!ok) continue;
      }
      if (mergeVals.length) {
        const isMerge = commit.parent_shas.length > 1;
        const ok = mergeVals.every((m) => {
          if (m === "true") return isMerge;
          if (m === "false") return !isMerge;
          return true;
        });
        if (!ok) continue;
      }
      const t = parsed.text.trim();
      if (t.length && !textMatches(commit.message, t)) continue;
      list.push(commit);
    }

    function rel(cm: GitHubCommit): number {
      const t = parsed.text.trim().toLowerCase();
      if (!t) return 1;
      return cm.message.toLowerCase().includes(t) ? 2 : 1;
    }

    if (sortRaw === "author-date") {
      list = [...list].sort((a, b) => {
        const cmp = a.author_date.localeCompare(b.author_date);
        return order === "desc" ? -cmp : cmp;
      });
    } else if (sortRaw === "committer-date") {
      list = [...list].sort((a, b) => {
        const cmp = a.committer_date.localeCompare(b.committer_date);
        return order === "desc" ? -cmp : cmp;
      });
    } else {
      list = [...list].sort((a, b) => rel(b) - rel(a));
    }

    const total = list.length;
    const slice = list.slice((page - 1) * per_page, (page - 1) * per_page + per_page);
    setLinkHeader(c, total, page, per_page);

    const items = slice.map((commit) => {
      const repo = gh.repos.get(commit.repo_id)!;
      return formatSearchCommit(gh, commit, repo, baseUrl);
    });

    return c.json({
      total_count: total,
      incomplete_results: false,
      items,
    });
  });

  app.get("/search/topics", (c) => {
    const q = c.req.query("q") ?? "";
    const parsed = parseSearchQuery(q);
    const { page, per_page } = parsePagination(c);
    const text = parsed.text.trim().toLowerCase();

    const topicSet = new Map<string, { name: string; updated: string }>();
    for (const repo of gh.repos.all()) {
      for (const t of repo.topics) {
        const key = t.toLowerCase();
        if (!topicSet.has(key)) {
          topicSet.set(key, { name: t, updated: repo.updated_at });
        } else {
          const cur = topicSet.get(key)!;
          if (repo.updated_at > cur.updated) topicSet.set(key, { name: t, updated: repo.updated_at });
        }
      }
    }

    let topics = Array.from(topicSet.values());
    if (text.length) {
      topics = topics.filter((t) => t.name.toLowerCase().includes(text));
    }

    topics.sort((a, b) => a.name.localeCompare(b.name));
    const total = topics.length;
    const slice = topics.slice((page - 1) * per_page, (page - 1) * per_page + per_page);
    setLinkHeader(c, total, page, per_page);

    const items = slice.map((t) => ({
      name: t.name,
      display_name: t.name,
      short_description: "",
      created_by: null as string | null,
      created_at: t.updated,
      updated_at: t.updated,
    }));

    return c.json({
      total_count: total,
      incomplete_results: false,
      items,
    });
  });

  app.get("/search/labels", (c) => {
    const q = c.req.query("q") ?? "";
    const rawId = c.req.query("repository_id");
    if (rawId === undefined || rawId === "") {
      throw new ApiError(422, "Validation Failed: repository_id is required");
    }
    const repositoryId = parseInt(rawId, 10);
    if (Number.isNaN(repositoryId)) {
      throw new ApiError(422, "Validation Failed: invalid repository_id");
    }
    const repo = gh.repos.get(repositoryId);
    if (!repo) {
      throw new ApiError(404, "Not Found");
    }

    const parsed = parseSearchQuery(q);
    const { page, per_page } = parsePagination(c);
    const text = parsed.text.trim().toLowerCase();

    let labels = gh.labels.findBy("repo_id", repositoryId);
    if (text.length) {
      labels = labels.filter(
        (l) =>
          l.name.toLowerCase().includes(text) ||
          (l.description && l.description.toLowerCase().includes(text))
      );
    }

    labels.sort((a, b) => a.name.localeCompare(b.name));
    const total = labels.length;
    const slice = labels.slice((page - 1) * per_page, (page - 1) * per_page + per_page);
    setLinkHeader(c, total, page, per_page);

    return c.json({
      total_count: total,
      incomplete_results: false,
      items: slice.map((l) => ({
        id: l.id,
        node_id: l.node_id,
        url: `${baseUrl}/repos/${repo.full_name}/labels/${encodeURIComponent(l.name)}`,
        name: l.name,
        color: l.color,
        default: l.default,
        description: l.description,
      })),
    });
  });
}
