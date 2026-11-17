// Writes a package's declaration files with tsc and its tsconfig.build.json. tsup's own `dts`
// option needs the TypeScript 6 API, so tsup configs call this from `onSuccess` instead, which
// runs after every build, including each rebuild in watch mode.
import { execFileSync } from "node:child_process";
import { join } from "node:path";

export function emitTypes(packageDir, { bundle = false } = {}) {
  execFileSync("tsc", ["-p", "tsconfig.build.json"], {
    cwd: packageDir,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (bundle) {
    execFileSync(process.execPath, [join(packageDir, "scripts/bundle-dts.mjs")], {
      cwd: packageDir,
      stdio: "inherit",
    });
  }
}
