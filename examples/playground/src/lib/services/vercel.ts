import type { ConsoleService } from "./types";

const DIGEST = "d4eecf2704fc7e6ddb40eefb596847b3737fa3e1";
const COMMIT_SHA = "7f3c2a9e1b0d4c5a6e7f8091a2b3c4d5e6f70812";
const BLOB_TOKEN = "Bearer vercel_blob_rw_devstore_devsecret";

const auth = { Authorization: "Bearer {{token}}" };
const json = { ...auth, "Content-Type": "application/json" };
const form = { "Content-Type": "application/x-www-form-urlencoded" };
const blob = { Authorization: BLOB_TOKEN, "x-api-version": "12" };
const blobJson = { ...blob, "Content-Type": "application/json" };
const blobUpload = { ...blob, "x-vercel-blob-access": "public" };

export const vercel: ConsoleService = {
  name: "vercel",
  label: "Vercel",
  description:
    "Vercel REST API for users, teams, projects, env vars, domains, deployments, API keys, blob storage, and OAuth.",
  variables: [
    {
      name: "token",
      label: "Access token",
      hint: "Sign in at /oauth with Vercel and this fills in by itself, or copy the access token from that dashboard.",
    },
    {
      name: "deployment_id",
      label: "Deployment id",
      hint: "Filled in when you run Create deployment. You can also paste an id.",
    },
    {
      name: "env_id",
      label: "Env var id",
      hint: "Filled in when you run Create env var. You can also paste an id.",
    },
    {
      name: "api_key_id",
      label: "API key id",
      hint: "Filled in when you run Create API key. You can also paste an id.",
    },
    {
      name: "bypass_secret",
      label: "Bypass secret",
      hint: "Copy the secret key from the protectionBypass object that Create bypass secret returns. Paste it here.",
    },
    {
      name: "authorization_code",
      label: "Authorization code",
      hint: "Copy the code parameter from the redirect after you pick a user at /oauth. It is single use and expires after 10 minutes.",
    },
  ],
  groups: [
    {
      title: "User",
      presets: [
        {
          label: "Check registration",
          description: "Reports whether self-service sign-up is enabled. No token needed.",
          method: "GET",
          path: "/registration",
        },
        {
          label: "Get current user",
          description: "Returns the user behind the access token. Run this first to confirm the token works.",
          method: "GET",
          path: "/v2/user",
          headers: auth,
        },
        {
          label: "Update user name",
          description: "Changes the display name of the signed-in user.",
          method: "PATCH",
          path: "/v2/user",
          headers: json,
          body: JSON.stringify({ name: "Admin" }, null, 2),
        },
      ],
    },
    {
      title: "Teams",
      presets: [
        {
          label: "Create team",
          description:
            "Creates a team owned by the signed-in user. The slug must be unused, so a second run on the same server returns 409.",
          method: "POST",
          path: "/v2/teams",
          headers: json,
          body: JSON.stringify({ slug: "scratch-team", name: "Scratch Team" }, null, 2),
        },
        {
          label: "Add team member",
          description: "Adds the seeded teammate user to scratch-team. Run Create team first.",
          method: "POST",
          path: "/v2/teams/scratch-team/members",
          headers: json,
          body: JSON.stringify({ email: "teammate@localhost", role: "DEVELOPER" }, null, 2),
        },
        {
          label: "List teams",
          description: "Lists the teams the signed-in user belongs to.",
          method: "GET",
          path: "/v2/teams",
          headers: auth,
        },
        {
          label: "Get team",
          description: "Returns playground-team, the seeded team, by slug. Its id works in the path too.",
          method: "GET",
          path: "/v2/teams/playground-team",
          headers: auth,
        },
        {
          label: "List team members",
          description: "Lists the members of playground-team.",
          method: "GET",
          path: "/v2/teams/playground-team/members",
          headers: auth,
        },
        {
          label: "Update team",
          description: "Changes the description of playground-team. The signed-in user must be an owner.",
          method: "PATCH",
          path: "/v2/teams/playground-team",
          headers: json,
          body: JSON.stringify({ description: "Team for the emulate playground." }, null, 2),
        },
      ],
    },
    {
      title: "Projects",
      presets: [
        {
          label: "Create project",
          description:
            "Creates scratch-app on the signed-in account. The later steps in this group update and delete it.",
          method: "POST",
          path: "/v11/projects",
          headers: json,
          body: JSON.stringify({ name: "scratch-app", framework: "nextjs" }, null, 2),
        },
        {
          label: "List projects",
          description: "Lists projects on the signed-in account.",
          method: "GET",
          path: "/v10/projects?limit=20",
          headers: auth,
        },
        {
          label: "Get project",
          description: "Returns scratch-app with its env vars.",
          method: "GET",
          path: "/v9/projects/scratch-app",
          headers: auth,
        },
        {
          label: "Get promotion status",
          description:
            "Shows whether the production deployment of playground-app is promoted and which aliases point at it. Run Create deployment first to see an alias.",
          method: "GET",
          path: "/v1/projects/playground-app/promote/aliases",
          headers: auth,
        },
        {
          label: "Update project",
          description: "Sets the build command of scratch-app.",
          method: "PATCH",
          path: "/v9/projects/scratch-app",
          headers: json,
          body: JSON.stringify({ buildCommand: "pnpm build" }, null, 2),
        },
        {
          label: "Delete project",
          description: "Deletes scratch-app along with its env vars, domains, and deployments.",
          method: "DELETE",
          path: "/v9/projects/scratch-app",
          headers: auth,
        },
      ],
    },
    {
      title: "Protection bypass",
      presets: [
        {
          label: "Create bypass secret",
          description:
            "Generates a protection bypass secret for playground-app. Copy the key of the protectionBypass object into bypass_secret for the next two steps.",
          method: "PATCH",
          path: "/v1/projects/playground-app/protection-bypass",
          headers: json,
          body: JSON.stringify({ generate: { note: "Playground bypass", scope: "deployment" } }, null, 2),
        },
        {
          label: "Regenerate bypass secret",
          description:
            "Replaces the secret named by bypass_secret with a new one. Paste the new key from the response into bypass_secret.",
          method: "PATCH",
          path: "/v1/projects/playground-app/protection-bypass",
          headers: json,
          body: JSON.stringify({ regenerate: ["{{bypass_secret}}"] }, null, 2),
        },
        {
          label: "Revoke bypass secret",
          description: "Removes the secret named by bypass_secret from playground-app.",
          method: "PATCH",
          path: "/v1/projects/playground-app/protection-bypass",
          headers: json,
          body: JSON.stringify({ revoke: ["{{bypass_secret}}"] }, null, 2),
        },
      ],
    },
    {
      title: "Environment variables",
      presets: [
        {
          label: "Create env var",
          description:
            "Adds GREETING to playground-app. upsert=true updates the variable instead of failing when it already exists.",
          method: "POST",
          path: "/v10/projects/playground-app/env?upsert=true",
          headers: json,
          body: JSON.stringify(
            {
              key: "GREETING",
              value: "hello from the playground",
              type: "plain",
              target: ["production", "preview", "development"],
            },
            null,
            2,
          ),
          captures: { env_id: "envs.0.id" },
        },
        {
          label: "List env vars",
          description: "Lists the env vars of playground-app.",
          method: "GET",
          path: "/v10/projects/playground-app/env",
          headers: auth,
        },
        {
          label: "Get env var",
          description: "Returns the GREETING variable. Run Create env var first.",
          method: "GET",
          path: "/v10/projects/playground-app/env/{{env_id}}",
          headers: auth,
        },
        {
          label: "Update env var",
          description: "Changes the value of the GREETING variable.",
          method: "PATCH",
          path: "/v9/projects/playground-app/env/{{env_id}}",
          headers: json,
          body: JSON.stringify({ value: "updated from the playground" }, null, 2),
        },
        {
          label: "Delete env var",
          description: "Deletes the GREETING variable from playground-app.",
          method: "DELETE",
          path: "/v9/projects/playground-app/env/{{env_id}}",
          headers: auth,
        },
      ],
    },
    {
      title: "Domains",
      presets: [
        {
          label: "Add domain",
          description:
            "Adds playground.example.com to playground-app. It stays unverified until Verify domain runs, and the response lists the TXT record that proves ownership.",
          method: "POST",
          path: "/v10/projects/playground-app/domains",
          headers: json,
          body: JSON.stringify({ name: "playground.example.com" }, null, 2),
        },
        {
          label: "List domains",
          description: "Lists the domains of playground-app.",
          method: "GET",
          path: "/v9/projects/playground-app/domains",
          headers: auth,
        },
        {
          label: "Get domain",
          description: "Returns playground.example.com. Run Add domain first.",
          method: "GET",
          path: "/v9/projects/playground-app/domains/playground.example.com",
          headers: auth,
        },
        {
          label: "Verify domain",
          description: "Marks playground.example.com as verified. Run Add domain first.",
          method: "POST",
          path: "/v9/projects/playground-app/domains/playground.example.com/verify",
          headers: auth,
        },
        {
          label: "Update domain",
          description: "Redirects playground.example.com to another host with a 308 status.",
          method: "PATCH",
          path: "/v9/projects/playground-app/domains/playground.example.com",
          headers: json,
          body: JSON.stringify({ redirect: "https://example.org", redirectStatusCode: 308 }, null, 2),
        },
        {
          label: "Delete domain",
          description: "Removes playground.example.com from playground-app.",
          method: "DELETE",
          path: "/v9/projects/playground-app/domains/playground.example.com",
          headers: auth,
        },
      ],
    },
    {
      title: "Deployments",
      presets: [
        {
          label: "Upload file",
          description:
            "Stores one file under its sha1 digest. Create deployment refers to the same digest, so run this first.",
          method: "POST",
          path: "/v2/files",
          headers: { ...auth, "Content-Type": "text/html", "x-vercel-digest": DIGEST },
          body: "<h1>Hello from the emulate playground</h1>\n",
        },
        {
          label: "Create deployment",
          description:
            "Creates a production deployment of playground-app from the uploaded index.html. The new id is captured for the steps below.",
          method: "POST",
          path: "/v13/deployments",
          headers: json,
          body: JSON.stringify(
            {
              name: "playground-app",
              project: "playground-app",
              target: "production",
              meta: { githubCommitSha: COMMIT_SHA },
              files: [{ file: "index.html", sha: DIGEST, size: 43 }],
            },
            null,
            2,
          ),
          captures: { deployment_id: "id" },
        },
        {
          label: "List deployments",
          description: "Lists production deployments of playground-app.",
          method: "GET",
          path: "/v6/deployments?app=playground-app&target=production",
          headers: auth,
        },
        {
          label: "List deployments by commit",
          description: "Lists deployments whose commit SHA matches the one used by Create deployment.",
          method: "GET",
          path: "/v7/deployments?sha=7f3c2a9e1b0d4c5a6e7f8091a2b3c4d5e6f70812",
          headers: auth,
        },
        {
          label: "Get deployment",
          description: "Returns the deployment created above.",
          method: "GET",
          path: "/v13/deployments/{{deployment_id}}",
          headers: auth,
        },
        {
          label: "List deployment aliases",
          description: "Lists the aliases that point at the deployment.",
          method: "GET",
          path: "/v2/deployments/{{deployment_id}}/aliases",
          headers: auth,
        },
        {
          label: "List deployment events",
          description: "Lists the build events of the deployment, newest first.",
          method: "GET",
          path: "/v3/deployments/{{deployment_id}}/events?limit=20",
          headers: auth,
        },
        {
          label: "List deployment files",
          description: "Returns the file tree of the deployment.",
          method: "GET",
          path: "/v6/deployments/{{deployment_id}}/files",
          headers: auth,
        },
        {
          label: "Delete deployment",
          description: "Deletes the deployment along with its builds, events, files, and aliases.",
          method: "DELETE",
          path: "/v13/deployments/{{deployment_id}}",
          headers: auth,
        },
      ],
    },
    {
      title: "API keys",
      presets: [
        {
          label: "Create API key",
          description: "Creates an API key for the signed-in user. The new id is captured for Delete API key.",
          method: "POST",
          path: "/v1/api-keys",
          headers: json,
          body: JSON.stringify({ name: "Playground key" }, null, 2),
          captures: { api_key_id: "apiKey.id" },
        },
        {
          label: "List API keys",
          description: "Lists the API keys of the signed-in user.",
          method: "GET",
          path: "/v1/api-keys",
          headers: auth,
        },
        {
          label: "Delete API key",
          description: "Deletes the API key created above.",
          method: "DELETE",
          path: "/v1/api-keys/{{api_key_id}}",
          headers: auth,
        },
      ],
    },
    {
      title: "Blob storage",
      presets: [
        {
          label: "Upload blob",
          description: "Stores a text file at playground-demo/hello.txt. Re-running overwrites it.",
          method: "PUT",
          path: "/api/blob?pathname=playground-demo/hello.txt",
          headers: { ...blobUpload, "Content-Type": "text/plain", "x-allow-overwrite": "1" },
          body: "Hello from the emulate playground.",
        },
        {
          label: "Copy blob",
          description: "Copies playground-demo/hello.txt to playground-demo/hello-copy.txt. Upload blob runs first.",
          method: "PUT",
          path: "/api/blob?pathname=playground-demo/hello-copy.txt&fromUrl=playground-demo/hello.txt",
          headers: blobUpload,
        },
        {
          label: "Start multipart upload",
          description:
            "Opens a multipart upload session for playground-demo/large.bin. Only creating the session is supported.",
          method: "POST",
          path: "/api/blob/mpu?pathname=playground-demo/large.bin",
          headers: { ...blobUpload, "x-mpu-action": "create" },
        },
        {
          label: "List blobs",
          description: "Lists the blobs under playground-demo/.",
          method: "GET",
          path: "/api/blob?prefix=playground-demo/",
          headers: blob,
        },
        {
          label: "Get blob metadata",
          description: "Returns the size, type, and URL of playground-demo/hello.txt.",
          method: "GET",
          path: "/api/blob?url=playground-demo/hello.txt",
          headers: blob,
        },
        {
          label: "Read blob content",
          description: "Serves playground-demo/hello.txt from the public blob URL. No token is needed.",
          method: "GET",
          path: "/blob/devstore/playground-demo/hello.txt",
        },
        {
          label: "Delete blobs",
          description: "Deletes the hello and hello-copy blobs. Run Upload blob again before reading them.",
          method: "POST",
          path: "/api/blob/delete",
          headers: blobJson,
          body: JSON.stringify({ urls: ["playground-demo/hello.txt", "playground-demo/hello-copy.txt"] }, null, 2),
        },
      ],
    },
    {
      title: "OAuth",
      presets: [
        {
          label: "Exchange code for token",
          description:
            "Trades an authorization code for an access token. The code comes from the consent redirect and works once.",
          method: "POST",
          path: "/login/oauth/token",
          headers: form,
          body: "grant_type=authorization_code&code={{authorization_code}}&client_id=emu_vercel_client_id&client_secret=emu_vercel_client_secret",
        },
        {
          label: "Get userinfo",
          description: "Returns the profile of the user behind the access token.",
          method: "GET",
          path: "/login/oauth/userinfo",
          headers: auth,
        },
      ],
    },
  ],
};
