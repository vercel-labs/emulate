import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface PersistenceAdapter {
  load(): Promise<string | null>;
  save(data: string): Promise<void>;
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
      await writeFile(path, data, "utf-8");
    },
  };
}
