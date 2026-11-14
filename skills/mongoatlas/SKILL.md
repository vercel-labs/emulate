---
name: mongoatlas
description: Emulated MongoDB Atlas for local development and testing. Use when the user needs to manage Atlas projects, clusters, and database users through the Atlas Administration API v2 locally, run document CRUD and aggregation through the Atlas Data API v1, seed Atlas data for tests, or test an Atlas integration without a real Atlas organization. Triggers include "MongoDB Atlas", "Atlas Admin API", "Atlas Data API", "emulate MongoDB Atlas", "mock Atlas", "Atlas cluster", "data-api action", or any task requiring a local MongoDB Atlas API.
allowed-tools: Bash(npx emulate:*), Bash(curl:*)
---

# MongoDB Atlas Emulator

MongoDB Atlas emulation with two HTTP surfaces: the Atlas Administration API v2 for projects, clusters, and database users, and the Atlas Data API v1 for document CRUD and aggregation. Documents live in memory. The emulator speaks HTTP only; it does not run a MongoDB wire protocol server, so the MongoDB drivers and `mongodb+srv://` connection strings it returns can't connect to it.

MongoDB retired the hosted Data API on September 30, 2025. The emulator keeps it for code and tests that still call it.

## Start

Local listeners bind to `127.0.0.1` by default. For access from containers or other machines, pass `--host 0.0.0.0` to the CLI or `hostname: '0.0.0.0'` to `createEmulator`. Configure `--base-url` or `baseUrl` for advertised URLs reachable by those clients.

```bash
# MongoDB Atlas only
npx emulate --service mongoatlas

# Default port (when run alone)
# http://localhost:4000
```

When all services start together, MongoDB Atlas listens on `http://localhost:4010`.

Or programmatically:

```typescript
import { createEmulator } from 'emulate'

const atlas = await createEmulator({ service: 'mongoatlas', port: 4010 })
// atlas.url === 'http://localhost:4010'
```

## Pointing Your App at the Emulator

Replace the Atlas hosts with the emulator URL. The examples below read it from `MONGOATLAS_EMULATOR_URL`, a variable your app defines; Atlas SDKs don't read it on their own.

```bash
MONGOATLAS_EMULATOR_URL=http://localhost:4010
```

| Real Atlas URL | Emulator URL |
|----------------|-------------|
| `https://cloud.mongodb.com/api/atlas/v2/groups` | `$MONGOATLAS_EMULATOR_URL/api/atlas/v2/groups` |
| `https://cloud.mongodb.com/api/atlas/v2/groups/{groupId}/clusters` | `$MONGOATLAS_EMULATOR_URL/api/atlas/v2/groups/{groupId}/clusters` |
| `https://data.mongodb-api.com/app/{appId}/endpoint/data/v1/action/{action}` | `$MONGOATLAS_EMULATOR_URL/app/data-api/v1/action/{action}` |

The Data API path has no app ID. Use the fixed `/app/data-api/v1` prefix.

### Embedded in Next.js

```typescript
// app/emulate/[...path]/route.ts
import { createEmulateHandler } from '@emulators/adapter-next'
import * as mongoatlas from '@emulators/mongoatlas'

export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = createEmulateHandler({
  services: {
    mongoatlas: {
      emulator: mongoatlas,
      seed: {
        databases: [{ cluster: 'Cluster0', name: 'app', collections: ['users'] }],
      },
    },
  },
})
```

The emulator is then served at `/emulate/mongoatlas/**` on your app's origin.

## Authentication

The emulator doesn't check credentials on either surface. Requests succeed without HTTP Digest auth, a service account token, or an `api-key` header, so you can send whatever your client already sends. It also ignores the versioned `Accept: application/vnd.atlas.<date>+json` header that real Admin API requests carry.

## Seed Config

Every start creates the default data first: project `Project0`, cluster `Cluster0` (AWS, `M10`, `US_EAST_1`, MongoDB `8.0`), database user `admin` with the `atlasAdmin` role, and database `test` with collection `items`. Seed config adds to it.

```yaml
mongoatlas:
  projects:
    - name: my-project
      org_id: my-org            # default: default_org
  clusters:
    - name: my-cluster
      project: my-project       # project name; Project0 also works
      provider: AWS             # default: AWS
      instance_size: M10        # default: M10
      region: US_EAST_1         # default: US_EAST_1
      disk_size_gb: 10          # default: 10
      mongodb_version: "8.0"    # default: "8.0"
  database_users:
    - username: app-user
      project: my-project
      roles:                    # default: readWriteAnyDatabase on admin
        - database_name: app
          role_name: readWrite
  databases:
    - cluster: my-cluster       # cluster name
      name: app
      collections: [users, posts]
```

Entries that name an unknown project or cluster are skipped. Entries that already exist, matched by name, are left as they are.

## Admin API

Responses use Atlas field names in camelCase. Lists return `{ "results": [...], "totalCount": n }`. Errors return `{ "error": <status>, "errorCode": "...", "detail": "..." }`, with codes such as `GROUP_NOT_FOUND`, `CLUSTER_NOT_FOUND`, `USER_NOT_FOUND`, and `INVALID_PARAMETER`.

### Projects

- `GET /api/atlas/v2/groups` — list projects
- `GET /api/atlas/v2/groups/:groupId` — get a project; `404 GROUP_NOT_FOUND` if missing
- `POST /api/atlas/v2/groups` — create a project from `name` and optional `orgId`; returns `201`, or `409 DUPLICATE_GROUP_NAME` for a taken name
- `DELETE /api/atlas/v2/groups/:groupId` — delete a project with its clusters and their documents; returns `204`

A project has `id`, `name`, `orgId`, `clusterCount`, and `created`.

### Clusters

- `GET /api/atlas/v2/groups/:groupId/clusters` — list clusters in a project
- `GET /api/atlas/v2/groups/:groupId/clusters/:clusterName` — get a cluster
- `POST /api/atlas/v2/groups/:groupId/clusters` — create a cluster; returns `201`, or `409 DUPLICATE_CLUSTER_NAME`
- `PATCH /api/atlas/v2/groups/:groupId/clusters/:clusterName` — change `providerSettings.instanceSizeName`, `providerSettings.regionName`, or `diskSizeGB`
- `DELETE /api/atlas/v2/groups/:groupId/clusters/:clusterName` — delete a cluster with its databases, collections, and documents; returns `204`

Create accepts `name` (required), `clusterType` (`REPLICASET` or `SHARDED`, default `REPLICASET`), `providerSettings.providerName`, `providerSettings.instanceSizeName`, `providerSettings.regionName`, `diskSizeGB`, and `mongoDBMajorVersion`, with the same defaults as seed config. This is the flat `providerSettings` shape; the `replicationSpecs` body of newer Atlas API versions is not read.

A cluster has `id`, `name`, `groupId`, `stateName` (always `IDLE`), `mongoURI`, `connectionStrings.standard`, `connectionStrings.standardSrv`, `providerSettings`, `clusterType`, `diskSizeGB`, `mongoDBVersion`, and `created`. For a cluster named `Cluster0`, `connectionStrings.standardSrv` is `mongodb+srv://Cluster0.emulate.mongodb.net`.

### Database users

- `GET /api/atlas/v2/groups/:groupId/databaseUsers` — list database users in a project
- `GET /api/atlas/v2/groups/:groupId/databaseUsers/admin/:username` — get a database user
- `POST /api/atlas/v2/groups/:groupId/databaseUsers` — create a user from `username` and `roles` (`[{ "databaseName", "roleName" }]`, default none); returns `201`, or `409 DUPLICATE_USER`
- `DELETE /api/atlas/v2/groups/:groupId/databaseUsers/admin/:username` — delete a database user; returns `204`

Only the `admin` authentication database is supported in the path, and every user reports `databaseName: "admin"`. A `password` in the create body is accepted and discarded.

### Databases and collections

These two routes are emulator additions for inspecting what the Data API stored. Atlas Administration API v2 has no equivalent.

- `GET /api/atlas/v2/groups/:groupId/clusters/:clusterName/databases` — list databases as `{ "databaseName" }`
- `GET /api/atlas/v2/groups/:groupId/clusters/:clusterName/databases/:databaseName/collections` — list collections as `{ "collectionName", "databaseName" }`

## Data API

Every action is a `POST` to `/app/data-api/v1/action/:action` with a JSON body naming `dataSource` (a cluster name), `database`, and `collection`. A missing field returns `400 InvalidParameter`; an unknown cluster returns `404 ClusterNotFound`. Writes create the database and collection on first use.

- `POST /app/data-api/v1/action/findOne` — `filter`, `projection`; returns `{ "document": {...} | null }`
- `POST /app/data-api/v1/action/find` — `filter`, `projection`, `sort`, `skip`, `limit`; returns `{ "documents": [...] }`
- `POST /app/data-api/v1/action/insertOne` — `document`; returns `201` with `{ "insertedId" }`
- `POST /app/data-api/v1/action/insertMany` — `documents`; returns `201` with `{ "insertedIds": [...] }`
- `POST /app/data-api/v1/action/updateOne` — `filter`, `update`, `upsert`; returns `{ "matchedCount", "modifiedCount" }`, plus `upsertedId` on upsert
- `POST /app/data-api/v1/action/updateMany` — `filter`, `update`, `upsert`; same response shape
- `POST /app/data-api/v1/action/deleteOne` — `filter`; returns `{ "deletedCount" }`
- `POST /app/data-api/v1/action/deleteMany` — `filter`; returns `{ "deletedCount" }`
- `POST /app/data-api/v1/action/aggregate` — `pipeline`; returns `{ "documents": [...] }`

Documents without an `_id` get a 24-character hex string ID. IDs are plain strings, not Extended JSON `{ "$oid": ... }` values.

### Filters

A missing or empty `filter` matches every document. Supported:

- Field equality on scalar values, including dot paths such as `"address.city"`. A scalar doesn't match an element inside an array field, an array value never matches, and an embedded document value such as `{ "address": { "city": "Lima" } }` matches every document, so filter on the dot path instead.
- `$eq`, `$ne`, `$in`, `$nin`, `$exists`
- `$gt`, `$gte`, `$lt`, `$lte`, which compare numbers only
- `$regex`, with `$options` for flags
- `$and`, `$or`, `$nor`

Unknown operators inside a field condition, such as `$type` or `$size`, are ignored. Top-level operators other than `$and`, `$or`, and `$nor` are read as field names, so `$expr` and `$where` match nothing.

### Projection and sort

Projection works on top-level fields. Use `1` to include fields (`_id` stays unless set to `0`) or `0` to exclude them. `sort` takes `{ field: 1 }` or `{ field: -1 }`. `find` applies the filter, then sort, `skip`, and `limit`.

### Updates

- `$set`, `$unset`, `$inc`, `$rename`, with dot paths
- `$push` appends one value and creates the array if needed
- `$pull` removes elements equal to a value
- An `update` without operators replaces the document and keeps its `_id`

On upsert with no match, the new document starts from the filter's plain equality fields and then receives the update. `updateOne` reports `modifiedCount: 1` whenever a document matched, even if nothing changed.

### Aggregation

Supported stages: `$match`, `$sort`, `$skip`, `$limit`, `$project`, and `$count`. Other stages, including `$group`, `$unwind`, and `$lookup`, are skipped without an error, so check results when you port a pipeline.

## Common Patterns

### Create a project and cluster

```bash
URL=http://localhost:4010

GROUP_ID=$(curl -s -X POST $URL/api/atlas/v2/groups \
  -H "Content-Type: application/json" \
  -d '{"name": "staging"}' | jq -r .id)

curl -s -X POST $URL/api/atlas/v2/groups/$GROUP_ID/clusters \
  -H "Content-Type: application/json" \
  -d '{"name": "StagingCluster", "providerSettings": {"providerName": "AWS", "instanceSizeName": "M20", "regionName": "EU_WEST_1"}}'
```

### Insert, query, and update documents

```typescript
const base = `${process.env.MONGOATLAS_EMULATOR_URL}/app/data-api/v1/action`
const target = { dataSource: 'Cluster0', database: 'app', collection: 'users' }

async function action(name: string, body: Record<string, unknown>) {
  const res = await fetch(`${base}/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...target, ...body }),
  })
  return res.json()
}

const { insertedId } = await action('insertOne', {
  document: { name: 'Jane', email: 'jane@example.com', logins: 0 },
})

await action('updateOne', {
  filter: { _id: insertedId },
  update: { $inc: { logins: 1 }, $push: { tags: 'verified' } },
})

const { documents } = await action('find', {
  filter: { logins: { $gte: 1 } },
  projection: { name: 1, logins: 1 },
  sort: { name: 1 },
})
// documents: [{ _id: insertedId, name: 'Jane', logins: 1 }]
```

### Count matching documents

```bash
curl -s -X POST http://localhost:4010/app/data-api/v1/action/aggregate \
  -H "Content-Type: application/json" \
  -d '{"dataSource": "Cluster0", "database": "app", "collection": "users",
       "pipeline": [{"$match": {"logins": {"$gt": 0}}}, {"$count": "active"}]}'
# {"documents":[{"active":1}]}
```
