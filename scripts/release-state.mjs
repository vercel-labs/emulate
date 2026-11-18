#!/usr/bin/env node

/**
 * Decides what a release run does, from the repo version and what npm has.
 *
 * Usage:
 *   node scripts/release-state.mjs          # prints state and version for the release workflow
 *   node scripts/release-state.mjs --check  # CI check (exit 1 if a listed package is not on npm)
 */

import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";

const root = join(fileURLToPath(import.meta.url), "../..");

/** Reads the package names in `EMULATOR_PACKAGES` from the release workflow, the one place that lists what gets published. */
export function listedPackages(workflow) {
  const line = /^\s*EMULATOR_PACKAGES:\s*(.+)$/m.exec(workflow);
  if (!line) throw new Error("EMULATOR_PACKAGES is not set in .github/workflows/release.yml");
  return line[1].trim().split(/\s+/);
}

/**
 * Names what a release run does. `published` maps each package name to its latest version on npm, or null when npm
 * has never seen it.
 *
 * - `release`: the repo version of `emulate` is not the one on npm, so a version bump landed.
 * - `resume`: `emulate` is already out at this version, but a package that exists on npm is behind, so an earlier
 *   release stopped halfway.
 * - `nothing`: everything else. A package npm has never seen is not a reason to release.
 */
export function releaseState(version, published) {
  if (published.get("emulate") !== version) return "release";
  const behind = [...published].some(([, latest]) => latest !== null && latest !== version);
  return behind ? "resume" : "nothing";
}

/** Asks npm for a package's latest version. Null means npm has never seen the package; any other failure throws. */
async function latestOnNpm(name) {
  const response = await fetch(`https://registry.npmjs.org/${name.replace("/", "%2f")}/latest`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`npm answered ${response.status} for ${name}`);
  return (await response.json()).version;
}

async function main() {
  const version = JSON.parse(readFileSync(join(root, "packages/emulate/package.json"), "utf8")).version;
  const listed = listedPackages(readFileSync(join(root, ".github/workflows/release.yml"), "utf8"));
  const names = ["emulate", ...listed.map((name) => `@emulators/${name}`)];
  const published = new Map(await Promise.all(names.map(async (name) => [name, await latestOnNpm(name)])));

  if (process.argv.includes("--check")) {
    const unknown = names.filter((name) => published.get(name) === null);
    const unlisted = readdirSync(join(root, "packages/@emulators")).filter((name) => !listed.includes(name));
    for (const name of unlisted) {
      console.log(`::notice::@emulators/${name} is not in EMULATOR_PACKAGES, so releases do not publish it.`);
    }
    if (unknown.length > 0) {
      console.error(`EMULATOR_PACKAGES lists packages npm has never seen: ${unknown.join(", ")}`);
      console.error("A release cannot create a package. Publish a 0.0.0 placeholder and set up trusted publishing");
      console.error("for it on npm first, then add it to the list in the release PR. See Releasing in AGENTS.md.");
      process.exit(1);
    }
    console.log(`All ${names.length} listed packages exist on npm`);
    return;
  }

  for (const [name, latest] of published) {
    console.error(`${name}: repo ${version}, npm ${latest ?? "never published"}`);
  }
  console.log(`state=${releaseState(version, published)}`);
  console.log(`version=${version}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
