import type { ConsoleService } from "./types";

const headers = { "Content-Type": "application/json" };
const target = { dataSource: "Cluster0", database: "test", collection: "items" };

/** Ready-made requests for every operation the MongoDB Atlas emulator serves. */
export const mongoatlas: ConsoleService = {
  name: "mongoatlas",
  label: "MongoDB Atlas",
  description: "Atlas Admin API and Data API.",
  variables: [
    {
      name: "project_id",
      label: "Project id",
      hint: "Filled in when you run List projects. You can also paste an id.",
    },
    {
      name: "new_project_id",
      label: "New project id",
      hint: "Filled in when you run Create project. You can also paste an id.",
    },
  ],
  groups: [
    {
      title: "Projects",
      presets: [
        {
          label: "List projects",
          description: "Returns every project, including Project0, with the id that the project paths need.",
          method: "GET",
          path: "/api/atlas/v2/groups",
          captures: { project_id: "results.0.id" },
        },
        {
          label: "Create project",
          description:
            "Creates a project and returns its id in the id field. Names must be unique, so change the name to run it again.",
          method: "POST",
          path: "/api/atlas/v2/groups",
          headers,
          body: JSON.stringify({ name: "Playground project" }, null, 2),
          captures: { new_project_id: "id" },
        },
        {
          label: "Get project",
          description: "Returns one project by its id.",
          method: "GET",
          path: "/api/atlas/v2/groups/{{project_id}}",
        },
        {
          label: "Delete project",
          description:
            "Deletes the project made by Create project and its clusters. Project0 stays, so the Cluster0 presets keep working.",
          method: "DELETE",
          path: "/api/atlas/v2/groups/{{new_project_id}}",
        },
      ],
    },
    {
      title: "Clusters",
      presets: [
        {
          label: "Create cluster",
          description: "Creates Cluster1 in the project. Rename the cluster to run it again.",
          method: "POST",
          path: "/api/atlas/v2/groups/{{project_id}}/clusters",
          headers,
          body: JSON.stringify(
            {
              name: "Cluster1",
              providerSettings: { providerName: "AWS", instanceSizeName: "M10", regionName: "US_EAST_1" },
            },
            null,
            2,
          ),
        },
        {
          label: "List clusters",
          description: "Lists the clusters in the project. Project0 has Cluster0.",
          method: "GET",
          path: "/api/atlas/v2/groups/{{project_id}}/clusters",
        },
        {
          label: "Get cluster",
          description: "Returns Cluster0 from the project. Use the id of Project0.",
          method: "GET",
          path: "/api/atlas/v2/groups/{{project_id}}/clusters/Cluster0",
        },
        {
          label: "Update cluster",
          description: "Sets the disk size of Cluster0 to 20 GB. Use the id of Project0.",
          method: "PATCH",
          path: "/api/atlas/v2/groups/{{project_id}}/clusters/Cluster0",
          headers,
          body: JSON.stringify({ diskSizeGB: 20 }, null, 2),
        },
        {
          label: "Delete cluster",
          description: "Deletes Cluster1 and its databases. Run Create cluster first, and use the same project id.",
          method: "DELETE",
          path: "/api/atlas/v2/groups/{{project_id}}/clusters/Cluster1",
        },
      ],
    },
    {
      title: "Database users",
      presets: [
        {
          label: "Create database user",
          description:
            "Creates playground-user with readWrite on the test database. Run Delete database user first to create it again.",
          method: "POST",
          path: "/api/atlas/v2/groups/{{project_id}}/databaseUsers",
          headers,
          body: JSON.stringify(
            { username: "playground-user", roles: [{ databaseName: "test", roleName: "readWrite" }] },
            null,
            2,
          ),
        },
        {
          label: "List database users",
          description: "Lists the database users in the project. Project0 has the admin user.",
          method: "GET",
          path: "/api/atlas/v2/groups/{{project_id}}/databaseUsers",
        },
        {
          label: "Get database user",
          description: "Returns playground-user. Run Create database user first.",
          method: "GET",
          path: "/api/atlas/v2/groups/{{project_id}}/databaseUsers/admin/playground-user",
        },
        {
          label: "Delete database user",
          description: "Deletes playground-user. Run Create database user first.",
          method: "DELETE",
          path: "/api/atlas/v2/groups/{{project_id}}/databaseUsers/admin/playground-user",
        },
      ],
    },
    {
      title: "Databases and collections",
      presets: [
        {
          label: "List databases",
          description: "Lists the databases in Cluster0. Use the id of Project0.",
          method: "GET",
          path: "/api/atlas/v2/groups/{{project_id}}/clusters/Cluster0/databases",
        },
        {
          label: "List collections",
          description: "Lists the collections in the test database of Cluster0. Use the id of Project0.",
          method: "GET",
          path: "/api/atlas/v2/groups/{{project_id}}/clusters/Cluster0/databases/test/collections",
        },
      ],
    },
    {
      title: "Data API: write",
      presets: [
        {
          label: "Insert document",
          description: "Inserts one document into test.items on Cluster0 and returns its insertedId.",
          method: "POST",
          path: "/app/data-api/v1/action/insertOne",
          headers,
          body: JSON.stringify({ ...target, document: { name: "Playground item", status: "new" } }, null, 2),
        },
        {
          label: "Insert documents",
          description: "Inserts two documents into test.items and returns their insertedIds.",
          method: "POST",
          path: "/app/data-api/v1/action/insertMany",
          headers,
          body: JSON.stringify(
            {
              ...target,
              documents: [
                { name: "Sample A", status: "new" },
                { name: "Sample B", status: "new" },
              ],
            },
            null,
            2,
          ),
        },
        {
          label: "Update one document",
          description: "Sets status to done on the first document named Playground item. Run Insert document first.",
          method: "POST",
          path: "/app/data-api/v1/action/updateOne",
          headers,
          body: JSON.stringify(
            { ...target, filter: { name: "Playground item" }, update: { $set: { status: "done" } } },
            null,
            2,
          ),
        },
        {
          label: "Update many documents",
          description: "Sets reviewed to true on every document with status new. Run the insert presets first.",
          method: "POST",
          path: "/app/data-api/v1/action/updateMany",
          headers,
          body: JSON.stringify({ ...target, filter: { status: "new" }, update: { $set: { reviewed: true } } }, null, 2),
        },
        {
          label: "Delete one document",
          description: "Deletes one document named Playground item. Run Insert document first.",
          method: "POST",
          path: "/app/data-api/v1/action/deleteOne",
          headers,
          body: JSON.stringify({ ...target, filter: { name: "Playground item" } }, null, 2),
        },
        {
          label: "Delete many documents",
          description: "Deletes every document with status new. Run it after the insert and update presets.",
          method: "POST",
          path: "/app/data-api/v1/action/deleteMany",
          headers,
          body: JSON.stringify({ ...target, filter: { status: "new" } }, null, 2),
        },
      ],
    },
    {
      title: "Data API: read",
      presets: [
        {
          label: "Find one document",
          description:
            "Returns the first document named Playground item from test.items. Run the insert presets first, since the delete presets remove them.",
          method: "POST",
          path: "/app/data-api/v1/action/findOne",
          headers,
          body: JSON.stringify({ ...target, filter: { name: "Playground item" } }, null, 2),
        },
        {
          label: "Find documents",
          description: "Returns up to 10 documents from test.items. Run the insert presets first to see results.",
          method: "POST",
          path: "/app/data-api/v1/action/find",
          headers,
          body: JSON.stringify({ ...target, filter: {}, limit: 10 }, null, 2),
        },
        {
          label: "Aggregate documents",
          description:
            "Counts the documents with status new with a $match and $count pipeline. Run the insert presets first.",
          method: "POST",
          path: "/app/data-api/v1/action/aggregate",
          headers,
          body: JSON.stringify({ ...target, pipeline: [{ $match: { status: "new" } }, { $count: "total" }] }, null, 2),
        },
      ],
    },
  ],
};
