import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createVercelScaffold, DEFAULT_VERCEL_SERVICE_OPTION } from "../commands/vercel.js";

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
    expect(readFileSync(join(cwd, "api/emulate.go"), "utf-8")).toContain(
      'Services: []string{"apple", "aws", "github", "google", "microsoft", "resend", "slack", "vercel"}',
    );
    expect(readFileSync(join(cwd, "go.mod"), "utf-8")).toContain("require github.com/vercel-labs/emulate v0.5.0");
    const vercelConfig = JSON.parse(readFileSync(join(cwd, "vercel.json"), "utf-8")) as {
      rewrites: Array<{ source: string; destination: string }>;
    };
    expect(vercelConfig.rewrites).toContainEqual({
      source: "/emulate/:path*",
      destination: "/api/emulate?path=:path*",
    });
  });

  it("includes google in the shared Vercel CLI service default", () => {
    expect(DEFAULT_VERCEL_SERVICE_OPTION).toBe("apple,aws,github,google,microsoft,resend,slack,vercel");
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

  it("inserts the rewrite before a catch-all rewrite", () => {
    const cwd = tempDir();
    writeFileSync(
      join(cwd, "vercel.json"),
      JSON.stringify({
        rewrites: [{ source: "/(.*)", destination: "/index.html" }],
      }),
    );

    createVercelScaffold({ cwd, version: "0.5.0" });

    const config = JSON.parse(readFileSync(join(cwd, "vercel.json"), "utf-8")) as {
      rewrites: Array<{ source: string; destination: string }>;
    };
    expect(config.rewrites).toEqual([
      { source: "/emulate/:path*", destination: "/api/emulate?path=:path*" },
      { source: "/(.*)", destination: "/index.html" },
    ]);
  });

  it("moves an existing rewrite before a catch-all rewrite", () => {
    const cwd = tempDir();
    writeFileSync(
      join(cwd, "vercel.json"),
      JSON.stringify({
        rewrites: [
          { source: "/(.*)", destination: "/index.html" },
          { source: "/emulate/:path*", destination: "/api/emulate?path=:path*" },
        ],
      }),
    );

    const result = createVercelScaffold({ cwd, version: "0.5.0" });

    expect(result.updated).toContain("vercel.json");
    const config = JSON.parse(readFileSync(join(cwd, "vercel.json"), "utf-8")) as {
      rewrites: Array<{ source: string; destination: string }>;
    };
    expect(config.rewrites).toEqual([
      { source: "/emulate/:path*", destination: "/api/emulate?path=:path*" },
      { source: "/(.*)", destination: "/index.html" },
    ]);
  });

  it("moves an existing rewrite before a catch-all rewrite when forced", () => {
    const cwd = tempDir();
    writeFileSync(
      join(cwd, "vercel.json"),
      JSON.stringify({
        rewrites: [
          { source: "/(.*)", destination: "/index.html" },
          { source: "/emulate/:path*", destination: "/api/emulate?path=:path*" },
        ],
      }),
    );

    const result = createVercelScaffold({ cwd, version: "0.5.0", force: true });

    expect(result.updated).toContain("vercel.json");
    const config = JSON.parse(readFileSync(join(cwd, "vercel.json"), "utf-8")) as {
      rewrites: Array<{ source: string; destination: string }>;
    };
    expect(config.rewrites).toEqual([
      { source: "/emulate/:path*", destination: "/api/emulate?path=:path*" },
      { source: "/(.*)", destination: "/index.html" },
    ]);
  });

  it("adds the Go dependency to an existing module", () => {
    const cwd = tempDir();
    writeFileSync(
      join(cwd, "go.mod"),
      `module example.com/app

go 1.24

require (
\tgithub.com/example/dependency v1.0.0
)
`,
    );

    const result = createVercelScaffold({ cwd, version: "0.5.0" });

    expect(result.updated).toContain("go.mod");
    expect(readFileSync(join(cwd, "go.mod"), "utf-8")).toContain("github.com/vercel-labs/emulate v0.5.0");
  });

  it("updates an older Go directive to the required Vercel function version", () => {
    const cwd = tempDir();
    writeFileSync(
      join(cwd, "go.mod"),
      `module example.com/app

go 1.20

require github.com/vercel-labs/emulate v0.5.0
`,
    );

    const result = createVercelScaffold({ cwd, version: "0.5.0" });

    expect(result.updated).toContain("go.mod");
    const content = readFileSync(join(cwd, "go.mod"), "utf-8");
    expect(content).toContain("go 1.24");
    expect(content).not.toContain("go 1.20");
  });

  it("inserts a Go directive when an existing module is missing one", () => {
    const cwd = tempDir();
    writeFileSync(
      join(cwd, "go.mod"),
      `module example.com/app

require github.com/vercel-labs/emulate v0.5.0
`,
    );

    const result = createVercelScaffold({ cwd, version: "0.5.0" });

    expect(result.updated).toContain("go.mod");
    expect(readFileSync(join(cwd, "go.mod"), "utf-8")).toContain(`module example.com/app

go 1.24

require github.com/vercel-labs/emulate v0.5.0`);
  });

  it("updates an existing Go dependency to the current scaffold version", () => {
    const cwd = tempDir();
    writeFileSync(
      join(cwd, "go.mod"),
      `module example.com/app

go 1.24

require (
\tgithub.com/vercel-labs/emulate v0.4.0 // indirect
)
`,
    );

    const result = createVercelScaffold({ cwd, version: "0.5.0" });

    expect(result.updated).toContain("go.mod");
    const content = readFileSync(join(cwd, "go.mod"), "utf-8");
    expect(content).toContain("github.com/vercel-labs/emulate v0.5.0 // indirect");
    expect(content).not.toContain("v0.4.0");
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

    expect(() => createVercelScaffold({ cwd, version: "0.5.0", service: "okta" })).toThrow(
      "currently supports native services: apple, aws, github, google, microsoft, resend, slack, vercel",
    );
  });

  it("does not leave partial scaffold files when vercel.json validation fails", () => {
    const cwd = tempDir();
    writeFileSync(
      join(cwd, "vercel.json"),
      JSON.stringify({
        rewrites: [{ source: "/emulate/:path*", destination: "/other" }],
      }),
    );

    expect(() => createVercelScaffold({ cwd, version: "0.5.0" })).toThrow(
      "vercel.json already has a rewrite for /emulate/:path*",
    );
    expect(() => readFileSync(join(cwd, "api/emulate.go"), "utf-8")).toThrow();
    expect(() => readFileSync(join(cwd, "go.mod"), "utf-8")).toThrow();
  });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "emulate-vercel-"));
  tempDirs.push(dir);
  return dir;
}
