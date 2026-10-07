import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_DEV_EMAIL, getJiraStore } from "../index.js";
import { adf, api, createJiraTestApp, jiraTestBaseUrl, type JiraTestApp } from "./helpers.js";

async function createIssue(t: JiraTestApp, fields: Record<string, unknown>, version = "3") {
  return api(t.app, `/rest/api/${version}/issue`, {
    method: "POST",
    body: { fields: { project: { key: "EMU" }, issuetype: { name: "Task" }, ...fields } },
  });
}

describe("Jira issues", () => {
  let t: JiraTestApp;
  let devId: string;

  beforeEach(() => {
    t = createJiraTestApp();
    devId = getJiraStore(t.store).users.findOneBy("email", DEFAULT_DEV_EMAIL)!.account_id;
  });

  describe("reading", () => {
    it("finds issues and projects by key in any case", async () => {
      expect((await api(t.app, "/rest/api/3/issue/emu-1")).json.key).toBe("EMU-1");
      expect((await api(t.app, "/rest/api/3/project/emu")).json.key).toBe("EMU");
    });

    it("returns only the requested fields", async () => {
      const res = await api(t.app, "/rest/api/3/issue/EMU-1?fields=summary,status");
      expect(Object.keys(res.json.fields).sort()).toEqual(["status", "summary"]);
      const excluded = await api(t.app, "/rest/api/3/issue/EMU-1?fields=*all,-comment");
      expect(excluded.json.fields.comment).toBeUndefined();
      expect(excluded.json.fields.summary).toBe("Ship Jira emulator");
    });

    it("returns the seeded issue with Jira shaped fields", async () => {
      const res = await api(t.app, "/rest/api/3/issue/EMU-1");
      expect(res.status).toBe(200);
      expect(res.json.key).toBe("EMU-1");
      expect(res.json.id).toBe("10000");
      expect(res.json.self).toBe(`${jiraTestBaseUrl}/rest/api/3/issue/10000`);
      const f = res.json.fields;
      expect(f.summary).toBe("Ship Jira emulator");
      expect(f.status.name).toBe("To Do");
      expect(f.status.statusCategory.key).toBe("new");
      expect(f.issuetype.name).toBe("Task");
      expect(f.project.key).toBe("EMU");
      expect(f.priority.name).toBe("Medium");
      expect(f.assignee.emailAddress).toBe(DEFAULT_DEV_EMAIL);
      expect(f.reporter.emailAddress).toBe("admin@jira.local");
      expect(f.description.type).toBe("doc");
      expect(f.created).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+0000$/);
      expect(f.comment.total).toBe(1);
      expect(f.resolution).toBeNull();
      expect(f.labels).toEqual(["emulate"]);
      expect(f.watches.watchCount).toBe(1);
    });

    it("reads the same issue by numeric id", async () => {
      const res = await api(t.app, "/rest/api/3/issue/10000");
      expect(res.json.key).toBe("EMU-1");
    });

    it("renders descriptions as plain strings in REST API v2", async () => {
      const res = await api(t.app, "/rest/api/2/issue/EMU-1");
      expect(typeof res.json.fields.description).toBe("string");
      expect(res.json.fields.description).toContain("local Jira state");
      expect(typeof res.json.fields.comment.comments[0].body).toBe("string");
    });

    it("returns 404 for unknown issues", async () => {
      const res = await api(t.app, "/rest/api/3/issue/EMU-999");
      expect(res.status).toBe(404);
      expect(res.json.errorMessages).toEqual(["Issue does not exist or you do not have permission to see it."]);
    });

    it("limits returned fields and supports expand", async () => {
      const res = await api(
        t.app,
        "/rest/api/3/issue/EMU-1?fields=summary,status&expand=renderedFields,names,transitions",
      );
      expect(Object.keys(res.json.fields).sort()).toEqual(["status", "summary"]);
      expect(res.json.names.summary).toBe("Summary");
      expect(res.json.renderedFields.description).toContain("<p>");
      expect(res.json.transitions.map((tr: any) => tr.name)).toContain("In Progress");

      const excluded = await api(t.app, "/rest/api/3/issue/EMU-1?fields=*all,-comment");
      expect(excluded.json.fields.comment).toBeUndefined();
      expect(excluded.json.fields.summary).toBeDefined();
    });
  });

  describe("creating", () => {
    it("creates an issue with ADF description and returns id, key, and self", async () => {
      const res = await createIssue(t, {
        summary: "New task",
        description: adf("Hello ADF"),
        assignee: { accountId: devId },
        labels: ["backend", "urgent"],
        priority: { name: "High" },
        duedate: "2026-12-01",
        customfield_10016: 5,
      });
      expect(res.status).toBe(201);
      expect(res.json).toEqual({ id: "10001", key: "EMU-2", self: `${jiraTestBaseUrl}/rest/api/3/issue/10001` });

      const issue = (await api(t.app, "/rest/api/3/issue/EMU-2")).json;
      expect(issue.fields.description).toEqual(adf("Hello ADF"));
      expect(issue.fields.assignee.accountId).toBe(devId);
      expect(issue.fields.reporter.emailAddress).toBe("admin@jira.local");
      expect(issue.fields.creator.emailAddress).toBe("admin@jira.local");
      expect(issue.fields.labels).toEqual(["backend", "urgent"]);
      expect(issue.fields.priority.name).toBe("High");
      expect(issue.fields.duedate).toBe("2026-12-01");
      expect(issue.fields.customfield_10016).toBe(5);
      expect(issue.fields.status.name).toBe("To Do");
    });

    it("rejects plain string descriptions in v3 but accepts them in v2", async () => {
      const v3 = await createIssue(t, { summary: "S", description: "plain" });
      expect(v3.status).toBe(400);
      expect(v3.json.errors.description).toBe(
        "Operation value must be an Atlassian Document (see the Atlassian Document Format)",
      );

      const v2 = await createIssue(t, { summary: "S", description: "line one\nline two" }, "2");
      expect(v2.status).toBe(201);
      expect(v2.json.self).toContain("/rest/api/2/issue/");
      const read = await api(t.app, `/rest/api/3/issue/${v2.json.key}`);
      expect(read.json.fields.description.type).toBe("doc");
      const readV2 = await api(t.app, `/rest/api/2/issue/${v2.json.key}`);
      expect(readV2.json.fields.description).toBe("line one\nline two");
    });

    it("validates required fields and references", async () => {
      const noSummary = await createIssue(t, {});
      expect(noSummary.status).toBe(400);
      expect(noSummary.json.errors.summary).toBe("You must specify a summary of the issue.");

      const noProject = await api(t.app, "/rest/api/3/issue", {
        method: "POST",
        body: { fields: { summary: "x", issuetype: { name: "Task" } } },
      });
      expect(noProject.json.errors.project).toBe("Specify a valid project ID or key");

      const badType = await createIssue(t, { summary: "x", issuetype: { id: "99999" } });
      expect(badType.json.errors.issuetype).toBe("Specify a valid issue type");

      const badUser = await createIssue(t, { summary: "x", assignee: { accountId: "ghost" } });
      expect(badUser.status).toBe(400);
      expect(badUser.json.errors.assignee).toBeTruthy();

      const unknownField = await createIssue(t, { summary: "x", customfield_99999: "nope" });
      expect(unknownField.json.errors.customfield_99999).toBe(
        "Field 'customfield_99999' cannot be set. It is not on the appropriate screen, or unknown.",
      );

      const tooLong = await createIssue(t, { summary: "x".repeat(256) });
      expect(tooLong.json.errors.summary).toBe("Summary must be less than 255 characters.");

      const badJson = await api(t.app, "/rest/api/3/issue", { method: "POST", body: "{not json" });
      expect(badJson.status).toBe(400);
    });

    it("requires a parent for subtasks and links parents and children", async () => {
      const orphan = await createIssue(t, { summary: "Sub", issuetype: { name: "Subtask" } });
      expect(orphan.status).toBe(400);
      expect(orphan.json.errors.parent).toBeTruthy();

      const sub = await createIssue(t, { summary: "Sub", issuetype: { name: "Subtask" }, parent: { key: "EMU-1" } });
      expect(sub.status).toBe(201);
      const child = (await api(t.app, `/rest/api/3/issue/${sub.json.key}`)).json;
      expect(child.fields.parent.key).toBe("EMU-1");
      expect(child.fields.parent.fields.summary).toBe("Ship Jira emulator");
      const parent = (await api(t.app, "/rest/api/3/issue/EMU-1")).json;
      expect(parent.fields.subtasks.map((s: any) => s.key)).toEqual([sub.json.key]);
    });

    it("sets components and fix versions by name", async () => {
      await api(t.app, "/rest/api/3/component", { method: "POST", body: { project: "EMU", name: "API" } });
      await api(t.app, "/rest/api/3/version", { method: "POST", body: { project: "EMU", name: "1.0" } });
      const res = await createIssue(t, { summary: "x", components: [{ name: "API" }], fixVersions: [{ name: "1.0" }] });
      expect(res.status).toBe(201);
      const issue = (await api(t.app, `/rest/api/3/issue/${res.json.key}`)).json;
      expect(issue.fields.components[0].name).toBe("API");
      expect(issue.fields.fixVersions[0].name).toBe("1.0");

      const bad = await createIssue(t, { summary: "x", components: [{ name: "Nope" }] });
      expect(bad.status).toBe(400);
      expect(bad.json.errors.components).toBeTruthy();
    });

    it("creates issues in bulk and reports per-issue errors", async () => {
      const res = await api(t.app, "/rest/api/3/issue/bulk", {
        method: "POST",
        body: {
          issueUpdates: [
            { fields: { project: { key: "EMU" }, issuetype: { name: "Bug" }, summary: "Bulk one" } },
            { fields: { project: { key: "EMU" }, issuetype: { name: "Bug" } } },
            { fields: { project: { key: "EMU" }, issuetype: { name: "Story" }, summary: "Bulk two" } },
          ],
        },
      });
      expect(res.status).toBe(201);
      expect(res.json.issues.map((i: any) => i.key)).toEqual(["EMU-2", "EMU-3"]);
      expect(res.json.errors).toHaveLength(1);
      expect(res.json.errors[0].failedElementNumber).toBe(1);
      expect(res.json.errors[0].elementErrors.errors.summary).toBeTruthy();
    });
  });

  describe("editing", () => {
    it("edits fields, records changelog history, and returns 204", async () => {
      const res = await api(t.app, "/rest/api/3/issue/EMU-1", {
        method: "PUT",
        body: {
          fields: { summary: "Renamed", priority: { name: "Highest" } },
          update: { labels: [{ add: "triage" }, { remove: "emulate" }] },
        },
      });
      expect(res.status).toBe(204);

      const issue = (await api(t.app, "/rest/api/3/issue/EMU-1?expand=changelog")).json;
      expect(issue.fields.summary).toBe("Renamed");
      expect(issue.fields.priority.name).toBe("Highest");
      expect(issue.fields.labels).toEqual(["triage"]);
      const items = issue.changelog.histories.flatMap((h: any) => h.items);
      expect(items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: "summary", fromString: "Ship Jira emulator", toString: "Renamed" }),
          expect.objectContaining({ field: "priority", fromString: "Medium", toString: "Highest" }),
          expect.objectContaining({ field: "labels", fromString: "emulate", toString: "triage" }),
        ]),
      );

      const changelog = await api(t.app, "/rest/api/3/issue/EMU-1/changelog");
      expect(changelog.json.total).toBe(1);
      expect(changelog.json.values[0].author.emailAddress).toBe("admin@jira.local");
    });

    it("supports update set operations and returnIssue", async () => {
      const res = await api(t.app, "/rest/api/3/issue/EMU-1?returnIssue=true", {
        method: "PUT",
        body: { update: { summary: [{ set: "Via update" }], labels: [{ set: ["a", "b"] }] } },
      });
      expect(res.status).toBe(200);
      expect(res.json.fields.summary).toBe("Via update");
      expect(res.json.fields.labels).toEqual(["a", "b"]);
    });

    it("refuses to set status through edit", async () => {
      const res = await api(t.app, "/rest/api/3/issue/EMU-1", {
        method: "PUT",
        body: { fields: { status: { name: "Done" } } },
      });
      expect(res.status).toBe(400);
      expect(res.json.errors.status).toBe(
        "Field 'status' cannot be set. It is not on the appropriate screen, or unknown.",
      );
    });

    it("assigns and unassigns through the assignee endpoint", async () => {
      const admin = (await api(t.app, "/rest/api/3/myself")).json;
      const assign = await api(t.app, "/rest/api/3/issue/EMU-1/assignee", {
        method: "PUT",
        body: { accountId: admin.accountId },
      });
      expect(assign.status).toBe(204);
      expect((await api(t.app, "/rest/api/3/issue/EMU-1")).json.fields.assignee.accountId).toBe(admin.accountId);

      const unassign = await api(t.app, "/rest/api/3/issue/EMU-1/assignee", {
        method: "PUT",
        body: { accountId: null },
      });
      expect(unassign.status).toBe(204);
      expect((await api(t.app, "/rest/api/3/issue/EMU-1")).json.fields.assignee).toBeNull();
    });

    it("moves an issue to a new parent", async () => {
      const epic = await createIssue(t, { summary: "Epic", issuetype: { name: "Epic" } });
      const res = await api(t.app, "/rest/api/3/issue/EMU-1", {
        method: "PUT",
        body: { fields: { parent: { key: epic.json.key } } },
      });
      expect(res.status).toBe(204);
      expect((await api(t.app, "/rest/api/3/issue/EMU-1")).json.fields.parent.key).toBe(epic.json.key);
    });
  });

  describe("deleting", () => {
    it("deletes issues and requires deleteSubtasks for parents", async () => {
      const sub = await createIssue(t, { summary: "Sub", issuetype: { name: "Subtask" }, parent: { key: "EMU-1" } });
      const blocked = await api(t.app, "/rest/api/3/issue/EMU-1", { method: "DELETE" });
      expect(blocked.status).toBe(400);

      const ok = await api(t.app, "/rest/api/3/issue/EMU-1?deleteSubtasks=true", { method: "DELETE" });
      expect(ok.status).toBe(204);
      expect((await api(t.app, "/rest/api/3/issue/EMU-1")).status).toBe(404);
      expect((await api(t.app, `/rest/api/3/issue/${sub.json.key}`)).status).toBe(404);
    });

    it("never reuses issue keys after deletion", async () => {
      const created = await createIssue(t, { summary: "Temp" });
      await api(t.app, `/rest/api/3/issue/${created.json.key}`, { method: "DELETE" });
      const next = await createIssue(t, { summary: "Next" });
      expect(next.json.key).not.toBe(created.json.key);
      expect(next.json.id).not.toBe(created.json.id);
    });
  });

  describe("transitions", () => {
    it("lists available transitions and moves the issue through the workflow", async () => {
      const list = await api(t.app, "/rest/api/3/issue/EMU-1/transitions");
      expect(list.status).toBe(200);
      const names = list.json.transitions.map((tr: any) => tr.name);
      expect(names).toEqual(["In Progress", "Done"]);
      const done = list.json.transitions.find((tr: any) => tr.name === "Done");
      expect(done.to.statusCategory.key).toBe("done");

      const move = await api(t.app, "/rest/api/3/issue/EMU-1/transitions", {
        method: "POST",
        body: { transition: { id: done.id } },
      });
      expect(move.status).toBe(204);

      const issue = (await api(t.app, "/rest/api/3/issue/EMU-1?expand=changelog")).json;
      expect(issue.fields.status.name).toBe("Done");
      expect(issue.fields.resolution.name).toBe("Done");
      expect(issue.fields.resolutiondate).toBeTruthy();
      const statusItem = issue.changelog.histories.flatMap((h: any) => h.items).find((i: any) => i.field === "status");
      expect(statusItem).toMatchObject({ fromString: "To Do", toString: "Done" });

      const reopen = (await api(t.app, "/rest/api/3/issue/EMU-1/transitions")).json.transitions.find(
        (tr: any) => tr.name === "To Do",
      );
      await api(t.app, "/rest/api/3/issue/EMU-1/transitions", {
        method: "POST",
        body: { transition: { id: reopen.id } },
      });
      const reopened = (await api(t.app, "/rest/api/3/issue/EMU-1")).json;
      expect(reopened.fields.resolution).toBeNull();
      expect(reopened.fields.resolutiondate).toBeNull();
    });

    it("applies fields and an update comment during a transition", async () => {
      const done = (await api(t.app, "/rest/api/3/issue/EMU-1/transitions")).json.transitions.find(
        (tr: any) => tr.name === "Done",
      );
      const res = await api(t.app, "/rest/api/3/issue/EMU-1/transitions", {
        method: "POST",
        body: {
          transition: { id: done.id },
          fields: { resolution: { name: "Won't Do" } },
          update: { comment: [{ add: { body: adf("Closing") } }] },
        },
      });
      expect(res.status).toBe(204);
      const issue = (await api(t.app, "/rest/api/3/issue/EMU-1")).json;
      expect(issue.fields.resolution.name).toBe("Won't Do");
      expect(issue.fields.comment.total).toBe(2);
    });

    it("rejects unknown transitions", async () => {
      const res = await api(t.app, "/rest/api/3/issue/EMU-1/transitions", {
        method: "POST",
        body: { transition: { id: "999" } },
      });
      expect(res.status).toBe(400);
      expect(res.json.errorMessages).toEqual(["Transition id '999' is not valid for this issue."]);
    });
  });

  describe("metadata", () => {
    it("serves create metadata for project issue types and fields", async () => {
      const types = await api(t.app, "/rest/api/3/issue/createmeta/EMU/issuetypes");
      expect(types.status).toBe(200);
      const task = types.json.issueTypes.find((type: any) => type.name === "Task");
      expect(task).toBeTruthy();

      const fields = await api(t.app, `/rest/api/3/issue/createmeta/EMU/issuetypes/${task.id}`);
      expect(fields.status).toBe(200);
      const summary = fields.json.fields.find((f: any) => f.fieldId === "summary");
      expect(summary.required).toBe(true);
      const priority = fields.json.fields.find((f: any) => f.fieldId === "priority");
      expect(priority.allowedValues.map((p: any) => p.name)).toContain("High");
    });

    it("serves edit metadata keyed by field id", async () => {
      const res = await api(t.app, "/rest/api/3/issue/EMU-1/editmeta");
      expect(res.status).toBe(200);
      expect(res.json.fields.summary.name).toBe("Summary");
      expect(res.json.fields.labels.operations).toContain("add");
    });
  });
});
