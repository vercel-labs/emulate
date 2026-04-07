# @emulators/mongoatlas

MongoDB Atlas emulation with Atlas Admin API v2 and Atlas Data API v1 for local development and testing. In-memory document storage with CRUD, filtering, and aggregation.

Part of [emulate](https://github.com/vercel-labs/emulate) — local drop-in replacement services for CI and no-network sandboxes.

## Install

```bash
npm install @emulators/mongoatlas
```

## Endpoints

### Admin API

#### Projects
- `GET /api/atlas/v2/groups` — list projects
- `GET /api/atlas/v2/groups/:groupId` — get project
- `POST /api/atlas/v2/groups` — create project
- `DELETE /api/atlas/v2/groups/:groupId` — delete project (cascades clusters and data)

#### Clusters
- `GET /api/atlas/v2/groups/:groupId/clusters` — list clusters
- `GET /api/atlas/v2/groups/:groupId/clusters/:clusterName` — get cluster
- `POST /api/atlas/v2/groups/:groupId/clusters` — create cluster
- `PATCH /api/atlas/v2/groups/:groupId/clusters/:clusterName` — update cluster
- `DELETE /api/atlas/v2/groups/:groupId/clusters/:clusterName` — delete cluster

#### Database Users
- `GET /api/atlas/v2/groups/:groupId/databaseUsers` — list database users
- `GET /api/atlas/v2/groups/:groupId/databaseUsers/admin/:username` — get database user
- `POST /api/atlas/v2/groups/:groupId/databaseUsers` — create database user
- `DELETE /api/atlas/v2/groups/:groupId/databaseUsers/admin/:username` — delete database user

#### Data Explorer
- `GET /api/atlas/v2/groups/:groupId/clusters/:clusterName/databases` — list databases
- `GET /api/atlas/v2/groups/:groupId/clusters/:clusterName/databases/:databaseName/collections` — list collections

### Data API

All operations via `POST` with JSON body specifying `dataSource`, `database`, and `collection`:

- `POST /app/data-api/v1/action/findOne` — find one document
- `POST /app/data-api/v1/action/find` — find many (filter, projection, sort, limit, skip)
- `POST /app/data-api/v1/action/insertOne` — insert one document
- `POST /app/data-api/v1/action/insertMany` — insert many documents
- `POST /app/data-api/v1/action/updateOne` — update one document (`$set`, upsert)
- `POST /app/data-api/v1/action/updateMany` — update many documents
- `POST /app/data-api/v1/action/deleteOne` — delete one document
- `POST /app/data-api/v1/action/deleteMany` — delete many documents
- `POST /app/data-api/v1/action/aggregate` — aggregation pipeline (`$match`, `$limit`, `$skip`, `$sort`, `$project`, `$count`)

## Seed Configuration

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
```

## Links

- [Full documentation](https://emulate.dev)
- [GitHub](https://github.com/vercel-labs/emulate)
