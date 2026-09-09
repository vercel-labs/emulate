# @emulators/document360

Stateful Document360 knowledge base API emulator plugin for [emulate](https://github.com/vercel-labs/emulate).

## Features

- Project versions with languages, cloning from a base version, and per-language fallbacks
- Category trees with translations and subtree deletion
- Articles with draft and published versions, forking, publishing, settings, review reminders, and markdown rendering
- Full-text search over published articles with highlights
- Readers and reader groups, including `GET /v2/Readers/?search_email=` lookups
- Team accounts (by id or email) with portal roles and team groups
- Drive folders and file uploads (multipart or JSON) served back from the emulator
- Document360 response envelope on every route, served under both `/v2` and `/v1`
- Event log at `/_document360/events` and a tabbed inspector at `/`

## Usage

```typescript
import { Hono, Store, WebhookDispatcher } from "@emulators/core";
import { document360Plugin, seedFromConfig } from "@emulators/document360";

const app = new Hono();
const store = new Store();
const baseUrl = "http://localhost:4017";

document360Plugin.register(app, store, new WebhookDispatcher(), baseUrl);
document360Plugin.seed?.(store, baseUrl);
seedFromConfig(store, baseUrl, {
  reader_groups: [{ id: "351f884c-b6ac-44d9-bac6-b49d03ba196a", title: "Customers" }],
  readers: [{ email: "customer@example.com", groups: ["Customers"] }],
});
```

Authenticate with the `api_token` header. The default token is `test_emulate_document360_token`.

## Defaults

The default seed creates project "Emulate Knowledge Base" with main version 1 (`en` and `fr`), categories "Getting Started" and "FAQ" with three articles, owner `admin@example.com`, reader groups Customers, MSP, and Distributors, reader `test@example.com`, and a Drive folder "Documents".

See the [Document360 skill](../../../skills/document360/SKILL.md) for the complete route list and seed schema.
