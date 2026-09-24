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

function maskStringsAndComments(source: string): string {
  const masked = source.split("");
  for (let index = 0; index < source.length; ) {
    const char = source[index];
    let end = index;
    if (char === "/" && source[index + 1] === "/") {
      end = source.indexOf("\n", index + 2);
      if (end < 0) end = source.length;
    } else if (char === "/" && source[index + 1] === "*") {
      end = source.indexOf("*/", index + 2);
      end = end < 0 ? source.length : end + 2;
    } else if (char === '"' || char === "'" || char === "`") {
      end = index + 1;
      while (end < source.length) {
        if (source[end] === "\\") end += 2;
        else if (source[end++] === char) break;
      }
    }
    if (end === index) {
      index++;
      continue;
    }
    for (let cursor = index; cursor < end; cursor++)
      if (masked[cursor] !== "\n" && masked[cursor] !== "\r") masked[cursor] = " ";
    index = end;
  }
  return masked.join("");
}

function skipTrivia(source: string, start: number): number {
  let index = start;
  while (index < source.length) {
    if (/\s/.test(source[index])) index++;
    else if (source.startsWith("//", index)) {
      const end = source.indexOf("\n", index + 2);
      index = end < 0 ? source.length : end;
    } else if (source.startsWith("/*", index)) {
      const end = source.indexOf("*/", index + 2);
      index = end < 0 ? source.length : end + 2;
    } else break;
  }
  return index;
}

function hasLiteralServiceKey(source: string, code: string, name: string): boolean {
  const openings: number[] = [];
  const addOpening = (afterKey: number) => {
    const colon = skipTrivia(source, afterKey);
    if (code[colon] !== ":") return;
    const opening = skipTrivia(source, colon + 1);
    if (code[opening] === "{") openings.push(opening);
  };
  for (const match of code.matchAll(/\bservices\b/g)) addOpening(match.index! + match[0].length);
  for (const match of source.matchAll(/(["'])services\1/g)) addOpening(match.index! + match[0].length);
  for (const opening of openings) {
    let braces = 1;
    let brackets = 0;
    let parentheses = 0;
    for (let index = opening + 1; index < code.length && braces > 0; index++) {
      const char = code[index];
      if (index === opening + 1 || (char === "," && braces === 1 && brackets === 0 && parentheses === 0)) {
        const keyStart = skipTrivia(source, index === opening + 1 ? index : index + 1);
        const quote = source[keyStart];
        const quoted = quote === '"' || quote === "'";
        const keyEnd = keyStart + name.length + (quoted ? 2 : 0);
        if (
          (!quoted || source[keyEnd - 1] === quote) &&
          source.slice(keyStart + (quoted ? 1 : 0), keyEnd - (quoted ? 1 : 0)) === name &&
          code[skipTrivia(source, keyEnd)] === ":"
        )
          return true;
      }
      if (char === "{") braces++;
      else if (char === "}") braces--;
      else if (char === "[") brackets++;
      else if (char === "]") brackets--;
      else if (char === "(") parentheses++;
      else if (char === ")") parentheses--;
    }
  }
  return false;
}

function addToExecutableConfig(
  original: string,
  name: string,
  identifier: string,
  importLine: string,
): string | undefined {
  if (original.startsWith("#!")) return undefined;
  const code = maskStringsAndComments(original);
  const exports = [...code.matchAll(/(?:^|[;\r\n])\s*(export\s+default)\b/g)];
  if (exports.length !== 1) return undefined;
  const base = `__emulateConfigBefore_${identifier}`;
  if (original.includes(base) || original.includes(`import ${identifier} `))
    throw new Error(`Service ${name} may already be defined in the config`);
  if (hasLiteralServiceKey(original, code, name))
    throw new Error(`Service ${name} may already be defined in the config`);
  const match = exports[0];
  const start = match.index! + match[0].lastIndexOf(match[1]);
  const renamed = original.slice(0, start) + `const ${base} =` + original.slice(start + match[1].length);
  return `${importLine}
// @emulate:imports
${renamed.trimEnd()}

if (Object.hasOwn(${base}.services ?? {}, ${JSON.stringify(name)}))
  throw new Error(${JSON.stringify(`Service ${name} already exists in config`)});

export default {
  ...${base},
  services: {
    ...${base}.services,
    ${JSON.stringify(name)}: { emulator: ${identifier} },
    // @emulate:services
  },
};
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
  } else if ([".ts", ".mts", ".js", ".mjs"].includes(extname(config))) {
    const original = readFileSync(config, "utf8");
    const importMarker = /^[ \t]*\/\/ @emulate:imports[ \t]*$/m;
    const serviceMarker = /^([ \t]*)\/\/ @emulate:services[ \t]*$/m;
    if (importMarker.test(original) && serviceMarker.test(original)) {
      if (
        hasLiteralServiceKey(original, maskStringsAndComments(original), name) ||
        original.includes(`import ${identifier} `)
      )
        throw new Error(`Service ${name} already exists in ${config}`);
      output = original
        .replace(importMarker, (marker) => `${importLine}\n${marker}`)
        .replace(
          serviceMarker,
          (marker, indent: string) => `${indent}${JSON.stringify(name)}: { emulator: ${identifier} },\n${marker}`,
        );
    } else output = addToExecutableConfig(original, name, identifier, importLine);
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
    `\nStart: npx emulate start --watch${configOption ? ` --config ${JSON.stringify(configOption)}` : ""}\nTest: node --test ${relative(cwd, test)}\nUse the ${name} URL and Inspector link printed by start to send requests and inspect state.`,
  );
}
