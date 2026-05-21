---
name: mongoatlas
description: Emulated MongoDB Atlas Admin API v2 and Data API v1 for local development, testing, and native Vercel preview functions. Use when the user needs to manage Atlas projects, clusters, database users, databases, collections, Data API documents, seed MongoDB Atlas state, scaffold MongoDB Atlas through npx emulate vercel init, or point Atlas SDK-style HTTP requests at a local API. Triggers include "MongoDB Atlas", "Atlas Admin API", "Atlas Data API", "emulate MongoDB", "mongoatlas", "dataSource", or any task requiring local MongoDB Atlas service emulation.
allowed-tools: Bash(npx emulate:*)
---

# MongoDB Atlas Emulator

Use the MongoDB Atlas emulator for Atlas Admin API v2 and Data API v1 flows in local development, CI, and Vercel preview functions.

## Start

```bash
npx emulate --service mongoatlas
```

Default base URL:

```bash
http://localhost:4010
```

## Vercel Preview

To expose MongoDB Atlas in a zero infra Vercel preview, scaffold the Go Function route:

```bash
npx emulate vercel init --service mongoatlas
```

The generated route serves MongoDB Atlas at `/emulate/mongoatlas/*`.

## Admin API

- `GET /api/atlas/v2/groups` lists projects.
- `GET /api/atlas/v2/groups/:groupId` gets a project.
- `POST /api/atlas/v2/groups` creates a project.
- `DELETE /api/atlas/v2/groups/:groupId` deletes a project and cascades clusters and data.
- `GET /api/atlas/v2/groups/:groupId/clusters` lists clusters.
- `GET /api/atlas/v2/groups/:groupId/clusters/:clusterName` gets a cluster.
- `POST /api/atlas/v2/groups/:groupId/clusters` creates a cluster.
- `PATCH /api/atlas/v2/groups/:groupId/clusters/:clusterName` updates a cluster.
- `DELETE /api/atlas/v2/groups/:groupId/clusters/:clusterName` deletes a cluster.
- `GET /api/atlas/v2/groups/:groupId/databaseUsers` lists database users.
- `GET /api/atlas/v2/groups/:groupId/databaseUsers/admin/:username` gets a database user.
- `POST /api/atlas/v2/groups/:groupId/databaseUsers` creates a database user.
- `DELETE /api/atlas/v2/groups/:groupId/databaseUsers/admin/:username` deletes a database user.
- `GET /api/atlas/v2/groups/:groupId/clusters/:clusterName/databases` lists databases.
- `GET /api/atlas/v2/groups/:groupId/clusters/:clusterName/databases/:databaseName/collections` lists collections.

## Data API

All Data API routes accept JSON bodies with `dataSource`, `database`, and `collection`.

- `POST /app/data-api/v1/action/findOne`
- `POST /app/data-api/v1/action/find`
- `POST /app/data-api/v1/action/insertOne`
- `POST /app/data-api/v1/action/insertMany`
- `POST /app/data-api/v1/action/updateOne`
- `POST /app/data-api/v1/action/updateMany`
- `POST /app/data-api/v1/action/deleteOne`
- `POST /app/data-api/v1/action/deleteMany`
- `POST /app/data-api/v1/action/aggregate`

Supported document filters include equality, dotted paths, `$and`, `$or`, `$nor`, `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin`, `$exists`, and `$regex`. Supported updates include `$set`, `$unset`, `$inc`, `$push`, `$pull`, `$rename`, replacement updates, and upserts.

## Seed Config

```yaml
mongoatlas:
  projects:
    - name: my-project
  clusters:
    - project: my-project
      name: my-cluster
  database_users:
    - project: my-project
      username: app-user
      roles:
        - database_name: mydb
          role_name: readWrite
  databases:
    - cluster: my-cluster
      name: mydb
      collections:
        - items
```
