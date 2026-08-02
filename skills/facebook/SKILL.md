---
name: facebook
description: Use the local Facebook Login and Graph API emulator for Page OAuth and Page video metric integration tests.
allowed-tools: Bash(npx emulate:*)
---

# Facebook emulation

Start only this service with npx emulate --service facebook. Its default port is 4014 when all services start from port 4000.

Seed users, oauth_apps, Pages, and page_videos under the facebook configuration key. Registered redirect URIs are enforced.

The focused API surface includes:

- /dialog/oauth and versioned /vXX.X/dialog/oauth
- /oauth/access_token
- /debug_token
- /me and /me/accounts
- /:pageId and /:videoId

Graph reads accept bearer access tokens or the access_token query parameter. /me/accounts exchanges an authorized user context for owned Page access tokens. Page and video reads require ownership plus pages_read_engagement.

This is not full Meta Graph API coverage. Applications need a Facebook client and a configurable Graph API base URL to use this emulator.
