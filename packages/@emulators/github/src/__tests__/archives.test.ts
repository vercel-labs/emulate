import { crc32, gunzipSync } from "zlib";
import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "@emulators/core";
import { Store } from "@emulators/core";
import { WebhookDispatcher } from "@emulators/core";
import { authMiddleware, createApiErrorHandler, createErrorHandler, type TokenMap } from "@emulators/core";
import { githubPlugin, seedFromConfig } from "../index.js";

const base = "http://localhost:4000";

function createTestApp() {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map();
  tokenMap.set("test-token", { login: "octocat", id: 1, scopes: ["repo", "user", "admin:org"] });
  tokenMap.set("outsider-token", { login: "outsider", id: 2, scopes: ["repo"] });

  const app = new Hono();
  app.onError(createApiErrorHandler());
  app.use("*", createErrorHandler());
  app.use("*", authMiddleware(tokenMap));
  githubPlugin.register(app as any, store, webhooks, base, tokenMap);
  githubPlugin.seed?.(store, base);
  seedFromConfig(store, base, {
    users: [{ login: "octocat" }, { login: "outsider" }],
    repos: [
      { owner: "octocat", name: "hello-world" },
      { owner: "octocat", name: "secret", private: true },
      { owner: "octocat", name: "empty-repo", auto_init: false },
    ],
  });

  return app;
}

function authHeaders(token = "test-token"): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function jsonHeaders(token = "test-token"): Record<string, string> {
  return { ...authHeaders(token), "Content-Type": "application/json" };
}

interface TarEntry {
  name: string;
  type: string;
  mode: number;
  linkname: string;
  data: Buffer;
}

/** Minimal ustar reader that also validates header checksums and applies pax path records. */
function readTar(gzipped: Buffer): { comment?: string; entries: TarEntry[] } {
  const tar = gunzipSync(gzipped);
  const entries: TarEntry[] = [];
  let comment: string | undefined;
  let paxPath: string | undefined;
  let offset = 0;
  const parsePax = (data: Buffer) =>
    Object.fromEntries(
      data
        .toString("utf8")
        .split("\n")
        .filter(Boolean)
        .map((record) => record.slice(record.indexOf(" ") + 1).split("=", 2)),
    );

  while (offset + 512 <= tar.byteLength) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start: number, length: number) =>
      header
        .subarray(start, start + length)
        .toString("utf8")
        .replace(/\0[\s\S]*$/, "");

    let expected = 0;
    for (let i = 0; i < 512; i++) expected += i >= 148 && i < 156 ? 0x20 : header[i];
    expect(parseInt(field(148, 8), 8)).toBe(expected);
    expect(field(257, 6)).toBe("ustar");

    const size = parseInt(field(124, 12), 8);
    const type = field(156, 1) || "0";
    const data = Buffer.from(tar.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;

    if (type === "g") {
      comment = parsePax(data).comment;
      continue;
    }
    if (type === "x") {
      paxPath = parsePax(data).path;
      continue;
    }
    const prefix = field(345, 155);
    const name = paxPath ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    paxPath = undefined;
    entries.push({ name, type, mode: parseInt(field(100, 8), 8), linkname: field(157, 100), data });
  }
  return { comment, entries };
}

interface ZipEntry {
  name: string;
  mode: number;
  directory: boolean;
  crc: number;
  data: Buffer;
}

/** Minimal zip reader that walks the central directory and reads stored entry data. */
function readZip(zip: Buffer): ZipEntry[] {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(end).toBeGreaterThan(-1);
  const count = zip.readUInt16LE(end + 10);
  let position = zip.readUInt32LE(end + 16);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(position)).toBe(0x02014b50);
    expect(zip.readUInt16LE(position + 10)).toBe(0);
    const crc = zip.readUInt32LE(position + 16);
    const size = zip.readUInt32LE(position + 24);
    const nameLength = zip.readUInt16LE(position + 28);
    const extraLength = zip.readUInt16LE(position + 30);
    const commentLength = zip.readUInt16LE(position + 32);
    const external = zip.readUInt32LE(position + 38);
    const localOffset = zip.readUInt32LE(position + 42);
    const name = zip.subarray(position + 46, position + 46 + nameLength).toString("utf8");

    expect(zip.readUInt32LE(localOffset)).toBe(0x04034b50);
    const dataStart = localOffset + 30 + zip.readUInt16LE(localOffset + 26) + zip.readUInt16LE(localOffset + 28);
    const data = Buffer.from(zip.subarray(dataStart, dataStart + size));
    entries.push({ name, mode: external >>> 16, directory: (external & 0x10) !== 0, crc, data });
    position += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function headSha(app: Hono, ref = "main"): Promise<string> {
  const response = await app.request(`${base}/repos/octocat/hello-world/commits/${ref}`, { headers: authHeaders() });
  expect(response.status).toBe(200);
  return ((await response.json()) as { sha: string }).sha;
}

describe("GitHub repository archives", () => {
  let app: Hono;

  beforeEach(() => {
    app = createTestApp();
  });

  it("serves the default branch tarball directly with a 200", async () => {
    const sha = await headSha(app);
    const readme = await app.request(`${base}/repos/octocat/hello-world/readme`, { headers: authHeaders() });
    const readmeText = Buffer.from(((await readme.json()) as { content: string }).content, "base64").toString("utf8");

    const response = await app.request(`${base}/repos/octocat/hello-world/tarball`, { headers: authHeaders() });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/x-gzip");
    const prefix = `octocat-hello-world-${sha.slice(0, 7)}`;
    expect(response.headers.get("Content-Disposition")).toBe(`attachment; filename=${prefix}.tar.gz`);
    const body = Buffer.from(await response.arrayBuffer());
    expect(response.headers.get("Content-Length")).toBe(String(body.byteLength));

    const tar = readTar(body);
    expect(tar.comment).toBe(sha);
    expect(tar.entries.map((entry) => [entry.name, entry.type])).toEqual([
      [`${prefix}/`, "5"],
      [`${prefix}/README.md`, "0"],
    ]);
    expect(tar.entries[1].mode).toBe(0o644);
    expect(tar.entries[1].data.toString("utf8")).toBe(readmeText);
  });

  it("serves the default branch zipball directly with a 200", async () => {
    const sha = await headSha(app);
    const response = await app.request(`${base}/repos/octocat/hello-world/zipball/`, { headers: authHeaders() });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/zip");
    const prefix = `octocat-hello-world-${sha.slice(0, 7)}`;
    expect(response.headers.get("Content-Disposition")).toBe(`attachment; filename=${prefix}.zip`);

    const entries = readZip(Buffer.from(await response.arrayBuffer()));
    expect(entries.map((entry) => entry.name)).toEqual([`${prefix}/`, `${prefix}/README.md`]);
    expect(entries[0].directory).toBe(true);
    expect(entries[1].directory).toBe(false);
    expect(entries[1].crc).toBe(crc32(entries[1].data));
    expect(entries[1].data.toString("utf8")).toContain("hello-world");
  });

  it("resolves branch, tag, full ref, and sha archive refs", async () => {
    const initial = await headSha(app);
    const nested = await app.request(`${base}/repos/octocat/hello-world/git/refs`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ ref: "refs/heads/feature/nested", sha: initial }),
    });
    expect(nested.status).toBe(201);
    const written = await app.request(`${base}/repos/octocat/hello-world/contents/docs/notes.txt`, {
      method: "PUT",
      headers: jsonHeaders(),
      body: JSON.stringify({
        message: "Add notes",
        content: Buffer.from("notes\n").toString("base64"),
        branch: "feature/nested",
      }),
    });
    expect(written.status).toBe(201);
    const nestedSha = ((await written.json()) as { commit: { sha: string } }).commit.sha;
    const tagged = await app.request(`${base}/repos/octocat/hello-world/git/refs`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ ref: "refs/tags/v1.0.0", sha: nestedSha }),
    });
    expect(tagged.status).toBe(201);

    const names = async (ref: string) => {
      const response = await app.request(`${base}/repos/octocat/hello-world/tarball/${ref}`, {
        headers: authHeaders(),
      });
      expect(response.status).toBe(200);
      return readTar(Buffer.from(await response.arrayBuffer())).entries.map((entry) => entry.name);
    };
    const nestedPrefix = `octocat-hello-world-${nestedSha.slice(0, 7)}`;
    const nestedNames = [
      `${nestedPrefix}/`,
      `${nestedPrefix}/README.md`,
      `${nestedPrefix}/docs/`,
      `${nestedPrefix}/docs/notes.txt`,
    ];
    expect(await names("feature/nested")).toEqual(nestedNames);
    expect(await names("refs/heads/feature/nested")).toEqual(nestedNames);
    expect(await names("v1.0.0")).toEqual(nestedNames);
    expect(await names(nestedSha)).toEqual(nestedNames);
    expect(await names(nestedSha.slice(0, 8))).toEqual(nestedNames);

    const initialPrefix = `octocat-hello-world-${initial.slice(0, 7)}`;
    expect(await names("main")).toEqual([`${initialPrefix}/`, `${initialPrefix}/README.md`]);

    const missing = await app.request(`${base}/repos/octocat/hello-world/zipball/does-not-exist`, {
      headers: authHeaders(),
    });
    expect(missing.status).toBe(404);
  });

  it("preserves file modes, symlinks, nested directories, and binary content", async () => {
    const sha = await headSha(app);
    const commitResponse = await app.request(`${base}/repos/octocat/hello-world/commits/${sha}`, {
      headers: authHeaders(),
    });
    const baseTree = ((await commitResponse.json()) as { commit: { tree: { sha: string } } }).commit.tree.sha;

    const binary = Buffer.from([0x00, 0xff, 0x10, 0x80, 0x7f, 0x00, 0x01]);
    const blob = await app.request(`${base}/repos/octocat/hello-world/git/blobs`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ content: binary.toString("base64"), encoding: "base64" }),
    });
    expect(blob.status).toBe(201);
    const binarySha = ((await blob.json()) as { sha: string }).sha;

    const tree = await app.request(`${base}/repos/octocat/hello-world/git/trees`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        base_tree: baseTree,
        tree: [
          { path: "bin/run.sh", mode: "100755", type: "blob", content: "#!/bin/sh\necho hi\n" },
          { path: "docs/guide.md", mode: "100644", type: "blob", content: "# Guide\n" },
          { path: "guide-link", mode: "120000", type: "blob", content: "docs/guide.md" },
          { path: "assets/logo.bin", mode: "100644", type: "blob", sha: binarySha },
        ],
      }),
    });
    expect(tree.status).toBe(201);
    const treeSha = ((await tree.json()) as { sha: string }).sha;

    const commit = await app.request(`${base}/repos/octocat/hello-world/git/commits`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ message: "Add tooling", tree: treeSha, parents: [sha] }),
    });
    expect(commit.status).toBe(201);
    const newSha = ((await commit.json()) as { sha: string }).sha;
    const moved = await app.request(`${base}/repos/octocat/hello-world/git/refs/heads/main`, {
      method: "PATCH",
      headers: jsonHeaders(),
      body: JSON.stringify({ sha: newSha }),
    });
    expect(moved.status).toBe(200);
    const prefix = `octocat-hello-world-${newSha.slice(0, 7)}`;

    const tarball = await app.request(`${base}/repos/octocat/hello-world/tarball/main`, { headers: authHeaders() });
    expect(tarball.status).toBe(200);
    const tar = readTar(Buffer.from(await tarball.arrayBuffer()));
    const byName = new Map(tar.entries.map((entry) => [entry.name, entry]));
    expect([...byName.keys()]).toEqual([
      `${prefix}/`,
      `${prefix}/README.md`,
      `${prefix}/assets/`,
      `${prefix}/assets/logo.bin`,
      `${prefix}/bin/`,
      `${prefix}/bin/run.sh`,
      `${prefix}/docs/`,
      `${prefix}/docs/guide.md`,
      `${prefix}/guide-link`,
    ]);
    expect(byName.get(`${prefix}/bin/`)).toMatchObject({ type: "5", mode: 0o755 });
    expect(byName.get(`${prefix}/bin/run.sh`)).toMatchObject({ type: "0", mode: 0o755 });
    expect(byName.get(`${prefix}/docs/guide.md`)).toMatchObject({ type: "0", mode: 0o644 });
    expect(byName.get(`${prefix}/guide-link`)).toMatchObject({ type: "2", mode: 0o777, linkname: "docs/guide.md" });
    expect(byName.get(`${prefix}/assets/logo.bin`)!.data.equals(binary)).toBe(true);
    expect(byName.get(`${prefix}/bin/run.sh`)!.data.toString("utf8")).toBe("#!/bin/sh\necho hi\n");

    const zipball = await app.request(`${base}/repos/octocat/hello-world/zipball/main`, { headers: authHeaders() });
    expect(zipball.status).toBe(200);
    const zip = new Map(readZip(Buffer.from(await zipball.arrayBuffer())).map((entry) => [entry.name, entry]));
    expect([...zip.keys()]).toEqual([...byName.keys()]);
    expect(zip.get(`${prefix}/bin/`)).toMatchObject({ directory: true, mode: 0o040755 });
    expect(zip.get(`${prefix}/bin/run.sh`)).toMatchObject({ directory: false, mode: 0o100755 });
    expect(zip.get(`${prefix}/docs/guide.md`)).toMatchObject({ mode: 0o100644 });
    expect(zip.get(`${prefix}/guide-link`)).toMatchObject({ mode: 0o120777 });
    expect(zip.get(`${prefix}/guide-link`)!.data.toString("utf8")).toBe("docs/guide.md");
    expect(zip.get(`${prefix}/assets/logo.bin`)!.data.equals(binary)).toBe(true);
    for (const entry of zip.values()) expect(entry.crc).toBe(crc32(entry.data));
  });

  it("stores long paths through pax extended headers", async () => {
    const deep = `${"directory-with-a-long-name/".repeat(6)}${"f".repeat(120)}.txt`;
    const written = await app.request(`${base}/repos/octocat/hello-world/contents/${deep}`, {
      method: "PUT",
      headers: jsonHeaders(),
      body: JSON.stringify({ message: "Deep file", content: Buffer.from("deep\n").toString("base64") }),
    });
    expect(written.status).toBe(201);
    const sha = ((await written.json()) as { commit: { sha: string } }).commit.sha;

    const tarball = await app.request(`${base}/repos/octocat/hello-world/tarball/${sha}`, { headers: authHeaders() });
    const tar = readTar(Buffer.from(await tarball.arrayBuffer()));
    const entry = tar.entries.find((candidate) => candidate.name.endsWith(".txt"));
    expect(entry?.name).toBe(`octocat-hello-world-${sha.slice(0, 7)}/${deep}`);
    expect(entry?.data.toString("utf8")).toBe("deep\n");
  });

  it("requires repository read access and rejects empty repositories", async () => {
    const anonymous = await app.request(`${base}/repos/octocat/secret/tarball`);
    expect(anonymous.status).toBe(401);
    const outsider = await app.request(`${base}/repos/octocat/secret/zipball`, {
      headers: authHeaders("outsider-token"),
    });
    expect(outsider.status).toBe(403);
    const owner = await app.request(`${base}/repos/octocat/secret/tarball`, { headers: authHeaders() });
    expect(owner.status).toBe(200);

    const publicAnonymous = await app.request(`${base}/repos/octocat/hello-world/zipball`);
    expect(publicAnonymous.status).toBe(200);

    const empty = await app.request(`${base}/repos/octocat/empty-repo/tarball`, { headers: authHeaders() });
    expect(empty.status).toBe(404);
    const unknown = await app.request(`${base}/repos/octocat/nope/tarball`, { headers: authHeaders() });
    expect(unknown.status).toBe(404);
  });
});
