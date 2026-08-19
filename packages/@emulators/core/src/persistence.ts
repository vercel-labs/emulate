import { readFile, mkdir, open, link, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export interface PersistenceAdapter {
  load(): Promise<string | null>;
  save(data: string): Promise<void>;
  initialize?(data: string): Promise<string>;
}

export function filePersistence(path: string): PersistenceAdapter {
  return {
    async load() {
      try {
        return await readFile(path, "utf-8");
      } catch {
        return null;
      }
    },
    async save(data: string) {
      await mkdir(dirname(path), { recursive: true });
      const temporaryPath = `${path}.${randomUUID()}.tmp`;
      try {
        const file = await open(temporaryPath, "wx", 0o600);
        try {
          await file.chmod(0o600);
          await file.writeFile(data, "utf-8");
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(temporaryPath, path);
      } finally {
        await unlink(temporaryPath).catch(() => {});
      }
    },
    async initialize(data: string) {
      await mkdir(dirname(path), { recursive: true });
      const temporaryPath = `${path}.${randomUUID()}.tmp`;
      try {
        const file = await open(temporaryPath, "wx", 0o600);
        try {
          await file.chmod(0o600);
          await file.writeFile(data, "utf-8");
          await file.sync();
        } finally {
          await file.close();
        }
        try {
          await link(temporaryPath, path);
          return data;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          return await readFile(path, "utf-8");
        }
      } catch (error) {
        throw error;
      } finally {
        await unlink(temporaryPath).catch(() => {});
      }
    },
  };
}
