---
name: document360
description: Emulated Document360 knowledge base API for local development and testing. Use when the user needs to manage Document360 readers, reader groups, team accounts, articles, categories, project versions, or Drive files locally, or test an integration that provisions knowledge base readers without a real Document360 project. Triggers include "Document360 API", "emulate Document360", "knowledge base readers", "api_token header", "apihub.document360.io", "reader groups", "DOCUMENT360_API_TOKEN", or any task requiring a local Document360 API.
allowed-tools: Bash(npx emulate:*), Bash(emulate:*), Bash(curl:*)
---

# Document360 API Emulator

Fully stateful Document360 API emulation. Project versions carry languages, categories form trees per language, articles keep draft and published versions, readers belong to reader groups, team accounts have portal roles, and Drive stores uploaded files. Every mutation is recorded in an event log and shown in the inspector.

Nothing leaves the machine. Every Document360 API call hits the emulator and produces Document360-shaped envelopes.

## Start

```bash
# Document360 only
npx emulate --service document360

# Default port (when run alone)
# http://localhost:4000
```

Or programmatically:

```typescript
import { createEmulator } from 'emulate'

const document360 = await createEmulator({ service: 'document360', port: 4000 })
// document360.url === 'http://localhost:4000'
```

## Defaults

```text
DOCUMENT360_BASE_URL=http://localhost:4000/v2
DOCUMENT360_API_TOKEN=test_emulate_document360_token
```

Seeded data:

- Project "Emulate Knowledge Base", main version 1 with languages `en` (default) and `fr`
- Categories "Getting Started" (published "Welcome", draft "Setup guide") and "FAQ" (one published article)
- Team owner `admin@example.com` and editor `editor@example.com` in team group "Editors"
- Reader groups Customers, MSP, and Distributors; reader `test@example.com` in Customers
- Drive folder "Documents" with `readme.txt`

## Authentication

Send the token in the `api_token` header. `x-api-token` and `Authorization: Bearer <token>` are accepted too. Missing or unknown tokens return 401 with `success: false`.

```bash
curl -H "api_token: test_emulate_document360_token" http://localhost:4000/v2/Project
```

All routes exist under both `/v2` and `/v1`. Responses use the envelope:

```json
{ "result": { }, "extension_data": null, "success": true, "errors": [], "warnings": [], "information": [] }
```

Errors return HTTP 400 or 404 with `errors: [{ description, error_code, ... }]`.

## Readers

```bash
# Look up by email (trailing slash form works too)
curl -H "api_token: test_emulate_document360_token" \
  "http://localhost:4000/v2/Readers/?search_email=test%40example.com"

# Create a reader in a group
curl -X POST -H "api_token: test_emulate_document360_token" -H "Content-Type: application/json" \
  http://localhost:4000/v2/Readers -d '{
    "access_scope": { "access_level": 0 },
    "first_name": "Ada", "last_name": "Lovelace",
    "email_id": "ada@example.com",
    "is_sso_user": false, "skip_sso_invitation_email": false,
    "invited_by": "admin@example.com",
    "associated_reader_groups": ["00000000-0000-4000-8000-00000000c001"]
  }'

# Update, fetch, delete
curl -X PUT -H "api_token: test_emulate_document360_token" -H "Content-Type: application/json" \
  http://localhost:4000/v2/Readers/{reader_id} -d '{ "first_name": "Augusta" }'
curl -H "api_token: test_emulate_document360_token" http://localhost:4000/v2/Readers/{reader_id}
curl -X DELETE -H "api_token: test_emulate_document360_token" http://localhost:4000/v2/Readers/{reader_id}
```

Reader results contain `reader_id`, `first_name`, `last_name`, `email`, `access_scope { access_level, categories, project_versions, languages }`, `associated_reader_groups`, and `invited_by`. Duplicate emails and invalid addresses return 400; unknown groups return 404.

Reader groups: `GET|POST /v2/Readers/groups`, `GET|PUT|DELETE /v2/Readers/groups/{id}`. Seed groups with explicit `id` values when your application references fixed GUIDs.

## Team Accounts

- `GET|POST /v2/Teams`, `GET|PUT|DELETE /v2/Teams/{id or email}`, `GET /v2/Teams/{id}/articles`
- `portal_role`: `owner`, `admin`, `editor`, `draft_writer`, `reader` (or codes 0 to 4); the last owner cannot be demoted or deleted
- `GET|POST /v2/Teams/groups`, `GET|PUT|DELETE /v2/Teams/groups/{id}`

## Project Versions, Languages, Categories

- `GET|POST /v2/ProjectVersions`, `GET|PUT|DELETE /v2/ProjectVersions/{id}` (`{id}` accepts id, number, or slug); `POST` with `base_version_id` clones content
- `GET /v2/ProjectVersions/{id}/categories?langCode=en&excludeArticles=true`, `GET /v2/ProjectVersions/{id}/articles`
- `GET|POST /v2/Language/{versionId}`, `PUT|DELETE /v2/Language/{versionId}/{code}`
- `POST /v2/Categories`, `GET|PUT|DELETE /v2/Categories/{id}/{lang}`, `GET /v2/Categories/{id}/{lang}/articles`

Requests for a language without a translation fall back to the default language and set `is_fall_back_content: true`. `PUT` on a missing translation creates it.

## Articles

```bash
# Create a draft (markdown is rendered to html_content)
curl -X POST -H "api_token: test_emulate_document360_token" -H "Content-Type: application/json" \
  http://localhost:4000/v2/Articles -d '{
    "title": "Billing", "content": "# Billing\n\nFirst draft.",
    "category_id": "00000000-0000-4000-8000-00000000d002",
    "user_id": "00000000-0000-4000-8000-00000000a001"
  }'

# Publish version 1, then edit (creates version 2 because version 1 is published)
curl -X POST -H "api_token: test_emulate_document360_token" -H "Content-Type: application/json" \
  http://localhost:4000/v2/Articles/{id}/en/publish -d '{ "version_number": 1, "publish_message": "Go live" }'
curl -X PUT -H "api_token: test_emulate_document360_token" -H "Content-Type: application/json" \
  http://localhost:4000/v2/Articles/{id}/en -d '{ "content": "Second revision" }'

# Public version only
curl -H "api_token: test_emulate_document360_token" "http://localhost:4000/v2/Articles/{id}/en?isForDisplay=true"
```

Also: `GET /v2/Articles/{id}/{lang}/versions`, `GET|DELETE .../versions/{n}`, `POST .../fork`, `PUT .../settings`, `GET|PUT|DELETE .../reviewreminder`, and `GET /v2/Search/{versionId}?searchQuery=term` (published, searchable articles with highlights).

## Drive

- `GET|POST /v2/Drive/Folders`, `GET|PUT|DELETE /v2/Drive/Folders/{id}`
- `GET|POST /v2/Drive/Folders/{id}/Items` - upload with multipart file fields (plus `tags`) or JSON `{ title, content, content_type, base64 }`
- `GET /v2/Drive/Items?search=`, `GET|PUT|DELETE /v2/Drive/Items/{id}`
- File content is served at the item `url` (`/_document360/drive/{id}/{name}`)

## Events and Inspector

- `GET /_document360/events?type=reader.created` - JSON event log; `DELETE /_document360/events` clears it
- `GET /v2/Project` - project summary and counts
- `GET /` - inspector tabs: articles, categories, versions, readers, team, drive, events, auth

## Seed Configuration

```json
{
  "document360": {
    "project_name": "Emulate Knowledge Base",
    "api_tokens": [{ "token": "test_emulate_document360_token" }],
    "team_accounts": [{ "email": "admin@example.com", "portal_role": "owner" }],
    "project_versions": [
      {
        "version_number": 1,
        "is_main_version": true,
        "languages": [{ "code": "en", "is_default": true }, "fr"],
        "categories": [
          { "name": "Getting Started", "articles": [{ "title": "Welcome", "content": "# Welcome", "published": true }] }
        ]
      }
    ],
    "reader_groups": [{ "id": "351f884c-b6ac-44d9-bac6-b49d03ba196a", "title": "Customers" }],
    "readers": [{ "email": "test@example.com", "groups": ["Customers"] }],
    "drive": [{ "title": "Documents", "items": [{ "title": "readme.txt", "content": "hello", "content_type": "text/plain" }] }]
  }
}
```

Every entity accepts an explicit `id`. Reader `groups` accept ids or titles. Seeding is idempotent: entries that already exist by id, email, or title are skipped.

## Limits

SSO invitations, article comments and feedback, analytics, redirects, custom pages, workflow assignments, AI features, and the public knowledge base site are not implemented.
