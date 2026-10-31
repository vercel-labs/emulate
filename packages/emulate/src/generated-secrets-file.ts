import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { link, lstat, open, realpath, stat, unlink } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type { ServiceName } from "./registry.js";

export interface GeneratedSecretRecord {
  service: ServiceName;
  kind: string;
  id: string;
  label: string;
  value: string;
}

export interface GeneratedSecretsArtifact {
  schemaVersion: 1;
  generatedSecrets: GeneratedSecretRecord[];
}

export interface GeneratedSecretsFileTarget {
  path: string;
  parent: string;
  platform: NodeJS.Platform;
}

export interface FileIdentity {
  dev: bigint;
  ino: bigint;
}

export interface PublishedGeneratedSecretsFile {
  path: string;
  identity: FileIdentity;
  rollback(): Promise<void>;
}

function temporaryPath(target: GeneratedSecretsFileTarget, purpose: string): string {
  return resolve(target.parent, `.${basename(target.path)}.${process.pid}.${randomUUID()}.${purpose}`);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function removeCreatedPathIfOwned(path: string, identity: FileIdentity): Promise<void> {
  try {
    const stats = await lstat(path, { bigint: true });
    if (stats.dev === identity.dev && stats.ino === identity.ino) {
      await unlink(path);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function runAclCommand(command: string, args: string[], file: FileHandle): string {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe", file.fd],
  });
  if (result.error) {
    throw new Error(`Generated secrets ACL command is unavailable: ${command}`, { cause: result.error });
  }
  if (result.status !== 0) {
    throw new Error(`Generated secrets ACL command failed: ${command}: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

function verifyDarwinAcl(output: string): void {
  if (output.split("\n").some((line) => /^\s+\d+:/.test(line))) {
    throw new Error("Generated secrets file retains an access control list after sanitization");
  }
}

function verifyLinuxAcl(output: string): void {
  const entries = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  if (
    entries.length !== 3 ||
    entries[0] !== "user::rw-" ||
    entries[1] !== "group::---" ||
    entries[2] !== "other::---"
  ) {
    throw new Error("Generated secrets file retains non-owner access after ACL sanitization");
  }
}

async function sanitizeAndVerifyPrivateFile(file: FileHandle, platform: NodeJS.Platform): Promise<FileIdentity> {
  await file.chmod(0o600);
  const getuid = process.getuid;
  if (!getuid) {
    throw new Error("--generated-secrets-file requires owner identity verification");
  }

  if (platform === "darwin") {
    runAclCommand("/bin/chmod", ["-N", "/dev/fd/3"], file);
    verifyDarwinAcl(runAclCommand("/bin/ls", ["-le", "/dev/fd/3"], file));
  } else if (platform === "linux") {
    runAclCommand("setfacl", ["-b", "/proc/self/fd/3"], file);
    verifyLinuxAcl(runAclCommand("getfacl", ["-c", "/proc/self/fd/3"], file));
  } else {
    throw new Error(`--generated-secrets-file is not supported on ${platform}`);
  }

  const stats = await file.stat({ bigint: true });
  if (!stats.isFile() || (stats.mode & 0o777n) !== 0o600n || stats.uid !== BigInt(getuid())) {
    throw new Error("Generated secrets file could not be verified as an owner-only regular file");
  }
  return { dev: stats.dev, ino: stats.ino };
}

async function verifyPathIdentity(path: string, identity: FileIdentity): Promise<void> {
  const stats = await lstat(path, { bigint: true });
  if (stats.dev !== identity.dev || stats.ino !== identity.ino) {
    throw new Error(`Generated secrets path identity changed during publication: ${path}`);
  }
}

async function verifyPrivateRegularFile(path: string): Promise<void> {
  const stats = await lstat(path);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`Generated secrets path is not a regular file: ${path}`);
  }
  if ((stats.mode & 0o777) !== 0o600) {
    throw new Error(`Generated secrets file permissions could not be restricted to 0600: ${path}`);
  }
}

async function verifyHardLink(
  source: string,
  destination: string,
  expectedIdentity?: FileIdentity,
): Promise<FileIdentity> {
  const [sourceStats, destinationStats] = await Promise.all([
    lstat(source, { bigint: true }),
    lstat(destination, { bigint: true }),
  ]);
  if (
    sourceStats.dev !== destinationStats.dev ||
    sourceStats.ino !== destinationStats.ino ||
    sourceStats.nlink < 2 ||
    destinationStats.nlink < 2
  ) {
    throw new Error(`Generated secrets filesystem does not provide verifiable hard links: ${destination}`);
  }
  if (
    expectedIdentity &&
    (destinationStats.dev !== expectedIdentity.dev || destinationStats.ino !== expectedIdentity.ino)
  ) {
    throw new Error(`Generated secrets temporary file identity changed before publication: ${source}`);
  }
  return { dev: destinationStats.dev, ino: destinationStats.ino };
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, constants.O_RDONLY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export async function preflightGeneratedSecretsFile(
  destination: string,
  platform = process.platform,
): Promise<GeneratedSecretsFileTarget> {
  if (platform === "win32") {
    throw new Error("--generated-secrets-file is not supported on Windows");
  }
  if (platform !== "darwin" && platform !== "linux") {
    throw new Error(`--generated-secrets-file is not supported on ${platform}`);
  }

  const requestedPath = resolve(destination);
  const parent = await realpath(dirname(requestedPath));
  const path = resolve(parent, basename(requestedPath));
  const parentStats = await stat(parent);
  if (!parentStats.isDirectory()) {
    throw new Error(`Generated secrets parent is not a directory: ${parent}`);
  }
  if (await pathExists(path)) {
    throw new Error(`Generated secrets path already exists: ${path}`);
  }

  const target = { path, parent, platform };
  const probeSource = temporaryPath(target, "probe");
  const probeLink = temporaryPath(target, "probe-link");
  let probeIdentity: FileIdentity | undefined;
  let linkCreated = false;

  try {
    const file = await open(probeSource, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try {
      const initialStats = await file.stat({ bigint: true });
      probeIdentity = { dev: initialStats.dev, ino: initialStats.ino };
      await sanitizeAndVerifyPrivateFile(file, platform);
      await file.sync();
    } finally {
      await file.close();
    }
    await verifyPrivateRegularFile(probeSource);
    await link(probeSource, probeLink);
    linkCreated = true;
    await verifyPrivateRegularFile(probeLink);
    await verifyHardLink(probeSource, probeLink, probeIdentity);
    await syncDirectory(parent);
  } finally {
    if (linkCreated && probeIdentity) await removeCreatedPathIfOwned(probeLink, probeIdentity);
    if (probeIdentity) await removeCreatedPathIfOwned(probeSource, probeIdentity);
  }

  return target;
}

export async function publishGeneratedSecretsFile(
  target: GeneratedSecretsFileTarget,
  artifact: GeneratedSecretsArtifact,
): Promise<PublishedGeneratedSecretsFile> {
  const temporary = temporaryPath(target, "tmp");
  let temporaryIdentity: FileIdentity | undefined;
  let published = false;

  try {
    const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try {
      const initialStats = await file.stat({ bigint: true });
      temporaryIdentity = { dev: initialStats.dev, ino: initialStats.ino };
      await sanitizeAndVerifyPrivateFile(file, target.platform);
      await file.writeFile(`${JSON.stringify(artifact, null, 2)}\n`, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }

    await link(temporary, target.path);
    published = true;
    await verifyPrivateRegularFile(target.path);
    await verifyHardLink(temporary, target.path, temporaryIdentity);
    await removeCreatedPathIfOwned(temporary, temporaryIdentity);
    await syncDirectory(target.parent);
    await verifyPathIdentity(target.path, temporaryIdentity);
    await verifyPrivateRegularFile(target.path);
    const identity = temporaryIdentity;
    return {
      path: target.path,
      identity,
      async rollback() {
        const existed = await pathExists(target.path);
        if (!existed) return;
        const current = await lstat(target.path, { bigint: true });
        if (current.dev !== identity.dev || current.ino !== identity.ino) return;
        await unlink(target.path);
        await syncDirectory(target.parent);
      },
    };
  } catch (error) {
    if (temporaryIdentity) await removeCreatedPathIfOwned(temporary, temporaryIdentity);
    if (published && temporaryIdentity) {
      await removeCreatedPathIfOwned(target.path, temporaryIdentity);
      await syncDirectory(target.parent);
    }
    if ((error as NodeJS.ErrnoException).code === "EEXIST" && !published) {
      throw new Error(`Generated secrets path already exists: ${target.path}`, { cause: error });
    }
    throw error;
  }
}
