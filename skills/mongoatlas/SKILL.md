---
name: mongoatlas
description: Emulated MongoDB Atlas Admin API v2 and Data API v1 for local development and testing. Use when the user needs to manage Atlas projects, clusters, database users, databases, collections, or test MongoDB Data API document operations without hitting real Atlas. Triggers include "MongoDB Atlas", "Atlas Data API", "emulate Atlas", "local MongoDB Atlas", "mongoatlas", "MONGOATLAS_EMULATOR_URL", or any task requiring a local Atlas API.
allowed-tools: Bash(npx emulate:*), Bash(emulate:*), Bash(curl:*)
---

# MongoDB Atlas Emulator

MongoDB Atlas Admin API v2 and Data API v1 emulation with in-memory projects, clusters, database users, databases, collections, and documents.

## Start

```bash
# MongoDB Atlas only
npx emulate --service mongoatlas

# Default port when run alone
# http://localhost:4000
```

Or programmatically:

```typescript
import { createEmulator } from 'emulate'

const atlas = await createEmulator({ service: 'mongoatlas', port: 4010 })
// atlas.url === 'http://localhost:4010'
```

## Pointing Your App at the Emulator

```bash
MONGOATLAS_EMULATOR_URL=http://localhost:4010
```

Use the emulator URL as the base URL for Atlas Admin API or Data API calls.

```bash
curl "$MONGOATLAS_EMULATOR_URL/api/atlas/v2/groups" \
  -H "Authorization: Bearer test_token_admin"
```

## Seed Config

```yaml
mongoatlas:
  projects:
    - name: Project0
  clusters:
    - name: Cluster0
      project: Project0
  database_users:
    - username: admin
      project: Project0
  databases:
    - cluster: Cluster0
      name: test
      collections: [items]
```

## Admin API Endpoints

- `GET /api/atlas/v2/groups`
- `POST /api/atlas/v2/groups`
- `GET /api/atlas/v2/groups/:groupId`
- `DELETE /api/atlas/v2/groups/:groupId`
- `GET /api/atlas/v2/groups/:groupId/clusters`
- `POST /api/atlas/v2/groups/:groupId/clusters`
- `GET /api/atlas/v2/groups/:groupId/clusters/:clusterName`
- `PATCH /api/atlas/v2/groups/:groupId/clusters/:clusterName`
- `DELETE /api/atlas/v2/groups/:groupId/clusters/:clusterName`
- `GET /api/atlas/v2/groups/:groupId/databaseUsers`
- `POST /api/atlas/v2/groups/:groupId/databaseUsers`
- `GET /api/atlas/v2/groups/:groupId/databaseUsers/admin/:username`
- `DELETE /api/atlas/v2/groups/:groupId/databaseUsers/admin/:username`
- `GET /api/atlas/v2/groups/:groupId/clusters/:clusterName/databases`
- `GET /api/atlas/v2/groups/:groupId/clusters/:clusterName/databases/:databaseName/collections`

## Data API Endpoints

All Data API operations use `POST` with `dataSource`, `database`, and `collection` in the JSON body.

- `/app/data-api/v1/action/findOne`
- `/app/data-api/v1/action/find`
- `/app/data-api/v1/action/insertOne`
- `/app/data-api/v1/action/insertMany`
- `/app/data-api/v1/action/updateOne`
- `/app/data-api/v1/action/updateMany`
- `/app/data-api/v1/action/deleteOne`
- `/app/data-api/v1/action/deleteMany`
- `/app/data-api/v1/action/aggregate`
