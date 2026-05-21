import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEmulator } from "../api.js";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const binaryPath = `/tmp/emulate-api-test-${process.pid}`;
let previousNativeBinary: string | undefined;

beforeAll(async () => {
  previousNativeBinary = process.env.EMULATE_NATIVE_BINARY;
  await execFileAsync("go", ["build", "-o", binaryPath, "./cmd/emulate"], { cwd: repoRoot });
  process.env.EMULATE_NATIVE_BINARY = binaryPath;
});

afterAll(async () => {
  if (previousNativeBinary == null) {
    delete process.env.EMULATE_NATIVE_BINARY;
  } else {
    process.env.EMULATE_NATIVE_BINARY = previousNativeBinary;
  }
  await rm(binaryPath, { force: true });
});

describe("createEmulator", () => {
  it("starts github through the native Go engine and returns a url", async () => {
    const github = await createEmulator({ service: "github", port: 14000 });

    expect(github.url).toBe("http://localhost:14000");

    const res = await fetch(`${github.url}/user`, {
      headers: { Authorization: "token test_token_admin" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { login: string };
    expect(body.login).toBe("admin");

    await github.close();
  });

  it("starts multiple native services independently", async () => {
    const [github, vercel] = await Promise.all([
      createEmulator({ service: "github", port: 14010 }),
      createEmulator({ service: "vercel", port: 14011 }),
    ]);

    expect(github.url).toBe("http://localhost:14010");
    expect(vercel.url).toBe("http://localhost:14011");

    await Promise.all([github.close(), vercel.close()]);
  });

  it("reset restarts the native process and reapplies seed config", async () => {
    const github = await createEmulator({
      service: "github",
      port: 14020,
      seed: { github: { users: [{ login: "test-user" }] } },
    });

    const createRes = await fetch(`${github.url}/user/repos`, {
      method: "POST",
      headers: {
        Authorization: "token test_token_admin",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "my-repo", private: false }),
    });
    expect(createRes.status).toBe(201);

    await github.reset();

    const listRes = await fetch(`${github.url}/user/repos`, {
      headers: { Authorization: "token test_token_admin" },
    });
    expect(listRes.status).toBe(200);
    const repos = (await listRes.json()) as unknown[];
    expect(repos).toHaveLength(0);

    await github.close();
  });

  it("throws on unknown service", async () => {
    // @ts-expect-error testing invalid service name
    await expect(createEmulator({ service: "unknown-svc" })).rejects.toThrow("Unknown service");
  });

  it("cleans up the native process when startup readiness times out", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "emulate-api-timeout-"));
    const fakeBinary = join(tempDir, "fake-emulate.js");
    const pidFile = join(tempDir, "pid");
    const previousFakePidFile = process.env.EMULATE_FAKE_PID_FILE;

    await writeFile(
      fakeBinary,
      [
        "#!/usr/bin/env node",
        'import { writeFileSync } from "node:fs";',
        "writeFileSync(process.env.EMULATE_FAKE_PID_FILE, String(process.pid));",
        "setInterval(() => {}, 1000);",
        "",
      ].join("\n"),
    );
    await chmod(fakeBinary, 0o755);

    process.env.EMULATE_NATIVE_BINARY = fakeBinary;
    process.env.EMULATE_FAKE_PID_FILE = pidFile;

    try {
      await expect(createEmulator({ service: "github", port: 14030, startupTimeoutMs: 500 })).rejects.toThrow(
        "Timed out waiting for native emulate process",
      );
      const pid = Number(await readFile(pidFile, "utf8"));
      expect(isProcessRunning(pid)).toBe(false);
    } finally {
      process.env.EMULATE_NATIVE_BINARY = binaryPath;
      if (previousFakePidFile == null) {
        delete process.env.EMULATE_FAKE_PID_FILE;
      } else {
        process.env.EMULATE_FAKE_PID_FILE = previousFakePidFile;
      }
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
