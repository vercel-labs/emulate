import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { describe, expect, it, vi } from "vitest";
import { initCommand } from "../commands/init.js";
import { DEFAULT_TOKENS, SERVICE_NAMES, SERVICE_REGISTRY } from "../registry.js";

const repoRoot = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
const examplePath = resolve(repoRoot, "emulate.config.example.yaml");
const validTopLevelKeys = new Set(["tokens", ...SERVICE_NAMES]);

describe("configuration examples", () => {
  it("contains the current service sections without placeholder PEM material", () => {
    const source = readFileSync(examplePath, "utf8");
    const config = parse(source) as Record<string, unknown>;

    expect(Object.keys(config).every((key) => validTopLevelKeys.has(key))).toBe(true);
    expect(SERVICE_NAMES.every((name) => name in config)).toBe(true);
    expect(source).not.toContain("BEGIN RSA PRIVATE KEY");
    expect(source).not.toContain("your PEM key");
    expect(source).not.toContain("...your");
  });

  it("generates a starter section for every registry service", () => {
    const previousDirectory = process.cwd();
    const directory = mkdtempSync(join(tmpdir(), "emulate-init-"));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      process.chdir(directory);
      initCommand({ service: "all" });

      const config = parse(readFileSync(join(directory, "emulate.config.yaml"), "utf8")) as Record<string, unknown>;

      expect(config.tokens).toEqual(DEFAULT_TOKENS.tokens);
      for (const name of SERVICE_NAMES) {
        expect(config[name]).toEqual(SERVICE_REGISTRY[name].initConfig[name]);
      }
    } finally {
      log.mockRestore();
      process.chdir(previousDirectory);
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
