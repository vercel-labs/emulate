import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createVercelScaffold } from "../commands/vercel.js";

const tempDirs: string[] = [];

describe("createVercelScaffold", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates the Vercel Go Function scaffold", () => {
    const cwd = tempDir();
    const result = createVercelScaffold({ cwd, version: "0.5.0" });

    expect(result.created.sort()).toEqual(["api/emulate.go", "go.mod", "vercel.json"]);
    expect(readFileSync(join(cwd, "api/emulate.go"), "utf-8")).toContain(
      'emulate "github.com/vercel-labs/emulate/vercel"',
    );
    expect(readFileSync(join(cwd, "api/emulate.go"), "utf-8")).toContain('Services: []string{"aws", "resend"}');
    expect(readFileSync(join(cwd, "go.mod"), "utf-8")).toContain(
      "require github.com/vercel-labs/emulate v0.5.0",
    );
    const vercelConfig = JSON.parse(readFileSync(join(cwd, "vercel.json"), "utf-8")) as {
      rewrites: Array<{ source: string; destination: string }>;
    };
    expect(vercelConfig.rewrites).toContainEqual({
      source: "/emulate/:path*",
      destination: "/api/emulate?path=:path*",
    });
  });

  it("merges the rewrite into an existing vercel.json", () => {
    const cwd = tempDir();
    writeFileSync(
      join(cwd, "vercel.json"),
      JSON.stringify({
        cleanUrls: true,
        rewrites: [{ source: "/docs/:path*", destination: "/docs/:path*" }],
      }),
    );

    const result = createVercelScaffold({ cwd, version: "0.5.0", service: "resend" });

    expect(result.updated).toEqual(["vercel.json"]);
    const handler = readFileSync(join(cwd, "api/emulate.go"), "utf-8");
    expect(handler).toContain('Services: []string{"resend"}');
    const config = JSON.parse(readFileSync(join(cwd, "vercel.json"), "utf-8")) as {
      cleanUrls: boolean;
      rewrites: Array<{ source: string; destination: string }>;
    };
    expect(config.cleanUrls).toBe(true);
    expect(config.rewrites).toEqual([
      { source: "/docs/:path*", destination: "/docs/:path*" },
      { source: "/emulate/:path*", destination: "/api/emulate?path=:path*" },
    ]);
  });

  it("is idempotent when generated files already exist", () => {
    const cwd = tempDir();
    createVercelScaffold({ cwd, version: "0.5.0" });

    const result = createVercelScaffold({ cwd, version: "0.5.0" });

    expect(result.created).toEqual([]);
    expect(result.updated).toEqual([]);
    expect(result.unchanged.sort()).toEqual(["api/emulate.go", "go.mod", "vercel.json"]);
  });

  it("rejects services not available in the native Vercel scaffold", () => {
    const cwd = tempDir();

    expect(() => createVercelScaffold({ cwd, version: "0.5.0", service: "github" })).toThrow(
      "currently supports native services: aws, resend",
    );
  });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "emulate-vercel-"));
  tempDirs.push(dir);
  return dir;
}
