import type { Context, RouteContext } from "@emulators/core";
import { ApiError, forbidden, parseJsonBody, parsePagination, setLinkHeader } from "@emulators/core";
import type { GitHubReaction, GitHubReactionContent } from "../entities.js";
import { formatReaction, generateNodeId, lookupRepo } from "../helpers.js";
import { assertAuthenticatedActor, assertRepoPermission, notFoundResponse } from "../route-helpers.js";
import { getGitHubStore } from "../store.js";

const reactionContents: GitHubReactionContent[] = [
  "+1",
  "-1",
  "laugh",
  "hooray",
  "confused",
  "heart",
  "rocket",
  "eyes",
];

function parseContent(value: unknown): GitHubReactionContent {
  if (typeof value !== "string" || !reactionContents.includes(value as GitHubReactionContent)) {
    throw new ApiError(422, "Validation failed");
  }
  return value as GitHubReactionContent;
}

export function reactionsRoutes({ app, store, baseUrl }: RouteContext): void {
  const gh = getGitHubStore(store);
  const subjects: Array<{
    path: string;
    type: GitHubReaction["subject_type"];
    permission: string;
  }> = [
    { path: "issues/:issue_number", type: "issue", permission: "issues" },
    { path: "issues/comments/:comment_id", type: "issue_comment", permission: "issues" },
    { path: "pulls/comments/:comment_id", type: "review_comment", permission: "pull_requests" },
  ];

  for (const subject of subjects) {
    const path = `/repos/:owner/:repo/${subject.path}/reactions`;

    function resolveSubject(c: Context, required: "read" | "write") {
      const repo = lookupRepo(gh, c.req.param("owner")!, c.req.param("repo")!);
      if (!repo) throw notFoundResponse();
      assertRepoPermission(gh, c.get("authUser"), repo, subject.permission, required);

      let subjectId: number;
      if (subject.type === "issue") {
        const number = Number(c.req.param("issue_number"));
        const issue = gh.issues.findBy("repo_id", repo.id).find((i) => i.number === number);
        if (!issue) throw notFoundResponse();
        subjectId = issue.id;
      } else {
        const comment = gh.comments.get(Number(c.req.param("comment_id")));
        const commentType = subject.type === "issue_comment" ? "issue" : "review";
        if (!comment || comment.repo_id !== repo.id || comment.comment_type !== commentType) {
          throw notFoundResponse();
        }
        subjectId = comment.id;
      }

      return { repoId: repo.id, subjectId };
    }

    app.get(path, (c) => {
      const { repoId, subjectId } = resolveSubject(c, "read");
      const query = c.req.query("content");
      const content = query === undefined ? undefined : parseContent(query);
      let reactions = gh.reactions
        .findBy("subject_id", subjectId)
        .filter((reaction) => reaction.repo_id === repoId && reaction.subject_type === subject.type);
      if (content !== undefined) reactions = reactions.filter((reaction) => reaction.content === content);
      reactions.sort((a, b) => a.id - b.id);
      const { page, per_page } = parsePagination(c);
      setLinkHeader(c, reactions.length, page, per_page);
      const start = (page - 1) * per_page;
      return c.json(reactions.slice(start, start + per_page).map((reaction) => formatReaction(reaction, gh, baseUrl)));
    });

    app.post(path, async (c) => {
      const { repoId, subjectId } = resolveSubject(c, "write");
      const actor = assertAuthenticatedActor(gh, c.get("authUser"));
      const raw = await parseJsonBody(c);
      const content = parseContent(raw.content);
      const existing = gh.reactions
        .findBy("subject_id", subjectId)
        .find(
          (reaction) =>
            reaction.repo_id === repoId &&
            reaction.subject_type === subject.type &&
            reaction.user_id === actor.id &&
            reaction.content === content,
        );
      if (existing) return c.json(formatReaction(existing, gh, baseUrl));

      const reaction = gh.reactions.insert({
        node_id: "",
        repo_id: repoId,
        subject_type: subject.type,
        subject_id: subjectId,
        user_id: actor.id,
        content,
      });
      gh.reactions.update(reaction.id, { node_id: generateNodeId("Reaction", reaction.id) });
      return c.json(formatReaction(gh.reactions.get(reaction.id)!, gh, baseUrl), 201);
    });

    app.delete(`${path}/:reaction_id`, (c) => {
      const { repoId, subjectId } = resolveSubject(c, "write");
      const actor = assertAuthenticatedActor(gh, c.get("authUser"));
      const reaction = gh.reactions.get(Number(c.req.param("reaction_id")));
      if (
        !reaction ||
        reaction.repo_id !== repoId ||
        reaction.subject_type !== subject.type ||
        reaction.subject_id !== subjectId
      ) {
        throw notFoundResponse();
      }
      if (reaction.user_id !== actor.id) throw forbidden();
      gh.reactions.delete(reaction.id);
      return c.body(null, 204);
    });
  }
}
