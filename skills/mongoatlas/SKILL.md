---
name: mongoatlas
description: Emulated MongoDB Atlas Admin API v2 and Data API v1 for local development and testing. Use when the user needs to manage Atlas projects, clusters or database users locally, run document CRUD and aggregations through the Data API, or work with MongoDB Atlas without hitting the real service. Triggers include "MongoDB Atlas", "Atlas Admin API", "Atlas Data API", "emulate Atlas", "mock MongoDB", "local Atlas cluster", or any task requiring a local MongoDB Atlas API.
allowed-tools: Bash(npx emulate:*), Bash(curl:*)
---

# MongoDB Atlas Emulator

Atlas Admin API v2 and Atlas Data API v1 emulation with in-memory document
storage supporting CRUD, filtering, and aggregation. State resets when the
process restarts.

## Start

```bash
# MongoDB Atlas only, pinned to the port used throughout this guide
npx emulate --service mongoatlas --port 4010

# Or run all 14 services; MongoDB Atlas is the 11th, so it also lands on 4010
npx emulate
```

Ports are `--port` (default 4000) plus the service's index in the **enabled**
set, so a bare `npx emulate --service mongoatlas` puts it on 4000, not 4010. The
`--port 4010` above makes every example on this page valid in both modes. To pin
the port no matter what else runs, set `mongoatlas.port` in the seed config.

Or programmatically:

```typescript
import { createEmulator } from 'emulate'

const atlas = await createEmulator({ service: 'mongoatlas', port: 4010 })
// atlas.url === 'http://localhost:4010'
```

## Auth

Pass tokens as `Authorization: Bearer <token>`. Any non-empty token is accepted
and unrecognized ones resolve to the fallback user; a request with **no**
`Authorization` header is unauthenticated and protected routes return 401.

## Pointing Your App at the Emulator

There is no SDK option to override — replace the Atlas API host in your own base
URL:

```bash
MONGOATLAS_EMULATOR_URL=http://localhost:4010
```

| Real Atlas URL | Emulator URL |
|---|---|
| `https://cloud.mongodb.com/api/atlas/v2/...` | `$MONGOATLAS_EMULATOR_URL/api/atlas/v2/...` |
| `https://data.mongodb-api.com/app/<id>/endpoint/data/v1/action/...` | `$MONGOATLAS_EMULATOR_URL/app/data-api/v1/action/...` |

## Default Seed

With no configuration: one project `Project0` with a default org, and one
cluster inside it.

## Seed Config

```yaml
mongoatlas:
  projects:
    - name: my-project
      org_id: my-org # optional
  clusters:
    - name: my-cluster
      project: my-project # must match a projects[].name
      provider: AWS
      instance_size: M10
      region: US_EAST_1
      disk_size_gb: 10
      mongodb_version: "7.0"
  database_users:
    - username: app-user
      project: my-project # must match a projects[].name
      roles:
        - database_name: appdb
          role_name: readWrite
  databases:
    - cluster: my-cluster # must match a clusters[].name
      name: appdb
      collections: [users, orders]
```

Seed config is never validated, so an unknown key is dropped silently. The
cross-references matter: `clusters[].project` and `database_users[].project` must
match a seeded project name, and `databases[].cluster` must match a seeded
cluster name, or the entry is skipped without a warning.

## Admin API

```bash
# Projects
curl http://localhost:4010/api/atlas/v2/groups \
  -H "Authorization: Bearer $TOKEN"
curl http://localhost:4010/api/atlas/v2/groups/$GROUP_ID \
  -H "Authorization: Bearer $TOKEN"
curl -X POST http://localhost:4010/api/atlas/v2/groups \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"my-project"}'
# Deleting a project cascades to its clusters and data
curl -X DELETE http://localhost:4010/api/atlas/v2/groups/$GROUP_ID \
  -H "Authorization: Bearer $TOKEN"

# Clusters
curl http://localhost:4010/api/atlas/v2/groups/$GROUP_ID/clusters \
  -H "Authorization: Bearer $TOKEN"
curl -X POST http://localhost:4010/api/atlas/v2/groups/$GROUP_ID/clusters \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"my-cluster"}'
curl -X PATCH http://localhost:4010/api/atlas/v2/groups/$GROUP_ID/clusters/my-cluster \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"diskSizeGB":20}'
curl -X DELETE http://localhost:4010/api/atlas/v2/groups/$GROUP_ID/clusters/my-cluster \
  -H "Authorization: Bearer $TOKEN"

# Database users (note the /admin/ segment on get and delete)
curl http://localhost:4010/api/atlas/v2/groups/$GROUP_ID/databaseUsers \
  -H "Authorization: Bearer $TOKEN"
curl http://localhost:4010/api/atlas/v2/groups/$GROUP_ID/databaseUsers/admin/app-user \
  -H "Authorization: Bearer $TOKEN"
curl -X POST http://localhost:4010/api/atlas/v2/groups/$GROUP_ID/databaseUsers \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"username":"app-user","roles":[{"databaseName":"appdb","roleName":"readWrite"}]}'
curl -X DELETE http://localhost:4010/api/atlas/v2/groups/$GROUP_ID/databaseUsers/admin/app-user \
  -H "Authorization: Bearer $TOKEN"

# Data explorer
curl http://localhost:4010/api/atlas/v2/groups/$GROUP_ID/clusters/my-cluster/databases \
  -H "Authorization: Bearer $TOKEN"
curl http://localhost:4010/api/atlas/v2/groups/$GROUP_ID/clusters/my-cluster/databases/appdb/collections \
  -H "Authorization: Bearer $TOKEN"
```

## Data API

Every action is a `POST` whose JSON body names `dataSource`, `database` and
`collection`:

```bash
BASE=http://localhost:4010/app/data-api/v1/action

# Insert
curl -X POST $BASE/insertOne \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"dataSource":"my-cluster","database":"appdb","collection":"users","document":{"name":"Ada"}}'

curl -X POST $BASE/insertMany \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"dataSource":"my-cluster","database":"appdb","collection":"users","documents":[{"name":"Grace"},{"name":"Alan"}]}'

# Read
curl -X POST $BASE/findOne \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"dataSource":"my-cluster","database":"appdb","collection":"users","filter":{"name":"Ada"}}'

curl -X POST $BASE/find \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"dataSource":"my-cluster","database":"appdb","collection":"users","filter":{},"sort":{"name":1},"limit":10,"skip":0}'

# Update (supports $set and upsert)
curl -X POST $BASE/updateOne \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"dataSource":"my-cluster","database":"appdb","collection":"users","filter":{"name":"Ada"},"update":{"$set":{"role":"admin"}},"upsert":true}'

curl -X POST $BASE/updateMany \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"dataSource":"my-cluster","database":"appdb","collection":"users","filter":{},"update":{"$set":{"active":true}}}'

# Delete
curl -X POST $BASE/deleteOne \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"dataSource":"my-cluster","database":"appdb","collection":"users","filter":{"name":"Alan"}}'

curl -X POST $BASE/deleteMany \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"dataSource":"my-cluster","database":"appdb","collection":"users","filter":{}}'

# Aggregate — supports $match, $limit, $skip, $sort, $project, $count
curl -X POST $BASE/aggregate \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"dataSource":"my-cluster","database":"appdb","collection":"users","pipeline":[{"$match":{"active":true}},{"$sort":{"name":1}},{"$limit":5}]}'
```

Only the aggregation stages listed above are implemented; other stages are not
supported.
