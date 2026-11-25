import assert from "node:assert/strict";
import { test } from "node:test";
import { listedPackages, releaseState } from "./release-state.mjs";

const on = (versions) => new Map(Object.entries(versions));

test("a version bump of emulate is a release", () => {
  assert.equal(releaseState("0.14.0", on({ emulate: "0.13.1", "@emulators/core": "0.13.1" })), "release");
  assert.equal(releaseState("0.1.0", on({ emulate: null })), "release");
});

test("a package npm has never seen does not start a release", () => {
  const published = on({ emulate: "0.13.1", "@emulators/core": "0.13.1", "@emulators/ai": null });
  assert.equal(releaseState("0.13.1", published), "nothing");
});

test("a published package left behind by a half finished release is resumed", () => {
  const published = on({ emulate: "0.13.1", "@emulators/core": "0.13.1", "@emulators/linear": "0.0.0" });
  assert.equal(releaseState("0.13.1", published), "resume");
});

test("nothing happens when every package is at the repo version", () => {
  assert.equal(releaseState("0.13.1", on({ emulate: "0.13.1", "@emulators/core": "0.13.1" })), "nothing");
});

test("the package list comes from the release workflow", () => {
  assert.deepEqual(listedPackages("env:\n  EMULATOR_PACKAGES: adapter-next core  github\n\njobs:\n"), [
    "adapter-next",
    "core",
    "github",
  ]);
  assert.throws(() => listedPackages("env: {}\n"), /EMULATOR_PACKAGES is not set/);
});
