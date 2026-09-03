---
name: airtable
description: Emulated Airtable Data API for local development and testing. Use when the user needs to test Airtable integrations locally, emulate bases, tables, fields, views, records, record comments, filterByFormula queries, or work with the Airtable REST API (or the Airtable.js / pyairtable SDKs) without hitting the real Airtable service. Triggers include "Airtable API", "emulate Airtable", "mock Airtable", "test filterByFormula", "Airtable records", "Airtable comments", "local Airtable", or any task requiring a local Airtable API.
allowed-tools: Bash(npx emulate:*)
---

# Airtable API Emulator

Stateful Airtable Data API emulation with user-defined bases, tables, fields, and views, plus records and record comments. Records are validated against the seeded schema (unknown fields error; select choices are enforced unless `typecast` is set).

## Start

```bash
# Airtable only
npx emulate --service airtable
```

Default URL: `http://localhost:4014` when all services are started, or `http://localhost:4000` when Airtable is the only service.

## Auth

Relaxed by default: any non-empty bearer token works.

```bash
curl "$AIRTABLE_EMULATOR_URL/v0/meta/bases" \
  -H "Authorization: Bearer pat_test_token"
```

Point SDKs at the emulator with no other code changes:

```bash
# Airtable.js
AIRTABLE_ENDPOINT_URL=http://localhost:4014
# pyairtable
Api("pat_test_token", endpoint_url="http://localhost:4014")
```

The seeded user's scopes (`data.records:read`, `data.records:write`, `schema.bases:read`) are returned by `whoami`.

## Records

| Operation | Route |
|-----------|-------|
| List | `GET /v0/:baseId/:tableIdOrName` |
| List (body) | `POST /v0/:baseId/:tableIdOrName/listRecords` |
| Get | `GET /v0/:baseId/:tableIdOrName/:recordId` |
| Create / batch | `POST /v0/:baseId/:tableIdOrName` |
| Update / upsert | `PATCH /v0/:baseId/:tableIdOrName` |
| Replace | `PUT /v0/:baseId/:tableIdOrName` |
| Update one | `PATCH /v0/:baseId/:tableIdOrName/:recordId` |
| Replace one | `PUT /v0/:baseId/:tableIdOrName/:recordId` |
| Delete one | `DELETE /v0/:baseId/:tableIdOrName/:recordId` |
| Batch delete | `DELETE /v0/:baseId/:tableIdOrName?records[]=...` |

List query params: `filterByFormula`, `sort[i][field]` / `sort[i][direction]`, `fields[]`, `view`, `pageSize` (max 100), `maxRecords`, `offset`, `cellFormat` (`json`), `returnFieldsByFieldId`. Batch create/update/upsert cap at 10 records; upsert uses `performUpsert.fieldsToMergeOn` (max 3).

Tables and fields are addressable by id or name. `filterByFormula` references fields by name; a `{fldXXX}` id token errors, matching Airtable. Computed fields (formula, rollup, lookup) filter on their stored value.

## filterByFormula

Supported: `AND`, `OR`, `NOT`, `IF`, comparisons (`= != < > <= >=`), `&`, arithmetic, `LOWER`, `UPPER`, `TRIM`, `LEN`, `FIND`, `SEARCH`, `LEFT`, `RIGHT`, `MID`, `CONCATENATE`, `SUBSTITUTE`, `VALUE`, `ROUND`, `ABS`, `MIN`, `MAX`, `SUM`, `RECORD_ID`, `BLANK`, `TRUE`, `FALSE`, `CREATED_TIME`, `TODAY`, `NOW`, `DATEADD`, `DATETIME_DIFF`, `IS_AFTER`, `IS_BEFORE`, `IS_SAME`. Unsupported functions return `INVALID_FILTER_BY_FORMULA`.

## Record Comments

| Operation | Route |
|-----------|-------|
| List | `GET /v0/:baseId/:tableIdOrName/:recordId/comments` |
| Add | `POST /v0/:baseId/:tableIdOrName/:recordId/comments` |
| Delete | `DELETE /v0/:baseId/:tableIdOrName/:recordId/comments/:commentId` |

Comments are threaded and `offset`-paginated; POST bodies take `{ text }` and `@[usrXXX]` mentions are parsed into `mentioned`. Each comment records its author identity.

## Meta

- `GET /v0/meta/whoami` - token identity (`id`, `email`, `scopes`)
- `GET /v0/meta/bases` - accessible bases
- `GET /v0/meta/bases/:baseId/tables` - base schema (tables, fields, views)

## Seed Config

```yaml
airtable:
  user:
    email: dev@example.com
    name: Local Developer
  bases:
    - id: appLocalDevExample
      name: Product
      tables:
        - name: Tasks
          fields:
            - { name: Name, type: singleLineText }
            - name: Status
              type: singleSelect
              options:
                choices:
                  - { name: Todo }
                  - { name: Doing }
                  - { name: Done }
            - { name: Estimate, type: number }
          views:
            - { name: All Tasks, type: grid }
          records:
            - { Name: Ship the emulator, Status: Doing, Estimate: 3 }
```

Base, table, and field ids pass through verbatim, so mirroring a real base's ids lets code that hardcodes those ids run unchanged. A table with records but no declared `fields` infers its schema from the records.

## Inspector

Open `GET /` in the Airtable emulator to inspect bases, tables, records, and identity.

## Current Limits

`filterByFormula` implements a documented function subset; computed fields are stored, not recomputed; view filters are seeded rather than discovered; webhooks, attachment uploads, and Meta write endpoints are not implemented.
