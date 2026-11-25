import type { Context, RouteContext } from "@emulators/core";
import { ApiError, parseJsonBody, parsePagination, setLinkHeader } from "@emulators/core";
import { getGitHubStore } from "../store.js";
import type { GitHubStore } from "../store.js";
import type { GitHubReaction, GitHubRepo } from "../entities.js";
import { assertRepoPermission, assertRepoWrite, notFoundResponse } from "../route-helpers.js";
import { formatReaction, generateNodeId, lookupRepo, REACTION_CONTENTS, type ReactionContent } from "../helpers.js";

type Subject = "issue" | "issue_comment" | "review_comment" | "commit_comment";

const COMMENT_TYPE: Record<Exclude<Subject, "issue">, "issue" | "review" | "commit"> = {
  issue_comment: "issue",
  review_comment: "review",
  commit_comment: "commit",
};

function subjectExists(gh: GitHubStore, repo: GitHubRepo, kind: Subject, id: number): boolean {
  if (kind === "issue") return gh.issues.findBy("repo_id", repo.id).some((issue) => issue.number === id);
  const comment = gh.comments.get(id);
  if (!comment || comment.repo_id !== repo.id) return false;
  return comment.comment_type === COMMENT_TYPE[kind];
}

function reactionsFor(gh: GitHubStore, repo: GitHubRepo, kind: Subject, id: number): GitHubReaction[] {
  const column = kind === "issue" ? "issue_number" : "comment_id";
  return gh.reactions
    .findBy("repo_id", repo.id)
    .filter((reaction) => reaction[column] === id)
    .sort((left, right) => left.id - right.id);
}

function isReactionContent(value: unknown): value is ReactionContent {
  return typeof value === "string" && (REACTION_CONTENTS as readonly string[]).includes(value);
}

/** Only issue reactions and issue-comment reactions live behind the repository's issue tracker. */
function requiresIssueTracker(kind: Subject): boolean {
  return kind === "issue" || kind === "issue_comment";
}

export function reactionsRoutes({ app, store, baseUrl }: RouteContext): void {
  const gh = getGitHubStore(store);

  function register(path: string, kind: Subject, readId: (c: Context) => number) {
    const permissions = ["issues", "pull_requests"];
    const subject = (c: Context) => {
      const repo = lookupRepo(gh, c.req.param("owner")!, c.req.param("repo")!);
      if (!repo || (requiresIssueTracker(kind) && !repo.has_issues)) throw notFoundResponse();
      const id = readId(c);
      if (!Number.isFinite(id) || !subjectExists(gh, repo, kind, id)) throw notFoundResponse();
      return { repo, id };
    };

    app.get(`${path}/reactions`, (c) => {
      const { repo, id } = subject(c);
      assertRepoPermission(gh, c.get("authUser"), repo, permissions);

      const content = c.req.query("content");
      if (content !== undefined && !isReactionContent(content)) {
        throw new ApiError(422, "Validation failed");
      }

      let rows = reactionsFor(gh, repo, kind, id);
      if (content !== undefined) rows = rows.filter((reaction) => reaction.content === content);

      const { page, per_page } = parsePagination(c);
      setLinkHeader(c, rows.length, page, per_page);
      const start = (page - 1) * per_page;
      return c.json(rows.slice(start, start + per_page).map((reaction) => formatReaction(reaction, gh, baseUrl)));
    });

    app.post(`${path}/reactions`, async (c) => {
      const repo = lookupRepo(gh, c.req.param("owner")!, c.req.param("repo")!);
      if (!repo || (requiresIssueTracker(kind) && !repo.has_issues)) throw notFoundResponse();
      const actor = assertRepoWrite(gh, c.get("authUser"), repo, permissions);
      const id = readId(c);
      if (!Number.isFinite(id) || !subjectExists(gh, repo, kind, id)) throw notFoundResponse();

      const body = await parseJsonBody(c);
      if (!isReactionContent(body.content)) throw new ApiError(422, "Validation failed");

      const existing = reactionsFor(gh, repo, kind, id).find(
        (reaction) => reaction.user_id === actor.id && reaction.content === body.content,
      );
      if (existing) return c.json(formatReaction(existing, gh, baseUrl), 200);

      const row = gh.reactions.insert({
        node_id: "",
        repo_id: repo.id,
        issue_number: kind === "issue" ? id : null,
        comment_id: kind === "issue" ? null : id,
        user_id: actor.id,
        content: body.content,
      } as Omit<GitHubReaction, "id" | "created_at" | "updated_at">);
      gh.reactions.update(row.id, { node_id: generateNodeId("Reaction", row.id) });
      return c.json(formatReaction(gh.reactions.get(row.id)!, gh, baseUrl), 201);
    });

    app.delete(`${path}/reactions/:reaction_id`, (c) => {
      const repo = lookupRepo(gh, c.req.param("owner")!, c.req.param("repo")!);
      if (!repo || (requiresIssueTracker(kind) && !repo.has_issues)) throw notFoundResponse();
      assertRepoWrite(gh, c.get("authUser"), repo, permissions);

      const id = readId(c);
      const reactionId = parseInt(c.req.param("reaction_id")!, 10);
      if (!Number.isFinite(id) || !Number.isFinite(reactionId)) throw notFoundResponse();

      const reaction = gh.reactions.get(reactionId);
      const column = kind === "issue" ? "issue_number" : "comment_id";
      if (!reaction || reaction.repo_id !== repo.id || reaction[column] !== id) throw notFoundResponse();

      gh.reactions.delete(reaction.id);
      return c.body(null, 204);
    });
  }

  // Comment paths come before the issue path so `comments` is not read as an issue number.
  register("/repos/:owner/:repo/issues/comments/:comment_id", "issue_comment", (c) =>
    parseInt(c.req.param("comment_id")!, 10),
  );
  register("/repos/:owner/:repo/pulls/comments/:comment_id", "review_comment", (c) =>
    parseInt(c.req.param("comment_id")!, 10),
  );
  register("/repos/:owner/:repo/comments/:comment_id", "commit_comment", (c) =>
    parseInt(c.req.param("comment_id")!, 10),
  );
  register("/repos/:owner/:repo/issues/:issue_number", "issue", (c) => parseInt(c.req.param("issue_number")!, 10));
}
