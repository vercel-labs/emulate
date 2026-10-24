import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_DEV_API_TOKEN, DEFAULT_DEV_EMAIL, getJiraStore } from "../index.js";
import { api, basicAuth, createJiraTestApp, jiraTestBaseUrl, type JiraTestApp } from "./helpers.js";

describe("Jira metadata", () => {
  let t: JiraTestApp;

  beforeEach(() => {
    t = createJiraTestApp();
  });

  describe("users", () => {
    it("looks up a user by accountId and 404s for unknown ids", async () => {
      const dev = getJiraStore(t.store).users.findOneBy("email", DEFAULT_DEV_EMAIL)!;
      const res = await api(t.app, `/rest/api/3/user?accountId=${dev.account_id}`);
      expect(res.status).toBe(200);
      expect(res.json.displayName).toBe("Developer");

      const missing = await api(t.app, "/rest/api/3/user?accountId=nope");
      expect(missing.status).toBe(404);
      expect(missing.json.errorMessages[0]).toContain("nope");
    });

    it("searches users by query across name and email", async () => {
      const res = await api(t.app, "/rest/api/3/user/search?query=dev");
      expect(res.status).toBe(200);
      expect(res.json.map((u: any) => u.emailAddress)).toEqual([DEFAULT_DEV_EMAIL]);

      const all = await api(t.app, "/rest/api/3/users/search");
      expect(all.json.length).toBe(2);
    });

    it("lists assignable users for a project", async () => {
      const res = await api(t.app, "/rest/api/3/user/assignable/search?project=EMU&query=admin");
      expect(res.status).toBe(200);
      expect(res.json).toHaveLength(1);
      expect(res.json[0].emailAddress).toBe("admin@jira.local");
    });

    it("returns bulk users as a paginated page", async () => {
      const users = getJiraStore(t.store).users.all();
      const res = await api(
        t.app,
        `/rest/api/3/user/bulk?accountId=${users[0].account_id}&accountId=${users[1].account_id}`,
      );
      expect(res.status).toBe(200);
      expect(res.json.total).toBe(2);
      expect(res.json.values).toHaveLength(2);
      expect(res.json.isLast).toBe(true);
    });
  });

  describe("projects", () => {
    it("lists projects as an array and as a paginated search", async () => {
      const list = await api(t.app, "/rest/api/3/project");
      expect(list.status).toBe(200);
      expect(list.json[0].key).toBe("EMU");
      expect(list.json[0].id).toBe("10000");

      const search = await api(t.app, "/rest/api/3/project/search?query=emu");
      expect(search.status).toBe(200);
      expect(search.json.total).toBe(1);
      expect(search.json.values[0].key).toBe("EMU");
      expect(search.json.isLast).toBe(true);
    });

    it("gets a project by key or id with issue types and lead", async () => {
      const byKey = await api(t.app, "/rest/api/3/project/EMU");
      expect(byKey.status).toBe(200);
      expect(byKey.json.self).toBe(`${jiraTestBaseUrl}/rest/api/3/project/10000`);
      expect(byKey.json.lead.emailAddress).toBe("admin@jira.local");
      expect(byKey.json.issueTypes.map((type: any) => type.name)).toContain("Bug");

      const byId = await api(t.app, "/rest/api/3/project/10000");
      expect(byId.json.key).toBe("EMU");

      const missing = await api(t.app, "/rest/api/3/project/NOPE");
      expect(missing.status).toBe(404);
      expect(missing.json.errorMessages).toEqual(["No project could be found with key 'NOPE'."]);
    });

    it("creates, updates, and deletes a project", async () => {
      const me = (await api(t.app, "/rest/api/3/myself")).json;
      const created = await api(t.app, "/rest/api/3/project", {
        method: "POST",
        body: { key: "OPS", name: "Operations", projectTypeKey: "software", leadAccountId: me.accountId },
      });
      expect(created.status).toBe(201);
      expect(created.json.key).toBe("OPS");
      expect(created.json.self).toBe(`${jiraTestBaseUrl}/rest/api/3/project/${created.json.id}`);

      const duplicate = await api(t.app, "/rest/api/3/project", {
        method: "POST",
        body: { key: "OPS", name: "Other", projectTypeKey: "software", leadAccountId: me.accountId },
      });
      expect(duplicate.status).toBe(400);
      expect(duplicate.json.errors.projectKey).toContain("already exists");

      const badKey = await api(t.app, "/rest/api/3/project", {
        method: "POST",
        body: { key: "lower", name: "Lower", projectTypeKey: "software", leadAccountId: me.accountId },
      });
      expect(badKey.status).toBe(400);
      expect(badKey.json.errors.projectKey).toBeTruthy();

      const updated = await api(t.app, "/rest/api/3/project/OPS", {
        method: "PUT",
        body: { name: "Ops", description: "Runbooks" },
      });
      expect(updated.status).toBe(200);
      expect(updated.json.name).toBe("Ops");
      expect(updated.json.description).toBe("Runbooks");

      const deleted = await api(t.app, "/rest/api/3/project/OPS", { method: "DELETE" });
      expect(deleted.status).toBe(204);
      expect((await api(t.app, "/rest/api/3/project/OPS")).status).toBe(404);
    });

    it("forbids non-admins from creating projects", async () => {
      const res = await api(t.app, "/rest/api/3/project", {
        method: "POST",
        auth: basicAuth(DEFAULT_DEV_EMAIL, DEFAULT_DEV_API_TOKEN),
        body: { key: "DEV", name: "Dev", projectTypeKey: "software" },
      });
      expect(res.status).toBe(403);
    });

    it("lists project statuses grouped by issue type", async () => {
      const res = await api(t.app, "/rest/api/3/project/EMU/statuses");
      expect(res.status).toBe(200);
      const task = res.json.find((entry: any) => entry.name === "Task");
      expect(task.statuses.map((s: any) => s.name)).toEqual(["To Do", "In Progress", "Done"]);
    });

    it("manages project components and versions", async () => {
      const component = await api(t.app, "/rest/api/3/component", {
        method: "POST",
        body: { project: "EMU", name: "API", description: "Backend" },
      });
      expect(component.status).toBe(201);
      expect(component.json.name).toBe("API");
      const components = await api(t.app, "/rest/api/3/project/EMU/components");
      expect(components.json.map((c: any) => c.name)).toEqual(["API"]);

      const version = await api(t.app, "/rest/api/3/version", {
        method: "POST",
        body: { projectId: 10000, name: "1.0.0", releaseDate: "2026-10-01" },
      });
      expect(version.status).toBe(201);
      expect(version.json.released).toBe(false);
      const released = await api(t.app, `/rest/api/3/version/${version.json.id}`, {
        method: "PUT",
        body: { released: true },
      });
      expect(released.json.released).toBe(true);
      const versions = await api(t.app, "/rest/api/3/project/EMU/versions");
      expect(versions.json.map((v: any) => v.name)).toEqual(["1.0.0"]);
    });

    it("validates component and version changes", async () => {
      const dev = basicAuth(DEFAULT_DEV_EMAIL, DEFAULT_DEV_API_TOKEN);
      const denied = await api(t.app, "/rest/api/3/component", {
        method: "POST",
        body: { project: "EMU", name: "API" },
        auth: dev,
      });
      expect(denied.status).toBe(403);

      const api1 = await api(t.app, "/rest/api/3/component", { method: "POST", body: { project: "EMU", name: "API" } });
      await api(t.app, "/rest/api/3/component", { method: "POST", body: { project: "EMU", name: "Web" } });
      const clash = await api(t.app, `/rest/api/3/component/${api1.json.id}`, {
        method: "PUT",
        body: { name: "web" },
      });
      expect(clash.status).toBe(400);
      expect(clash.json.errors.name).toMatch(/already exists/);
      const deniedDelete = await api(t.app, `/rest/api/3/component/${api1.json.id}`, { method: "DELETE", auth: dev });
      expect(deniedDelete.status).toBe(403);

      const badDate = await api(t.app, "/rest/api/3/version", {
        method: "POST",
        body: { project: "EMU", name: "2.0.0", releaseDate: "next week" },
      });
      expect(badDate.status).toBe(400);
      expect(badDate.json.errors.releaseDate).toBeTruthy();
    });

    it("lets the project lead manage components", async () => {
      const store = getJiraStore(t.store);
      const dev = store.users.findOneBy("email", DEFAULT_DEV_EMAIL)!;
      const project = store.projects.findOneBy("key", "EMU")!;
      store.projects.update(project.id, { lead_account_id: dev.account_id });
      const created = await api(t.app, "/rest/api/3/component", {
        method: "POST",
        body: { project: "EMU", name: "API" },
        auth: basicAuth(DEFAULT_DEV_EMAIL, DEFAULT_DEV_API_TOKEN),
      });
      expect(created.status).toBe(201);
    });
  });

  describe("configuration", () => {
    it("lists issue types, including per project", async () => {
      const all = await api(t.app, "/rest/api/3/issuetype");
      expect(all.status).toBe(200);
      const subtask = all.json.find((type: any) => type.name === "Subtask");
      expect(subtask.subtask).toBe(true);
      expect(subtask.hierarchyLevel).toBe(-1);

      const one = await api(t.app, `/rest/api/3/issuetype/${subtask.id}`);
      expect(one.json.name).toBe("Subtask");

      const forProject = await api(t.app, "/rest/api/3/issuetype/project?projectId=10000");
      expect(forProject.json.length).toBe(5);
    });

    it("lists statuses, status categories, priorities, and resolutions", async () => {
      const statuses = await api(t.app, "/rest/api/3/status");
      expect(statuses.json.map((s: any) => s.statusCategory.key)).toEqual(["new", "indeterminate", "done"]);
      const byName = await api(t.app, "/rest/api/3/status/In%20Progress");
      expect(byName.json.name).toBe("In Progress");

      const categories = await api(t.app, "/rest/api/3/statuscategory");
      expect(categories.json.map((c: any) => c.key)).toContain("done");

      const priorities = await api(t.app, "/rest/api/3/priority");
      expect(priorities.json.map((p: any) => p.name)).toEqual(["Highest", "High", "Medium", "Low", "Lowest"]);
      const medium = await api(t.app, "/rest/api/3/priority/3");
      expect(medium.json.name).toBe("Medium");

      const resolutions = await api(t.app, "/rest/api/3/resolution");
      expect(resolutions.json.map((r: any) => r.name)).toContain("Done");
    });

    it("lists system and custom fields with clause names", async () => {
      const res = await api(t.app, "/rest/api/3/field");
      expect(res.status).toBe(200);
      const summary = res.json.find((f: any) => f.id === "summary");
      expect(summary.custom).toBe(false);
      expect(summary.clauseNames).toContain("summary");
      const sprint = res.json.find((f: any) => f.name === "Sprint");
      expect(sprint.id).toBe("customfield_10020");
      expect(sprint.custom).toBe(true);
      expect(sprint.clauseNames).toContain("cf[10020]");
    });

    it("lists issue link types", async () => {
      const res = await api(t.app, "/rest/api/3/issueLinkType");
      expect(res.json.issueLinkTypes.map((l: any) => l.name)).toEqual(["Blocks", "Cloners", "Duplicate", "Relates"]);
    });

    it("reports permissions for the current user", async () => {
      const res = await api(t.app, "/rest/api/3/mypermissions?permissions=BROWSE_PROJECTS,ADMINISTER");
      expect(res.status).toBe(200);
      expect(res.json.permissions.BROWSE_PROJECTS.havePermission).toBe(true);
      expect(res.json.permissions.ADMINISTER.havePermission).toBe(true);

      const dev = await api(t.app, "/rest/api/3/mypermissions?permissions=ADMINISTER", {
        auth: basicAuth(DEFAULT_DEV_EMAIL, DEFAULT_DEV_API_TOKEN),
      });
      expect(dev.json.permissions.ADMINISTER.havePermission).toBe(false);
    });

    it("names permission keys with empty underscore segments", async () => {
      const res = await api(t.app, "/rest/api/3/mypermissions?permissions=_,EDIT__ISSUES");
      expect(res.status).toBe(200);
      expect(res.json.permissions._.name).toBe("");
      expect(res.json.permissions.EDIT__ISSUES.name).toBe("Edit Issues");
    });
  });
});
