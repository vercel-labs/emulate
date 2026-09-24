import { copyFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = new URL("../", import.meta.url);
const packageDir = process.cwd();
const pkg = JSON.parse(readFileSync(resolve(packageDir, "package.json"), "utf8"));

for (const file of ["LICENSE", "THIRD_PARTY_NOTICES.md"]) {
  copyFileSync(new URL(file, root), resolve(packageDir, file));
}

if (pkg.name === "emulate") {
  copyFileSync(new URL("README.md", root), resolve(packageDir, "README.md"));
}
