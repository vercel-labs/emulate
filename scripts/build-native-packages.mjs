#!/usr/bin/env node

import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(readFileSync(join(root, "packages/emulate/package.json"), "utf8")).version;

const targets = [
  { pkg: "emulate-darwin-arm64", goos: "darwin", goarch: "arm64", exe: "emulate" },
  { pkg: "emulate-darwin-x64", goos: "darwin", goarch: "amd64", exe: "emulate" },
  { pkg: "emulate-linux-arm64", goos: "linux", goarch: "arm64", exe: "emulate" },
  { pkg: "emulate-linux-x64", goos: "linux", goarch: "amd64", exe: "emulate" },
  { pkg: "emulate-win32-arm64", goos: "windows", goarch: "arm64", exe: "emulate.exe" },
  { pkg: "emulate-win32-x64", goos: "windows", goarch: "amd64", exe: "emulate.exe" },
];

for (const target of targets) {
  const outDir = join(root, "packages/@emulators", target.pkg, "bin");
  const outFile = join(outDir, target.exe);
  mkdirSync(outDir, { recursive: true });

  const result = spawnSync(
    "go",
    ["build", "-trimpath", "-ldflags", `-s -w -X main.version=${version}`, "-o", outFile, "./cmd/emulate"],
    {
      cwd: root,
      env: {
        ...process.env,
        CGO_ENABLED: "0",
        GOOS: target.goos,
        GOARCH: target.goarch,
      },
      stdio: "inherit",
    },
  );

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }

  if (target.goos !== "windows") {
    chmodSync(outFile, 0o755);
  }
  console.log(`Built @emulators/${target.pkg}/bin/${target.exe}`);
}
