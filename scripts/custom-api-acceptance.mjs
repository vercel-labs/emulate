import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { createServer } from "node:net";
import { sign } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const consumer = await mkdtemp(join(tmpdir(), "emulate packed consumer "));
const external = await mkdtemp(join(tmpdir(), "emulate external import "));
const artifacts = join(consumer, "artifacts");
await mkdir(artifacts);
const pnpm = process.env.npm_execpath;
assert.ok(pnpm, "Run this suite with pnpm test:custom-consumer");
function run(command, args, cwd = consumer) {
  if (command === pnpm && /\.[cm]?js$/.test(pnpm)) {
    args = [pnpm, ...args];
    command = process.execPath;
  }
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 10 * 1024 * 1024,
  });
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}\n${result.error ?? ""}`,
  );
  return result.stdout;
}
async function port() {
  const server = createServer();
  await new Promise((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", done);
  });
  const value = server.address().port;
  await new Promise((done) => server.close(done));
  return value;
}
let child;
let output = "";
let passed = false;
async function waitFor(predicate, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    if (child && child.exitCode !== null) throw new Error(`Runner exited while waiting for ${label}\n${output}`);
    await new Promise((done) => setTimeout(done, 30));
  }
  throw new Error(`Timed out: ${label}\n${output}`);
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const processToStop = child;
  await new Promise((done) => {
    const timer = setTimeout(() => {
      processToStop.kill("SIGKILL");
      done();
    }, 10000);
    processToStop.once("exit", () => {
      clearTimeout(timer);
      done();
    });
    processToStop.kill("SIGTERM");
  });
  child = undefined;
}
try {
  run(pnpm, ["--filter", "emulate", "pack", "--pack-destination", artifacts], root);
  const archive = (await readdir(artifacts)).find((file) => file.endsWith(".tgz"));
  assert.ok(archive, `Packing did not create a tarball in ${artifacts}`);
  const tarball = join(artifacts, archive);
  const repo = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      devDependencies: {
        emulate: `file:${tarball}`,
        typescript: repo.devDependencies.typescript,
        "@types/node": repo.devDependencies["@types/node"],
      },
    }),
  );
  run(pnpm, ["install", "--ignore-scripts"]);
  const cli = join(consumer, "node_modules/emulate/dist/index.js");
  const discoveryPort = await port();
  child = spawn(process.execPath, [cli, "start", "--watch", "--service", "github", "--port", String(discoveryPort)], {
    cwd: consumer,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (data) => {
    output += data;
  });
  child.stderr.on("data", (data) => {
    output += data;
  });
  const discoveryReady = () => (output.match(/Watching imports and fixtures/g) ?? []).length;
  await waitFor(() => discoveryReady() >= 1, "startup without a config");
  await writeFile(join(consumer, "emulate.config.yaml"), "github: {}\n");
  await waitFor(() => discoveryReady() >= 2, "config creation reload");
  await stop();
  await rm(join(consumer, "emulate.config.yaml"));
  output = "";
  console.log("Watch mode detected a config created after startup.");
  const before = await readFile(join(consumer, "package.json"), "utf8");
  run(process.execPath, [cli, "init", "--custom", "inventory"]);
  assert.equal(await readFile(join(consumer, "package.json"), "utf8"), before);
  run(process.execPath, ["--test", "emulators/inventory.test.ts"]);
  await writeFile(
    join(consumer, "contract.ts"),
    `import { defineEmulator, defineConfig, createEmulator } from "emulate";
const service = defineEmulator({ name: "typed", state: () => ({ count: 0 }), setup({ app, state }) {
  state.count++;
  // @ts-expect-error unknown state field
  state.missing++;
  app.get("/", c => c.json(state));
} });
const valid = defineConfig({ services: { typed: { emulator: service, seed: { count: 1 } } } });
// @ts-expect-error incorrect inline seed
defineConfig({ services: { typed: { emulator: service, seed: { count: "bad" } } } });
// @ts-expect-error incorrect programmatic seed
createEmulator({ service, listen: false, seed: { count: "bad" } });
const api = await createEmulator({ service, listen: false });
// @ts-expect-error no network URL for an in-process emulator
api.url;
api.snapshot().state.count satisfies number;
await api.close();
`,
  );
  await writeFile(
    join(consumer, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        allowImportingTsExtensions: true,
        module: "NodeNext",
        target: "ES2022",
        types: ["node"],
      },
      include: ["contract.ts", "emulate.config.ts", "emulators/*.ts"],
    }),
  );
  run(pnpm, ["exec", "tsc", "--noEmit"]);
  console.log("Packed package: scaffold, generated test, and strict public types passed.");

  const linkedPackage = join(consumer, "plugins", "linked-api");
  await mkdir(linkedPackage, { recursive: true });
  await writeFile(
    join(linkedPackage, "package.json"),
    JSON.stringify({ name: "linked-api", type: "module", exports: { ".": { import: "./index.js" } } }),
  );
  await writeFile(
    join(linkedPackage, "index.js"),
    'import {defineEmulator} from "emulate"; export default defineEmulator({name:"linked",state:()=>({count:1}),setup(){}});',
  );
  await symlink(linkedPackage, join(consumer, "node_modules", "linked-api"), "junction");
  await mkdir(join(consumer, "fixtures"));
  await writeFile(join(consumer, "fixtures", "seed.json"), '{"count":2}');
  await writeFile(
    join(consumer, "fixtures", "counter.ts"),
    'import {defineEmulator} from "emulate"; import seed from "./seed.json"; export default defineEmulator({name:"fixture",state:()=>seed,setup(){}});',
  );
  const tsconfigPath = join(consumer, "tsconfig.json");
  const tsconfig = JSON.parse(await readFile(tsconfigPath, "utf8"));
  tsconfig.compilerOptions.paths = { "@fixtures/*": ["./fixtures/*"] };
  await writeFile(tsconfigPath, JSON.stringify(tsconfig));
  await writeFile(
    join(consumer, "plugins.config.ts"),
    'import linked from "linked-api"; import fixture from "@fixtures/counter"; export default {services:{linked:{emulator:linked},fixture:{emulator:fixture}}};',
  );
  const listed = run(process.execPath, [cli, "list", "--config", "plugins.config.ts"]);
  assert.ok(listed.includes("Configured instances:") && listed.includes("linked") && listed.includes("fixture"));
  console.log("Packed loader: import-only workspace link, TypeScript aliases, and JSON imports passed.");

  const assignedPort = await port();
  const base = `http://localhost:${assignedPort}`;
  const configFile = join(consumer, "emulate.config.ts");
  const githubPort = await port();
  const secretsFile = join(consumer, "generated-secrets.json");
  const generated = process.platform !== "win32";
  if (generated)
    await writeFile(
      configFile,
      (await readFile(configFile, "utf8")).replace(
        "// @emulate:services",
        `github: { emulator: "github", port: ${githubPort}, seed: { apps: [{ app_id: 91, slug: "generated", name: "Generated" }] } },\n    // @emulate:services`,
      ),
    );
  child = spawn(
    process.execPath,
    [
      "--enable-source-maps",
      cli,
      "start",
      "--watch",
      "--port",
      String(assignedPort),
      ...(generated ? ["--generated-secrets-file", secretsFile] : []),
    ],
    { cwd: consumer, stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout.on("data", (data) => {
    output += data;
  });
  child.stderr.on("data", (data) => {
    output += data;
  });
  const readyCount = () => (output.match(/Watching imports and fixtures/g) ?? []).length;
  await waitFor(() => readyCount() === 1, "initial startup");
  const delivered = generated ? await readFile(secretsFile, "utf8") : undefined;
  async function checkIdentity() {
    if (!delivered) return;
    assert.ok((await readFile(secretsFile, "utf8")) === delivered, "Reload replaced the generated secrets file");
    const key = JSON.parse(delivered).generatedSecrets[0].value;
    const now = Math.floor(Date.now() / 1000);
    const unsigned =
      Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url") +
      "." +
      Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 300, iss: "91" })).toString("base64url");
    const jwt = unsigned + "." + sign("RSA-SHA256", Buffer.from(unsigned), key).toString("base64url");
    assert.equal(
      (await fetch(`http://localhost:${githubPort}/app`, { headers: { Authorization: `Bearer ${jwt}` } })).status,
      200,
    );
    assert.ok(!output.includes(key), "Generated key leaked into output");
  }
  await checkIdentity();
  assert.equal((await fetch(`${base}/reservations`, { method: "POST" })).status, 201);
  assert.deepEqual(await (await fetch(`${base}/inventory`)).json(), { stock: 9 });
  const inspector = await (await fetch(`${base}/_emulate`)).text();
  assert.ok(inspector.includes("POST /reservations"));
  assert.ok(inspector.includes("Reset to seed"));
  await fetch(`${base}/_emulate/reset`, { method: "POST" });
  assert.deepEqual(await (await fetch(`${base}/inventory`)).json(), { stock: 10 });

  const modulePath = join(consumer, "emulators/inventory.ts");
  const original = await readFile(modulePath, "utf8");
  await writeFile(join(consumer, "emulators/stock.ts"), "export const stock = 12;\n");
  await writeFile(modulePath, `import { stock } from "./stock.ts";\n${original.replace("stock: 10", "stock")}`);
  await waitFor(() => readyCount() >= 2, "entry reload");
  assert.deepEqual(await (await fetch(`${base}/inventory`)).json(), { stock: 12 });
  const previous = readyCount();
  await writeFile(join(consumer, "emulators/stock.ts"), "export const stock = 14;\n");
  await waitFor(() => readyCount() > previous, "imported helper reload");
  assert.deepEqual(await (await fetch(`${base}/inventory`)).json(), { stock: 14 });
  await writeFile(join(consumer, "emulators/stock.ts"), "export const stock = ;\n");
  await waitFor(() => output.includes("serving the last successful version"), "syntax failure");
  assert.deepEqual(await (await fetch(`${base}/inventory`)).json(), { stock: 14 });
  const errorsBefore = readyCount();
  await writeFile(join(consumer, "emulators/stock.ts"), "export const stock = 16;\n");
  await waitFor(() => readyCount() > errorsBefore, "syntax recovery");
  assert.deepEqual(await (await fetch(`${base}/inventory`)).json(), { stock: 16 });
  const validModule = await readFile(modulePath, "utf8");
  const failures = () => (output.match(/Reload failed/g) ?? []).length;
  const failuresBefore = failures();
  await writeFile(
    modulePath,
    validModule.replace("setup({ app, state }) {", 'setup({ app, state }) { throw new Error("setup fixture failed");'),
  );
  await waitFor(() => failures() > failuresBefore, "setup failure");
  const setupLine = validModule.slice(0, validModule.indexOf("setup({ app, state }) {")).split("\n").length;
  assert.ok(
    output.includes(`inventory.ts:${setupLine}:`),
    `Setup diagnostic must refer to inventory.ts:${setupLine}\n${output}`,
  );
  assert.deepEqual(await (await fetch(`${base}/inventory`)).json(), { stock: 16 });
  const setupBefore = readyCount();
  await writeFile(modulePath, validModule);
  await waitFor(() => readyCount() > setupBefore, "setup recovery");
  await checkIdentity();

  const lazyPath = join(consumer, "emulators/lazy.ts");
  await writeFile(lazyPath, "export default 21;\n");
  const lazyBefore = readyCount();
  await writeFile(
    modulePath,
    validModule.replace(
      "setup({ app, state }) {",
      'setup({ app, state }) { app.get("/lazy", async c => c.json({value: (await import("./lazy.ts")).default}));',
    ),
  );
  await waitFor(() => readyCount() > lazyBefore, "lazy import route");
  assert.deepEqual(await (await fetch(`${base}/lazy`)).json(), { value: 21 });
  const lazyConfigReady = readyCount();
  await writeFile(configFile, (await readFile(configFile, "utf8")) + "\n");
  await waitFor(() => readyCount() > lazyConfigReady, "reload with a previously discovered dynamic import");
  const lazyReady = readyCount();
  await writeFile(lazyPath, "export default 23;\n");
  await waitFor(() => readyCount() > lazyReady, "dynamic import reload");
  assert.deepEqual(await (await fetch(`${base}/lazy`)).json(), { value: 23 });

  const missingBefore = failures();
  await writeFile(modulePath, validModule.replace('"./stock.ts"', '"./missing-stock.ts"'));
  await waitFor(() => failures() > missingBefore, "missing import failure");
  const missingReady = readyCount();
  await writeFile(join(consumer, "emulators/missing-stock.ts"), "export const stock = 17;\n");
  await waitFor(() => readyCount() > missingReady, "new file recovery");
  assert.deepEqual(await (await fetch(`${base}/inventory`)).json(), { stock: 17 });
  const restored = readyCount();
  await writeFile(modulePath, validModule);
  await waitFor(() => readyCount() > restored, "restore static imports");

  const missingExternal = join(external, "stock.ts");
  const externalSpecifier = relative(dirname(modulePath), missingExternal).replaceAll("\\", "/");
  const externalFailure = failures();
  await writeFile(modulePath, validModule.replace('"./stock.ts"', JSON.stringify(externalSpecifier)));
  await waitFor(() => failures() > externalFailure, "missing import outside the config directory");
  const externalRecovery = readyCount();
  await writeFile(missingExternal, "export const stock = 19;\n");
  await waitFor(() => readyCount() > externalRecovery, "external import creation recovery");
  assert.deepEqual(await (await fetch(`${base}/inventory`)).json(), { stock: 19 });
  const externalRestored = readyCount();
  await writeFile(modulePath, validModule);
  await waitFor(() => readyCount() > externalRestored, "restore external import change");

  await writeFile(join(consumer, "fixtures/stock.json"), '{"stock":18}');
  await writeFile(
    configFile,
    (await readFile(configFile, "utf8")).replace("services: {", 'watch: ["./fixtures/**"],\n  services: {'),
  );
  const fixtureBefore = readyCount();
  await writeFile(
    join(consumer, "emulators/stock.ts"),
    'import {readFileSync} from "node:fs"; export const stock = JSON.parse(readFileSync(new URL("../fixtures/stock.json", import.meta.url), "utf8")).stock;\n',
  );
  await waitFor(() => readyCount() > fixtureBefore, "fixture configuration");
  assert.deepEqual(await (await fetch(`${base}/inventory`)).json(), { stock: 18 });
  const fixtureReady = readyCount();
  await writeFile(join(consumer, "fixtures/stock.json"), '{"stock":20}');
  await waitFor(() => readyCount() > fixtureReady, "runtime fixture reload");
  assert.deepEqual(await (await fetch(`${base}/inventory`)).json(), { stock: 20 });
  await checkIdentity();
  if (generated) {
    const config = await readFile(configFile, "utf8");
    const beforeIdentityError = failures();
    await writeFile(configFile, config.replace('name: "Generated"', 'name: "Changed"'));
    await waitFor(() => failures() > beforeIdentityError, "identity seed guard");
    assert.ok(output.includes("new --generated-secrets-file path"));
    await checkIdentity();
    const beforeRecovery = readyCount();
    await writeFile(configFile, config);
    await waitFor(() => readyCount() > beforeRecovery, "identity config recovery");
    const beforeAddition = failures();
    await writeFile(
      configFile,
      config.replace(
        "// @emulate:services",
        'another: { emulator: "github", port: ' +
          (await port()) +
          ', seed: { apps: [{ app_id: 93, slug: "another", name: "Another" }] } },\n// @emulate:services',
      ),
    );
    await waitFor(() => failures() > beforeAddition, "new identity guard");
    assert.ok(output.includes("Generated identities changed"));
    await checkIdentity();
  }
  await stop();
  await assert.rejects(fetch(`${base}/inventory`));
  console.log(
    "HTTP, inspector reset, watch dependencies, syntax/setup recovery, runtime fixtures, generated identity retention, and shutdown passed.",
  );
  passed = true;
} finally {
  await stop();
  if (passed && !process.env.EMULATE_KEEP_ACCEPTANCE)
    await Promise.all([
      rm(consumer, { recursive: true, force: true }),
      rm(external, { recursive: true, force: true }),
    ]);
  else console.log(`Consumer artifacts: ${consumer}\nExternal import artifacts: ${external}`);
}
