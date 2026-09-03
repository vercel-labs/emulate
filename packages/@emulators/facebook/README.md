# @emulators/facebook

Local Facebook Login and Graph API emulation for server-side Page integrations.

## Scope

The package provides seedable users, OAuth apps, Pages, and Page videos. It supports authorization code login, app-secret validation, single-use codes, user and Page access tokens, token debugging, /me, /me/accounts, Page lookup, and Page video lookup. Graph endpoints accept bearer or access_token query authentication and are also available below versioned paths such as /v23.0.

Video responses expose views plus likes and comments summary counts. This is a focused foundation, not the complete Meta Graph API.

## Seed

    facebook:
      users:
        - id: "1001"
          name: Test User
          email: test@example.com
      oauth_apps:
        - app_id: "123456"
          app_secret: example_secret
          name: My App
          redirect_uris:
            - http://localhost:3000/api/auth/callback/facebook
      pages:
        - id: "2001"
          name: Test Page
          owner_user_ids: ["1001"]
      page_videos:
        - id: "3001"
          page_id: "2001"
          title: Campaign video
          views: 1200
          likes: 80
          comments: 12

To consume this emulator, an application needs a Facebook platform client, Page OAuth integration, and a configurable Graph API base URL.
