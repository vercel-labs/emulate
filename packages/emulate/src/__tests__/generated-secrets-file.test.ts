import { execFileSync } from "node:child_process";
import { access, chmod, lstat, mkdtemp, readFile, readdir, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  preflightGeneratedSecretsFile,
  publishGeneratedSecretsFile,
  type GeneratedSecretsArtifact,
} from "../generated-secrets-file.js";

const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "emulate-generated-secrets-"));
  directories.push(directory);
  return directory;
}

function artifact(value = "secret"): GeneratedSecretsArtifact {
  return {
    schemaVersion: 1,
    generatedSecrets: [{ service: "github", kind: "github.app_private_key", id: "1", label: "App", value }],
  };
}

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true, force: true }));
  }
});

describe("generated secrets file", () => {
  it("publishes complete JSON with owner-only permissions", async () => {
    const directory = await temporaryDirectory();
    const destination = join(directory, "secrets.json");
    const target = await preflightGeneratedSecretsFile(destination);
    const payload = artifact();

    await publishGeneratedSecretsFile(target, payload);

    expect(JSON.parse(await readFile(destination, "utf8"))).toEqual(payload);
    expect((await lstat(destination)).mode & 0o777).toBe(0o600);
    expect(await readdir(directory)).toEqual(["secrets.json"]);
  });

  it.runIf(process.platform === "darwin")("removes inherited ACLs before publishing", async () => {
    const directory = await temporaryDirectory();
    const destination = join(directory, "secrets.json");
    execFileSync("/bin/chmod", ["+a", "group:everyone allow read,file_inherit", directory]);

    const target = await preflightGeneratedSecretsFile(destination);
    await publishGeneratedSecretsFile(target, artifact());

    const acl = execFileSync("/bin/ls", ["-le", destination], { encoding: "utf8" });
    expect(acl).not.toMatch(/^\s+\d+:/m);
    expect((await lstat(destination)).mode & 0o777).toBe(0o600);
  });

  it("keeps 0600 permissions under a restrictive umask", async () => {
    const directory = await temporaryDirectory();
    const destination = join(directory, "secrets.json");
    const previousUmask = process.umask(0o077);
    try {
      const target = await preflightGeneratedSecretsFile(destination);
      await publishGeneratedSecretsFile(target, artifact());
    } finally {
      process.umask(previousUmask);
    }

    expect((await lstat(destination)).mode & 0o777).toBe(0o600);
  });

  it("publishes a valid empty artifact", async () => {
    const directory = await temporaryDirectory();
    const destination = join(directory, "secrets.json");
    const target = await preflightGeneratedSecretsFile(destination);

    await publishGeneratedSecretsFile(target, { schemaVersion: 1, generatedSecrets: [] });

    expect(JSON.parse(await readFile(destination, "utf8"))).toEqual({
      schemaVersion: 1,
      generatedSecrets: [],
    });
  });

  it.each(["file", "directory", "symlink"] as const)("refuses an existing %s without changing it", async (kind) => {
    const directory = await temporaryDirectory();
    const destination = join(directory, "secrets.json");
    if (kind === "file") await writeFile(destination, "keep");
    if (kind === "directory") await import("node:fs/promises").then(({ mkdir }) => mkdir(destination));
    if (kind === "symlink") {
      await writeFile(join(directory, "target"), "keep");
      await symlink(join(directory, "target"), destination);
    }
    const before = await lstat(destination);

    await expect(preflightGeneratedSecretsFile(destination)).rejects.toThrow("already exists");

    const after = await lstat(destination);
    expect(after.isFile()).toBe(before.isFile());
    expect(after.isDirectory()).toBe(before.isDirectory());
    expect(after.isSymbolicLink()).toBe(before.isSymbolicLink());
    if (kind !== "directory") expect(await readFile(destination, "utf8")).toBe("keep");
  });

  it("rejects a missing parent and Windows before creating files", async () => {
    const directory = await temporaryDirectory();
    const missingDestination = join(directory, "missing", "secrets.json");
    const windowsDestination = join(directory, "windows.json");

    await expect(preflightGeneratedSecretsFile(missingDestination)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(preflightGeneratedSecretsFile(windowsDestination, "win32")).rejects.toThrow(
      "not supported on Windows",
    );
    await expect(access(windowsDestination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an unwritable parent", async () => {
    const directory = await temporaryDirectory();
    const destination = join(directory, "secrets.json");
    await chmod(directory, 0o500);
    try {
      await expect(preflightGeneratedSecretsFile(destination)).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      await chmod(directory, 0o700);
    }
  });

  it("loses a destination race without overwriting and removes its temporary file", async () => {
    const directory = await temporaryDirectory();
    const destination = join(directory, "secrets.json");
    const target = await preflightGeneratedSecretsFile(destination);
    await writeFile(destination, "winner");

    await expect(publishGeneratedSecretsFile(target, artifact())).rejects.toThrow("already exists");

    expect(await readFile(destination, "utf8")).toBe("winner");
    expect(await readdir(directory)).toEqual(["secrets.json"]);
  });

  it("removes its temporary file when serialization fails", async () => {
    const directory = await temporaryDirectory();
    const destination = join(directory, "secrets.json");
    const target = await preflightGeneratedSecretsFile(destination);
    const invalidArtifact = {
      schemaVersion: 1,
      generatedSecrets: [{ service: "github", kind: "test", id: "1", label: "Test", value: 1n }],
    } as unknown as GeneratedSecretsArtifact;

    await expect(publishGeneratedSecretsFile(target, invalidArtifact)).rejects.toThrow();

    expect(await readdir(directory)).toEqual([]);
  });

  it("never exposes partial JSON at the destination", async () => {
    const directory = await temporaryDirectory();
    const destination = join(directory, "secrets.json");
    const target = await preflightGeneratedSecretsFile(destination);
    const payload = artifact("x".repeat(8 * 1024 * 1024));
    let stopped = false;
    const observations: string[] = [];
    const observer = (async () => {
      while (!stopped) {
        try {
          observations.push(await readFile(destination, "utf8"));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    })();

    await publishGeneratedSecretsFile(target, payload);
    stopped = true;
    await observer;
    observations.push(await readFile(destination, "utf8"));

    expect(observations.length).toBeGreaterThan(0);
    for (const observation of observations) {
      expect(() => JSON.parse(observation)).not.toThrow();
      expect(JSON.parse(observation)).toEqual(payload);
    }
  });

  it("rolls back only the exact published inode", async () => {
    const directory = await temporaryDirectory();
    const destination = join(directory, "secrets.json");
    const replacement = join(directory, "replacement.json");
    const target = await preflightGeneratedSecretsFile(destination);
    const published = await publishGeneratedSecretsFile(target, artifact());

    await rename(destination, join(directory, "published.json"));
    await writeFile(replacement, "keep");
    await rename(replacement, destination);
    await published.rollback();

    expect(await readFile(destination, "utf8")).toBe("keep");
    expect(await readFile(join(directory, "published.json"), "utf8")).toContain("secret");
  });

  it("removes the owned artifact and permits immediate retry", async () => {
    const directory = await temporaryDirectory();
    const destination = join(directory, "secrets.json");
    const target = await preflightGeneratedSecretsFile(destination);
    const published = await publishGeneratedSecretsFile(target, artifact());

    await published.rollback();

    await expect(access(destination)).rejects.toMatchObject({ code: "ENOENT" });
    const retryTarget = await preflightGeneratedSecretsFile(destination);
    await publishGeneratedSecretsFile(retryTarget, artifact("retry"));
    expect(await readFile(destination, "utf8")).toContain("retry");
  });
});
