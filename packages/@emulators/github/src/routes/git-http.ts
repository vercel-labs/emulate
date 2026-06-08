import { gunzipSync } from "zlib";
import type { Context, RouteContext, TokenMap, AuthUser } from "@emulators/core";
import { debug } from "@emulators/core";
import { getGitHubStore } from "../store.js";
import type { GitHubStore } from "../store.js";
import type { GitHubRepo } from "../entities.js";
import { canAccessRepo, ownerLoginOf } from "../route-helpers.js";
import { lookupRepo } from "../helpers.js";
import { createRepoObjectSource } from "../git-data.js";
import { buildPackfile, FLUSH_PKT, parsePktLines, pktLine, ZERO_SHA, type GitObject } from "../git-objects.js";

/**
 * Read side of the git smart HTTP protocol (protocol v0), enough for a real
 * `git clone ${baseUrl}/{owner}/{repo}.git` against fixture repos. Push
 * (git-receive-pack), shallow clones, and partial fetches are not supported.
 *
 * Unlike the REST routes, these endpoints do not fall back to a default user
 * for unknown tokens: a presented token must be one this emulator instance
 * knows, either seeded through config or minted at runtime (for example by
 * POST /app/installations/:id/access_tokens). That keeps clone tests honest.
 */

const MAX_REQUEST_BODY_BYTES = 1024 * 1024;
const MAX_INFLATED_BODY_BYTES = 4 * 1024 * 1024;
const UPLOAD_PACK_CAPS = "agent=emulate";

const ADVERTISEMENT_TYPE = "application/x-git-upload-pack-advertisement";
const RESULT_TYPE = "application/x-git-upload-pack-result";

function stripGitSuffix(repoName: string): string {
  return repoName.endsWith(".git") ? repoName.slice(0, -4) : repoName;
}

function resolveGitUser(c: Context, tokenMap: TokenMap | undefined): { provided: boolean; user: AuthUser | null } {
  const header = c.req.header("Authorization")?.trim();
  if (!header) return { provided: false, user: null };

  const candidates: string[] = [];
  const basic = /^Basic\s+(.+)$/i.exec(header);
  if (basic) {
    // Buffer.from tolerates malformed base64; garbage decodes to garbage and
    // simply will not match any known token.
    const decoded = Buffer.from(basic[1], "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    const username = separator === -1 ? decoded : decoded.slice(0, separator);
    const password = separator === -1 ? "" : decoded.slice(separator + 1);
    // git sends the token as the password (x-access-token:TOKEN), but URLs
    // like http://TOKEN@host put it in the username, so check both.
    if (password) candidates.push(password);
    if (username) candidates.push(username);
  } else {
    const bearer = /^(?:Bearer|token)\s+(.+)$/i.exec(header);
    if (bearer) candidates.push(bearer[1].trim());
  }

  for (const candidate of candidates) {
    const user = tokenMap?.get(candidate);
    if (user) return { provided: true, user };
  }
  return { provided: true, user: null };
}

function unauthorized(c: Context): Response {
  c.header("WWW-Authenticate", 'Basic realm="GitHub"');
  return c.text("Authentication required", 401);
}

function repoNotFound(c: Context): Response {
  return c.text("Repository not found.", 404);
}

function authorizeGitRequest(c: Context, gh: GitHubStore, tokenMap: TokenMap | undefined): GitHubRepo | Response {
  const owner = c.req.param("owner");
  const repoName = c.req.param("repo");
  // Exact name first so a repo literally named "x.git" stays reachable.
  const repo = lookupRepo(gh, owner, repoName) ?? lookupRepo(gh, owner, stripGitSuffix(repoName));

  const { provided, user } = resolveGitUser(c, tokenMap);
  if (provided && !user) {
    // A token was presented but was never minted or seeded by this instance.
    return unauthorized(c);
  }
  if (!repo) return repoNotFound(c);

  if (repo.private) {
    if (!user) return unauthorized(c);
    const allowed = user.login === ownerLoginOf(gh, repo) || canAccessRepo(gh, user, repo);
    if (!allowed) return repoNotFound(c);
  }
  return repo;
}

function loadServeableRefs(
  gh: GitHubStore,
  repo: GitHubRepo,
): { refs: Array<{ name: string; sha: string }>; headSha: string | null; hasRefs: boolean } {
  const resolve = createRepoObjectSource(gh, repo.id);
  const rows = gh.refs.findBy("repo_id", repo.id);
  const refs: Array<{ name: string; sha: string }> = [];
  for (const row of rows) {
    if (resolve(row.sha)) {
      refs.push({ name: row.ref, sha: row.sha });
    } else {
      debug("github:git", `skipping ${row.ref} in ${repo.full_name}: objects for ${row.sha} are not materialized`);
    }
  }
  refs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const head = refs.find((r) => r.name === `refs/heads/${repo.default_branch}`);
  return { refs, headSha: head?.sha ?? null, hasRefs: rows.length > 0 };
}

function noCache(c: Context): void {
  c.header("Cache-Control", "no-cache, max-age=0, must-revalidate");
  c.header("Pragma", "no-cache");
}

/** Reads the request body, aborting (null) as soon as it exceeds the limit instead of buffering it all. */
async function readBodyWithLimit(c: Context, limit: number): Promise<Buffer | null> {
  const stream = c.req.raw.body;
  if (!stream) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const piece = Buffer.from(chunk as Uint8Array);
    total += piece.length;
    if (total > limit) return null;
    chunks.push(piece);
  }
  return Buffer.concat(chunks);
}

export function gitHttpRoutes({ app, store, tokenMap }: RouteContext): void {
  const gh = getGitHubStore(store);

  app.get("/:owner/:repo/info/refs", (c) => {
    const service = c.req.query("service");
    if (service === "git-receive-pack") {
      return c.text("The emulator does not support git push", 403);
    }
    if (service !== "git-upload-pack") {
      return c.text("Smart HTTP is required: use service=git-upload-pack", 400);
    }

    const repo = authorizeGitRequest(c, gh, tokenMap);
    if (repo instanceof Response) return repo;

    const { refs, headSha, hasRefs } = loadServeableRefs(gh, repo);
    noCache(c);

    const chunks: Buffer[] = [pktLine("# service=git-upload-pack\n"), FLUSH_PKT];
    if (refs.length === 0) {
      chunks.push(
        hasRefs
          ? pktLine(`ERR ${repo.full_name} has refs but no materialized git objects to serve`)
          : pktLine(`${ZERO_SHA} capabilities^{}\0${UPLOAD_PACK_CAPS}\n`),
      );
    } else {
      let caps = UPLOAD_PACK_CAPS;
      const lines: string[] = [];
      if (headSha) {
        caps = `symref=HEAD:refs/heads/${repo.default_branch} ${caps}`;
        lines.push(`${headSha} HEAD`);
      }
      for (const ref of refs) {
        lines.push(`${ref.sha} ${ref.name}`);
      }
      lines.forEach((line, index) => {
        chunks.push(pktLine(index === 0 ? `${line}\0${caps}\n` : `${line}\n`));
      });
    }
    chunks.push(FLUSH_PKT);
    return c.body(Buffer.concat(chunks), 200, { "Content-Type": ADVERTISEMENT_TYPE });
  });

  app.post("/:owner/:repo/git-upload-pack", async (c) => {
    const repo = authorizeGitRequest(c, gh, tokenMap);
    if (repo instanceof Response) return repo;

    let body = await readBodyWithLimit(c, MAX_REQUEST_BODY_BYTES);
    if (body === null) {
      return c.text("Request body too large", 413);
    }
    const encoding = c.req.header("Content-Encoding")?.toLowerCase();
    if (encoding === "gzip" || encoding === "x-gzip") {
      try {
        body = gunzipSync(body, { maxOutputLength: MAX_INFLATED_BODY_BYTES });
      } catch {
        return c.text("Invalid gzip request body", 400);
      }
    }

    let lines: string[];
    try {
      lines = parsePktLines(body);
    } catch {
      return c.text("Invalid pkt-line request body", 400);
    }

    const wants = new Set<string>();
    let done = false;
    for (const line of lines) {
      const want = /^want ([0-9a-f]{40})(?: |$)/.exec(line);
      if (want) {
        wants.add(want[1]);
        continue;
      }
      if (line === "done") {
        done = true;
        continue;
      }
      if (/^(deepen|shallow|filter)/.test(line)) {
        return c.text("Shallow and filtered fetches are not supported by the emulator", 400);
      }
      // "have" lines and anything else are ignored: the emulator always sends
      // a full pack, which is a valid (if unoptimized) response.
    }
    if (wants.size === 0) {
      return c.text("No want lines in request", 400);
    }

    const tips = new Set(gh.refs.findBy("repo_id", repo.id).map((r) => r.sha));
    noCache(c);

    for (const want of wants) {
      if (!tips.has(want)) {
        return c.body(pktLine(`ERR upload-pack: not our ref ${want}`), 200, { "Content-Type": RESULT_TYPE });
      }
    }

    if (!done) {
      // Stateless negotiation round: nothing in common yet, ask the client to
      // continue. A fresh clone always sends "done" in its first request.
      return c.body(pktLine("NAK\n"), 200, { "Content-Type": RESULT_TYPE });
    }

    const resolve = createRepoObjectSource(gh, repo.id);
    const objects = new Map<string, GitObject>();
    for (const want of wants) {
      const resolved = resolve(want);
      if (!resolved) {
        return c.body(pktLine(`ERR ${repo.full_name} has refs but no materialized git objects to serve`), 200, {
          "Content-Type": RESULT_TYPE,
        });
      }
      for (const [sha, obj] of resolved) {
        objects.set(sha, obj);
      }
    }

    const pack = buildPackfile([...objects.values()]);
    return c.body(Buffer.concat([pktLine("NAK\n"), pack]), 200, { "Content-Type": RESULT_TYPE });
  });
}
