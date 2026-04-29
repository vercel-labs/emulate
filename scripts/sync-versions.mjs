#!/usr/bin/env node

/**
 * Reads the version from packages/emulate/package.json (the canonical
 * source) and writes it to every @emulators/* package.json.
 *
 * Usage:
 *   node scripts/sync-versions.mjs          # sync
 *   node scripts/sync-versions.mjs --check  # CI check (exit 1 if out of sync)
 */

import { readFileSync, writeFileSync, readdirSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";

const root = join(fileURLToPath(import.meta.url), "../..");
const emulatePkgPath = join(root, "packages/emulate/package.json");
const emulatorsDir = join(root, "packages/@emulators");

const canonicalPkg = JSON.parse(readFileSync(emulatePkgPath, "utf8"));
const version = canonicalPkg.version;

const check = process.argv.includes("--check");
let mismatches = [];

for (const dir of readdirSync(emulatorsDir)) {
  const pkgPath = join(emulatorsDir, dir, "package.json");
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  } catch {
    continue;
  }

  if (pkg.version === version) continue;

  if (check) {
    mismatches.push(`${pkg.name}: ${pkg.version} (expected ${version})`);
  } else {
    pkg.version = version;
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
    console.log(`Updated ${pkg.name} to ${version}`);
  }
}

if (check && mismatches.length > 0) {
  console.error("Version mismatch:");
  for (const m of mismatches) console.error(`  ${m}`);
  process.exit(1);
} else if (check) {
  console.log(`All @emulators/* packages are at ${version}`);
}
