// Bundles the declarations tsc writes to .types into dist/api.d.ts, inlining the types of
// @emulators/core so the published package has no type dependency on it. rolldown-plugin-dts
// reads the .d.ts files as they are (dtsInput), so this step needs no TypeScript API.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { rolldown } from "rolldown";
import { dts } from "rolldown-plugin-dts";

const cwd = fileURLToPath(new URL("..", import.meta.url));

// The bundler drops file-header comments, so `/*!` license notices (such as the Hono
// attribution in @emulators/core) are collected from the bundled files and kept as a banner.
function licenseNotices(chunk) {
  const notices = new Set();
  for (const id of chunk.moduleIds) {
    let text;
    try {
      text = readFileSync(id, "utf8");
    } catch {
      continue;
    }
    for (const notice of text.match(/\/\*![\s\S]*?\*\//g) ?? []) notices.add(notice);
  }
  return [...notices].join("\n");
}

const bundle = await rolldown({
  cwd,
  input: { api: fileURLToPath(new URL("../.types/api.d.ts", import.meta.url)) },
  plugins: [dts({ dtsInput: true, emitDtsOnly: true, generator: "oxc", resolve: ["@emulators/core"] })],
});
await bundle.write({ dir: "dist", format: "es", banner: licenseNotices });
await bundle.close();
