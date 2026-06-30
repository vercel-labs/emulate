---
name: mongoatlas
description: Emulated MongoDB Atlas API for local development and testing. Use when the user needs to manage Atlas projects and clusters locally, perform CRUD operations via the Data API, test MongoDB Atlas integrations, or work with the Atlas Admin API without hitting the real Atlas API. Triggers include "MongoDB Atlas", "Atlas Data API", "emulate MongoDB", "Atlas cluster", "atlas admin", or any task requiring a local MongoDB Atlas API.
allowed-tools: Bash(npx emulate:*), Bash(emulate:*), Bash(curl:*)
---

# MongoDB Atlas API Emulator

Fully stateful MongoDB Atlas emulation with two API surfaces: the Atlas Admin API for infrastructure management (projects, clusters, database users) and the Data API for document CRUD and aggregation. All state persists in memory.

## Start

```bash
# MongoDB Atlas only
npx emulate --service mongoatlas

# Default port (when run alone)
# http://localhost:4000
```

Or programmatically:

```typescript
import { createEmulator } from 'emulate'

const atlas = await createEmulator({ service: 'mongoatlas', port: 4000 })
// atlas.url === 'http://localhost:4000'
```

## Auth

Admin API endpoints accept any API key. The Data API accepts any `api-key` header value.

```bash
# Admin API
curl http://localhost:4000/api/atlas/v2/groups \
  -H "Authorization: Bearer test_api_key"

# Data API
curl -X POST http://localhost:4000/app/data-api/v1/action/find \
  -H "api-key: test_api_key" \
  -H "Content-Type: application/json" \
  -d '{"dataSource": "Cluster0", "database": "mydb", "collection": "users"}'
```

## Pointing Your App at the Emulator

### Environment Variable

```bash
MONGODB_ATLAS_API_BASE=http://localhost:4000
MONGODB_DATA_API_BASE=http://localhost:4000
```

### Embedded in Next.js (adapter-next)

```typescript
// next.config.ts
import { withEmulate } from '@emulators/adapter-next'

export default withEmulate({
  env: {
    MONGODB_ATLAS_API_BASE: `http://localhost:${process.env.PORT ?? '3000'}/emulate/mongoatlas`,
    MONGODB_DATA_API_BASE: `http://localhost:${process.env.PORT ?? '3000'}/emulate/mongoatlas`,
  },
})
```

```typescript
// app/emulate/[...path]/route.ts
import { createEmulateHandler } from '@emulators/adapter-next'
import * as mongoatlas from '@emulators/mongoatlas'

export const { GET, POST, PUT, PATCH, DELETE } = createEmulateHandler({
  services: {
    mongoatlas: {
      emulator: mongoatlas,
      seed: {
        clusters: [
          { name: 'Cluster0', project: 'Project0', instance_size: 'M10', region: 'US_EAST_1' },
        ],
        databases: [
          { cluster: 'Cluster0', name: 'mydb', collections: ['users', 'posts'] },
        ],
      },
    },
  },
})
```

## Seed Config

```yaml
mongoatlas:
  projects:
    - name: Project0
      org_id: my_org
  clusters:
    - name: Cluster0
      project: Project0
      provider: AWS
      instance_size: M10
      region: US_EAST_1
      disk_size_gb: 10
      mongodb_version: "7.0"
  database_users:
    - username: admin
      project: Project0
      roles:
        - database_name: admin
          role_name: atlasAdmin
  databases:
    - cluster: Cluster0
      name: mydb
      collections:
        - users
        - posts
```

Without seed config, the emulator creates a default Project0 with one M10 cluster.

## API Endpoints

### Admin API - Projects

```bash
BASE="http://localhost:4000"

# List projects
curl $BASE/api/atlas/v2/groups

# Get project by ID
curl $BASE/api/atlas/v2/groups/<groupId>

# Create project
curl -X POST $BASE/api/atlas/v2/groups \
  -H "Content-Type: application/json" \
  -d '{"name": "New Project", "orgId": "my_org"}'

# Delete project
curl -X DELETE $BASE/api/atlas/v2/groups/<groupId>
```

### Admin API - Clusters

Cluster states: `IDLE`, `CREATING`, `UPDATING`, `DELETING`, `DELETED`, `REPAIRING`.

```bash
# List clusters in project
curl $BASE/api/atlas/v2/groups/<groupId>/clusters

# Get cluster by name
curl $BASE/api/atlas/v2/groups/<groupId>/clusters/<clusterName>

# Create cluster
curl -X POST $BASE/api/atlas/v2/groups/<groupId>/clusters \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Analytics",
    "clusterType": "REPLICASET",
    "providerSettings": {
      "providerName": "AWS",
      "instanceSizeName": "M10",
      "regionName": "US_EAST_1"
    }
  }'

# Update cluster
curl -X PATCH $BASE/api/atlas/v2/groups/<groupId>/clusters/<clusterName> \
  -H "Content-Type: application/json" \
  -d '{"providerSettings": {"instanceSizeName": "M20"}}'

# Delete cluster
curl -X DELETE $BASE/api/atlas/v2/groups/<groupId>/clusters/<clusterName>
```

Clusters include connection strings in their response:

```json
{
  "connectionStrings": {
    "standard": "mongodb://localhost:27017",
    "standardSrv": "mongodb+srv://cluster0.emulate.local"
  }
}
```

### Admin API - Database Users

```bash
# List database users
curl $BASE/api/atlas/v2/groups/<groupId>/databaseUsers

# Get database user
curl $BASE/api/atlas/v2/groups/<groupId>/databaseUsers/admin/<username>

# Create database user
curl -X POST $BASE/api/atlas/v2/groups/<groupId>/databaseUsers \
  -H "Content-Type: application/json" \
  -d '{
    "databaseName": "admin",
    "username": "readonly",
    "roles": [{"databaseName": "mydb", "roleName": "read"}]
  }'

# Delete database user
curl -X DELETE $BASE/api/atlas/v2/groups/<groupId>/databaseUsers/admin/<username>
```

### Admin API - Databases and Collections

```bash
# List databases in cluster
curl $BASE/api/atlas/v2/groups/<groupId>/clusters/<clusterName>/databases

# List collections in database
curl $BASE/api/atlas/v2/groups/<groupId>/clusters/<clusterName>/databases/<databaseName>/collections
```

### Data API - Document Operations

All Data API operations use `POST` and require `dataSource`, `database`, and `collection` in the request body.

```bash
BASE="http://localhost:4000"
HEADERS='-H "Content-Type: application/json" -H "api-key: test_api_key"'

# Find one document
curl -X POST $BASE/app/data-api/v1/action/findOne \
  -H "Content-Type: application/json" \
  -H "api-key: test_api_key" \
  -d '{"dataSource": "Cluster0", "database": "mydb", "collection": "users", "filter": {"email": "jane@example.com"}}'

# Find documents (supports filter, projection, sort, limit, skip)
curl -X POST $BASE/app/data-api/v1/action/find \
  -H "Content-Type: application/json" \
  -H "api-key: test_api_key" \
  -d '{
    "dataSource": "Cluster0",
    "database": "mydb",
    "collection": "users",
    "filter": {"status": "active"},
    "sort": {"createdAt": -1},
    "limit": 10,
    "projection": {"name": 1, "email": 1}
  }'

# Insert one document
curl -X POST $BASE/app/data-api/v1/action/insertOne \
  -H "Content-Type: application/json" \
  -H "api-key: test_api_key" \
  -d '{
    "dataSource": "Cluster0",
    "database": "mydb",
    "collection": "users",
    "document": {"name": "Jane", "email": "jane@example.com", "status": "active"}
  }'

# Insert many documents
curl -X POST $BASE/app/data-api/v1/action/insertMany \
  -H "Content-Type: application/json" \
  -H "api-key: test_api_key" \
  -d '{
    "dataSource": "Cluster0",
    "database": "mydb",
    "collection": "users",
    "documents": [
      {"name": "Alice", "email": "alice@example.com"},
      {"name": "Bob", "email": "bob@example.com"}
    ]
  }'

# Update one document (supports $set, $unset, $inc, $push, $pull, $addToSet)
curl -X POST $BASE/app/data-api/v1/action/updateOne \
  -H "Content-Type: application/json" \
  -H "api-key: test_api_key" \
  -d '{
    "dataSource": "Cluster0",
    "database": "mydb",
    "collection": "users",
    "filter": {"email": "jane@example.com"},
    "update": {"$set": {"status": "inactive"}, "$inc": {"loginCount": 1}}
  }'

# Update many documents
curl -X POST $BASE/app/data-api/v1/action/updateMany \
  -H "Content-Type: application/json" \
  -H "api-key: test_api_key" \
  -d '{
    "dataSource": "Cluster0",
    "database": "mydb",
    "collection": "users",
    "filter": {"status": "inactive"},
    "update": {"$set": {"archived": true}}
  }'

# Delete one document
curl -X POST $BASE/app/data-api/v1/action/deleteOne \
  -H "Content-Type: application/json" \
  -H "api-key: test_api_key" \
  -d '{
    "dataSource": "Cluster0",
    "database": "mydb",
    "collection": "users",
    "filter": {"email": "jane@example.com"}
  }'

# Delete many documents
curl -X POST $BASE/app/data-api/v1/action/deleteMany \
  -H "Content-Type: application/json" \
  -H "api-key: test_api_key" \
  -d '{
    "dataSource": "Cluster0",
    "database": "mydb",
    "collection": "users",
    "filter": {"status": "inactive"}
  }'

# Aggregate (supports $match, $group, $sort, $limit, $skip, $project, $count, $unwind)
curl -X POST $BASE/app/data-api/v1/action/aggregate \
  -H "Content-Type: application/json" \
  -H "api-key: test_api_key" \
  -d '{
    "dataSource": "Cluster0",
    "database": "mydb",
    "collection": "users",
    "pipeline": [
      {"$match": {"status": "active"}},
      {"$group": {"_id": "$role", "count": {"$sum": 1}}},
      {"$sort": {"count": -1}}
    ]
  }'
```

Both `updateOne` and `updateMany` support `upsert: true`.

## Common Patterns

### Project + Cluster + CRUD Flow

```typescript
import { createEmulator } from 'emulate'

const emu = await createEmulator({ service: 'mongoatlas', port: 4000 })
const BASE = emu.url
const headers = { 'Content-Type': 'application/json', 'api-key': 'test_api_key' }

// Insert a document
await fetch(`${BASE}/app/data-api/v1/action/insertOne`, {
  method: 'POST',
  headers,
  body: JSON.stringify({
    dataSource: 'Cluster0',
    database: 'mydb',
    collection: 'users',
    document: { name: 'Jane', email: 'jane@example.com', tags: ['admin'] },
  }),
})

// Query it back
const res = await fetch(`${BASE}/app/data-api/v1/action/findOne`, {
  method: 'POST',
  headers,
  body: JSON.stringify({
    dataSource: 'Cluster0',
    database: 'mydb',
    collection: 'users',
    filter: { email: 'jane@example.com' },
  }),
})
const { document } = await res.json()
// document.name === 'Jane'

// Update with operators
await fetch(`${BASE}/app/data-api/v1/action/updateOne`, {
  method: 'POST',
  headers,
  body: JSON.stringify({
    dataSource: 'Cluster0',
    database: 'mydb',
    collection: 'users',
    filter: { email: 'jane@example.com' },
    update: { '$push': { tags: 'verified' }, '$inc': { loginCount: 1 } },
  }),
})
```
