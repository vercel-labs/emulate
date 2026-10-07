import type { RouteContext } from "@emulators/core";
import {
  API_V,
  fieldError,
  JiraError,
  makeHandler,
  pageParams,
  READ,
  readJson,
  WRITE,
  type JiraRequest,
} from "../context.js";
import { formatUser, restUrl } from "../formatters.js";
import { formatComment, formatIssueRef, formatWorklog, parseDuration } from "../issue-format.js";
import { addComment, createLink, findLinkType, readBody } from "../issue-service.js";
import { findIssue, findUser, requireIssue } from "../lookup.js";
import { insertFrom } from "../store.js";
import { touchIssue } from "../services.js";
import { emitCommentEvent, emitIssueEvent } from "../webhooks.js";
import type { JiraComment, JiraIssue, JiraWorklog } from "../entities.js";

function timeSpentSeconds(body: { timeSpent?: unknown; timeSpentSeconds?: unknown }): number | undefined {
  if (typeof body.timeSpentSeconds === "number") {
    if (body.timeSpentSeconds <= 0) throw fieldError("timeLogged", "You must indicate the time spent working.");
    return body.timeSpentSeconds;
  }
  if (typeof body.timeSpent === "string") {
    const seconds = parseDuration(body.timeSpent);
    if (!seconds) throw fieldError("timeLogged", "Invalid time duration entered.");
    return seconds;
  }
  return undefined;
}

export function subresourceRoutes({ app, store, baseUrl }: RouteContext): void {
  const handle = makeHandler(store, baseUrl);

  const requireComment = (r: JiraRequest, issue: JiraIssue): JiraComment => {
    const comment = r.js.comments.get(Number(r.c.req.param("id")));
    if (!comment || comment.issue_id !== issue.id) {
      throw new JiraError(404, [`Can not find a comment for the id: ${r.c.req.param("id")}.`]);
    }
    return comment;
  };

  const requireCommentAuthor = (r: JiraRequest, comment: JiraComment) => {
    if (comment.author_id !== r.user.account_id && !r.user.admin) {
      throw new JiraError(403, ["You do not have the permission to edit this comment."]);
    }
  };

  // Comments

  app.post(
    `${API_V}/comment/list`,
    handle(
      async (r) => {
        const body = await readJson(r.c);
        const ids: number[] = Array.isArray(body.ids) ? body.ids.map(Number) : [];
        const comments = ids
          .map((id) => r.js.comments.get(id))
          .filter((comment): comment is JiraComment => Boolean(comment));
        return r.c.json({
          startAt: 0,
          maxResults: comments.length,
          total: comments.length,
          isLast: true,
          values: comments.map((comment) => formatComment(r, comment)),
        });
      },
      { scopes: READ },
    ),
  );

  app.get(
    `${API_V}/issue/:key/comment`,
    handle(
      (r) => {
        const issue = requireIssue(r.js, r.c.req.param("key"));
        const orderBy = r.c.req.query("orderBy") ?? "created";
        const descending = orderBy.startsWith("-");
        const comments = r.js.comments
          .findBy("issue_id", issue.id)
          .sort((a, b) => (descending ? b.id - a.id : a.id - b.id));
        const { startAt, maxResults } = pageParams(r.c, 5000, 5000);
        return r.c.json({
          self: restUrl(r, `/issue/${issue.id}/comment`),
          startAt,
          maxResults,
          total: comments.length,
          comments: comments.slice(startAt, startAt + maxResults).map((comment) => formatComment(r, comment)),
        });
      },
      { scopes: READ },
    ),
  );

  app.post(
    `${API_V}/issue/:key/comment`,
    handle(
      async (r) => {
        const issue = requireIssue(r.js, r.c.req.param("key"));
        const body = await readJson(r.c);
        const doc = readCommentBody(r, body.body);
        const comment = addComment(r, issue, doc);
        await emitCommentEvent(r, "comment_created", issue, comment);
        await emitIssueEvent(r, "jira:issue_updated", r.js.issues.get(issue.id)!, { comments: [comment] });
        return r.c.json(formatComment(r, comment), 201);
      },
      { scopes: WRITE },
    ),
  );

  app.get(
    `${API_V}/issue/:key/comment/:id`,
    handle(
      (r) => {
        const issue = requireIssue(r.js, r.c.req.param("key"));
        return r.c.json(formatComment(r, requireComment(r, issue)));
      },
      { scopes: READ },
    ),
  );

  app.put(
    `${API_V}/issue/:key/comment/:id`,
    handle(
      async (r) => {
        const issue = requireIssue(r.js, r.c.req.param("key"));
        const comment = requireComment(r, issue);
        requireCommentAuthor(r, comment);
        const body = await readJson(r.c);
        const updated = r.js.comments.update(comment.id, {
          body: readCommentBody(r, body.body),
          update_author_id: r.user.account_id,
        })!;
        await emitCommentEvent(r, "comment_updated", issue, updated);
        return r.c.json(formatComment(r, updated));
      },
      { scopes: WRITE },
    ),
  );

  app.delete(
    `${API_V}/issue/:key/comment/:id`,
    handle(
      async (r) => {
        const issue = requireIssue(r.js, r.c.req.param("key"));
        const comment = requireComment(r, issue);
        requireCommentAuthor(r, comment);
        r.js.comments.delete(comment.id);
        touchIssue(r.js, issue.id);
        await emitCommentEvent(r, "comment_deleted", issue, comment);
        return r.c.body(null, 204);
      },
      { scopes: WRITE },
    ),
  );

  // Watchers

  app.get(
    `${API_V}/issue/:key/watchers`,
    handle(
      (r) => {
        const issue = requireIssue(r.js, r.c.req.param("key"));
        return r.c.json({
          self: restUrl(r, `/issue/${issue.key}/watchers`),
          isWatching: issue.watcher_ids.includes(r.user.account_id),
          watchCount: issue.watcher_ids.length,
          watchers: issue.watcher_ids
            .map((id) => formatUser(r, r.js.users.findOneBy("account_id", id)))
            .filter(Boolean),
        });
      },
      { scopes: READ },
    ),
  );

  app.post(
    `${API_V}/issue/:key/watchers`,
    handle(
      async (r) => {
        const issue = requireIssue(r.js, r.c.req.param("key"));
        const body = await readJson(r.c);
        const ref = typeof body === "string" ? body : r.user.account_id;
        const user = findUser(r.js, ref);
        if (!user) throw new JiraError(404, [`The user "${ref}" does not exist.`]);
        if (!issue.watcher_ids.includes(user.account_id)) {
          r.js.issues.update(issue.id, { watcher_ids: [...issue.watcher_ids, user.account_id] });
        }
        return r.c.body(null, 204);
      },
      { scopes: WRITE },
    ),
  );

  app.delete(
    `${API_V}/issue/:key/watchers`,
    handle(
      (r) => {
        const issue = requireIssue(r.js, r.c.req.param("key"));
        const ref = r.c.req.query("accountId") ?? r.c.req.query("username");
        if (!ref) throw new JiraError(400, ["You must specify an accountId."]);
        const user = findUser(r.js, ref);
        if (!user) throw new JiraError(404, [`The user "${ref}" does not exist.`]);
        r.js.issues.update(issue.id, { watcher_ids: issue.watcher_ids.filter((id) => id !== user.account_id) });
        return r.c.body(null, 204);
      },
      { scopes: WRITE },
    ),
  );

  // Worklogs

  const requireWorklog = (r: JiraRequest, issue: JiraIssue): JiraWorklog => {
    const worklog = r.js.worklogs.get(Number(r.c.req.param("id")));
    if (!worklog || worklog.issue_id !== issue.id) {
      throw new JiraError(404, [`Cannot find worklog with id: '${r.c.req.param("id")}'.`]);
    }
    return worklog;
  };

  app.get(
    `${API_V}/issue/:key/worklog`,
    handle(
      (r) => {
        const issue = requireIssue(r.js, r.c.req.param("key"));
        const worklogs = r.js.worklogs.findBy("issue_id", issue.id).sort((a, b) => a.id - b.id);
        const { startAt, maxResults } = pageParams(r.c, 5000, 5000);
        return r.c.json({
          startAt,
          maxResults,
          total: worklogs.length,
          worklogs: worklogs.slice(startAt, startAt + maxResults).map((worklog) => formatWorklog(r, worklog)),
        });
      },
      { scopes: READ },
    ),
  );

  app.post(
    `${API_V}/issue/:key/worklog`,
    handle(
      async (r) => {
        const issue = requireIssue(r.js, r.c.req.param("key"));
        const body = await readJson(r.c);
        const seconds = timeSpentSeconds(body);
        if (!seconds) throw fieldError("timeLogged", "You must indicate the time spent working.");
        const worklog = insertFrom(r.js.worklogs, 10000, {
          issue_id: issue.id,
          author_id: r.user.account_id,
          update_author_id: r.user.account_id,
          comment: body.comment === undefined ? null : readBody(r, "comment", body.comment),
          started: parseStarted(body.started),
          time_spent_seconds: seconds,
        });
        touchIssue(r.js, issue.id);
        return r.c.json(formatWorklog(r, worklog), 201);
      },
      { scopes: WRITE },
    ),
  );

  app.get(
    `${API_V}/issue/:key/worklog/:id`,
    handle((r) => r.c.json(formatWorklog(r, requireWorklog(r, requireIssue(r.js, r.c.req.param("key"))))), {
      scopes: READ,
    }),
  );

  app.put(
    `${API_V}/issue/:key/worklog/:id`,
    handle(
      async (r) => {
        const worklog = requireWorklog(r, requireIssue(r.js, r.c.req.param("key")));
        const body = await readJson(r.c);
        const seconds = timeSpentSeconds(body);
        const updated = r.js.worklogs.update(worklog.id, {
          ...(seconds ? { time_spent_seconds: seconds } : {}),
          ...(body.comment !== undefined ? { comment: readBody(r, "comment", body.comment) } : {}),
          ...(body.started !== undefined ? { started: parseStarted(body.started) } : {}),
          update_author_id: r.user.account_id,
        })!;
        touchIssue(r.js, worklog.issue_id);
        return r.c.json(formatWorklog(r, updated));
      },
      { scopes: WRITE },
    ),
  );

  app.delete(
    `${API_V}/issue/:key/worklog/:id`,
    handle(
      (r) => {
        const worklog = requireWorklog(r, requireIssue(r.js, r.c.req.param("key")));
        r.js.worklogs.delete(worklog.id);
        touchIssue(r.js, worklog.issue_id);
        return r.c.body(null, 204);
      },
      { scopes: WRITE },
    ),
  );

  // Issue links

  app.post(
    `${API_V}/issueLink`,
    handle(
      async (r) => {
        const body = await readJson(r.c);
        const type = findLinkType(r.js, body.type);
        if (!type) throw new JiraError(404, ["No issue link type with name or id specified found."]);
        const inward = findIssue(r.js, body.inwardIssue?.key ?? body.inwardIssue?.id);
        const outward = findIssue(r.js, body.outwardIssue?.key ?? body.outwardIssue?.id);
        if (!inward || !outward)
          throw new JiraError(404, ["Issue does not exist or you do not have permission to see it."]);
        createLink(r.js, type.id, inward.id, outward.id);
        if (body.comment?.body !== undefined) {
          // Jira adds the link comment to the "from" issue, which is the outward side.
          const comment = addComment(r, outward, readCommentBody(r, body.comment.body));
          await emitCommentEvent(r, "comment_created", outward, comment);
        }
        return r.c.body(null, 201);
      },
      { scopes: WRITE },
    ),
  );

  const requireLink = (r: JiraRequest) => {
    const link = r.js.issueLinks.get(Number(r.c.req.param("id")));
    if (!link) throw new JiraError(404, [`No issue link with id '${r.c.req.param("id")}' exists.`]);
    return link;
  };

  app.get(
    `${API_V}/issueLink/:id`,
    handle(
      (r) => {
        const link = requireLink(r);
        const type = r.js.issueLinkTypes.get(link.type_id)!;
        return r.c.json({
          id: String(link.id),
          self: restUrl(r, `/issueLink/${link.id}`),
          type: {
            id: String(type.id),
            name: type.name,
            inward: type.inward,
            outward: type.outward,
            self: restUrl(r, `/issueLinkType/${type.id}`),
          },
          inwardIssue: formatIssueRef(r, r.js.issues.get(link.inward_issue_id)!),
          outwardIssue: formatIssueRef(r, r.js.issues.get(link.outward_issue_id)!),
        });
      },
      { scopes: READ },
    ),
  );

  app.delete(
    `${API_V}/issueLink/:id`,
    handle(
      (r) => {
        const link = requireLink(r);
        r.js.issueLinks.delete(link.id);
        return r.c.body(null, 204);
      },
      { scopes: WRITE },
    ),
  );
}

function readCommentBody(r: JiraRequest, value: unknown) {
  if (r.version === "3" && typeof value === "string") throw new JiraError(400, ["INVALID_INPUT"]);
  const doc = readBody(r, "comment", value);
  if (!doc) throw fieldError("comment", "Comment body can not be empty!");
  return doc;
}

function parseStarted(value: unknown): string {
  if (typeof value !== "string") return new Date().toISOString();
  const normalized = value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) throw fieldError("started", "Invalid started date.");
  return date.toISOString();
}
