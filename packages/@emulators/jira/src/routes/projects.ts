import type { RouteContext } from "@emulators/core";
import {
  API_V,
  fieldError,
  JiraError,
  listParam,
  makeHandler,
  MANAGE,
  pageParams,
  READ,
  readJson,
  type JiraRequest,
} from "../context.js";
import { formatComponent, formatProject, formatVersion, restUrl } from "../formatters.js";
import { findProject, findUser, paginate, requireProject } from "../lookup.js";
import { insertFrom } from "../store.js";
import { createProject, deleteComponentRecord, deleteProjectRecord, deleteVersionRecord } from "../services.js";

const PROJECT_KEY = /^[A-Z][A-Z0-9_]{1,9}$/;

/** Jira lets site admins and the project lead administer a project's components and versions. */
function requireProjectAdmin(r: JiraRequest, projectId: number) {
  const project = r.js.projects.get(projectId);
  if (r.user.admin || (project && project.lead_account_id === r.user.account_id)) return;
  throw new JiraError(403, ["You do not have permission to administer this project."]);
}

/** Rejects a component or version name already used by another item in the same project. */
function requireUniqueName(
  items: Array<{ id: number; name: string }>,
  name: string,
  error: () => JiraError,
  exceptId?: number,
) {
  if (items.some((item) => item.id !== exceptId && item.name.toLowerCase() === name.toLowerCase())) throw error();
}

/** Reads an optional `yyyy-MM-dd` date from a request body. */
function dateField(field: string, value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw fieldError(field, `Invalid date format. Please enter the date in the format "yyyy-MM-dd".`);
  }
  return value;
}

const componentExists = (name: string) =>
  fieldError("name", `A component with the name ${name} already exists in this project.`);
const versionExists = () => fieldError("name", "A version with this name already exists in this project.");

function requireAdmin(r: JiraRequest) {
  if (!r.user.admin) {
    throw new JiraError(403, ["You must have global administrator rights in order to modify projects."]);
  }
}

export function projectRoutes({ app, store, baseUrl }: RouteContext): void {
  const handle = makeHandler(store, baseUrl);

  app.get(
    `${API_V}/project`,
    handle((r) => r.c.json(r.js.projects.all().map((project) => formatProject(r, project))), { scopes: READ }),
  );

  app.get(
    `${API_V}/project/search`,
    handle(
      (r) => {
        const query = r.c.req.query("query")?.toLowerCase();
        const keys = listParam(r.c, "keys").map((key) => key.toLowerCase());
        const ids = listParam(r.c, "id");
        const typeKey = r.c.req.query("typeKey");
        const projects = r.js.projects.all().filter((project) => {
          if (query && !project.key.toLowerCase().includes(query) && !project.name.toLowerCase().includes(query)) {
            return false;
          }
          if (keys.length > 0 && !keys.includes(project.key.toLowerCase())) return false;
          if (ids.length > 0 && !ids.includes(String(project.id))) return false;
          if (typeKey && project.project_type_key !== typeKey) return false;
          return true;
        });
        const { startAt, maxResults } = pageParams(r.c, 50, 100);
        const page = paginate(projects, { startAt, maxResults });
        return r.c.json({
          self: restUrl(r, `/project/search?startAt=${startAt}&maxResults=${maxResults}`),
          ...(page.isLast
            ? {}
            : { nextPage: restUrl(r, `/project/search?startAt=${startAt + maxResults}&maxResults=${maxResults}`) }),
          ...page,
          values: page.values.map((project) => formatProject(r, project)),
        });
      },
      { scopes: READ },
    ),
  );

  app.post(
    `${API_V}/project`,
    handle(
      async (r) => {
        requireAdmin(r);
        const body = await readJson(r.c);
        const key = String(body.key ?? "");
        const name = String(body.name ?? "").trim();
        if (!PROJECT_KEY.test(key)) {
          throw fieldError(
            "projectKey",
            "Project keys must start with an uppercase letter, followed by one or more uppercase alphanumeric characters.",
          );
        }
        if (findProject(r.js, key))
          throw fieldError(
            "projectKey",
            `Project '${key}' uses this project key. A project with that project key already exists.`,
          );
        if (!name) throw fieldError("projectName", "You must specify a valid project name.");
        if (r.js.projects.all().some((project) => project.name.toLowerCase() === name.toLowerCase())) {
          throw fieldError("projectName", "A project with that name already exists.");
        }
        const typeKey = body.projectTypeKey ?? "software";
        if (!["software", "business", "service_desk"].includes(typeKey)) {
          throw fieldError("projectTypeKey", "Invalid project type key.");
        }
        let lead = r.user.account_id;
        if (body.leadAccountId) {
          const user = findUser(r.js, String(body.leadAccountId));
          if (!user) throw fieldError("projectLead", "The project lead you specified does not exist.");
          lead = user.account_id;
        }
        const project = createProject(r.js, {
          key,
          name,
          description: body.description ?? "",
          lead,
          project_type_key: typeKey,
        });
        return r.c.json({ self: restUrl(r, `/project/${project.id}`), id: project.id, key: project.key }, 201);
      },
      { scopes: MANAGE },
    ),
  );

  app.get(
    `${API_V}/project/:key`,
    handle((r) => r.c.json(formatProject(r, requireProject(r.js, r.c.req.param("key")))), { scopes: READ }),
  );

  app.put(
    `${API_V}/project/:key`,
    handle(
      async (r) => {
        requireAdmin(r);
        const project = requireProject(r.js, r.c.req.param("key"));
        const body = await readJson(r.c);
        const patch: Partial<typeof project> = {};
        if (typeof body.name === "string") patch.name = body.name;
        if (typeof body.description === "string") patch.description = body.description;
        if (typeof body.key === "string" && body.key !== project.key) {
          if (!PROJECT_KEY.test(body.key)) throw fieldError("projectKey", "Invalid project key.");
          if (findProject(r.js, body.key))
            throw fieldError("projectKey", "A project with that project key already exists.");
          patch.key = body.key;
        }
        if (body.leadAccountId) {
          const user = findUser(r.js, String(body.leadAccountId));
          if (!user) throw fieldError("projectLead", "The project lead you specified does not exist.");
          patch.lead_account_id = user.account_id;
        }
        const updated = r.js.projects.update(project.id, patch)!;
        if (patch.key) {
          for (const issue of r.js.issues.findBy("project_id", project.id)) {
            r.js.issues.update(issue.id, { key: `${patch.key}-${issue.number}` });
          }
        }
        return r.c.json(formatProject(r, updated));
      },
      { scopes: MANAGE },
    ),
  );

  app.delete(
    `${API_V}/project/:key`,
    handle(
      (r) => {
        requireAdmin(r);
        deleteProjectRecord(r.js, requireProject(r.js, r.c.req.param("key")));
        return r.c.body(null, 204);
      },
      { scopes: MANAGE },
    ),
  );

  app.get(
    `${API_V}/project/:key/components`,
    handle(
      (r) => {
        const project = requireProject(r.js, r.c.req.param("key"));
        return r.c.json(
          r.js.components.findBy("project_id", project.id).map((component) => formatComponent(r, component)),
        );
      },
      { scopes: READ },
    ),
  );

  app.get(
    `${API_V}/project/:key/versions`,
    handle(
      (r) => {
        const project = requireProject(r.js, r.c.req.param("key"));
        return r.c.json(r.js.versions.findBy("project_id", project.id).map((version) => formatVersion(r, version)));
      },
      { scopes: READ },
    ),
  );

  app.post(
    `${API_V}/component`,
    handle(
      async (r) => {
        const body = await readJson(r.c);
        const project = findProject(r.js, body.projectId ?? body.project);
        if (!project) throw fieldError("project", "The project with key or id specified does not exist.");
        requireProjectAdmin(r, project.id);
        const name = String(body.name ?? "").trim();
        if (!name) throw fieldError("name", "The component name must not be empty.");
        requireUniqueName(r.js.components.findBy("project_id", project.id), name, () => componentExists(name));
        const lead = body.leadAccountId ? findUser(r.js, String(body.leadAccountId)) : undefined;
        const component = insertFrom(r.js.components, 10000, {
          project_id: project.id,
          name,
          description: body.description ?? "",
          lead_account_id: lead?.account_id ?? null,
        });
        return r.c.json(formatComponent(r, component), 201);
      },
      { scopes: MANAGE },
    ),
  );

  const requireComponent = (r: JiraRequest) => {
    const component = r.js.components.get(Number(r.c.req.param("id")));
    if (!component) throw new JiraError(404, [`The component with id ${r.c.req.param("id")} does not exist.`]);
    return component;
  };

  app.get(
    `${API_V}/component/:id`,
    handle((r) => r.c.json(formatComponent(r, requireComponent(r))), { scopes: READ }),
  );

  app.put(
    `${API_V}/component/:id`,
    handle(
      async (r) => {
        const component = requireComponent(r);
        requireProjectAdmin(r, component.project_id);
        const body = await readJson(r.c);
        const name = typeof body.name === "string" ? body.name.trim() : undefined;
        if (name !== undefined) {
          if (!name) throw fieldError("name", "The component name must not be empty.");
          const siblings = r.js.components.findBy("project_id", component.project_id);
          requireUniqueName(siblings, name, () => componentExists(name), component.id);
        }
        const updated = r.js.components.update(component.id, {
          ...(name !== undefined ? { name } : {}),
          ...(typeof body.description === "string" ? { description: body.description } : {}),
        })!;
        return r.c.json(formatComponent(r, updated));
      },
      { scopes: MANAGE },
    ),
  );

  app.delete(
    `${API_V}/component/:id`,
    handle(
      (r) => {
        const component = requireComponent(r);
        requireProjectAdmin(r, component.project_id);
        deleteComponentRecord(r.js, component);
        return r.c.body(null, 204);
      },
      { scopes: MANAGE },
    ),
  );

  app.post(
    `${API_V}/version`,
    handle(
      async (r) => {
        const body = await readJson(r.c);
        const project = findProject(r.js, body.projectId ?? body.project);
        if (!project) throw fieldError("project", "The project with key or id specified does not exist.");
        requireProjectAdmin(r, project.id);
        const name = String(body.name ?? "").trim();
        if (!name) throw fieldError("name", "You must specify a valid version name");
        requireUniqueName(r.js.versions.findBy("project_id", project.id), name, versionExists);
        const version = insertFrom(r.js.versions, 10000, {
          project_id: project.id,
          name,
          description: body.description ?? "",
          released: body.released === true,
          archived: body.archived === true,
          start_date: dateField("startDate", body.startDate),
          release_date: dateField("releaseDate", body.releaseDate),
        });
        return r.c.json(formatVersion(r, version), 201);
      },
      { scopes: MANAGE },
    ),
  );

  const requireVersion = (r: JiraRequest) => {
    const version = r.js.versions.get(Number(r.c.req.param("id")));
    if (!version) throw new JiraError(404, [`Could not find version for id '${r.c.req.param("id")}'`]);
    return version;
  };

  app.get(
    `${API_V}/version/:id`,
    handle((r) => r.c.json(formatVersion(r, requireVersion(r))), { scopes: READ }),
  );

  app.put(
    `${API_V}/version/:id`,
    handle(
      async (r) => {
        const version = requireVersion(r);
        requireProjectAdmin(r, version.project_id);
        const body = await readJson(r.c);
        const name = typeof body.name === "string" ? body.name.trim() : undefined;
        if (name !== undefined) {
          if (!name) throw fieldError("name", "You must specify a valid version name");
          requireUniqueName(r.js.versions.findBy("project_id", version.project_id), name, versionExists, version.id);
        }
        const updated = r.js.versions.update(version.id, {
          ...(name !== undefined ? { name } : {}),
          ...(typeof body.description === "string" ? { description: body.description } : {}),
          ...(typeof body.released === "boolean" ? { released: body.released } : {}),
          ...(typeof body.archived === "boolean" ? { archived: body.archived } : {}),
          ...(body.startDate !== undefined ? { start_date: dateField("startDate", body.startDate) } : {}),
          ...(body.releaseDate !== undefined ? { release_date: dateField("releaseDate", body.releaseDate) } : {}),
        })!;
        return r.c.json(formatVersion(r, updated));
      },
      { scopes: MANAGE },
    ),
  );

  app.delete(
    `${API_V}/version/:id`,
    handle(
      (r) => {
        const version = requireVersion(r);
        requireProjectAdmin(r, version.project_id);
        deleteVersionRecord(r.js, version);
        return r.c.body(null, 204);
      },
      { scopes: MANAGE },
    ),
  );
}
