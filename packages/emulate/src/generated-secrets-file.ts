import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
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
}

interface FileIdentity {
  dev: bigint;
  ino: bigint;
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

  const target = { path, parent };
  const probeSource = temporaryPath(target, "probe");
  const probeLink = temporaryPath(target, "probe-link");
  let probeIdentity: FileIdentity | undefined;
  let linkCreated = false;

  try {
    const file = await open(probeSource, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try {
      const initialStats = await file.stat({ bigint: true });
      probeIdentity = { dev: initialStats.dev, ino: initialStats.ino };
      await file.chmod(0o600);
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
): Promise<void> {
  const temporary = temporaryPath(target, "tmp");
  let temporaryIdentity: FileIdentity | undefined;
  let published = false;

  try {
    const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try {
      const initialStats = await file.stat({ bigint: true });
      temporaryIdentity = { dev: initialStats.dev, ino: initialStats.ino };
      await file.chmod(0o600);
      const privateStats = await file.stat({ bigint: true });
      if (!privateStats.isFile() || (privateStats.mode & 0o777n) !== 0o600n) {
        throw new Error(`Generated secrets file permissions could not be restricted to 0600: ${temporary}`);
      }
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
