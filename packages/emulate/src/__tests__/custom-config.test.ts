import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { stripTypeScriptTypes } from "node:module";
import { describe, it, expect, afterEach } from "vitest";
import { loadConfig } from "../config-loader.js";
import { scaffoldCommand } from "../commands/scaffold.js";
import { prepareProject } from "../project-runner.js";
import { ProjectLoader } from "../project-loader.js";

const directories: string[] = [];
const supportsNativeTransform = (() => {
  try {
    stripTypeScriptTypes("enum Stock { Count = 1 }", { mode: "transform" });
    return true;
  } catch (error) {
    if (error instanceof TypeError && "code" in error && error.code === "ERR_INVALID_ARG_VALUE") return false;
    throw error;
  }
})();
async function project() {
  const dir = await mkdtemp(join(tmpdir(), "emulate config space "));
  directories.push(dir);
  await mkdir(join(dir, "node_modules"));
  await symlink(
    resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
    join(dir, "node_modules/emulate"),
    "junction",
  );
  await writeFile(join(dir, "package.json"), '{"type":"module"}');
  return realpath(dir);
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("custom configuration and scaffold", () => {
  it("isolates simultaneous module graphs and keeps source metadata with erasable TypeScript", async () => {
    const dir = await project();
    const entry = join(dir, "entry.ts");
    const helper = join(dir, "helper.ts");
    await writeFile(helper, "export const Stock: { Count: number } = { Count: 3 }");
    await writeFile(
      entry,
      'import { Stock } from "./helper.js"; export default { count: Stock.Count, url: import.meta.url, directory: import.meta.dirname, filename: import.meta.filename };',
    );
    const first = new ProjectLoader(dir);
    const second = new ProjectLoader(dir);
    try {
      expect(await first.load(entry)).toMatchObject({ count: 3, directory: dir, filename: entry });
      await writeFile(helper, "export const Stock: { Count: number } = { Count: 7 }");
      const updated = (await second.load(entry)) as { count: number; url: string };
      expect(updated.count).toBe(7);
      expect(fileURLToPath(updated.url)).toBe(entry);
      expect(new URL(updated.url).search).toBe("");
      expect(await first.load(entry)).toMatchObject({ count: 3 });
      expect(second.dependencies.has(helper)).toBe(true);
    } finally {
      first.close();
      second.close();
    }
    await expect(first.load(entry)).rejects.toThrow("closed");
  });

  it.skipIf(!supportsNativeTransform)("supports TypeScript enums when native transform mode is available", async () => {
    const dir = await project();
    const entry = join(dir, "enum.ts");
    await writeFile(entry, "enum Stock { Count = 3 }\nexport default Stock.Count");
    const loader = new ProjectLoader(dir);
    try {
      expect(await loader.load(entry)).toBe(3);
    } finally {
      loader.close();
    }
  });

  it("resolves inherited JSONC aliases relative to their declaring config and prefers exact paths", async () => {
    const dir = await project();
    await mkdir(join(dir, "config"));
    await mkdir(join(dir, "src"));
    await writeFile(
      join(dir, "config/base.json"),
      '{ // shared aliases\n "compilerOptions": {"paths": {"@/*": ["../missing/*", "../src/*"], "@/value": ["../src/exact.ts"],},},}',
    );
    await writeFile(join(dir, "tsconfig.json"), '{"extends":"./config/base",}');
    await writeFile(join(dir, "src/value.ts"), "export default 1");
    await writeFile(join(dir, "src/exact.ts"), "export default 2");
    await writeFile(join(dir, "src/other.ts"), "export default 3");
    await writeFile(
      join(dir, "entry.mts"),
      'import exact from "@/value"; import other from "@/other"; export default {exact,other}',
    );
    const loader = new ProjectLoader(dir);
    try {
      expect(await loader.load("./entry.mts")).toEqual({ exact: 2, other: 3 });
      expect(loader.dependencies.has(join(dir, "config/base.json"))).toBe(true);
      expect(loader.dependencies.has(join(dir, "tsconfig.json"))).toBe(true);
    } finally {
      loader.close();
    }
  });

  it("leaves persistence unchanged when a listener cannot start", async () => {
    const dir = await project();
    scaffoldCommand("inventory", undefined, dir);
    const blocker = createServer();
    await new Promise<void>((done) => blocker.listen(0, done));
    const port = (blocker.address() as { port: number }).port;
    const snapshot = JSON.stringify({
      formatVersion: 1,
      definition: "inventory",
      stateVersion: 1,
      state: { stock: 7, nextId: 1, reservations: [] },
    });
    await writeFile(join(dir, "saved.json"), snapshot);
    await writeFile(
      join(dir, "only.json"),
      JSON.stringify({
        services: { inventory: { emulator: "./emulators/inventory.ts", port, persistence: "./saved.json" } },
      }),
    );
    const run = await prepareProject({ port: 4000, config: join(dir, "only.json") }, {}, true);
    try {
      await expect(run.start()).rejects.toThrow(`Cannot listen for inventory on port ${port}`);
      expect(await readFile(join(dir, "saved.json"), "utf8")).toBe(snapshot);
    } finally {
      await run.close();
      await new Promise<void>((done) => blocker.close(() => done()));
    }
  });

  it("scaffolds names that are JavaScript keywords", async () => {
    const dir = await project();
    scaffoldCommand("default", undefined, dir);
    const config = await loadConfig({ cwd: dir });
    expect(config.services[0].name).toBe("default");
    config.loader.close();
  });

  it("scaffolds repeated services without overwrites and loads only configured instances", async () => {
    const dir = await project();
    scaffoldCommand("inventory", undefined, dir);
    scaffoldCommand("billing", undefined, dir);
    expect(() => scaffoldCommand("inventory", undefined, dir)).toThrow("already exists");
    const config = await loadConfig({ cwd: dir });
    try {
      expect(config.services.map((service) => service.name)).toEqual(["inventory", "billing"]);
      expect(config.loader.dependencies.has(join(dir, "emulators/inventory.ts"))).toBe(true);
    } finally {
      config.loader.close();
    }
  });

  it("registers a service when an existing config uses differently indented markers", async () => {
    const dir = await project();
    const path = join(dir, "emulate.config.ts");
    await writeFile(
      path,
      'import { defineConfig } from "emulate";\n// @emulate:imports\nexport default defineConfig({ services: {\n  github: { emulator: "github" },\n  // @emulate:services\n} });\n',
    );
    scaffoldCommand("inventory", undefined, dir);
    const config = await loadConfig({ cwd: dir });
    try {
      expect(config.services.map((service) => service.name)).toEqual(["github", "inventory"]);
      expect(await readFile(path, "utf8")).toContain('  "inventory": { emulator: inventoryEmulator },');
    } finally {
      config.loader.close();
    }
  });

  it("adds services to an existing TypeScript config without markers", async () => {
    const dir = await project();
    const path = join(dir, "emulate.config.ts");
    await writeFile(
      path,
      'import { defineConfig } from "emulate";\n// export default { services: { inventory: true } };\nconst example = `export default { services: { inventory: true } }`;\nconst nested = { services: { github: { inventory: true, "billing": true } } };\nexport default defineConfig({ services: { github: { emulator: "github" } }, watch: ["./fixtures/**"] });\n',
    );
    scaffoldCommand("inventory", undefined, dir);
    scaffoldCommand("billing", undefined, dir);
    const updated = await readFile(path, "utf8");
    expect(updated).toContain("const example = `export default");
    expect(updated).toContain("// @emulate:imports");
    expect(updated).toContain("// @emulate:services");
    expect(updated).not.toContain("__emulateConfigBefore_billingEmulator");
    const config = await loadConfig({ cwd: dir });
    try {
      expect(config.services.map((service) => service.name)).toEqual(["github", "inventory", "billing"]);
      expect(config.watch).toEqual(["./fixtures/**"]);
    } finally {
      config.loader.close();
    }
  });

  it("adds a service to a JavaScript config while preserving other exports", async () => {
    const dir = await project();
    const path = join(dir, "emulate.config.js");
    await writeFile(
      path,
      'export const enabled = true;\nconst config = { services: { github: { emulator: "github" } } };\nexport default config;\n',
    );
    scaffoldCommand("inventory", undefined, dir);
    const updated = await readFile(path, "utf8");
    expect(updated).toContain("export const enabled = true");
    const config = await loadConfig({ cwd: dir });
    try {
      expect(config.services.map((service) => service.name)).toEqual(["github", "inventory"]);
    } finally {
      config.loader.close();
    }
  });

  it.each([
    ["services", "inventory"],
    ["services", '"inventory"'],
    ["'services' /* configured */", "'inventory'"],
  ])("refuses a duplicate custom name %s %s before creating files", async (servicesKey, key) => {
    const dir = await project();
    await writeFile(
      join(dir, "emulate.config.ts"),
      `export default { ${servicesKey}: { ${key}: { emulator: "./existing.ts" } } };\n`,
    );
    expect(() => scaffoldCommand("inventory", undefined, dir)).toThrow("may already be defined");
    await expect(readFile(join(dir, "emulators/inventory.ts"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps YAML comments and legacy services while adding a custom API", async () => {
    const dir = await project();
    await writeFile(
      join(dir, "emulate.config.yaml"),
      "# keep this comment\ngithub:\n  users:\n    - login: developer\n",
    );
    scaffoldCommand("inventory", undefined, dir);
    expect(await readFile(join(dir, "emulate.config.yaml"), "utf8")).toContain("# keep this comment");
    const config = await loadConfig({ cwd: dir });
    try {
      expect(config.services.map((s) => s.name)).toEqual(["inventory", "github"]);
    } finally {
      config.loader.close();
    }
  });

  it("loads TypeScript path aliases, imported JSON, and import-only installed packages", async () => {
    const dir = await project();
    await mkdir(join(dir, "src"));
    await writeFile(
      join(dir, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } } }),
    );
    await writeFile(join(dir, "src/seed.json"), '{"count":3}');
    await writeFile(
      join(dir, "src/custom.ts"),
      'import { defineEmulator } from "emulate"; import seed from "./seed.json"; export default defineEmulator({name:"counter",state:()=>seed,setup(){}});',
    );
    await writeFile(
      join(dir, "emulate.config.ts"),
      'import custom from "@/custom"; export default { services: { counter: { emulator: custom } } };',
    );
    const config = await loadConfig({ cwd: dir });
    try {
      expect(config.loader.dependencies.has(join(dir, "src/seed.json"))).toBe(true);
    } finally {
      config.loader.close();
    }
    await mkdir(join(dir, "node_modules/custom-package"));
    await writeFile(
      join(dir, "node_modules/custom-package/package.json"),
      '{"type":"module","exports":{".":{"import":"./index.js"}}}',
    );
    await writeFile(
      join(dir, "node_modules/custom-package/index.js"),
      'import {defineEmulator} from "emulate"; export default defineEmulator({name:"package",state:()=>({}),setup(){}});',
    );
    await writeFile(
      join(dir, "emulate.config.ts"),
      'export default { services: { package: { emulator: "custom-package" } } };',
    );
    const installed = await loadConfig({ cwd: dir });
    try {
      expect(installed.services[0].name).toBe("package");
    } finally {
      installed.loader.close();
    }
  });

  it("reports ambiguous config, unknown fields, collisions, and duplicate ports", async () => {
    const dir = await project();
    scaffoldCommand("inventory", undefined, dir);
    await writeFile(join(dir, "emulate.config.json"), "{}");
    await expect(loadConfig({ cwd: dir })).rejects.toThrow("Multiple config");
    await writeFile(join(dir, "emulate.config.json"), '{"servcies":{}}');
    await expect(loadConfig({ cwd: dir, config: "emulate.config.json" })).rejects.toThrow("Unknown config key");
    await writeFile(join(dir, "emulate.config.json"), '{"github":{},"services":{"github":{"emulator":"github"}}}');
    await expect(loadConfig({ cwd: dir, config: "emulate.config.json" })).rejects.toThrow("both legacy");
    await writeFile(
      join(dir, "emulate.config.json"),
      '{"services":{"github":{"emulator":"github","port":16570},"resend":{"emulator":"resend","port":16570}}}',
    );
    await expect(prepareProject({ port: 4000, config: join(dir, "emulate.config.json") })).rejects.toThrow(
      "Duplicate port",
    );
  });
});
