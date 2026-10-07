import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_DEV_API_TOKEN, DEFAULT_DEV_EMAIL, getJiraStore } from "../index.js";
import { adf, api, basicAuth, createJiraTestApp, type JiraTestApp } from "./helpers.js";

describe("Jira issue sub-resources", () => {
  let t: JiraTestApp;

  beforeEach(() => {
    t = createJiraTestApp();
  });

  describe("comments", () => {
    it("adds, lists, reads, updates, and deletes comments", async () => {
      const created = await api(t.app, "/rest/api/3/issue/EMU-1/comment", {
        method: "POST",
        body: { body: adf("First!") },
      });
      expect(created.status).toBe(201);
      expect(created.json.body).toEqual(adf("First!"));
      expect(created.json.author.emailAddress).toBe("admin@jira.local");
      const id = created.json.id;

      const list = await api(t.app, "/rest/api/3/issue/EMU-1/comment?orderBy=-created");
      expect(list.status).toBe(200);
      expect(list.json.total).toBe(2);
      expect(list.json.comments[0].id).toBe(id);

      const paged = await api(t.app, "/rest/api/3/issue/EMU-1/comment?startAt=1&maxResults=1");
      expect(paged.json.comments).toHaveLength(1);
      expect(paged.json.startAt).toBe(1);

      const one = await api(t.app, `/rest/api/3/issue/EMU-1/comment/${id}`);
      expect(one.json.id).toBe(id);

      const updated = await api(t.app, `/rest/api/3/issue/EMU-1/comment/${id}`, {
        method: "PUT",
        body: { body: adf("Edited") },
      });
      expect(updated.status).toBe(200);
      expect(updated.json.body).toEqual(adf("Edited"));

      const deleted = await api(t.app, `/rest/api/3/issue/EMU-1/comment/${id}`, { method: "DELETE" });
      expect(deleted.status).toBe(204);
      expect((await api(t.app, `/rest/api/3/issue/EMU-1/comment/${id}`)).status).toBe(404);
    });

    it("requires ADF comment bodies in v3 and accepts strings in v2", async () => {
      const bad = await api(t.app, "/rest/api/3/issue/EMU-1/comment", { method: "POST", body: { body: "plain" } });
      expect(bad.status).toBe(400);

      const ok = await api(t.app, "/rest/api/2/issue/EMU-1/comment", { method: "POST", body: { body: "plain" } });
      expect(ok.status).toBe(201);
      expect(ok.json.body).toBe("plain");
    });

    it("only lets authors or admins edit comments", async () => {
      const created = await api(t.app, "/rest/api/3/issue/EMU-1/comment", {
        method: "POST",
        body: { body: adf("Admin comment") },
      });
      const res = await api(t.app, `/rest/api/3/issue/EMU-1/comment/${created.json.id}`, {
        method: "PUT",
        auth: basicAuth(DEFAULT_DEV_EMAIL, DEFAULT_DEV_API_TOKEN),
        body: { body: adf("Hijack") },
      });
      expect(res.status).toBe(403);
    });

    it("fetches comments across issues by id list", async () => {
      const a = await api(t.app, "/rest/api/3/issue/EMU-1/comment", { method: "POST", body: { body: adf("a") } });
      const res = await api(t.app, "/rest/api/3/comment/list", { method: "POST", body: { ids: [Number(a.json.id)] } });
      expect(res.status).toBe(200);
      expect(res.json.values.map((c: any) => c.id)).toEqual([a.json.id]);
    });
  });

  describe("watchers", () => {
    it("adds and removes watchers", async () => {
      const dev = getJiraStore(t.store).users.findOneBy("email", DEFAULT_DEV_EMAIL)!;
      const initial = await api(t.app, "/rest/api/3/issue/EMU-1/watchers");
      expect(initial.status).toBe(200);
      expect(initial.json.watchCount).toBe(1);
      expect(initial.json.isWatching).toBe(true);

      const add = await api(t.app, "/rest/api/3/issue/EMU-1/watchers", {
        method: "POST",
        body: JSON.stringify(dev.account_id),
      });
      expect(add.status).toBe(204);
      const after = await api(t.app, "/rest/api/3/issue/EMU-1/watchers");
      expect(after.json.watchers.map((w: any) => w.accountId)).toContain(dev.account_id);

      const remove = await api(t.app, `/rest/api/3/issue/EMU-1/watchers?accountId=${dev.account_id}`, {
        method: "DELETE",
      });
      expect(remove.status).toBe(204);
      expect((await api(t.app, "/rest/api/3/issue/EMU-1/watchers")).json.watchCount).toBe(1);
    });

    it("adds the current user when the body is empty", async () => {
      const devAuth = basicAuth(DEFAULT_DEV_EMAIL, DEFAULT_DEV_API_TOKEN);
      const res = await api(t.app, "/rest/api/3/issue/EMU-1/watchers", { method: "POST", auth: devAuth });
      expect(res.status).toBe(204);
      const watchers = await api(t.app, "/rest/api/3/issue/EMU-1/watchers", { auth: devAuth });
      expect(watchers.json.isWatching).toBe(true);
    });
  });

  describe("worklogs", () => {
    it("logs work, parses durations, and totals time spent", async () => {
      const created = await api(t.app, "/rest/api/3/issue/EMU-1/worklog", {
        method: "POST",
        body: { timeSpent: "1h 30m", started: "2026-09-30T09:00:00.000+0000", comment: adf("Pairing") },
      });
      expect(created.status).toBe(201);
      expect(created.json.timeSpentSeconds).toBe(5400);
      expect(created.json.timeSpent).toBe("1h 30m");

      await api(t.app, "/rest/api/3/issue/EMU-1/worklog", { method: "POST", body: { timeSpentSeconds: 1800 } });

      const list = await api(t.app, "/rest/api/3/issue/EMU-1/worklog");
      expect(list.json.total).toBe(2);

      const issue = await api(t.app, "/rest/api/3/issue/EMU-1");
      expect(issue.json.fields.timespent).toBe(7200);

      const updated = await api(t.app, `/rest/api/3/issue/EMU-1/worklog/${created.json.id}`, {
        method: "PUT",
        body: { timeSpent: "2h" },
      });
      expect(updated.json.timeSpentSeconds).toBe(7200);

      const deleted = await api(t.app, `/rest/api/3/issue/EMU-1/worklog/${created.json.id}`, { method: "DELETE" });
      expect(deleted.status).toBe(204);
    });

    it("rejects worklogs without a valid duration", async () => {
      const res = await api(t.app, "/rest/api/3/issue/EMU-1/worklog", { method: "POST", body: { timeSpent: "soon" } });
      expect(res.status).toBe(400);
      expect(res.json.errors.timeLogged).toBeTruthy();
    });
  });

  describe("issue links", () => {
    it("links issues and shows the link on both sides", async () => {
      const other = await api(t.app, "/rest/api/3/issue", {
        method: "POST",
        body: { fields: { project: { key: "EMU" }, issuetype: { name: "Bug" }, summary: "Blocker" } },
      });
      const link = await api(t.app, "/rest/api/3/issueLink", {
        method: "POST",
        body: { type: { name: "Blocks" }, inwardIssue: { key: "EMU-1" }, outwardIssue: { key: other.json.key } },
      });
      expect(link.status).toBe(201);

      // outwardIssue is the source: the blocker blocks EMU-1, so EMU-1 "is blocked by" it.
      const inward = (await api(t.app, "/rest/api/3/issue/EMU-1")).json.fields.issuelinks;
      expect(inward).toHaveLength(1);
      expect(inward[0].type.name).toBe("Blocks");
      expect(inward[0].inwardIssue.key).toBe(other.json.key);

      const outward = (await api(t.app, `/rest/api/3/issue/${other.json.key}`)).json.fields.issuelinks;
      expect(outward[0].outwardIssue.key).toBe("EMU-1");

      const fetched = await api(t.app, `/rest/api/3/issueLink/${inward[0].id}`);
      expect(fetched.json.inwardIssue.key).toBe("EMU-1");
      expect(fetched.json.outwardIssue.key).toBe(other.json.key);

      const deleted = await api(t.app, `/rest/api/3/issueLink/${inward[0].id}`, { method: "DELETE" });
      expect(deleted.status).toBe(204);
      expect((await api(t.app, "/rest/api/3/issue/EMU-1")).json.fields.issuelinks).toHaveLength(0);
    });

    it("adds the optional link comment to the outward (from) issue", async () => {
      const other = await api(t.app, "/rest/api/3/issue", {
        method: "POST",
        body: { fields: { project: { key: "EMU" }, issuetype: { name: "Bug" }, summary: "Source" } },
      });
      await api(t.app, "/rest/api/3/issueLink", {
        method: "POST",
        body: {
          type: { name: "Blocks" },
          inwardIssue: { key: "EMU-1" },
          outwardIssue: { key: other.json.key },
          comment: { body: adf("Linking these") },
        },
      });
      expect((await api(t.app, `/rest/api/3/issue/${other.json.key}/comment`)).json.total).toBe(1);
      expect((await api(t.app, "/rest/api/3/issue/EMU-1/comment")).json.total).toBe(1);
    });

    it("keeps JQL linkedIssues consistent with the issue view", async () => {
      const other = await api(t.app, "/rest/api/3/issue", {
        method: "POST",
        body: { fields: { project: { key: "EMU" }, issuetype: { name: "Bug" }, summary: "Blocker" } },
      });
      await api(t.app, "/rest/api/3/issue/EMU-1", {
        method: "PUT",
        body: {
          update: { issuelinks: [{ add: { type: { name: "Blocks" }, outwardIssue: { key: other.json.key } } }] },
        },
      });
      // EMU-1 now shows the other issue as outwardIssue, which reads "EMU-1 blocks <other>".
      const search = async (jql: string) =>
        (await api(t.app, "/rest/api/3/search/jql", { method: "POST", body: { jql } })).json.issues.map(
          (i: any) => i.key,
        );
      expect(await search('issue in linkedIssues(EMU-1, "blocks")')).toEqual([other.json.key]);
      expect(await search('issue in linkedIssues(EMU-1, "is blocked by")')).toEqual([]);
      expect(await search(`issue in linkedIssues(${other.json.key}, "is blocked by")`)).toEqual(["EMU-1"]);
    });

    it("validates link type and issues", async () => {
      const badType = await api(t.app, "/rest/api/3/issueLink", {
        method: "POST",
        body: { type: { name: "Nope" }, inwardIssue: { key: "EMU-1" }, outwardIssue: { key: "EMU-1" } },
      });
      expect(badType.status).toBe(404);
      const badIssue = await api(t.app, "/rest/api/3/issueLink", {
        method: "POST",
        body: { type: { name: "Blocks" }, inwardIssue: { key: "EMU-1" }, outwardIssue: { key: "EMU-404" } },
      });
      expect(badIssue.status).toBe(404);
    });

    it("links issues through the update operation on edit", async () => {
      const other = await api(t.app, "/rest/api/3/issue", {
        method: "POST",
        body: { fields: { project: { key: "EMU" }, issuetype: { name: "Task" }, summary: "Related" } },
      });
      const res = await api(t.app, "/rest/api/3/issue/EMU-1", {
        method: "PUT",
        body: {
          update: { issuelinks: [{ add: { type: { name: "Relates" }, outwardIssue: { key: other.json.key } } }] },
        },
      });
      expect(res.status).toBe(204);
      const links = (await api(t.app, "/rest/api/3/issue/EMU-1")).json.fields.issuelinks;
      expect(links[0].outwardIssue.key).toBe(other.json.key);
    });
  });
});
