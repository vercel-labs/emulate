import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

export interface NativeTarget {
  platform: NodeJS.Platform;
  arch: NodeJS.Architecture;
}

export interface NativeResolveOptions {
  target?: NativeTarget;
  env?: NodeJS.ProcessEnv;
  resolvePackage?: (specifier: string) => string;
  exists?: (path: string) => boolean;
}

export type NativeResolveResult =
  | { ok: true; path: string; packageName?: string }
  | { ok: false; message: string; packageName?: string };

const require = createRequire(import.meta.url);

const packageByTarget = new Map<string, string>([
  ["darwin:arm64", "@emulators/emulate-darwin-arm64"],
  ["darwin:x64", "@emulators/emulate-darwin-x64"],
  ["linux:arm64", "@emulators/emulate-linux-arm64"],
  ["linux:x64", "@emulators/emulate-linux-x64"],
  ["win32:arm64", "@emulators/emulate-win32-arm64"],
  ["win32:x64", "@emulators/emulate-win32-x64"],
]);

export function nativePackageName(target: NativeTarget = process): string | undefined {
  return packageByTarget.get(`${target.platform}:${target.arch}`);
}

export function resolveNativeBinary(options: NativeResolveOptions = {}): NativeResolveResult {
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;
  const override = env.EMULATE_NATIVE_BINARY;
  if (override) {
    if (exists(override)) {
      return { ok: true, path: override };
    }
    return { ok: false, message: `EMULATE_NATIVE_BINARY does not exist: ${override}` };
  }

  const target = options.target ?? process;
  const packageName = nativePackageName(target);
  if (!packageName) {
    return {
      ok: false,
      message: `No native emulate binary is published for ${target.platform}/${target.arch}.`,
    };
  }

  const resolvePackage = options.resolvePackage ?? require.resolve;
  try {
    const packageJSON = resolvePackage(`${packageName}/package.json`);
    const executable = target.platform === "win32" ? "emulate.exe" : "emulate";
    const binary = join(dirname(packageJSON), "bin", executable);
    if (exists(binary)) {
      return { ok: true, path: binary, packageName };
    }
  } catch {
    // Fall back below so local development can still use a checked-out binary.
  }

  const localBinary = localDevelopmentBinary(target);
  if (localBinary && exists(localBinary)) {
    return { ok: true, path: localBinary, packageName };
  }
  return {
    ok: false,
    packageName,
    message: [
      `Missing native emulate binary package for ${target.platform}/${target.arch}: ${packageName}.`,
      "Reinstall with optional dependencies enabled, or set EMULATE_NATIVE_BINARY to a locally built binary.",
    ].join("\n"),
  };
}

function localDevelopmentBinary(target: NativeTarget): string | undefined {
  if (target.platform !== process.platform || target.arch !== process.arch) {
    return undefined;
  }
  const currentFile = fileURLToPath(import.meta.url);
  const executable = target.platform === "win32" ? "emulate.exe" : "emulate";
  return join(dirname(currentFile), "native", executable);
}
