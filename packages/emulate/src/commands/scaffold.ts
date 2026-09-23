import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname, extname, relative } from "node:path";
import { parseDocument } from "yaml";
import { findConfig, isBuiltin } from "../config-loader.js";

export function inventorySource(name: string): string {
  return `import { defineEmulator } from "emulate";

export default defineEmulator({
  name: ${JSON.stringify(name)},
  state: () => ({
    stock: 10,
    nextId: 1,
    reservations: [] as Array<{ id: string }>,
  }),

  setup({ app, state }) {
    app.get("/inventory", (c) => c.json({ stock: state.stock }));
    app.get("/reservations", (c) => c.json(state.reservations));
    app.get("/reservations/:id", (c) => {
      const reservation = state.reservations.find((item) => item.id === c.req.param("id"));
      return reservation ? c.json(reservation) : c.json({ error: "not_found" }, 404);
    });

    app.post("/reservations", (c) => {
      if (state.stock < 1) return c.json({ error: "out_of_stock" }, 409);
      const reservation = { id: "r_" + state.nextId++ };
      state.stock -= 1;
      state.reservations.push(reservation);
      return c.json(reservation, 201);
    });

    app.delete("/reservations/:id", (c) => {
      const index = state.reservations.findIndex((item) => item.id === c.req.param("id"));
      if (index < 0) return c.json({ error: "not_found" }, 404);
      state.reservations.splice(index, 1);
      state.stock += 1;
      return c.body(null, 204);
    });
  },
});
`;
}

export function inventoryTest(name: string): string {
  return `import assert from "node:assert/strict";
import { test } from "node:test";
import { createEmulator } from "emulate";
import inventory from "./${name}.ts";

test("reservations update inventory, cancellation restores it, and reset re-seeds", async () => {
  const api = await createEmulator({ service: inventory, listen: false });
  try {
    const response = await api.request("/reservations", { method: "POST" });
    assert.equal(response.status, 201);
    const reservation = (await response.json()) as { id: string };
    assert.deepEqual(await (await api.request("/inventory")).json(), { stock: 9 });
    assert.equal((await api.request("/reservations/" + reservation.id, { method: "DELETE" })).status, 204);
    assert.deepEqual(await (await api.request("/inventory")).json(), { stock: 10 });

    for (let i = 0; i < 10; i++) await api.request("/reservations", { method: "POST" });
    assert.equal((await api.request("/reservations", { method: "POST" })).status, 409);
    await api.reset();
    assert.deepEqual(await (await api.request("/inventory")).json(), { stock: 10 });
    assert.deepEqual(await (await api.request("/reservations")).json(), []);
  } finally {
    await api.close();
  }
});
`;
}

export function scaffoldCommand(name: string, configOption?: string, cwd = process.cwd()): void {
  if (!/^[a-z][a-z0-9-]*$/.test(name) || isBuiltin(name))
    throw new Error(
      "Choose a custom name using lowercase letters, digits, and hyphens that does not match a built-in service",
    );
  const existing = findConfig(configOption, cwd);
  const directory = existing ? dirname(existing) : cwd;
  const source = resolve(directory, "emulators", `${name}.ts`);
  const test = resolve(directory, "emulators", `${name}.test.ts`);
  for (const path of [source, test])
    if (existsSync(path)) throw new Error(`File already exists: ${path}. Choose another custom name.`);
  const identifier = `${name.replaceAll("-", "_")}Emulator`;
  const importLine = `import ${identifier} from "./emulators/${name}.ts";`;
  const entryLine = `    ${JSON.stringify(name)}: { emulator: ${identifier} },`;
  const config = existing ?? resolve(directory, "emulate.config.ts");
  let output: string | undefined;
  if (!existing)
    output = `import { defineConfig } from "emulate";\n${importLine}\n// @emulate:imports\n\nexport default defineConfig({\n  services: {\n${entryLine}\n    // @emulate:services\n  },\n});\n`;
  else if ([".yaml", ".yml", ".json"].includes(extname(config))) {
    const original = readFileSync(config, "utf8");
    const document = parseDocument(original);
    if (document.errors.length) throw new Error(`Cannot update config: ${document.errors[0].message}`);
    if (document.has(name) || document.hasIn(["services", name]))
      throw new Error(`Service ${name} already exists in ${config}`);
    document.setIn(["services", name], { emulator: `./emulators/${name}.ts` });
    output = extname(config) === ".json" ? `${JSON.stringify(document.toJS(), null, 2)}\n` : document.toString();
  } else {
    const original = readFileSync(config, "utf8");
    if (original.includes("// @emulate:imports") && original.includes("// @emulate:services")) {
      if (original.includes(`"${name}":`) || original.includes(`import ${identifier} `))
        throw new Error(`Service ${name} already exists in ${config}`);
      output = original
        .replace("// @emulate:imports", `${importLine}\n// @emulate:imports`)
        .replace("    // @emulate:services", `${entryLine}\n    // @emulate:services`);
    }
  }
  mkdirSync(dirname(source), { recursive: true });
  writeFileSync(source, inventorySource(name), { flag: "wx" });
  writeFileSync(test, inventoryTest(name), { flag: "wx" });
  if (output !== undefined) writeFileSync(config, output, { flag: existing ? "w" : "wx" });
  console.log(`Created ${relative(cwd, source)}\nCreated ${relative(cwd, test)}`);
  if (output === undefined)
    console.log(`\nAdd this import to ${config}:\n${importLine}\n\nAdd this entry to services:\n${entryLine}`);
  else console.log(`${existing ? "Updated" : "Created"} ${relative(cwd, config)}`);
  console.log(
    `\nStart: npx emulate start --watch${configOption ? ` --config ${JSON.stringify(configOption)}` : ""}\nTest: node --test ${relative(cwd, test)}\nReserve: curl -X POST http://localhost:4000/reservations\nInspect: http://localhost:4000/_emulate`,
  );
}
