import { randomBytes } from "crypto";
import { spawn, spawnSync } from "child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { gzipSync } from "zlib";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono, Store, WebhookDispatcher, serve } from "@emulators/core";
import {
  authMiddleware,
  createApiErrorHandler,
  createErrorHandler,
  type AuthFallback,
  type TokenMap,
} from "@emulators/core";
import { getGitHubStore, githubPlugin, seedFromConfig } from "../index.js";

const base = "http://localhost:4000";

const FIXTURE_FILES: Record<string, string> = {
  "README.md": "# private-fixture\n\nHello from the emulator.\n",
  "src/index.ts": 'export const answer = 42;\nconsole.log("hi");\n',
  "docs/guide/intro.md": "Deeply nested file.\n",
  "docs/guide/copy.md": "Deeply nested file.\n",
};

function createTestApp(options: { fallbackUser?: AuthFallback } = {}) {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map();
  tokenMap.set("test-token", { login: "octocat", id: 1, scopes: ["repo", "user", "admin:org"] });

  const app = new Hono();
  app.onError(createApiErrorHandler());
  app.use("*", createErrorHandler());
  app.use("*", authMiddleware(tokenMap, undefined, options.fallbackUser));
  githubPlugin.register(app as any, store, webhooks, base, tokenMap);
  githubPlugin.seed?.(store, base);
  seedFromConfig(store, base, {
    users: [{ login: "octocat" }],
    repos: [
      { owner: "octocat", name: "private-fixture", private: true, files: FIXTURE_FILES },
      { owner: "octocat", name: "public-fixture" },
      { owner: "octocat", name: "empty-repo", auto_init: false },
    ],
  });

  return { app, store, tokenMap };
}

/**
 * Records a token the same way POST /app/installations/:id/access_tokens does
 * (see routes/apps.ts). Minting over HTTP requires an App JWT, whose
 * verification is currently broken (#96); once that is fixed this helper can
 * be replaced with a real request to the endpoint.
 */
function mintInstallationToken(tokenMap: TokenMap): string {
  const token = "ghs_" + randomBytes(20).toString("base64url");
  tokenMap.set(token, { login: "octocat", id: 1, scopes: ["contents:read"] });
  return token;
}

function basicAuth(token: string): string {
  return `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
}

async function fetchAdvertisement(app: Hono, repoPath: string, token?: string) {
  return app.request(`${base}/${repoPath}/info/refs?service=git-upload-pack`, {
    headers: token ? { Authorization: basicAuth(token) } : {},
  });
}

async function fetchHeadSha(app: Hono, repoPath: string, token: string): Promise<string> {
  const adv = await fetchAdvertisement(app, repoPath, token);
  return /([0-9a-f]{40}) HEAD\0/.exec(await adv.text())![1];
}

// Framed by hand on purpose so the requests stay independent of pktLine in the
// code under test.
function uploadPackBody(wantSha: string, extraLines: string[] = []): Buffer {
  const frame = (payload: string) => (payload.length + 4).toString(16).padStart(4, "0") + payload;
  return Buffer.from([frame(`want ${wantSha}\n`), ...extraLines.map(frame), "0000", frame("done\n")].join(""));
}

describe("git smart HTTP endpoints", () => {
  it("advertises refs with the service header, symref, and capabilities", async () => {
    const { app, tokenMap } = createTestApp();
    const token = mintInstallationToken(tokenMap);
    const res = await fetchAdvertisement(app, "octocat/private-fixture.git", token);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-git-upload-pack-advertisement");
    const body = Buffer.from(await res.arrayBuffer()).toString("utf8");
    expect(body.startsWith("001e# service=git-upload-pack\n0000")).toBe(true);
    expect(body).toContain("symref=HEAD:refs/heads/main");
    expect(body).toMatch(/[0-9a-f]{40} HEAD\0/);
    expect(body).toMatch(/[0-9a-f]{40} refs\/heads\/main\n/);
    expect(body.endsWith("0000")).toBe(true);
  });

  it("serves the same advertisement with and without the .git suffix", async () => {
    const { app, tokenMap } = createTestApp();
    const token = mintInstallationToken(tokenMap);
    const withSuffix = await fetchAdvertisement(app, "octocat/private-fixture.git", token);
    const withoutSuffix = await fetchAdvertisement(app, "octocat/private-fixture", token);
    expect(await withSuffix.text()).toBe(await withoutSuffix.text());
  });

  it("rejects git-receive-pack since push is unsupported", async () => {
    const { app } = createTestApp();
    const res = await app.request(`${base}/octocat/public-fixture/info/refs?service=git-receive-pack`);
    expect(res.status).toBe(403);
  });

  it("rejects dumb protocol requests without the service parameter", async () => {
    const { app } = createTestApp();
    const res = await app.request(`${base}/octocat/public-fixture/info/refs`);
    expect(res.status).toBe(400);
  });

  it("returns 404 for unknown repos", async () => {
    const { app } = createTestApp();
    const res = await fetchAdvertisement(app, "octocat/does-not-exist");
    expect(res.status).toBe(404);
  });

  it("challenges anonymous access to private repos with WWW-Authenticate", async () => {
    const { app } = createTestApp();
    const res = await fetchAdvertisement(app, "octocat/private-fixture");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/^Basic/);
  });

  it("rejects tokens that were never minted, even for public repos", async () => {
    const { app } = createTestApp();
    const res = await fetchAdvertisement(app, "octocat/public-fixture", "ghs_never_minted");
    expect(res.status).toBe(401);
  });

  it("stays strict when the REST fallback user is configured", async () => {
    const fallbackUser = { login: "octocat", id: 1, scopes: ["repo"] };
    const { app } = createTestApp({ fallbackUser });

    const rest = await app.request(`${base}/repos/octocat/private-fixture`, {
      headers: { Authorization: "Bearer ghs_never_minted" },
    });
    expect(rest.status).toBe(200);

    const git = await fetchAdvertisement(app, "octocat/private-fixture", "ghs_never_minted");
    expect(git.status).toBe(401);
  });

  it("hides private repos from minted tokens without access", async () => {
    const { app, tokenMap } = createTestApp();
    tokenMap.set("ghs_other_user", { login: "someone-else", id: 99, scopes: ["contents:read"] });
    const res = await fetchAdvertisement(app, "octocat/private-fixture", "ghs_other_user");
    expect(res.status).toBe(404);
  });

  it("allows anonymous advertisement for public repos", async () => {
    const { app } = createTestApp();
    const res = await fetchAdvertisement(app, "octocat/public-fixture");
    expect(res.status).toBe(200);
  });

  it("advertises an empty repo with the zero id capabilities line", async () => {
    const { app } = createTestApp();
    const res = await fetchAdvertisement(app, "octocat/empty-repo");
    expect(res.status).toBe(200);
    const body = Buffer.from(await res.arrayBuffer()).toString("utf8");
    expect(body).toContain(`${"0".repeat(40)} capabilities^{}`);
  });

  it("responds to upload-pack with NAK followed by a version 2 packfile", async () => {
    const { app, tokenMap } = createTestApp();
    const token = mintInstallationToken(tokenMap);
    const headSha = await fetchHeadSha(app, "octocat/private-fixture", token);

    const res = await app.request(`${base}/octocat/private-fixture.git/git-upload-pack`, {
      method: "POST",
      headers: { Authorization: basicAuth(token), "Content-Type": "application/x-git-upload-pack-request" },
      body: uploadPackBody(headSha),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-git-upload-pack-result");
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.subarray(0, 8).toString("utf8")).toBe("0008NAK\n");
    expect(body.subarray(8, 12).toString("utf8")).toBe("PACK");
    expect(body.readUInt32BE(12)).toBe(2);
    // 1 commit, 4 trees (root, src, docs, docs/guide), 3 blobs (one is content-deduplicated).
    expect(body.readUInt32BE(16)).toBe(8);
  });

  it("accepts gzip-encoded upload-pack request bodies", async () => {
    const { app, tokenMap } = createTestApp();
    const token = mintInstallationToken(tokenMap);
    const headSha = await fetchHeadSha(app, "octocat/private-fixture", token);

    const res = await app.request(`${base}/octocat/private-fixture/git-upload-pack`, {
      method: "POST",
      headers: { Authorization: basicAuth(token), "Content-Encoding": "gzip" },
      body: gzipSync(uploadPackBody(headSha)),
    });

    expect(res.status).toBe(200);
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.subarray(8, 12).toString("utf8")).toBe("PACK");
  });

  it("answers wants for unknown shas with an ERR packet", async () => {
    const { app, tokenMap } = createTestApp();
    const token = mintInstallationToken(tokenMap);
    const res = await app.request(`${base}/octocat/private-fixture/git-upload-pack`, {
      method: "POST",
      headers: { Authorization: basicAuth(token) },
      body: uploadPackBody("a".repeat(40)),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("ERR upload-pack: not our ref");
  });

  it("rejects malformed pkt-line bodies", async () => {
    const { app, tokenMap } = createTestApp();
    const token = mintInstallationToken(tokenMap);
    const res = await app.request(`${base}/octocat/private-fixture/git-upload-pack`, {
      method: "POST",
      headers: { Authorization: basicAuth(token) },
      body: "zzzzwant nothing",
    });
    expect(res.status).toBe(400);
  });

  it("rejects shallow fetches, which are not advertised", async () => {
    const { app, tokenMap } = createTestApp();
    const token = mintInstallationToken(tokenMap);
    const headSha = await fetchHeadSha(app, "octocat/private-fixture", token);
    const res = await app.request(`${base}/octocat/private-fixture/git-upload-pack`, {
      method: "POST",
      headers: { Authorization: basicAuth(token) },
      body: uploadPackBody(headSha, ["deepen 1\n"]),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Shallow");
  });

  it("keeps the REST git data API consistent with the served objects", async () => {
    const { app } = createTestApp();
    const headers = { Authorization: "Bearer test-token" };

    const ref = await app.request(`${base}/repos/octocat/private-fixture/git/ref/heads/main`, { headers });
    const refJson = (await ref.json()) as { object: { sha: string } };
    const commit = await app.request(`${base}/repos/octocat/private-fixture/git/commits/${refJson.object.sha}`, {
      headers,
    });
    const commitJson = (await commit.json()) as { commit: { tree: { sha: string } } };
    const tree = await app.request(
      `${base}/repos/octocat/private-fixture/git/trees/${commitJson.commit.tree.sha}?recursive=1`,
      { headers },
    );
    const treeJson = (await tree.json()) as { tree: Array<{ path: string; type: string; sha: string }> };

    const blobPaths = treeJson.tree.filter((e) => e.type === "blob").map((e) => e.path);
    expect(blobPaths.sort()).toEqual(Object.keys(FIXTURE_FILES).sort());

    const readmeEntry = treeJson.tree.find((e) => e.path === "README.md")!;
    const blob = await app.request(`${base}/repos/octocat/private-fixture/git/blobs/${readmeEntry.sha}`, { headers });
    const blobJson = (await blob.json()) as { content: string };
    expect(Buffer.from(blobJson.content, "base64").toString("utf8")).toBe(FIXTURE_FILES["README.md"]);
  });

  it("produces identical shas across instances for the same fixture", async () => {
    const first = createTestApp();
    const second = createTestApp();
    const [a, b] = await Promise.all([
      fetchAdvertisement(first.app, "octocat/public-fixture"),
      fetchAdvertisement(second.app, "octocat/public-fixture"),
    ]);
    expect(await a.text()).toBe(await b.text());
  });

  it("rejects fixture file paths with traversal or .git segments", () => {
    const { store } = createTestApp();

    expect(() =>
      seedFromConfig(store, base, {
        users: [{ login: "octocat" }],
        repos: [{ owner: "octocat", name: "bad", files: { "../escape.txt": "no" } }],
      }),
    ).toThrow(/path/);
    expect(getGitHubStore(store).repos.findOneBy("full_name", "octocat/bad")).toBeUndefined();

    expect(() =>
      seedFromConfig(store, base, {
        users: [{ login: "octocat" }],
        repos: [{ owner: "octocat", name: "bad2", files: { ".git/config": "no" } }],
      }),
    ).toThrow(/\.git/);

    expect(() =>
      seedFromConfig(store, base, {
        users: [{ login: "octocat" }],
        repos: [{ owner: "octocat", name: "bad3", files: { a: "file", "a/b": "dir clash" } }],
      }),
    ).toThrow(/both a file and a directory|uses "a" as a directory/);
  });
});

const hasGit = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;

describe.skipIf(!hasGit)("git clone integration", () => {
  let server: ReturnType<typeof serve>;
  let port: number;
  let tokenMap: TokenMap;
  let app: Hono;
  let work: string;
  let gitEnv: Record<string, string>;

  beforeAll(async () => {
    const created = createTestApp();
    app = created.app;
    tokenMap = created.tokenMap;
    server = serve({ fetch: app.fetch, port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (address == null || typeof address === "string") throw new Error("expected a TCP address");
    port = address.port;

    work = await mkdtemp(join(tmpdir(), "emulate-git-"));
    const home = join(work, "home");
    await mkdir(home);
    await writeFile(join(home, ".gitconfig"), "[init]\n\tdefaultBranch = main\n");
    gitEnv = {
      PATH: process.env.PATH ?? "",
      HOME: home,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
    };
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(work, { recursive: true, force: true });
  });

  // The server runs inside this test process, so git must be spawned
  // asynchronously; a sync spawn would block the event loop and deadlock.
  function git(args: string[], cwd?: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const child = spawn("git", args, { cwd, env: gitEnv, timeout: 60000 });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    });
  }

  function cloneUrl(repo: string, token?: string): string {
    const auth = token ? `x-access-token:${token}@` : "";
    return `http://${auth}127.0.0.1:${port}/octocat/${repo}.git`;
  }

  it("clones a private fixture repo with a minted installation token", { timeout: 60000 }, async () => {
    const token = mintInstallationToken(tokenMap);
    const dir = join(work, "private-clone");
    const clone = await git(["clone", cloneUrl("private-fixture", token), dir]);
    expect(clone.status, clone.stderr).toBe(0);

    for (const [path, content] of Object.entries(FIXTURE_FILES)) {
      expect(await readFile(join(dir, path), "utf8")).toBe(content);
    }

    const fsck = await git(["fsck", "--strict"], dir);
    expect(fsck.status, fsck.stderr).toBe(0);

    const log = await git(["log", "--format=%s|%an|%ae", "-n1"], dir);
    expect(log.stdout.trim()).toBe("Initial commit|octocat|octocat@localhost");

    const branch = await git(["branch", "--show-current"], dir);
    expect(branch.stdout.trim()).toBe("main");

    const head = await git(["rev-parse", "HEAD"], dir);
    const ref = await fetch(`http://127.0.0.1:${port}/repos/octocat/private-fixture/git/ref/heads/main`, {
      headers: { Authorization: "Bearer test-token" },
    });
    const refJson = (await ref.json()) as { object: { sha: string } };
    expect(head.stdout.trim()).toBe(refJson.object.sha);
  });

  it("fails to clone with a token that was never minted", { timeout: 60000 }, async () => {
    const clone = await git(["clone", cloneUrl("private-fixture", "ghs_never_minted"), join(work, "denied")]);
    expect(clone.status).not.toBe(0);
    expect(clone.stderr).toMatch(/Authentication failed|401/);
  });

  it("fails to clone a private repo anonymously", { timeout: 60000 }, async () => {
    const clone = await git(["clone", cloneUrl("private-fixture"), join(work, "anonymous")]);
    expect(clone.status).not.toBe(0);
  });

  it("clones a public fixture repo anonymously", { timeout: 60000 }, async () => {
    const dir = join(work, "public-clone");
    const clone = await git(["clone", cloneUrl("public-fixture"), dir]);
    expect(clone.status, clone.stderr).toBe(0);
    expect(await readFile(join(dir, "README.md"), "utf8")).toBe("# public-fixture\n");
  });

  it("clones a repo created at runtime through the REST API", { timeout: 60000 }, async () => {
    const create = await fetch(`http://127.0.0.1:${port}/user/repos`, {
      method: "POST",
      headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
      body: JSON.stringify({ name: "made-at-runtime", auto_init: true }),
    });
    expect(create.status).toBe(201);

    const dir = join(work, "runtime-clone");
    const clone = await git(["clone", cloneUrl("made-at-runtime", "test-token"), dir]);
    expect(clone.status, clone.stderr).toBe(0);
    expect(await readFile(join(dir, "README.md"), "utf8")).toBe("# made-at-runtime\n");
  });
});
