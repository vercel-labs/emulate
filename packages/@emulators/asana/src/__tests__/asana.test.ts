import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { Store, WebhookDispatcher, authMiddleware, createApiErrorHandler, createErrorHandler, type TokenMap } from "@emulators/core";
import { asanaPlugin, seedFromConfig, getAsanaStore } from "../index.js";

const base = "http://localhost:4000";

function createTestApp() {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map();
  tokenMap.set("test-token", {
    login: "dev@example.com",
    id: 1,
    scopes: [],
  });

  const app = new Hono();
  app.onError(createApiErrorHandler());
  app.use("*", createErrorHandler());
  app.use("*", authMiddleware(tokenMap));
  asanaPlugin.register(app as any, store, webhooks, base, tokenMap);
  asanaPlugin.seed?.(store, base);
  seedFromConfig(store, base, {
    workspaces: [{ name: "Test Workspace", is_organization: true }],
    users: [{ name: "Developer", email: "dev@example.com" }],
    teams: [{ name: "Engineering", workspace: "Test Workspace" }],
    projects: [{ name: "Test Project", workspace: "Test Workspace", team: "Engineering", owner: "Developer" }],
    sections: [{ name: "To Do", project: "Test Project" }, { name: "In Progress", project: "Test Project" }],
    tags: [{ name: "urgent", workspace: "Test Workspace", color: "red" }],
  });

  return { app, store, webhooks, tokenMap };
}

function authHeaders(): HeadersInit {
  return { Authorization: "Bearer test-token", "Content-Type": "application/json" };
}

// ── Users ──────────────────────────────────────────────────

describe("Asana - Users", () => {
  let app: Hono;

  beforeEach(() => {
    app = createTestApp().app;
  });

  it("GET /users/me returns authenticated user", async () => {
    const res = await app.request(`${base}/api/1.0/users/me`, { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.email).toBe("dev@example.com");
    expect(body.data.name).toBe("Developer");
    expect(body.data.workspaces).toBeDefined();
  });

  it("GET /users/:gid returns user by gid", async () => {
    const meRes = await app.request(`${base}/api/1.0/users/me`, { headers: authHeaders() });
    const me = (await meRes.json() as any).data;

    const res = await app.request(`${base}/api/1.0/users/${me.gid}`, { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.gid).toBe(me.gid);
  });

  it("GET /users requires workspace parameter", async () => {
    const res = await app.request(`${base}/api/1.0/users`, { headers: authHeaders() });
    expect(res.status).toBe(400);
  });

  it("GET /users lists users in workspace", async () => {
    const meRes = await app.request(`${base}/api/1.0/users/me`, { headers: authHeaders() });
    const workspaces = (await meRes.json() as any).data.workspaces;
    const wsGid = workspaces[0].gid;

    const res = await app.request(`${base}/api/1.0/users?workspace=${wsGid}`, { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    expect(body.next_page).toBeNull();
  });
});

// ── Workspaces ─────────────────────────────────────────────

describe("Asana - Workspaces", () => {
  let app: Hono;

  beforeEach(() => {
    app = createTestApp().app;
  });

  it("GET /workspaces lists workspaces", async () => {
    const res = await app.request(`${base}/api/1.0/workspaces`, { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    expect(body.data.some((w: any) => w.name === "Test Workspace")).toBe(true);
  });

  it("PUT /workspaces/:gid updates workspace", async () => {
    const listRes = await app.request(`${base}/api/1.0/workspaces`, { headers: authHeaders() });
    const ws = (await listRes.json() as any).data.find((w: any) => w.name === "Test Workspace");

    const res = await app.request(`${base}/api/1.0/workspaces/${ws.gid}`, {
      method: "PUT",
      headers: authHeaders(),
      body: JSON.stringify({ data: { name: "Renamed Workspace" } }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.name).toBe("Renamed Workspace");
  });
});

// ── Projects ───────────────────────────────────────────────

describe("Asana - Projects", () => {
  let app: Hono;
  let workspaceGid: string;

  beforeEach(async () => {
    app = createTestApp().app;
    const wsRes = await app.request(`${base}/api/1.0/workspaces`, { headers: authHeaders() });
    const wsData = await wsRes.json() as any;
    workspaceGid = wsData.data.find((w: any) => w.name === "Test Workspace").gid;
  });

  it("GET /projects lists projects", async () => {
    const res = await app.request(`${base}/api/1.0/projects?workspace=${workspaceGid}`, { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.length).toBeGreaterThanOrEqual(1);
  });

  it("POST /projects creates a project", async () => {
    const res = await app.request(`${base}/api/1.0/projects`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ data: { name: "New Project", workspace: workspaceGid } }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.data.name).toBe("New Project");
    expect(body.data.gid).toBeDefined();
  });

  it("PUT /projects/:gid updates a project", async () => {
    const listRes = await app.request(`${base}/api/1.0/projects?workspace=${workspaceGid}`, { headers: authHeaders() });
    const project = (await listRes.json() as any).data[0];

    const res = await app.request(`${base}/api/1.0/projects/${project.gid}`, {
      method: "PUT",
      headers: authHeaders(),
      body: JSON.stringify({ data: { name: "Updated Project" } }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.name).toBe("Updated Project");
  });

  it("DELETE /projects/:gid deletes a project", async () => {
    const createRes = await app.request(`${base}/api/1.0/projects`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ data: { name: "To Delete", workspace: workspaceGid } }),
    });
    const { data: { gid } } = await createRes.json() as any;

    const res = await app.request(`${base}/api/1.0/projects/${gid}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);

    const getRes = await app.request(`${base}/api/1.0/projects/${gid}`, { headers: authHeaders() });
    expect(getRes.status).toBe(404);
  });

  it("GET /projects/:gid/task_counts returns counts", async () => {
    const listRes = await app.request(`${base}/api/1.0/projects?workspace=${workspaceGid}`, { headers: authHeaders() });
    const project = (await listRes.json() as any).data[0];

    const res = await app.request(`${base}/api/1.0/projects/${project.gid}/task_counts`, { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.num_tasks).toBeDefined();
  });
});

// ── Sections ───────────────────────────────────────────────

describe("Asana - Sections", () => {
  let app: Hono;
  let projectGid: string;

  beforeEach(async () => {
    const testApp = createTestApp();
    app = testApp.app;
    const as = getAsanaStore(testApp.store);
    projectGid = as.projects.all().find((p) => p.name === "Test Project")!.gid;
  });

  it("GET /projects/:gid/sections lists sections", async () => {
    const res = await app.request(`${base}/api/1.0/projects/${projectGid}/sections`, { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.length).toBe(2);
  });

  it("POST /projects/:gid/sections creates a section", async () => {
    const res = await app.request(`${base}/api/1.0/projects/${projectGid}/sections`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ data: { name: "Done" } }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.data.name).toBe("Done");
  });

  it("DELETE /sections/:gid deletes a section", async () => {
    const createRes = await app.request(`${base}/api/1.0/projects/${projectGid}/sections`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ data: { name: "Temp" } }),
    });
    const { data: { gid } } = await createRes.json() as any;

    const res = await app.request(`${base}/api/1.0/sections/${gid}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
  });
});

// ── Tasks ──────────────────────────────────────────────────

describe("Asana - Tasks", () => {
  let app: Hono;
  let testStore: Store;
  let workspaceGid: string;
  let projectGid: string;

  beforeEach(() => {
    const testApp = createTestApp();
    app = testApp.app;
    testStore = testApp.store;
    const as = getAsanaStore(testStore);
    workspaceGid = as.workspaces.all().find((w) => w.name === "Test Workspace")!.gid;
    projectGid = as.projects.all().find((p) => p.name === "Test Project")!.gid;
  });

  it("POST /tasks creates a task", async () => {
    const res = await app.request(`${base}/api/1.0/tasks`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        data: {
          name: "New Task",
          workspace: workspaceGid,
          projects: [projectGid],
        },
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.data.name).toBe("New Task");
    expect(body.data.projects.length).toBe(1);
  });

  it("GET /tasks/:gid returns task details", async () => {
    const createRes = await app.request(`${base}/api/1.0/tasks`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ data: { name: "Detail Task", workspace: workspaceGid } }),
    });
    const { data: { gid } } = await createRes.json() as any;

    const res = await app.request(`${base}/api/1.0/tasks/${gid}`, { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.name).toBe("Detail Task");
    expect(body.data.resource_type).toBe("task");
  });

  it("PUT /tasks/:gid updates a task", async () => {
    const createRes = await app.request(`${base}/api/1.0/tasks`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ data: { name: "To Update", workspace: workspaceGid } }),
    });
    const { data: { gid } } = await createRes.json() as any;

    const res = await app.request(`${base}/api/1.0/tasks/${gid}`, {
      method: "PUT",
      headers: authHeaders(),
      body: JSON.stringify({ data: { name: "Updated", completed: true } }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.name).toBe("Updated");
    expect(body.data.completed).toBe(true);
    expect(body.data.completed_at).toBeDefined();
  });

  it("DELETE /tasks/:gid deletes a task", async () => {
    const createRes = await app.request(`${base}/api/1.0/tasks`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ data: { name: "To Delete", workspace: workspaceGid } }),
    });
    const { data: { gid } } = await createRes.json() as any;

    const res = await app.request(`${base}/api/1.0/tasks/${gid}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);

    const getRes = await app.request(`${base}/api/1.0/tasks/${gid}`, { headers: authHeaders() });
    expect(getRes.status).toBe(404);
  });

  it("GET /tasks filters by project", async () => {
    await app.request(`${base}/api/1.0/tasks`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ data: { name: "Project Task", workspace: workspaceGid, projects: [projectGid] } }),
    });

    const res = await app.request(`${base}/api/1.0/tasks?project=${projectGid}`, { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.length).toBeGreaterThanOrEqual(1);
  });

  it("subtasks - create and list", async () => {
    const parentRes = await app.request(`${base}/api/1.0/tasks`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ data: { name: "Parent Task", workspace: workspaceGid } }),
    });
    const parentGid = (await parentRes.json() as any).data.gid;

    const subRes = await app.request(`${base}/api/1.0/tasks/${parentGid}/subtasks`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ data: { name: "Child Task" } }),
    });
    expect(subRes.status).toBe(201);
    const subBody = await subRes.json() as any;
    expect(subBody.data.parent.gid).toBe(parentGid);

    const listRes = await app.request(`${base}/api/1.0/tasks/${parentGid}/subtasks`, { headers: authHeaders() });
    const listBody = await listRes.json() as any;
    expect(listBody.data.length).toBe(1);
  });

  it("addProject / removeProject", async () => {
    const taskRes = await app.request(`${base}/api/1.0/tasks`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ data: { name: "Unassigned", workspace: workspaceGid } }),
    });
    const taskGid = (await taskRes.json() as any).data.gid;

    // Add to project
    const addRes = await app.request(`${base}/api/1.0/tasks/${taskGid}/addProject`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ data: { project: projectGid } }),
    });
    expect(addRes.status).toBe(200);

    const projRes = await app.request(`${base}/api/1.0/tasks/${taskGid}/projects`, { headers: authHeaders() });
    const projBody = await projRes.json() as any;
    expect(projBody.data.length).toBe(1);

    // Remove from project
    const removeRes = await app.request(`${base}/api/1.0/tasks/${taskGid}/removeProject`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ data: { project: projectGid } }),
    });
    expect(removeRes.status).toBe(200);

    const projRes2 = await app.request(`${base}/api/1.0/tasks/${taskGid}/projects`, { headers: authHeaders() });
    const projBody2 = await projRes2.json() as any;
    expect(projBody2.data.length).toBe(0);
  });

  it("addTag / removeTag", async () => {
    const taskRes = await app.request(`${base}/api/1.0/tasks`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ data: { name: "Tagged", workspace: workspaceGid } }),
    });
    const taskGid = (await taskRes.json() as any).data.gid;

    const as = getAsanaStore(testStore);
    const tagGid = as.tags.all()[0].gid;

    await app.request(`${base}/api/1.0/tasks/${taskGid}/addTag`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ data: { tag: tagGid } }),
    });

    const tagsRes = await app.request(`${base}/api/1.0/tasks/${taskGid}/tags`, { headers: authHeaders() });
    const tagsBody = await tagsRes.json() as any;
    expect(tagsBody.data.length).toBe(1);

    await app.request(`${base}/api/1.0/tasks/${taskGid}/removeTag`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ data: { tag: tagGid } }),
    });

    const tagsRes2 = await app.request(`${base}/api/1.0/tasks/${taskGid}/tags`, { headers: authHeaders() });
    const tagsBody2 = await tagsRes2.json() as any;
    expect(tagsBody2.data.length).toBe(0);
  });

  it("addDependencies / removeDependencies", async () => {
    const task1Res = await app.request(`${base}/api/1.0/tasks`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ data: { name: "Task A", workspace: workspaceGid } }),
    });
    const task1Gid = (await task1Res.json() as any).data.gid;

    const task2Res = await app.request(`${base}/api/1.0/tasks`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ data: { name: "Task B", workspace: workspaceGid } }),
    });
    const task2Gid = (await task2Res.json() as any).data.gid;

    await app.request(`${base}/api/1.0/tasks/${task1Gid}/addDependencies`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ data: { dependencies: [task2Gid] } }),
    });

    const depsRes = await app.request(`${base}/api/1.0/tasks/${task1Gid}/dependencies`, { headers: authHeaders() });
    const depsBody = await depsRes.json() as any;
    expect(depsBody.data.length).toBe(1);
    expect(depsBody.data[0].gid).toBe(task2Gid);

    // Check dependents from the other side
    const deptsRes = await app.request(`${base}/api/1.0/tasks/${task2Gid}/dependents`, { headers: authHeaders() });
    const deptsBody = await deptsRes.json() as any;
    expect(deptsBody.data.length).toBe(1);
    expect(deptsBody.data[0].gid).toBe(task1Gid);

    await app.request(`${base}/api/1.0/tasks/${task1Gid}/removeDependencies`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ data: { dependencies: [task2Gid] } }),
    });

    const depsRes2 = await app.request(`${base}/api/1.0/tasks/${task1Gid}/dependencies`, { headers: authHeaders() });
    const depsBody2 = await depsRes2.json() as any;
    expect(depsBody2.data.length).toBe(0);
  });

  it("setParent moves task to new parent", async () => {
    const parentRes = await app.request(`${base}/api/1.0/tasks`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ data: { name: "New Parent", workspace: workspaceGid } }),
    });
    const parentGid = (await parentRes.json() as any).data.gid;

    const childRes = await app.request(`${base}/api/1.0/tasks`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ data: { name: "Child", workspace: workspaceGid } }),
    });
    const childGid = (await childRes.json() as any).data.gid;

    const res = await app.request(`${base}/api/1.0/tasks/${childGid}/setParent`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ data: { parent: parentGid } }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.parent.gid).toBe(parentGid);
  });

  it("stories - create comment and list", async () => {
    const taskRes = await app.request(`${base}/api/1.0/tasks`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ data: { name: "With Stories", workspace: workspaceGid } }),
    });
    const taskGid = (await taskRes.json() as any).data.gid;

    const commentRes = await app.request(`${base}/api/1.0/tasks/${taskGid}/stories`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ data: { text: "This is a comment" } }),
    });
    expect(commentRes.status).toBe(201);
    const commentBody = await commentRes.json() as any;
    expect(commentBody.data.text).toBe("This is a comment");
    expect(commentBody.data.type).toBe("comment");

    const listRes = await app.request(`${base}/api/1.0/tasks/${taskGid}/stories`, { headers: authHeaders() });
    const listBody = await listRes.json() as any;
    expect(listBody.data.length).toBe(1);
  });
});

// ── Tags ───────────────────────────────────────────────────

describe("Asana - Tags", () => {
  let app: Hono;
  let workspaceGid: string;

  beforeEach(async () => {
    const testApp = createTestApp();
    app = testApp.app;
    workspaceGid = getAsanaStore(testApp.store).workspaces.all().find((w) => w.name === "Test Workspace")!.gid;
  });

  it("POST /tags creates a tag", async () => {
    const res = await app.request(`${base}/api/1.0/tags`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ data: { name: "bug", workspace: workspaceGid } }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.data.name).toBe("bug");
  });

  it("GET /tags lists tags", async () => {
    const res = await app.request(`${base}/api/1.0/tags?workspace=${workspaceGid}`, { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.length).toBeGreaterThanOrEqual(1);
  });

  it("PUT /tags/:gid updates a tag", async () => {
    const createRes = await app.request(`${base}/api/1.0/tags`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ data: { name: "old-name", workspace: workspaceGid } }),
    });
    const tagGid = (await createRes.json() as any).data.gid;

    const res = await app.request(`${base}/api/1.0/tags/${tagGid}`, {
      method: "PUT",
      headers: authHeaders(),
      body: JSON.stringify({ data: { name: "new-name" } }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.name).toBe("new-name");
  });

  it("DELETE /tags/:gid deletes a tag", async () => {
    const createRes = await app.request(`${base}/api/1.0/tags`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ data: { name: "to-delete", workspace: workspaceGid } }),
    });
    const tagGid = (await createRes.json() as any).data.gid;

    const res = await app.request(`${base}/api/1.0/tags/${tagGid}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
  });

  it("GET /workspaces/:gid/tags lists workspace tags", async () => {
    const res = await app.request(`${base}/api/1.0/workspaces/${workspaceGid}/tags`, { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.length).toBeGreaterThanOrEqual(1);
  });
});

// ── Stories ────────────────────────────────────────────────

describe("Asana - Stories", () => {
  let app: Hono;
  let workspaceGid: string;

  beforeEach(async () => {
    const testApp = createTestApp();
    app = testApp.app;
    workspaceGid = getAsanaStore(testApp.store).workspaces.all().find((w) => w.name === "Test Workspace")!.gid;
  });

  it("PUT /stories/:gid updates a story", async () => {
    // Create task and story first
    const taskRes = await app.request(`${base}/api/1.0/tasks`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ data: { name: "Story Task", workspace: workspaceGid } }),
    });
    const taskGid = (await taskRes.json() as any).data.gid;

    const storyRes = await app.request(`${base}/api/1.0/tasks/${taskGid}/stories`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ data: { text: "Original" } }),
    });
    const storyGid = (await storyRes.json() as any).data.gid;

    const res = await app.request(`${base}/api/1.0/stories/${storyGid}`, {
      method: "PUT",
      headers: authHeaders(),
      body: JSON.stringify({ data: { text: "Updated comment" } }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.text).toBe("Updated comment");
  });

  it("DELETE /stories/:gid deletes a story", async () => {
    const taskRes = await app.request(`${base}/api/1.0/tasks`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ data: { name: "Del Story Task", workspace: workspaceGid } }),
    });
    const taskGid = (await taskRes.json() as any).data.gid;

    const storyRes = await app.request(`${base}/api/1.0/tasks/${taskGid}/stories`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ data: { text: "To delete" } }),
    });
    const storyGid = (await storyRes.json() as any).data.gid;

    const res = await app.request(`${base}/api/1.0/stories/${storyGid}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
  });
});

// ── Teams ──────────────────────────────────────────────────

describe("Asana - Teams", () => {
  let app: Hono;
  let testStore: Store;
  let workspaceGid: string;

  beforeEach(() => {
    const testApp = createTestApp();
    app = testApp.app;
    testStore = testApp.store;
    workspaceGid = getAsanaStore(testStore).workspaces.all().find((w) => w.name === "Test Workspace")!.gid;
  });

  it("POST /teams creates a team", async () => {
    const res = await app.request(`${base}/api/1.0/teams`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ data: { name: "Design", organization: workspaceGid } }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.data.name).toBe("Design");
  });

  it("GET /workspaces/:gid/teams lists teams", async () => {
    const res = await app.request(`${base}/api/1.0/workspaces/${workspaceGid}/teams`, { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.length).toBeGreaterThanOrEqual(1);
  });

  it("addUser / removeUser manages membership", async () => {
    const as = getAsanaStore(testStore);
    const teamGid = as.teams.all()[0].gid;
    const userGid = as.users.all()[0].gid;

    const addRes = await app.request(`${base}/api/1.0/teams/${teamGid}/addUser`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ data: { user: userGid } }),
    });
    expect(addRes.status).toBe(200);

    const usersRes = await app.request(`${base}/api/1.0/teams/${teamGid}/users`, { headers: authHeaders() });
    const usersBody = await usersRes.json() as any;
    expect(usersBody.data.length).toBe(1);

    await app.request(`${base}/api/1.0/teams/${teamGid}/removeUser`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ data: { user: userGid } }),
    });

    const usersRes2 = await app.request(`${base}/api/1.0/teams/${teamGid}/users`, { headers: authHeaders() });
    const usersBody2 = await usersRes2.json() as any;
    expect(usersBody2.data.length).toBe(0);
  });
});

// ── Webhooks ───────────────────────────────────────────────

describe("Asana - Webhooks", () => {
  let app: Hono;

  beforeEach(() => {
    app = createTestApp().app;
  });

  it("CRUD webhooks", async () => {
    // Create
    const createRes = await app.request(`${base}/api/1.0/webhooks`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ data: { resource: "12345", target: "https://example.com/webhook" } }),
    });
    expect(createRes.status).toBe(201);
    const { data: webhook } = await createRes.json() as any;
    expect(webhook.active).toBe(true);

    // Get
    const getRes = await app.request(`${base}/api/1.0/webhooks/${webhook.gid}`, { headers: authHeaders() });
    expect(getRes.status).toBe(200);

    // List
    const listRes = await app.request(`${base}/api/1.0/webhooks`, { headers: authHeaders() });
    const listBody = await listRes.json() as any;
    expect(listBody.data.length).toBeGreaterThanOrEqual(1);

    // Update
    const updateRes = await app.request(`${base}/api/1.0/webhooks/${webhook.gid}`, {
      method: "PUT",
      headers: authHeaders(),
      body: JSON.stringify({ data: { active: false } }),
    });
    expect(updateRes.status).toBe(200);
    const updatedBody = await updateRes.json() as any;
    expect(updatedBody.data.active).toBe(false);

    // Delete
    const deleteRes = await app.request(`${base}/api/1.0/webhooks/${webhook.gid}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    expect(deleteRes.status).toBe(200);
  });
});

// ── Seed Config ────────────────────────────────────────────

describe("Asana - seedFromConfig", () => {
  it("seeds all resource types from config", () => {
    const { store } = createTestApp();
    const as = getAsanaStore(store);

    expect(as.workspaces.all().length).toBeGreaterThanOrEqual(1);
    expect(as.users.all().length).toBeGreaterThanOrEqual(1);
    expect(as.teams.all().length).toBeGreaterThanOrEqual(1);
    expect(as.projects.all().length).toBeGreaterThanOrEqual(1);
    expect(as.sections.all().length).toBe(2);
    expect(as.tags.all().length).toBeGreaterThanOrEqual(1);
  });

  it("does not create duplicates on re-seed", () => {
    const store = new Store();
    const config = {
      workspaces: [{ name: "WS" }],
      users: [{ name: "User", email: "user@test.com" }],
    };

    seedFromConfig(store, base, config);
    seedFromConfig(store, base, config);

    const as = getAsanaStore(store);
    expect(as.workspaces.all().filter((w) => w.name === "WS").length).toBe(1);
    expect(as.users.all().filter((u) => u.email === "user@test.com").length).toBe(1);
  });
});
