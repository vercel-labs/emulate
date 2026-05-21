import { describe, expect, it } from "vitest";
import { nativePackageName, resolveNativeBinary } from "../native.js";

describe("native binary resolution", () => {
  it("maps supported npm platform and arch pairs to native packages", () => {
    expect(nativePackageName({ platform: "darwin", arch: "arm64" })).toBe("@emulators/emulate-darwin-arm64");
    expect(nativePackageName({ platform: "darwin", arch: "x64" })).toBe("@emulators/emulate-darwin-x64");
    expect(nativePackageName({ platform: "linux", arch: "arm64" })).toBe("@emulators/emulate-linux-arm64");
    expect(nativePackageName({ platform: "linux", arch: "x64" })).toBe("@emulators/emulate-linux-x64");
    expect(nativePackageName({ platform: "win32", arch: "arm64" })).toBe("@emulators/emulate-win32-arm64");
    expect(nativePackageName({ platform: "win32", arch: "x64" })).toBe("@emulators/emulate-win32-x64");
  });

  it("returns a clear error for unsupported targets", () => {
    const resolved = resolveNativeBinary({
      target: { platform: "freebsd", arch: "x64" },
      env: {},
      resolvePackage: () => {
        throw new Error("not found");
      },
    });

    expect(resolved).toEqual({
      ok: false,
      message: "No native emulate binary is published for freebsd/x64.",
    });
  });

  it("resolves the platform package binary path", () => {
    const resolved = resolveNativeBinary({
      target: { platform: "linux", arch: "x64" },
      env: {},
      exists: () => true,
      resolvePackage: (specifier) => {
        expect(specifier).toBe("@emulators/emulate-linux-x64/package.json");
        return "/repo/node_modules/@emulators/emulate-linux-x64/package.json";
      },
    });

    expect(resolved).toEqual({
      ok: true,
      packageName: "@emulators/emulate-linux-x64",
      path: "/repo/node_modules/@emulators/emulate-linux-x64/bin/emulate",
    });
  });

  it("uses the Windows executable name", () => {
    const resolved = resolveNativeBinary({
      target: { platform: "win32", arch: "arm64" },
      env: {},
      exists: () => true,
      resolvePackage: () => "C:\\repo\\node_modules\\@emulators\\emulate-win32-arm64\\package.json",
    });

    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.path).toContain("emulate.exe");
    }
  });

  it("fails clearly when the platform package is installed without a binary", () => {
    const resolved = resolveNativeBinary({
      target: { platform: "linux", arch: "arm64" },
      env: {},
      exists: () => false,
      resolvePackage: () => "/repo/node_modules/@emulators/emulate-linux-arm64/package.json",
    });

    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.packageName).toBe("@emulators/emulate-linux-arm64");
      expect(resolved.message).toContain("Missing native emulate binary package");
    }
  });
});
