import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface PersistenceAdapter {
  load(): Promise<string | null>;
  save(data: string): Promise<void>;
}

export function filePersistence(path: string): PersistenceAdapter {
  return {
    async load() {
      try {
        return readFileSync(path, "utf-8");
      } catch {
        return null;
      }
    },
    async save(data: string) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, data, "utf-8");
    },
  };
}
