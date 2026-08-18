import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  spawnSync: vi.fn(() => ({
    error: Object.assign(new Error("ACL tool unavailable"), { code: "ENOENT" }),
    status: null,
    stdout: "",
    stderr: "",
  })),
}));

vi.mock("node:child_process", () => ({
  spawnSync: mocks.spawnSync,
}));

const { preflightGeneratedSecretsFile } = await import("../generated-secrets-file.js");
const directories: string[] = [];

afterEach(async () => {
  vi.clearAllMocks();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("generated secrets ACL support", () => {
  it("fails closed and removes probes when ACL tools are unavailable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "emulate-generated-secrets-acl-unsupported-"));
    directories.push(directory);

    await expect(preflightGeneratedSecretsFile(join(directory, "secrets.json"))).rejects.toThrow(
      "ACL command is unavailable",
    );

    expect(mocks.spawnSync).toHaveBeenCalledOnce();
    expect(await readdir(directory)).toEqual([]);
  });
});
