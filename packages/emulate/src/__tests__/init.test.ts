import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { initCommand } from "../commands/init.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe("initCommand", () => {
  const originalCwd = process.cwd();
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "emulate-init-"));
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates config for an external plugin when explicitly targeted", async () => {
    await initCommand({
      service: "echo",
      plugin: resolve(__dirname, "fixtures/echo-plugin.ts"),
    });

    const content = readFileSync(join(tempDir, "emulate.config.yaml"), "utf-8");
    expect(content).toContain("tokens:");
    expect(content).toContain("echo:");
    expect(content).toContain("message: hello");
  });
});
