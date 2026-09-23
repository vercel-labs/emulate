import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { describe, it, expect, afterEach } from "vitest";
import { loadConfig } from "../config-loader.js";
import { scaffoldCommand } from "../commands/scaffold.js";
import { prepareProject } from "../project-runner.js";

const directories: string[] = [];
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
  return dir;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("custom configuration and scaffold", () => {
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
